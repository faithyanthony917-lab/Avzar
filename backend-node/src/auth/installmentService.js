import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { subtractMoney } from '../money.js';
import { withTransaction } from './accountService.js';
import { invoiceForPayment, requirePartialPaymentFeature, todayInZone } from './paymentService.js';
import {
  allocateSchedule, buildCustomSchedule, buildEqualSchedule, cents, fromCents, requireNotInPast, sameSchedule,
} from './installmentSchedule.js';

// Step 15b: installment plans. A plan is only a schedule on one issued invoice. It never holds money: payments keep landing on the
// invoice (15a webhook, staff-recorded payments) and the schedule is read against what the invoice has received since the plan was made.

const iso = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

async function businessToday(db, businessId) {
  const { rows } = await db.query('SELECT "TimeZoneId" FROM "Businesses" WHERE "Id" = $1', [businessId]);
  return todayInZone(rows[0]?.TimeZoneId);
}

async function audit(db, user, action, invoiceId, details) {
  await db.query(`INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'Invoice')`,
  [randomUUID(), action, user.userId, user.businessId, JSON.stringify(details), invoiceId]);
}

/**
 * The Active plan of each named invoice, read against the invoice's payments and credit notes, as a Map keyed by invoice ID.
 * Used by the staff screen and the customer portal alike. `today` is the business's local date.
 */
export async function loadActivePlans(db, businessId, invoiceIds, today) {
  const plans = new Map();
  if (!invoiceIds.length) return plans;
  const { rows } = await db.query(`
    SELECT pl.*, i."Status" AS "InvoiceStatus", i."Total" AS "InvoiceTotal", i."CurrencyCode",
      COALESCE((SELECT sum(p."Amount") FROM "Payments" p WHERE p."BusinessId" = pl."BusinessId" AND p."InvoiceId" = pl."InvoiceId" AND p."Status" = 'Verified'), 0) AS "AmountPaid",
      COALESCE((SELECT sum(cn."Amount") FROM "CreditNotes" cn WHERE cn."BusinessId" = pl."BusinessId" AND cn."InvoiceId" = pl."InvoiceId"), 0) AS "AmountCredited"
    FROM "InvoiceInstallmentPlans" pl
    JOIN "Invoices" i ON i."BusinessId" = pl."BusinessId" AND i."Id" = pl."InvoiceId"
    WHERE pl."BusinessId" = $1 AND pl."InvoiceId" = ANY($2::uuid[]) AND pl."Status" = 'Active'`, [businessId, invoiceIds]);
  if (!rows.length) return plans;
  const { rows: parts } = await db.query(`SELECT "PlanId", "Sequence", "DueDate", "Amount" FROM "InvoiceInstallments"
    WHERE "BusinessId" = $1 AND "PlanId" = ANY($2::uuid[]) ORDER BY "PlanId", "Sequence"`, [businessId, rows.map((row) => row.Id)]);
  for (const row of rows) {
    const installments = parts.filter((part) => part.PlanId === row.Id)
      .map((part) => ({ sequence: part.Sequence, dueDate: iso(part.DueDate), amount: Number(part.Amount) }));
    const invoiceBalance = row.InvoiceStatus === 'Void' ? 0 : Math.max(0, subtractMoney(row.InvoiceTotal, row.AmountPaid, row.AmountCredited));
    const read = allocateSchedule({
      installments,
      paidSince: subtractMoney(row.AmountPaid, row.PaidAtCreation),
      creditedSince: subtractMoney(row.AmountCredited, row.CreditedAtCreation),
      today,
    });
    const complete = invoiceBalance <= 0 || cents(read.outstanding) === 0;
    plans.set(row.InvoiceId, {
      id: row.Id,
      invoiceId: row.InvoiceId,
      status: row.Status,
      state: complete ? 'Completed' : 'Active',
      currencyCode: row.CurrencyCode,
      note: row.Note ?? null,
      createdAtUtc: row.CreatedAtUtc,
      createdByUserId: row.CreatedByUserId ?? null,
      invoiceBalance,
      // False when the invoice owes something the schedule does not cover (for example an older payment was reversed).
      matchesInvoice: cents(read.outstanding) === cents(invoiceBalance),
      outstanding: read.outstanding,
      overdueCount: read.overdueCount,
      installments: read.installments,
      next: complete || !read.next ? null
        : { ...read.next, payAmount: fromCents(Math.min(cents(read.next.amount), cents(invoiceBalance))) },
    });
  }
  return plans;
}

/** Staff view: the invoice's Active plan, or `{ plan: null }`. Location scope follows the invoice's order, as for payments. */
export async function getInstallmentPlan(pool, user, invoiceId, allowed) {
  await invoiceForPayment(pool, user, invoiceId, allowed);
  const today = await businessToday(pool, user.businessId);
  const plans = await loadActivePlans(pool, user.businessId, [invoiceId], today);
  return { plan: plans.get(invoiceId) ?? null };
}

/**
 * Makes a plan for an issued invoice that still owes money. Runs under the same per-invoice advisory lock as startInvoicePayment, so a
 * plan cannot be made in the middle of a payment. `body` is either { parts, firstDueDate, interval } or { installments: [...] }.
 * A repeat of the same request returns the existing plan; a different request while a plan is Active is refused.
 */
export async function createInstallmentPlan(pool, user, invoiceId, body, allowed) {
  const result = await withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${invoiceId}`]);
    const invoice = await invoiceForPayment(db, user, invoiceId, allowed, { lock: true });
    if (invoice.Status !== 'Issued') throw AppError.conflict('invoice_not_payable', `Only issued invoices can have a payment plan (this one is ${invoice.Status}).`);
    const balance = subtractMoney(invoice.Total, invoice.AmountPaid, invoice.AmountCredited);
    if (balance <= 0) throw AppError.conflict('nothing_owed', 'This invoice has nothing left to pay.');
    await requirePartialPaymentFeature(db, user.businessId);

    const { rows: existing } = await db.query(`SELECT pl."Id", (SELECT sum(x."Amount") FROM "InvoiceInstallments" x WHERE x."BusinessId" = pl."BusinessId" AND x."PlanId" = pl."Id") AS "Scheduled"
      FROM "InvoiceInstallmentPlans" pl WHERE pl."BusinessId" = $1 AND pl."InvoiceId" = $2 AND pl."Status" = 'Active'`, [user.businessId, invoiceId]);
    const build = (amount) => (body.installments
      ? buildCustomSchedule({ balance: amount, items: body.installments })
      : buildEqualSchedule({ balance: amount, parts: body.parts, firstDueDate: body.firstDueDate, interval: body.interval }));

    if (existing.length) {
      const { rows: stored } = await db.query(`SELECT "Sequence", "DueDate", "Amount" FROM "InvoiceInstallments"
        WHERE "BusinessId" = $1 AND "PlanId" = $2 ORDER BY "Sequence"`, [user.businessId, existing[0].Id]);
      let same = false;
      try {
        same = sameSchedule(build(Number(existing[0].Scheduled)), stored.map((row) => ({ dueDate: iso(row.DueDate), amount: Number(row.Amount) })));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
      if (!same) throw AppError.conflict('installment_plan_exists', 'This invoice already has a payment plan. Cancel it before making a different one.');
      return { created: false };
    }

    const today = await businessToday(db, user.businessId);
    const schedule = build(balance);
    requireNotInPast(schedule, today);
    const planId = randomUUID();
    await db.query(`INSERT INTO "InvoiceInstallmentPlans" ("Id", "BusinessId", "InvoiceId", "Status", "PaidAtCreation", "CreditedAtCreation", "Note", "CreatedByUserId")
      VALUES ($1, $2, $3, 'Active', $4, $5, $6, $7)`,
    [planId, user.businessId, invoiceId, invoice.AmountPaid, invoice.AmountCredited, body.note?.trim() || null, user.userId]);
    for (const row of schedule) {
      await db.query(`INSERT INTO "InvoiceInstallments" ("Id", "BusinessId", "PlanId", "Sequence", "DueDate", "Amount") VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), user.businessId, planId, row.sequence, row.dueDate, row.amount]);
    }
    await audit(db, user, 'invoice.installment_plan_created', invoiceId,
      { number: invoice.Number, installments: schedule.length, firstDueDate: schedule[0].dueDate, lastDueDate: schedule[schedule.length - 1].dueDate, total: balance });
    return { created: true };
  });
  const today = await businessToday(pool, user.businessId);
  const plans = await loadActivePlans(pool, user.businessId, [invoiceId], today);
  return { plan: plans.get(invoiceId), created: result.created };
}

/** Staff cancels the Active plan. The invoice, its balance and its payments are untouched. */
export async function cancelInstallmentPlan(pool, user, invoiceId, reason, allowed) {
  return withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${invoiceId}`]);
    const invoice = await invoiceForPayment(db, user, invoiceId, allowed, { lock: true });
    const { rows } = await db.query(`UPDATE "InvoiceInstallmentPlans" SET "Status" = 'Cancelled', "CancelledAtUtc" = now(), "CancelledByUserId" = $3, "CancelReason" = $4
      WHERE "BusinessId" = $1 AND "InvoiceId" = $2 AND "Status" = 'Active' RETURNING "Id"`,
    [user.businessId, invoiceId, user.userId, reason?.trim() || null]);
    if (!rows.length) throw AppError.notFound('installment_plan_not_found', 'This invoice has no active payment plan.');
    await audit(db, user, 'invoice.installment_plan_cancelled', invoiceId, { number: invoice.Number, reason: reason?.trim() || null });
    return { cancelled: true };
  });
}

/** Called inside voidInvoice's transaction: a void invoice ends its plan. Returns how many plans were ended. */
export async function cancelPlansForVoidedInvoice(db, user, invoiceId) {
  const { rowCount } = await db.query(`UPDATE "InvoiceInstallmentPlans" SET "Status" = 'Cancelled', "CancelledAtUtc" = now(), "CancelledByUserId" = $3, "CancelReason" = 'invoice_void'
    WHERE "BusinessId" = $1 AND "InvoiceId" = $2 AND "Status" = 'Active'`, [user.businessId, invoiceId, user.userId]);
  if (rowCount) await audit(db, user, 'invoice.installment_plan_cancelled', invoiceId, { reason: 'invoice_void' });
  return rowCount;
}

/** For the customer portal: the schedules of the customer's issued invoices, read-only, keyed by invoice ID. */
export async function portalInstallmentPlans(db, businessId, invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const today = await businessToday(db, businessId);
  return loadActivePlans(db, businessId, invoiceIds, today);
}
