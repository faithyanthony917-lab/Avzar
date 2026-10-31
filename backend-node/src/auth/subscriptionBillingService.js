import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { withFreshTenantContext } from '../db/forEachBusiness.js';

const INT32_MAX = 2_147_483_647;
const checkoutSchema = z.object({ planCode: z.string().trim().min(1).max(40), billingPeriod: z.string().trim().min(1).max(20) });

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

/** Converts a Postgres numeric string ("5000.00") to integer minor units (x100) with no floating point. Returns null if invalid. */
export function toMinorUnits(value) {
  const match = /^(\d{1,16})(?:\.(\d{1,4}))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(4, '0');
  const rounded = BigInt(fraction.slice(0, 2)) + (fraction[2] >= '5' ? 1n : 0n); // half away from zero
  const total = BigInt(match[1]) * 100n + rounded;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

const DAY_MS = 86_400_000;

/** One audit row per subscription event. ActorUserId is null for system events (webhook, lifecycle sweep). */
export async function recordSubscriptionAudit(db, businessId, actorUserId, action, entityType, entityId, details = {}) {
  await db.query(
    `INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","EntityId","EntityType","DetailsJson")
     VALUES ($1,$2,$3,$4,now(),$5,$6,$7::jsonb)`,
    [randomUUID(), action, actorUserId ?? null, businessId, entityId ?? null, entityType, JSON.stringify(details)]);
}

/**
 * Prorated credit, in integer minor units, for the unused part of the last payment when upgrading mid-period.
 * It never exceeds the last payment and never covers more than one paid interval, so stacked renewals cannot over-credit.
 */
export function computeUpgradeCredit({ paidMinor, billingPeriod, periodEnd, now }) {
  if (!Number.isSafeInteger(paidMinor) || paidMinor <= 0) return 0;
  const intervalMs = (billingPeriod === 'annual' ? 365 : 30) * DAY_MS;
  const remainingMs = new Date(periodEnd).getTime() - now.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  const creditedMs = Math.min(Math.floor(remainingMs), intervalMs);
  return Number((BigInt(paidMinor) * BigInt(creditedMs)) / BigInt(intervalMs));
}

/** The billing period of the most recent paid checkout for this plan ("monthly" | "annual"), or null when there is none. */
export async function lastPaidBillingPeriod(db, businessId, planId) {
  const result = await db.query(
    `SELECT "BillingPeriod" FROM "SubscriptionPayments"
     WHERE "BusinessId" = $1 AND "PlanId" = $2 AND "Status" = 'Paid' ORDER BY "PaidAtUtc" DESC NULLS LAST LIMIT 1`,
    [businessId, planId]);
  const period = result?.rows?.[0]?.BillingPeriod;
  return period === 'annual' || period === 'monthly' ? period : null;
}

async function upgradeCreditFor(pool, businessId, subscription) {
  const { rows } = await pool.query(
    `SELECT "Amount", "BillingPeriod" FROM "SubscriptionPayments"
     WHERE "BusinessId" = $1 AND "PlanId" = $2 AND "Status" = 'Paid' ORDER BY "PaidAtUtc" DESC NULLS LAST LIMIT 1`,
    [businessId, subscription.PlanId]);
  if (!rows[0]) return 0;
  return computeUpgradeCredit({ paidMinor: toMinorUnits(rows[0].Amount), billingPeriod: rows[0].BillingPeriod, periodEnd: subscription.CurrentPeriodEndUtc, now: new Date() });
}

export async function createCheckout(pool, env, provider, user, body) {
  const businessId = user.businessId;
  if (!provider.isConfigured()) throw new AppError(503, 'billing_provider_not_configured', 'Subscription payments are not configured on this deployment.');
  const parsed = checkoutSchema.safeParse(body ?? {});
  if (!parsed.success) throw AppError.badRequest('invalid_billing_period', 'Billing period must be monthly or annual.');
  const period = parsed.data.billingPeriod.toLowerCase();
  if (period !== 'monthly' && period !== 'annual') throw AppError.badRequest('invalid_billing_period', 'Billing period must be monthly or annual.');

  // The plan and its price always come from the database, never from the client.
  const { rows: plans } = await pool.query('SELECT "Id", "Code", "CurrencyCode", "MonthlyPrice", "AnnualPrice" FROM "Plans" WHERE "Code" = $1 AND "IsActive" = TRUE', [parsed.data.planCode]);
  const plan = plans[0];
  if (!plan) throw AppError.notFound('plan_not_found', 'This plan is unavailable.');
  if (plan.Code === 'free') throw AppError.badRequest('free_plan_checkout', 'The Free plan does not require checkout.');
  if (plan.CurrencyCode !== 'NGN') throw AppError.badRequest('unsupported_billing_currency', 'Paystack checkout currently supports NGN plans only.');
  const rawPrice = period === 'annual' ? plan.AnnualPrice : plan.MonthlyPrice;
  const amountMinor = rawPrice == null ? null : toMinorUnits(rawPrice);
  if (amountMinor == null || amountMinor <= 0 || amountMinor > INT32_MAX) throw AppError.badRequest('invalid_plan_price', 'This plan has no valid price for the selected period.');

  // Mid-period plan changes: a higher-priced plan starts immediately and the unused part of the last payment is credited;
  // a lower-priced plan is never bought through checkout while a paid period is running (it is scheduled for the period end).
  const { rows: currentRows } = await pool.query(`
    SELECT s."Status", s."PlanId", s."CurrentPeriodEndUtc", cp."MonthlyPrice" AS "CurrentMonthlyPrice"
    FROM "Subscriptions" s JOIN "Plans" cp ON cp."Id" = s."PlanId" WHERE s."BusinessId" = $1`, [businessId]);
  const currentSubscription = currentRows[0];
  let creditMinor = 0;
  if (currentSubscription?.Status === 'Active' && currentSubscription.CurrentPeriodEndUtc && currentSubscription.PlanId !== plan.Id) {
    const currentMonthly = toMinorUnits(currentSubscription.CurrentMonthlyPrice);
    const newMonthly = toMinorUnits(plan.MonthlyPrice);
    if (currentMonthly != null && currentMonthly > 0) {
      if (newMonthly == null || newMonthly <= currentMonthly) {
        throw AppError.conflict('use_scheduled_downgrade', 'This plan costs the same or less than your current one. Schedule the change for the end of your paid period instead.');
      }
      creditMinor = await upgradeCreditFor(pool, businessId, currentSubscription);
    }
  }
  // Same plan, different period. Monthly -> annual is allowed: the remaining paid time is kept (the webhook stacks the new year after it),
  // so nothing is lost and no credit is needed. Annual -> monthly while an annual period is still running would only stack a month behind
  // the remaining year, so it is refused; the monthly period is chosen when the annual one ends.
  if (currentSubscription?.Status === 'Active' && currentSubscription.PlanId === plan.Id && period === 'monthly'
    && currentSubscription.CurrentPeriodEndUtc && new Date(currentSubscription.CurrentPeriodEndUtc).getTime() > Date.now()
    && await lastPaidBillingPeriod(pool, businessId, plan.Id) === 'annual') {
    throw AppError.conflict('monthly_after_annual', 'You are paid on annual billing until your current period ends. Choose monthly billing when it renews.');
  }
  const chargeMinor = amountMinor - creditMinor;
  if (creditMinor > 0 && chargeMinor < 100) {
    throw AppError.conflict('upgrade_credit_exceeds_price', 'Your remaining credit already covers this plan. Schedule the change for the end of your current period instead.');
  }
  const amount = (chargeMinor / 100).toFixed(2); // exact: minor units are an integer

  const { rows: businesses } = await pool.query('SELECT "ContactEmail" FROM "Businesses" WHERE "Id" = $1', [businessId]);
  const email = businesses[0]?.ContactEmail?.trim();
  if (!email) throw AppError.badRequest('billing_email_required', 'Add a business contact email before checkout.');

  const reference = `avz_${randomUUID().replaceAll('-', '')}`;
  const paymentId = randomUUID();
  await pool.query(`
    INSERT INTO "SubscriptionPayments" ("Id", "BusinessId", "PlanId", "BillingPeriod", "Amount", "CurrencyCode", "Provider", "ProviderReference", "Status", "CreatedAtUtc")
    VALUES ($1, $2, $3, $4, $5::numeric, 'NGN', 'paystack', $6, 'Pending', now())`,
  [paymentId, businessId, plan.Id, period, amount, reference]);

  let session;
  try {
    session = await provider.initialize({
      email, amountMinor: chargeMinor, currency: 'NGN', reference,
      callbackUrl: env.BILLING_PAYSTACK_CALLBACK_URL || undefined,
      metadata: { businessId, planCode: plan.Code, billingPeriod: period, paymentId, creditMinor },
    });
  } catch (error) {
    await pool.query(`UPDATE "SubscriptionPayments" SET "Status" = 'Failed', "UpdatedAtUtc" = now() WHERE "Id" = $1 AND "Status" = 'Pending'`, [paymentId]);
    throw new AppError(502, 'billing_provider_error', 'The payment provider could not initialize checkout.');
  }
  return { authorizationUrl: session.authorizationUrl, reference, amount: Number(amount), creditAmount: creditMinor / 100, currencyCode: 'NGN', expiresAtUtc: new Date(Date.now() + 30 * 60_000).toISOString() };
}

/** Returns the HTTP status for the webhook response. Never grants a plan from the payload alone. */
export async function handlePaystackWebhook(pool, provider, rawBody, signature, log = console) {
  if (!provider.isConfigured()) return 503;
  if (!provider.verifySignature(rawBody, signature)) return 401;

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return 400; }
  if (payload?.event !== 'charge.success') return 200;
  const reference = payload?.data?.reference;
  if (typeof reference !== 'string' || !reference.trim()) return 400;

  // The payment reference is the key to the one payment (and so the business) this webhook is about.
  return withFreshTenantContext(pool, async () => {
    await bindTenantByLookup(pool, 'subscription_payment_reference', reference);
    const { rows } = await pool.query('SELECT "Id", "Status", "Amount", "CurrencyCode" FROM "SubscriptionPayments" WHERE "ProviderReference" = $1', [reference]);
    const payment = rows[0];
    if (!payment) {
      log.error?.(JSON.stringify({ level: 'error', event: 'subscription_webhook_unmatched_reference', reference }));
      return 404;
    }
    if (payment.Status === 'Paid') return 200;

    let verified;
    try { verified = await provider.verify(reference); } catch { return 502; }
    const expectedMinor = toMinorUnits(payment.Amount);
    if (verified.status !== 'success' || verified.reference !== reference || verified.currency !== payment.CurrencyCode || verified.amountMinor !== expectedMinor) {
      await pool.query(`UPDATE "SubscriptionPayments" SET "Status" = 'Failed', "UpdatedAtUtc" = now() WHERE "Id" = $1 AND "Status" = 'Pending'`, [payment.Id]);
      return 400;
    }

    await inTransaction(pool, async (client) => {
      // Lock the payment row and re-read it so concurrent webhook retries cannot extend a subscription twice.
      const { rows: locked } = await client.query('SELECT "Id", "BusinessId", "PlanId", "BillingPeriod", "Status" FROM "SubscriptionPayments" WHERE "Id" = $1 FOR UPDATE', [payment.Id]);
      const current = locked[0];
      if (!current || current.Status !== 'Pending') return;
      await client.query(`UPDATE "SubscriptionPayments" SET "Status" = 'Paid', "PaidAtUtc" = now(), "UpdatedAtUtc" = now() WHERE "Id" = $1`, [current.Id]);
      const interval = current.BillingPeriod === 'annual' ? '1 year' : '1 month';
      // Renewals of the same plan stack on the remaining paid time; a different plan, a trial, a grace period or a suspension starts a fresh period now.
      const updated = await client.query(`
        UPDATE "Subscriptions" SET
          "CurrentPeriodEndUtc" = (CASE WHEN "Status" = 'Active' AND "PlanId" = $2 AND "CurrentPeriodEndUtc" > now() THEN "CurrentPeriodEndUtc" ELSE now() END) + $3::interval,
          "CurrentPeriodStartUtc" = now(),
          "PlanId" = $2,
          "Status" = 'Active',
          "GraceEndsAtUtc" = NULL,
          "SuspendedAtUtc" = NULL,
          "PendingPlanId" = NULL,
          "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $1`, [current.BusinessId, current.PlanId, interval]);
      if (!updated.rowCount) {
        await client.query(`
          INSERT INTO "Subscriptions" ("Id", "BusinessId", "PlanId", "Status", "CurrentPeriodStartUtc", "CurrentPeriodEndUtc", "CreatedAtUtc")
          VALUES ($1, $2, $3, 'Active', now(), now() + $4::interval, now())`, [randomUUID(), current.BusinessId, current.PlanId, interval]);
      }
      await recordSubscriptionAudit(client, current.BusinessId, null, 'subscription.payment_applied', 'SubscriptionPayment', current.Id, { planId: current.PlanId, billingPeriod: current.BillingPeriod });
    });
    return 200;
  });
}
