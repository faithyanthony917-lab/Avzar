import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { forEachBusiness, sumResults } from '../db/forEachBusiness.js';
import { AppError } from '../http/errors.js';
import { recordSubscriptionAudit, toMinorUnits } from './subscriptionBillingService.js';
import { notify } from '../notifications/notificationService.js';

// Lifecycle rules (nothing here ever deletes or locks business data; limits only stop NEW records being added):
//   Free --trial--> Trialing --ends--> Free            (one trial per business, ever)
//   Active (paid) --period ends--> PastDue (grace)     paid access continues during the grace period
//   PastDue --grace ends--> Expired                    Free-plan limits apply; existing data stays readable and editable
//   Active (paid) + scheduled change --period ends--> Free (active) or the lower plan (renewal due, PastDue until paid)
//   any paid webhook (verified payment) --> Active
const LOCK_KEY = 7_262_031; // pg_advisory_xact_lock: one sweep at a time across replicas
const planSchema = z.object({ planCode: z.string().trim().min(1).max(40) });

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

async function lockSubscription(db, businessId) {
  const { rows } = await db.query(`
    SELECT s."Id", s."Status", s."PlanId", s."CurrentPeriodEndUtc", s."TrialStartedAtUtc", s."PendingPlanId",
           p."Code" AS "PlanCode", p."MonthlyPrice" AS "MonthlyPrice"
    FROM "Subscriptions" s JOIN "Plans" p ON p."Id" = s."PlanId"
    WHERE s."BusinessId" = $1 FOR UPDATE OF s`, [businessId]);
  return rows[0] ?? null;
}

async function findPlan(db, code) {
  const { rows } = await db.query('SELECT "Id", "Code", "Name", "MonthlyPrice" FROM "Plans" WHERE "Code" = $1 AND "IsActive" = TRUE', [code]);
  return rows[0] ?? null;
}

function parsePlan(body) {
  const parsed = planSchema.safeParse(body ?? {});
  if (!parsed.success) throw AppError.badRequest('invalid_plan', 'Choose a plan.');
  return parsed.data.planCode;
}

/** Starts the single free trial of a paid plan. Only a business on the Free plan that has never trialled may start one. */
export async function startTrial(pool, env, user, body) {
  const planCode = parsePlan(body);
  const trialDays = env.BILLING_TRIAL_DAYS ?? 14;
  try {
    return await inTransaction(pool, async (db) => {
      const plan = await findPlan(db, planCode);
      if (!plan) throw AppError.notFound('plan_not_found', 'This plan is unavailable.');
      const price = toMinorUnits(plan.MonthlyPrice);
      if (plan.Code === 'free' || !price) throw AppError.badRequest('free_plan_trial', 'Only paid plans have a trial.');
      const existing = await lockSubscription(db, user.businessId);
      // Not on Free (trialling now, paying, past due or suspended) is reported first; "already used" is for a business back on Free.
      if (existing && !(existing.Status === 'Active' && existing.PlanCode === 'free')) {
        throw AppError.conflict('trial_not_available', 'A trial can only be started from the Free plan.');
      }
      if (existing?.TrialStartedAtUtc) throw AppError.conflict('trial_already_used', 'This business has already used its free trial.');
      let subscriptionId = existing?.Id;
      let endsAt;
      if (existing) {
        const { rows } = await db.query(`
          UPDATE "Subscriptions" SET "PlanId" = $2, "Status" = 'Trialing', "CurrentPeriodStartUtc" = now(),
            "CurrentPeriodEndUtc" = now() + make_interval(hours => $3::int * 24), "TrialStartedAtUtc" = now(),
            "GraceEndsAtUtc" = NULL, "SuspendedAtUtc" = NULL, "PendingPlanId" = NULL, "UpdatedAtUtc" = now()
          WHERE "Id" = $1 RETURNING "CurrentPeriodEndUtc"`, [existing.Id, plan.Id, trialDays]);
        endsAt = rows[0]?.CurrentPeriodEndUtc;
      } else {
        subscriptionId = randomUUID();
        const { rows } = await db.query(`
          INSERT INTO "Subscriptions" ("Id","BusinessId","PlanId","Status","CurrentPeriodStartUtc","CurrentPeriodEndUtc","TrialStartedAtUtc","CreatedAtUtc")
          VALUES ($1,$2,$3,'Trialing',now(),now() + make_interval(hours => $4::int * 24),now(),now()) RETURNING "CurrentPeriodEndUtc"`,
        [subscriptionId, user.businessId, plan.Id, trialDays]);
        endsAt = rows[0]?.CurrentPeriodEndUtc;
      }
      await recordSubscriptionAudit(db, user.businessId, user.userId, 'subscription.trial_started', 'Subscription', subscriptionId, { planCode: plan.Code, trialDays });
      return { status: 'Trialing', planCode: plan.Code, trialEndsAtUtc: iso(endsAt) };
    });
  } catch (error) {
    if (error?.code === '23505') throw AppError.conflict('trial_not_available', 'A subscription already exists for this business.');
    throw error;
  }
}

/** Schedules a lower-priced plan (or Free, i.e. cancel) for the end of the paid period. Access to the current plan continues until then. */
export async function scheduleChange(pool, user, body) {
  const planCode = parsePlan(body);
  return inTransaction(pool, async (db) => {
    const subscription = await lockSubscription(db, user.businessId);
    if (!subscription || subscription.Status !== 'Active' || subscription.PlanCode === 'free' || !subscription.CurrentPeriodEndUtc) {
      throw AppError.conflict('no_paid_subscription', 'Only an active paid subscription can be changed at the end of its period.');
    }
    const target = await findPlan(db, planCode);
    if (!target) throw AppError.notFound('plan_not_found', 'This plan is unavailable.');
    if (target.Id === subscription.PlanId) throw AppError.conflict('same_plan', 'You are already on this plan.');
    if (target.Code !== 'free') {
      const targetPrice = toMinorUnits(target.MonthlyPrice);
      const currentPrice = toMinorUnits(subscription.MonthlyPrice);
      if (targetPrice == null || currentPrice == null || targetPrice >= currentPrice) {
        throw AppError.conflict('use_checkout_for_upgrade', 'Upgrades start immediately through checkout. Only lower-priced plans can be scheduled.');
      }
    }
    await db.query('UPDATE "Subscriptions" SET "PendingPlanId" = $2, "UpdatedAtUtc" = now() WHERE "Id" = $1', [subscription.Id, target.Id]);
    await recordSubscriptionAudit(db, user.businessId, user.userId, 'subscription.change_scheduled', 'Subscription', subscription.Id,
      { from: subscription.PlanCode, to: target.Code });
    return { pendingPlanCode: target.Code, effectiveAtUtc: iso(subscription.CurrentPeriodEndUtc) };
  });
}

export async function cancelScheduledChange(pool, user) {
  return inTransaction(pool, async (db) => {
    const subscription = await lockSubscription(db, user.businessId);
    if (!subscription?.PendingPlanId) throw AppError.conflict('no_scheduled_change', 'There is no scheduled plan change to cancel.');
    await db.query('UPDATE "Subscriptions" SET "PendingPlanId" = NULL, "UpdatedAtUtc" = now() WHERE "Id" = $1', [subscription.Id]);
    await recordSubscriptionAudit(db, user.businessId, user.userId, 'subscription.change_cancelled', 'Subscription', subscription.Id, {});
    return { pendingPlanCode: null };
  });
}

/**
 * Idempotent state transitions driven by time. Safe to run on every replica and as often as wanted: a row is only ever moved forward,
 * and the advisory lock makes concurrent sweeps skip instead of racing. Returns the events so notifications (a later step) can be sent.
 */
export async function runLifecycleSweep(pool, { graceDays = 7, now = new Date() } = {}) {
  const at = now.toISOString();
  return inTransaction(pool, async (db) => {
    const { rows: lock } = await db.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK_KEY]);
    if (!lock[0]?.ok) return { skipped: true, events: [] };
    const events = [];
    const note = async (rows, event, action) => {
      for (const row of rows) {
        events.push({ businessId: row.BusinessId, subscriptionId: row.Id, event });
        await recordSubscriptionAudit(db, row.BusinessId, null, action, 'Subscription', row.Id, {});
        const descriptions = {
          trial_ended: ['Trial ended', 'The trial ended and the business moved to the Free plan.'],
          subscription_ended: ['Subscription ended', 'The subscription ended at the end of its paid period.'],
          payment_overdue: ['Subscription payment overdue', 'A subscription payment is overdue.'],
          subscription_suspended: ['Subscription suspended', 'The grace period ended and Free-plan limits now apply.'],
        };
        const [title, body] = descriptions[event];
        await notify(db, {
          businessId: row.BusinessId, category: 'billing', eventType: `subscription.${event}`, title, body,
          dedupeKey: `billing.${event}:${row.Id}`,
          target: { kind: 'subscription', id: row.Id }, recipients: { ownersOnly: true },
          email: { templateKey: `billing.${event}`, subject: title, text: () => `${body} Open Avzar to review subscription settings.` },
        });
      }
    };

    // 1. Trials that ended fall back to Free. TrialStartedAtUtc stays set so a second trial is impossible.
    const trials = await db.query(`
      UPDATE "Subscriptions" s SET "PlanId" = f."Id", "Status" = 'Active', "CurrentPeriodStartUtc" = $1::timestamptz,
        "CurrentPeriodEndUtc" = NULL, "PendingPlanId" = NULL, "UpdatedAtUtc" = $1::timestamptz
      FROM "Plans" f WHERE f."Code" = 'free' AND s."Status" = 'Trialing' AND s."CurrentPeriodEndUtc" <= $1::timestamptz
      RETURNING s."Id", s."BusinessId"`, [at]);
    await note(trials.rows, 'trial_ended', 'subscription.trial_ended');

    // 2. A scheduled move to Free (cancel at period end) takes effect when the paid period ends.
    const cancelled = await db.query(`
      UPDATE "Subscriptions" s SET "PlanId" = f."Id", "Status" = 'Active', "CurrentPeriodStartUtc" = $1::timestamptz,
        "CurrentPeriodEndUtc" = NULL, "PendingPlanId" = NULL, "GraceEndsAtUtc" = NULL, "UpdatedAtUtc" = $1::timestamptz
      FROM "Plans" f WHERE f."Code" = 'free' AND s."Status" = 'Active' AND s."PendingPlanId" = f."Id" AND s."CurrentPeriodEndUtc" <= $1::timestamptz
      RETURNING s."Id", s."BusinessId"`, [at]);
    await note(cancelled.rows, 'subscription_ended', 'subscription.ended_at_period_end');

    // 3. A paid period that ended without a payment starts the grace period (paid access continues). A scheduled lower plan becomes the plan to renew.
    const pastDue = await db.query(`
      UPDATE "Subscriptions" s SET "PlanId" = COALESCE(s."PendingPlanId", s."PlanId"), "PendingPlanId" = NULL, "Status" = 'PastDue',
        "GraceEndsAtUtc" = s."CurrentPeriodEndUtc" + make_interval(hours => $2::int * 24), "UpdatedAtUtc" = $1::timestamptz
      WHERE s."Status" = 'Active' AND s."CurrentPeriodEndUtc" <= $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM "Plans" f WHERE f."Id" = s."PlanId" AND f."Code" = 'free')
      RETURNING s."Id", s."BusinessId"`, [at, graceDays]);
    await note(pastDue.rows, 'payment_overdue', 'subscription.payment_overdue');

    // 4. After the grace period the subscription is suspended: Free-plan limits apply. No data is deleted, hidden or made read-only.
    const suspended = await db.query(`
      UPDATE "Subscriptions" s SET "Status" = 'Expired', "SuspendedAtUtc" = $1::timestamptz, "UpdatedAtUtc" = $1::timestamptz
      WHERE s."Status" = 'PastDue' AND s."GraceEndsAtUtc" <= $1::timestamptz
      RETURNING s."Id", s."BusinessId"`, [at]);
    await note(suspended.rows, 'subscription_suspended', 'subscription.suspended');

    return { skipped: false, events };
  });
}

export function startSubscriptionLifecycleWorker({ pool, enabled = true, graceDays = 7, intervalMinutes = 60, startupDelayMs = 30_000,
  log = console, schedule = setTimeout, cancel = clearTimeout, onEvents = async () => {} }) {
  if (!pool || !enabled) return async () => {};
  let stopped = false;
  let timer = null;
  let running = null;

  const cycle = async () => {
    if (stopped) return;
    // The sweep updates Subscriptions, which are isolated per business, so it runs once under each business's context.
    running = forEachBusiness(pool, () => runLifecycleSweep(pool, { graceDays }), { log }).then(sumResults);
    try {
      const result = await running;
      if (result?.events?.length) {
        log.info?.('Subscription lifecycle sweep changed subscriptions.', { changes: result.events.length });
        await onEvents(result.events);
      }
    } catch (error) {
      log.error?.('Subscription lifecycle sweep failed; it will retry.', { errorType: error?.constructor?.name ?? 'Error' });
    } finally {
      running = null;
    }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, Math.max(1, intervalMinutes) * 60_000);
  };

  timer = schedule(() => { timer = null; void cycle(); }, Math.max(0, startupDelayMs));
  return async () => {
    stopped = true;
    if (timer !== null) cancel(timer);
    await running?.catch(() => {});
  };
}
