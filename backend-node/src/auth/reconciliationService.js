import { AppError } from '../http/errors.js';
import { requireTier } from './entitlementService.js';
import { todayInZone } from './paymentService.js';
import { loadActivePlans } from './installmentService.js';
import {
  LIST_LIMIT, MISMATCH_LABELS, PLAN_LIMIT, STALE_PENDING_DAYS, attentionCount, parseRange, section, summarizeCollected, summarizeOverdueInstallments,
} from './reconciliationReport.js';

// Step 15c: the payment reconciliation report. Read only: it never changes a payment, an attempt or an invoice, and it does not ask the
// payment provider anything (a comparison with the provider's own settlement list is left for step 20, because it cannot be tested here).
// Every query is limited to the caller's business (and row-level security enforces that again) and, for a location-limited user, to the
// invoices whose order is at one of their locations, the same rule as the payment list. Invoices with no order are visible to
// unscoped users only.

const SCOPE = '($2::uuid[] IS NULL OR (i."OrderId" IS NOT NULL AND o."LocationId" = ANY($2::uuid[])))';
const JOINS = `JOIN "Invoices" i ON i."BusinessId" = p."BusinessId" AND i."Id" = p."InvoiceId"
  LEFT JOIN "Orders" o ON o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"`;
const ATTEMPT_JOINS = `JOIN "Invoices" i ON i."BusinessId" = a."BusinessId" AND i."Id" = a."InvoiceId"
  LEFT JOIN "Orders" o ON o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"`;
const iso = (value) => (value instanceof Date ? value.toISOString() : value == null ? null : String(value));

export async function reconciliationReport(pool, user, allowed, fromValue, toValue) {
  const businessId = user.businessId;
  await requireTier(pool, businessId, 'reports.level', 'basic');
  const { from, to, fromUtc, untilUtc } = parseRange(fromValue, toValue, new Date().toISOString().slice(0, 10));
  const business = await pool.query('SELECT "CurrencyCode", "TimeZoneId" FROM "Businesses" WHERE "Id" = $1', [businessId]);
  if (!business.rows.length) throw AppError.unauthorized('business_required', 'Select a business first.');
  const today = todayInZone(business.rows[0].TimeZoneId);
  const scope = [businessId, allowed];

  const [collected, review, stale, pending, voided, mismatches, invoices, planIds] = await Promise.all([
    pool.query(`
      SELECT p."Method", EXISTS (SELECT 1 FROM "InvoicePaymentAttempts" a WHERE a."BusinessId" = p."BusinessId" AND a."PaymentId" = p."Id") AS "Online",
        count(*)::int AS "Count", COALESCE(sum(p."Amount"), 0)::numeric(18,2) AS "Amount"
      FROM "Payments" p ${JOINS}
      WHERE p."BusinessId" = $1 AND ${SCOPE} AND p."Status" = 'Verified' AND p."VerifiedAtUtc" >= $3::timestamptz AND p."VerifiedAtUtc" < $4::timestamptz
      GROUP BY 1, 2`, [...scope, fromUtc, untilUtc]),
    // Money a customer paid that the invoice could no longer take. Open items, whatever their date.
    pool.query(`
      SELECT a."Id", a."InvoiceId", i."Number" AS "InvoiceNumber", a."Amount", a."CurrencyCode", a."Reference", a."FailureReason", a."Source",
        a."UpdatedAtUtc", (count(*) OVER ())::int AS "Total", COALESCE(sum(a."Amount") OVER (), 0)::numeric(18,2) AS "TotalAmount"
      FROM "InvoicePaymentAttempts" a ${ATTEMPT_JOINS}
      WHERE a."BusinessId" = $1 AND ${SCOPE} AND a."Status" = 'NeedsReview'
      ORDER BY a."UpdatedAtUtc" DESC NULLS LAST, a."Id" LIMIT ${LIST_LIMIT + 1}`, scope),
    // Payment links that expired unpaid in the range. If the provider's message never arrived the customer may in fact have paid.
    pool.query(`
      SELECT a."Id", a."InvoiceId", i."Number" AS "InvoiceNumber", a."Amount", a."CurrencyCode", a."Reference", a."Source", a."CreatedAtUtc", a."ExpiresAtUtc",
        (count(*) OVER ())::int AS "Total", COALESCE(sum(a."Amount") OVER (), 0)::numeric(18,2) AS "TotalAmount"
      FROM "InvoicePaymentAttempts" a ${ATTEMPT_JOINS}
      WHERE a."BusinessId" = $1 AND ${SCOPE} AND a."Status" = 'Pending' AND a."ExpiresAtUtc" < now()
        AND a."CreatedAtUtc" >= $3::timestamptz AND a."CreatedAtUtc" < $4::timestamptz
      ORDER BY a."CreatedAtUtc" DESC, a."Id" LIMIT ${LIST_LIMIT + 1}`, [...scope, fromUtc, untilUtc]),
    // Payments staff recorded and nobody verified yet. Open items, whatever their date.
    pool.query(`
      SELECT p."Id", p."InvoiceId", i."Number" AS "InvoiceNumber", p."Amount", p."CurrencyCode", p."Method", p."Reference", p."ReceivedOn", p."CreatedAtUtc",
        (count(*) OVER ())::int AS "Total", COALESCE(sum(p."Amount") OVER (), 0)::numeric(18,2) AS "TotalAmount"
      FROM "Payments" p ${JOINS}
      WHERE p."BusinessId" = $1 AND ${SCOPE} AND p."Status" = 'Pending' AND p."CreatedAtUtc" < now() - ($3::int * interval '1 day')
      ORDER BY p."CreatedAtUtc", p."Id" LIMIT ${LIST_LIMIT + 1}`, [...scope, STALE_PENDING_DAYS]),
    pool.query(`
      SELECT p."Id", p."InvoiceId", i."Number" AS "InvoiceNumber", p."Amount", p."CurrencyCode", p."Method", p."Reference", p."VerifiedAtUtc",
        EXISTS (SELECT 1 FROM "InvoicePaymentAttempts" a WHERE a."BusinessId" = p."BusinessId" AND a."PaymentId" = p."Id") AS "Online",
        (count(*) OVER ())::int AS "Total", COALESCE(sum(p."Amount") OVER (), 0)::numeric(18,2) AS "TotalAmount"
      FROM "Payments" p ${JOINS}
      WHERE p."BusinessId" = $1 AND ${SCOPE} AND p."Status" = 'Verified' AND i."Status" = 'Void'
        AND p."VerifiedAtUtc" >= $3::timestamptz AND p."VerifiedAtUtc" < $4::timestamptz
      ORDER BY p."VerifiedAtUtc" DESC, p."Id" LIMIT ${LIST_LIMIT + 1}`, [...scope, fromUtc, untilUtc]),
    // Online payments (attempt marked Paid) whose payment no longer matches: reversed, not verified, a different amount, or missing.
    pool.query(`
      SELECT a."Id", a."InvoiceId", i."Number" AS "InvoiceNumber", a."Amount", a."CurrencyCode", a."Reference", a."PaymentId", p."Status" AS "PaymentStatus",
        p."Amount" AS "PaymentAmount", p."UpdatedAtUtc" AS "PaymentUpdatedAtUtc",
        CASE WHEN p."Id" IS NULL THEN 'payment_missing' WHEN p."Status" = 'Reversed' THEN 'reversed' WHEN p."Status" <> 'Verified' THEN 'not_verified'
             ELSE 'amount_differs' END AS "Kind",
        (count(*) OVER ())::int AS "Total", COALESCE(sum(a."Amount") OVER (), 0)::numeric(18,2) AS "TotalAmount"
      FROM "InvoicePaymentAttempts" a ${ATTEMPT_JOINS}
      LEFT JOIN "Payments" p ON p."BusinessId" = a."BusinessId" AND p."Id" = a."PaymentId"
      WHERE a."BusinessId" = $1 AND ${SCOPE} AND a."Status" = 'Paid'
        AND (p."Id" IS NULL OR p."Status" <> 'Verified' OR p."Amount" <> a."Amount")
        AND (p."Id" IS NULL OR p."Status" <> 'Reversed' OR (p."UpdatedAtUtc" >= $3::timestamptz AND p."UpdatedAtUtc" < $4::timestamptz))
      ORDER BY COALESCE(p."UpdatedAtUtc", a."UpdatedAtUtc") DESC NULLS LAST, a."Id" LIMIT ${LIST_LIMIT + 1}`, [...scope, fromUtc, untilUtc]),
    // Issued invoices with something still owed, as of today. Not limited to the range.
    pool.query(`
      SELECT count(*)::int AS "OpenCount", COALESCE(sum(x."Balance"), 0)::numeric(18,2) AS "OpenBalance",
        count(*) FILTER (WHERE x."DueDate" < $3::date)::int AS "OverdueCount",
        COALESCE(sum(x."Balance") FILTER (WHERE x."DueDate" < $3::date), 0)::numeric(18,2) AS "OverdueBalance"
      FROM (
        SELECT i."DueDate", i."Total"
          - COALESCE((SELECT sum(p."Amount") FROM "Payments" p WHERE p."BusinessId" = i."BusinessId" AND p."InvoiceId" = i."Id" AND p."Status" = 'Verified'), 0)
          - COALESCE((SELECT sum(cn."Amount") FROM "CreditNotes" cn WHERE cn."BusinessId" = i."BusinessId" AND cn."InvoiceId" = i."Id"), 0) AS "Balance"
        FROM "Invoices" i LEFT JOIN "Orders" o ON o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"
        WHERE i."BusinessId" = $1 AND ${SCOPE} AND i."Status" = 'Issued'
      ) x WHERE x."Balance" > 0`, [...scope, today]),
    pool.query(`
      SELECT pl."InvoiceId", i."Number" AS "InvoiceNumber"
      FROM "InvoiceInstallmentPlans" pl
      JOIN "Invoices" i ON i."BusinessId" = pl."BusinessId" AND i."Id" = pl."InvoiceId"
      LEFT JOIN "Orders" o ON o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"
      WHERE pl."BusinessId" = $1 AND ${SCOPE} AND pl."Status" = 'Active' AND i."Status" = 'Issued'
      ORDER BY pl."CreatedAtUtc", pl."Id" LIMIT ${PLAN_LIMIT + 1}`, scope),
  ]);

  const numbers = new Map(planIds.rows.slice(0, PLAN_LIMIT).map((row) => [row.InvoiceId, row.InvoiceNumber]));
  const plans = await loadActivePlans(pool, businessId, [...numbers.keys()], today);
  const totalOf = (result) => ({ count: result.rows[0]?.Total ?? 0, amount: result.rows[0]?.TotalAmount ?? 0 });
  const attempt = (row) => ({
    id: row.Id, invoiceId: row.InvoiceId, invoiceNumber: row.InvoiceNumber, amount: Number(row.Amount), currencyCode: row.CurrencyCode, reference: row.Reference,
  });

  const needsAttention = {
    needsReviewPayments: section(review.rows.map((row) => ({
      ...attempt(row), reason: row.FailureReason ?? null, source: row.Source, updatedAtUtc: iso(row.UpdatedAtUtc),
    })), totalOf(review)),
    staleLinks: section(stale.rows.map((row) => ({
      ...attempt(row), source: row.Source, createdAtUtc: iso(row.CreatedAtUtc), expiredAtUtc: iso(row.ExpiresAtUtc),
    })), totalOf(stale)),
    pendingVerification: {
      thresholdDays: STALE_PENDING_DAYS,
      ...section(pending.rows.map((row) => ({
        id: row.Id, invoiceId: row.InvoiceId, invoiceNumber: row.InvoiceNumber, amount: Number(row.Amount), currencyCode: row.CurrencyCode,
        method: row.Method, reference: row.Reference ?? null, receivedOn: iso(row.ReceivedOn)?.slice(0, 10), createdAtUtc: iso(row.CreatedAtUtc),
      })), totalOf(pending)),
    },
    paymentsOnVoidedInvoices: section(voided.rows.map((row) => ({
      id: row.Id, invoiceId: row.InvoiceId, invoiceNumber: row.InvoiceNumber, amount: Number(row.Amount), currencyCode: row.CurrencyCode,
      method: row.Method, online: Boolean(row.Online), reference: row.Reference ?? null, verifiedAtUtc: iso(row.VerifiedAtUtc),
    })), totalOf(voided)),
    onlineMismatches: section(mismatches.rows.map((row) => ({
      ...attempt(row), paymentId: row.PaymentId ?? null, paymentStatus: row.PaymentStatus ?? null,
      paymentAmount: row.PaymentAmount == null ? null : Number(row.PaymentAmount), kind: row.Kind, note: MISMATCH_LABELS[row.Kind],
    })), totalOf(mismatches)),
  };
  const open = invoices.rows[0] ?? {};
  return {
    from, to, asOf: today, currencyCode: business.rows[0].CurrencyCode,
    attentionCount: attentionCount(needsAttention),
    collected: summarizeCollected(collected.rows),
    needsAttention,
    invoices: {
      openCount: Number(open.OpenCount ?? 0), openBalance: Number(open.OpenBalance ?? 0),
      overdueCount: Number(open.OverdueCount ?? 0), overdueBalance: Number(open.OverdueBalance ?? 0),
      installmentsOverdue: summarizeOverdueInstallments([...plans.values()], numbers, { planCapReached: planIds.rows.length > PLAN_LIMIT }),
    },
  };
}
