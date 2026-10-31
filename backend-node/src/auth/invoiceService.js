import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { isInvoiceable } from './orderTransitions.js';
import { cancelPlansForVoidedInvoice } from './installmentService.js';
import {
  centsToNumber, hasAtMostPlaces, mulCents, mulMoney, percentOfCents, percentOfMoney, roundMoney,
  subtractMoney, sumMoney, toCents,
} from '../money.js';

const statuses = new Map([
  ['draft', 'Draft'],
  ['issued', 'Issued'],
  ['void', 'Void'],
]);

// Exact decimal rounding, half away from zero: see src/money.js. Never use floating-point arithmetic on money here.
const money = roundMoney;

function clean(value) {
  if (value == null) return null;
  const result = String(value).replaceAll('\0', '').trim();
  return result || null;
}

function dateOnly(value) {
  if (value == null) return null;
  const text = String(value);
  const parsed = new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== text.slice(0, 10)) {
    throw AppError.badRequest('invalid_date', 'Dates must be valid dates in YYYY-MM-DD format.');
  }
  return text.slice(0, 10);
}

function dtoDate(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function roundNumber(value) {
  return Number(value ?? 0);
}

function invoiceScope(user, allowed) {
  const params = [user.businessId];
  const conditions = ['i."BusinessId" = $1'];
  if (allowed !== null) {
    params.push(allowed);
    conditions.push(`i."OrderId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Orders" scoped_order
      WHERE scoped_order."BusinessId" = i."BusinessId" AND scoped_order."Id" = i."OrderId"
        AND scoped_order."LocationId" = ANY($${params.length}::uuid[])
    )`);
  }
  return { params, conditions };
}

function lineAmounts(input) {
  const description = input.description.trim();
  const { quantity, unitPrice, discount = 0, taxPercent = null } = input;
  const tax = taxPercent ?? 0;
  if (!description) throw AppError.badRequest('invalid_invoice_line', 'Every line needs a description.');
  if (quantity <= 0 || !hasAtMostPlaces(quantity, 2)) {
    throw AppError.badRequest('invalid_invoice_line', `'${description}': quantity must be above zero and have at most 2 decimal places.`);
  }
  if (unitPrice < 0 || discount < 0 || !hasAtMostPlaces(unitPrice, 2) || !hasAtMostPlaces(discount, 2)) {
    throw AppError.badRequest('invalid_invoice_line', `'${description}': prices and discounts must be non-negative and have at most 2 decimal places.`);
  }
  if (tax < 0 || tax > 100) throw AppError.badRequest('invalid_invoice_line', `'${description}': tax must be between 0% and 100%.`);
  const grossCents = mulCents(quantity, unitPrice);
  const discountCents = toCents(discount);
  if (discountCents > grossCents) throw AppError.badRequest('invalid_invoice_line', `'${description}': the discount is larger than the line.`);
  const netCents = grossCents - discountCents;
  const taxCents = percentOfCents(netCents, tax);
  return {
    description,
    quantity,
    unitPrice,
    discount,
    taxPercent: tax,
    netAmount: centsToNumber(netCents),
    taxAmount: centsToNumber(taxCents),
    lineTotal: centsToNumber(netCents + taxCents),
  };
}

async function recordAudit(db, user, action, entityId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc",
      "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'Invoice')`,
  [randomUUID(), action, user.userId, user.businessId,
    details === null ? null : JSON.stringify(details), entityId]);
}

async function business(pool, businessId) {
  const { rows } = await pool.query(`
    SELECT "CurrencyCode", "TimeZoneId" FROM "Businesses" WHERE "Id" = $1`,
  [businessId]);
  if (!rows.length) throw AppError.notFound('business_not_found', 'Business not found.');
  return rows[0];
}

async function businessTax(pool, businessId) {
  const { rows } = await pool.query(`
    SELECT "TaxPercent" FROM "PricingProfiles" WHERE "BusinessId" = $1 LIMIT 1`,
  [businessId]);
  return roundNumber(rows[0]?.TaxPercent);
}

function referenceNow() {
  if (process.env.NODE_ENV === 'test' && process.env.AVZAR_NOW) return new Date(process.env.AVZAR_NOW);
  return new Date();
}

function todayInZone(timeZoneId) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZoneId, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(referenceNow()).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch (error) {
    if (error instanceof RangeError) return referenceNow().toISOString().slice(0, 10);
    throw error;
  }
}

async function invoiceRow(pool, user, id, allowed, { lock = false } = {}) {
  const { params, conditions } = invoiceScope(user, allowed);
  params.push(id);
  conditions.push(`i."Id" = $${params.length}`);
  const { rows } = await pool.query(`
    SELECT i.*, i.xmin::text::bigint AS "Version",
      c."FullName" AS "CustomerName", o."OrderNumber" AS "OrderNumber",
      COALESCE((SELECT sum(p."Amount") FROM "Payments" p
        WHERE p."BusinessId" = i."BusinessId" AND p."InvoiceId" = i."Id" AND p."Status" = 'Verified'), 0) AS "AmountPaid",
      COALESCE((SELECT sum(p."Amount") FROM "Payments" p
        WHERE p."BusinessId" = i."BusinessId" AND p."InvoiceId" = i."Id" AND p."Status" = 'Pending'), 0) AS "AmountPending",
      COALESCE((SELECT sum(cn."Amount") FROM "CreditNotes" cn
        WHERE cn."BusinessId" = i."BusinessId" AND cn."InvoiceId" = i."Id"), 0) AS "AmountCredited"
    FROM "Invoices" i
    LEFT JOIN "Customers" c ON c."BusinessId" = i."BusinessId" AND c."Id" = i."CustomerId"
    LEFT JOIN "Orders" o ON o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"
    WHERE ${conditions.join(' AND ')}${lock ? ' FOR UPDATE OF i' : ''}`,
  params);
  if (!rows.length) throw AppError.notFound('invoice_not_found', 'Invoice not found.');
  return rows[0];
}

function derived(invoice, today) {
  if (invoice.Status === 'Void') return { balance: 0, paymentStatus: null, isOverdue: false };
  if (invoice.Status === 'Draft') return { balance: roundNumber(invoice.Total), paymentStatus: null, isOverdue: false };
  const balance = subtractMoney(invoice.Total, invoice.AmountPaid, invoice.AmountCredited);
  const paymentStatus = balance <= 0
    ? (roundNumber(invoice.AmountPaid) > 0 ? 'Paid' : 'Credited')
    : (roundNumber(invoice.AmountPaid) > 0 ? 'PartPaid' : 'Unpaid');
  return {
    balance,
    paymentStatus,
    isOverdue: balance > 0 && invoice.DueDate != null && dtoDate(invoice.DueDate) < today,
  };
}

function lineDto(row) {
  return {
    id: row.Id,
    lineNumber: row.LineNumber,
    description: row.Description,
    quantity: roundNumber(row.Quantity),
    unitPrice: roundNumber(row.UnitPrice),
    discount: roundNumber(row.Discount),
    taxPercent: roundNumber(row.TaxPercent),
    netAmount: roundNumber(row.NetAmount),
    taxAmount: roundNumber(row.TaxAmount),
    lineTotal: roundNumber(row.LineTotal),
  };
}

function paymentDto(row) {
  return {
    id: row.Id,
    invoiceId: row.InvoiceId,
    invoiceNumber: row.InvoiceNumber,
    customerId: row.CustomerId,
    amount: roundNumber(row.Amount),
    currencyCode: row.CurrencyCode,
    method: row.Method,
    reference: row.Reference,
    receivedOn: dtoDate(row.ReceivedOn),
    status: row.Status,
    notes: row.Notes,
    statusReason: row.StatusReason,
    recordedByUserId: row.RecordedByUserId,
    verifiedByUserId: row.VerifiedByUserId,
    verifiedAtUtc: row.VerifiedAtUtc,
    receiptId: row.ReceiptId,
    receiptNumber: row.ReceiptNumber,
    version: Number(row.Version),
    createdAtUtc: new Date(row.CreatedAtUtc).toISOString(),
  };
}

async function invoiceDto(pool, user, row, allowed) {
  const [todayBusiness, lineResult, paymentResult, creditResult] = await Promise.all([
    business(pool, user.businessId),
    pool.query(`
      SELECT * FROM "InvoiceLines" WHERE "BusinessId" = $1 AND "InvoiceId" = $2
      ORDER BY "LineNumber"`,
    [user.businessId, row.Id]),
    pool.query(`
      SELECT p.*, i."Number" AS "InvoiceNumber", r."Id" AS "ReceiptId", r."Number" AS "ReceiptNumber",
        p.xmin::text::bigint AS "Version"
      FROM "Payments" p
      JOIN "Invoices" i ON i."BusinessId" = p."BusinessId" AND i."Id" = p."InvoiceId"
      LEFT JOIN "Receipts" r ON r."BusinessId" = p."BusinessId" AND r."PaymentId" = p."Id"
      WHERE p."BusinessId" = $1 AND p."InvoiceId" = $2
      ORDER BY p."CreatedAtUtc"`,
    [user.businessId, row.Id]),
    pool.query(`
      SELECT "Id", "Number", "Amount", "Reason", "CreatedAtUtc"
      FROM "CreditNotes" WHERE "BusinessId" = $1 AND "InvoiceId" = $2
      ORDER BY "CreatedAtUtc"`,
    [user.businessId, row.Id]),
  ]);
  const derivedAmounts = derived(row, todayInZone(todayBusiness.TimeZoneId));
  return {
    id: row.Id,
    number: row.Number,
    kind: row.Kind,
    status: row.Status,
    customerId: row.CustomerId,
    customerName: row.CustomerName ?? '',
    orderId: row.OrderId,
    orderNumber: row.OrderNumber,
    currencyCode: row.CurrencyCode,
    issueDate: dtoDate(row.IssueDate),
    dueDate: dtoDate(row.DueDate),
    notes: row.Notes,
    terms: row.Terms,
    subtotal: roundNumber(row.Subtotal),
    taxTotal: roundNumber(row.TaxTotal),
    total: roundNumber(row.Total),
    amountPaid: roundNumber(row.AmountPaid),
    amountPending: roundNumber(row.AmountPending),
    amountCredited: roundNumber(row.AmountCredited),
    ...derivedAmounts,
    voidReason: row.VoidReason,
    version: Number(row.Version),
    createdAtUtc: new Date(row.CreatedAtUtc).toISOString(),
    issuedAtUtc: row.IssuedAtUtc,
    lines: lineResult.rows.map(lineDto),
    payments: paymentResult.rows.map(paymentDto),
    creditNotes: creditResult.rows.map((note) => ({
      id: note.Id, number: note.Number, amount: roundNumber(note.Amount),
      reason: note.Reason, createdAtUtc: new Date(note.CreatedAtUtc).toISOString(),
    })),
  };
}

function normalizedLines(inputs, defaultTax) {
  return inputs.map((input) => lineAmounts({ ...input, taxPercent: input.taxPercent ?? defaultTax }));
}

async function insertLines(db, businessId, invoiceId, lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await db.query(`
      INSERT INTO "InvoiceLines" ("Id", "BusinessId", "CreatedAtUtc", "Description", "Discount",
        "InvoiceId", "LineNumber", "LineTotal", "NetAmount", "Quantity", "TaxAmount", "TaxPercent", "UnitPrice")
      VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [randomUUID(), businessId, line.description, line.discount, invoiceId, index + 1, line.lineTotal,
      line.netAmount, line.quantity, line.taxAmount, line.taxPercent, line.unitPrice]);
  }
}

function totals(lines) {
  return {
    subtotal: sumMoney(lines.map((line) => line.netAmount)),
    taxTotal: sumMoney(lines.map((line) => line.taxAmount)),
    total: sumMoney(lines.map((line) => line.lineTotal)),
  };
}

function allocateDiscount(grossValues, discountValue) {
  const grossCents = grossValues.map((value) => toCents(value));
  const discountCents = toCents(discountValue);
  const totalCents = grossCents.reduce((sum, value) => sum + value, 0n);
  if (discountCents <= 0n || totalCents <= 0n) return grossCents.map(() => 0);
  if (discountCents > totalCents) throw AppError.conflict('order_total_mismatch', 'The order discount exceeds its line totals.');
  const shares = grossCents.map((gross, index) => {
    const numerator = gross * discountCents;
    return { index, cents: numerator / totalCents, remainder: numerator % totalCents };
  });
  let remaining = discountCents - shares.reduce((sum, share) => sum + share.cents, 0n);
  shares.sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (let index = 0; remaining > 0n; index += 1, remaining -= 1n) shares[index].cents += 1n;
  shares.sort((left, right) => left.index - right.index);
  return shares.map(({ cents }) => Number(cents) / 100);
}

function normalizeKey(value) {
  const key = clean(value);
  if (key?.length > 100) throw AppError.badRequest('invalid_idempotency_key', 'Idempotency key is too long.');
  return key;
}

async function requireInvoiceFeature(db, businessId, key) {
  const { rows } = await db.query(`
    SELECT COALESCE(override."Value", pe."Value", 'false') AS "Value"
    FROM "Plans" p
    LEFT JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id" AND pe."Key" = $2
    LEFT JOIN LATERAL (
      SELECT o."Value" FROM "EntitlementOverrides" o
      WHERE o."BusinessId" = $1 AND o."Key" = $2
        AND (o."ExpiresAtUtc" IS NULL OR o."ExpiresAtUtc" > now())
      ORDER BY o."CreatedAtUtc" DESC LIMIT 1
    ) override ON TRUE
    WHERE p."Id" = COALESCE(
      (SELECT s."PlanId" FROM "Subscriptions" s
        WHERE s."BusinessId" = $1 AND s."Status" <> 'Expired' LIMIT 1),
      (SELECT free."Id" FROM "Plans" free WHERE free."Code" = 'free' LIMIT 1)
    )`,
  [businessId, key]);
  if (!rows.length) throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');
  if (String(rows[0].Value ?? '').trim() !== 'true') {
    throw AppError.forbidden('feature_not_in_plan', 'This feature is not included in your current plan.');
  }
}

async function loadByKey(pool, user, key) {
  const { rows } = await pool.query(`
    SELECT i.*, i.xmin::text::bigint AS "Version", c."FullName" AS "CustomerName", o."OrderNumber" AS "OrderNumber",
      COALESCE((SELECT sum(p."Amount") FROM "Payments" p WHERE p."BusinessId" = i."BusinessId"
        AND p."InvoiceId" = i."Id" AND p."Status" = 'Verified'), 0) AS "AmountPaid",
      COALESCE((SELECT sum(p."Amount") FROM "Payments" p WHERE p."BusinessId" = i."BusinessId"
        AND p."InvoiceId" = i."Id" AND p."Status" = 'Pending'), 0) AS "AmountPending",
      COALESCE((SELECT sum(cn."Amount") FROM "CreditNotes" cn WHERE cn."BusinessId" = i."BusinessId"
        AND cn."InvoiceId" = i."Id"), 0) AS "AmountCredited"
    FROM "Invoices" i
    LEFT JOIN "Customers" c ON c."BusinessId" = i."BusinessId" AND c."Id" = i."CustomerId"
    LEFT JOIN "Orders" o ON o."BusinessId" = i."BusinessId" AND o."Id" = i."OrderId"
    WHERE i."BusinessId" = $1 AND i."IdempotencyKey" = $2`,
  [user.businessId, key]);
  return rows[0] ?? null;
}

export async function listInvoices(pool, user, query, allowed) {
  const { params, conditions } = invoiceScope(user, allowed);
  if (query.status) {
    const status = statuses.get(query.status.toLowerCase());
    if (!status) throw AppError.badRequest('invalid_status', 'Status must be Draft, Issued or Void.');
    params.push(status);
    conditions.push(`i."Status" = $${params.length}`);
  }
  for (const [field, column] of [['customerId', 'CustomerId'], ['orderId', 'OrderId']]) {
    if (query[field]) {
      params.push(query[field]);
      conditions.push(`i."${column}" = $${params.length}`);
    }
  }
  if (query.from) {
    params.push(query.from);
    conditions.push(`i."IssueDate" >= $${params.length}::date`);
  }
  if (query.to) {
    params.push(query.to);
    conditions.push(`i."IssueDate" <= $${params.length}::date`);
  }
  if (query.search) {
    params.push(`%${query.search.replace(/[\\%_]/g, '\\$&')}%`);
    conditions.push(`(i."Number" ILIKE $${params.length} ESCAPE E'\\\\' OR c."FullName" ILIKE $${params.length} ESCAPE E'\\\\')`);
  }
  const todayBusiness = await business(pool, user.businessId);
  const today = todayInZone(todayBusiness.TimeZoneId);
  if (query.outstanding === true) {
    conditions.push(`i."Status" = 'Issued' AND i."Total" - COALESCE((
      SELECT sum(p."Amount") FROM "Payments" p WHERE p."BusinessId" = i."BusinessId"
        AND p."InvoiceId" = i."Id" AND p."Status" = 'Verified'), 0) - COALESCE((
      SELECT sum(cn."Amount") FROM "CreditNotes" cn WHERE cn."BusinessId" = i."BusinessId"
        AND cn."InvoiceId" = i."Id"), 0) > 0`);
  }
  if (query.overdue === true) {
    params.push(today);
    conditions.push(`i."Status" = 'Issued' AND i."DueDate" < $${params.length}::date AND i."Total" - COALESCE((
      SELECT sum(p."Amount") FROM "Payments" p WHERE p."BusinessId" = i."BusinessId"
        AND p."InvoiceId" = i."Id" AND p."Status" = 'Verified'), 0) - COALESCE((
      SELECT sum(cn."Amount") FROM "CreditNotes" cn WHERE cn."BusinessId" = i."BusinessId"
        AND cn."InvoiceId" = i."Id"), 0) > 0`);
  }
  const where = conditions.join(' AND ');
  const count = await pool.query(`
    SELECT count(*)::int AS "TotalCount"
    FROM "Invoices" i LEFT JOIN "Customers" c ON c."BusinessId" = i."BusinessId" AND c."Id" = i."CustomerId"
    WHERE ${where}`,
  params);
  const { rows } = await pool.query(`
    SELECT i.*, i.xmin::text::bigint AS "Version", c."FullName" AS "CustomerName",
      COALESCE((SELECT sum(p."Amount") FROM "Payments" p WHERE p."BusinessId" = i."BusinessId"
        AND p."InvoiceId" = i."Id" AND p."Status" = 'Verified'), 0) AS "AmountPaid",
      COALESCE((SELECT sum(cn."Amount") FROM "CreditNotes" cn WHERE cn."BusinessId" = i."BusinessId"
        AND cn."InvoiceId" = i."Id"), 0) AS "AmountCredited"
    FROM "Invoices" i LEFT JOIN "Customers" c ON c."BusinessId" = i."BusinessId" AND c."Id" = i."CustomerId"
    WHERE ${where}
    ORDER BY COALESCE(i."IssuedAtUtc", i."CreatedAtUtc") DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
  [...params, query.pageSize, (query.page - 1) * query.pageSize]);
  const items = rows.map((row) => ({
    id: row.Id,
    number: row.Number,
    kind: row.Kind,
    status: row.Status,
    customerId: row.CustomerId,
    customerName: row.CustomerName ?? '',
    orderId: row.OrderId,
    currencyCode: row.CurrencyCode,
    total: roundNumber(row.Total),
    amountPaid: roundNumber(row.AmountPaid),
    amountCredited: roundNumber(row.AmountCredited),
    ...derived(row, today),
    issueDate: dtoDate(row.IssueDate),
    dueDate: dtoDate(row.DueDate),
  }));
  return { items, page: query.page, pageSize: query.pageSize, totalCount: Number(count.rows[0]?.TotalCount ?? 0) };
}

export async function getInvoice(pool, user, id, allowed) {
  const row = await invoiceRow(pool, user, id, allowed);
  return invoiceDto(pool, user, row, allowed);
}

export async function createInvoice(pool, transaction, user, payload, idempotencyKey, allowed) {
  const key = normalizeKey(idempotencyKey);
  if (key) {
    const existing = await loadByKey(pool, user, key);
    if (existing) {
      const visible = await invoiceRow(pool, user, existing.Id, allowed);
      return { invoice: await invoiceDto(pool, user, visible, allowed), created: false };
    }
  }
  if (allowed !== null) {
    throw AppError.forbidden('location_forbidden',
      'An invoice that is not billed from an order has no location, so only staff with access to every location can create it.');
  }
  const [{ rows: customers }, businessInfo] = await Promise.all([
    pool.query('SELECT 1 FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, payload.customerId]),
    business(pool, user.businessId),
  ]);
  if (!customers.length) throw AppError.badRequest('unknown_customer', 'Customer not found.');
  const defaultTax = payload.taxPercent ?? await businessTax(pool, user.businessId);
  const lines = normalizedLines(payload.lines, defaultTax);
  const amounts = totals(lines);
  const id = randomUUID();
  const dueDate = dateOnly(payload.dueDate);
  try {
    return await transaction(pool, async (db) => {
      const { rows } = await db.query(`
        INSERT INTO "Invoices" ("Id", "BusinessId", "CreatedAtUtc", "CreatedByUserId", "CurrencyCode",
          "CustomerId", "DueDate", "IdempotencyKey", "Kind", "Notes", "Status", "Subtotal", "TaxTotal", "Terms", "Total")
        VALUES ($1, $2, now(), $3, $4, $5, $6::date, $7, 'Standard', $8, 'Draft', $9, $10, $11, $12)
        RETURNING *, xmin::text::bigint AS "Version"`,
      [id, user.businessId, user.userId, businessInfo.CurrencyCode, payload.customerId, dueDate, key,
        clean(payload.notes), amounts.subtotal, amounts.taxTotal, clean(payload.terms), amounts.total]);
      await insertLines(db, user.businessId, id, lines);
      await recordAudit(db, user, 'invoice.created', id, { subtotal: amounts.subtotal });
      const invoice = await invoiceRow(db, user, id, null);
      return { invoice: await invoiceDto(db, user, invoice, null), created: true };
    });
  } catch (error) {
    if (key && error.code === '23505') {
      const winner = await loadByKey(pool, user, key);
      if (!winner) throw error;
      const visible = await invoiceRow(pool, user, winner.Id, allowed);
      return { invoice: await invoiceDto(pool, user, visible, allowed), created: false };
    }
    throw error;
  }
}

export async function createInvoiceFromOrder(pool, transaction, user, orderId, payload, idempotencyKey, allowed) {
  const key = normalizeKey(idempotencyKey);
  if (key) {
    const existing = await loadByKey(pool, user, key);
    if (existing) {
      const visible = await invoiceRow(pool, user, existing.Id, allowed);
      return { invoice: await invoiceDto(pool, user, visible, allowed), created: false };
    }
  }
  const modes = new Map([['full', 'Standard'], ['deposit', 'Deposit'], ['balance', 'Balance']]);
  const kind = modes.get(String(payload.mode ?? '').trim().toLowerCase());
  if (!kind) throw AppError.badRequest('invalid_mode', 'Mode must be Full, Deposit or Balance.');
  if (kind !== 'Standard') await requireInvoiceFeature(pool, user.businessId, 'finance.partial_payments');
  if (kind === 'Deposit' && (payload.depositPercent == null) === (payload.depositAmount == null)) {
    throw AppError.badRequest('deposit_amount_required', 'Give either DepositPercent or DepositAmount for a deposit invoice.');
  }
  const defaultTax = payload.taxPercent ?? await businessTax(pool, user.businessId);
  try {
    return await transaction(pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`order-invoicing:${orderId.replaceAll('-', '')}`]);
      const { rows: orders } = await db.query(`
        SELECT "Id", "CustomerId", "OrderNumber", "CurrencyCode", "Status", "Total", "Discount", "LocationId"
        FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2
          AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[]))`,
      [user.businessId, orderId, allowed]);
      if (!orders.length) throw AppError.notFound('order_not_found', 'Order not found.');
      const order = orders[0];
      if (!isInvoiceable(order.Status)) {
        throw AppError.conflict('order_not_billable',
          `Only confirmed orders can be invoiced (this one is ${order.Status}). Quotes can still change, so they are not billed.`);
      }
      const { rows: billedRows } = await db.query(`
        SELECT COALESCE(sum("Subtotal"), 0) AS "Billed"
        FROM "Invoices" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" <> 'Void'`,
      [user.businessId, orderId]);
      const billed = roundNumber(billedRows[0]?.Billed);
      const remaining = subtractMoney(order.Total, billed);
      let lines;
      if (kind === 'Standard') {
        if (billed > 0) throw AppError.conflict('already_invoiced', 'This order already has invoices. Use Mode=Balance to bill what is left.');
        if (roundNumber(order.Total) <= 0) throw AppError.conflict('nothing_to_invoice', 'This order has nothing to bill.');
        const { rows: garments } = await db.query(`
          SELECT "LineNumber", "Name", "Quantity", "UnitPrice"
          FROM "OrderGarments" WHERE "BusinessId" = $1 AND "OrderId" = $2
          ORDER BY "LineNumber"`,
        [user.businessId, orderId]);
        const gross = garments.map((garment) => mulMoney(garment.Quantity, garment.UnitPrice));
        const discounts = allocateDiscount(gross, roundNumber(order.Discount));
        lines = garments.map((garment, index) => ({
          description: garment.Name,
          quantity: roundNumber(garment.Quantity),
          unitPrice: roundNumber(garment.UnitPrice),
          discount: discounts[index],
        }));
      } else if (kind === 'Deposit') {
        if (remaining <= 0) throw AppError.conflict('nothing_to_invoice', 'The whole order has already been invoiced.');
        const amount = payload.depositAmount ?? percentOfMoney(order.Total, payload.depositPercent);
        if (amount <= 0 || !hasAtMostPlaces(amount, 2) || amount > remaining) {
          throw AppError.badRequest('deposit_out_of_range', `The deposit must be above zero and at most the part not yet billed (${remaining}).`);
        }
        lines = [{ description: `Deposit for order ${order.OrderNumber}`, quantity: 1, unitPrice: amount }];
      } else {
        if (billed <= 0) throw AppError.conflict('nothing_billed_yet', 'Nothing has been invoiced for this order yet. Use Mode=Full or Deposit first.');
        if (remaining <= 0) throw AppError.conflict('nothing_to_invoice', 'The whole order has already been invoiced.');
        lines = [{ description: `Balance for order ${order.OrderNumber}`, quantity: 1, unitPrice: remaining }];
      }

      const normalized = normalizedLines(lines, defaultTax);
      const amounts = totals(normalized);
      const lineSubtotal = kind === 'Standard'
        ? sumMoney(normalized.map((line) => line.netAmount))
        : sumMoney(lines.map((line) => line.unitPrice));
      if (amounts.subtotal !== lineSubtotal || lineSubtotal !== (kind === 'Standard' ? roundNumber(order.Total) : lineSubtotal)) {
        throw AppError.conflict('order_total_mismatch', "The order's line totals do not add up to its total. Open and re-save the order, then try again.");
      }
      const id = randomUUID();
      const dueDate = dateOnly(payload.dueDate);
      await db.query(`
        INSERT INTO "Invoices" ("Id", "BusinessId", "CreatedAtUtc", "CreatedByUserId", "CurrencyCode",
          "CustomerId", "DueDate", "IdempotencyKey", "Kind", "Notes", "OrderId", "Status", "Subtotal", "TaxTotal", "Terms", "Total")
        VALUES ($1, $2, now(), $3, $4, $5, $6::date, $7, $8, $9, $10, 'Draft', $11, $12, $13, $14)`,
      [id, user.businessId, user.userId, order.CurrencyCode, order.CustomerId, dueDate, key, kind,
        clean(payload.notes), orderId, amounts.subtotal, amounts.taxTotal, clean(payload.terms), amounts.total]);
      await insertLines(db, user.businessId, id, normalized);
      await recordAudit(db, user, 'invoice.created', id, {
        order: order.OrderNumber, kind, subtotal: amounts.subtotal,
      });
      const created = await invoiceRow(db, user, id, allowed);
      return { invoice: await invoiceDto(db, user, created, allowed), created: true };
    });
  } catch (error) {
    if (key && error.code === '23505') {
      const winner = await loadByKey(pool, user, key);
      if (!winner) throw error;
      const visible = await invoiceRow(pool, user, winner.Id, allowed);
      return { invoice: await invoiceDto(pool, user, visible, allowed), created: false };
    }
    throw error;
  }
}

export async function updateDraftInvoice(pool, transaction, user, id, payload, allowed) {
  const requestVersion = payload.version;
  if (requestVersion === undefined) throw AppError.badRequest('version_required', 'Include the invoice current version when updating.');
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${id}`]);
    const current = await invoiceRow(db, user, id, allowed, { lock: true });
    if (current.Status !== 'Draft') {
      throw AppError.conflict('invoice_not_draft', 'Issued invoices cannot be edited. Void it and create a new one, or add a credit note.');
    }
    if (Number(current.Version) !== requestVersion) {
      throw AppError.conflict('stale_version', 'This invoice was changed by someone else. Reload and try again.');
    }
    if (payload.lines !== undefined && current.OrderId !== null) {
      throw AppError.badRequest('order_invoice_lines_locked', 'Lines of an invoice billed from an order cannot be edited. Delete the draft and create it again.');
    }
    const lines = payload.lines === undefined ? null : normalizedLines(payload.lines, payload.taxPercent ?? await businessTax(db, user.businessId));
    const amounts = lines === null ? null : totals(lines);
    const { rows } = await db.query(`
      UPDATE "Invoices" SET "DueDate" = $1::date, "Notes" = $2, "Terms" = $3,
        "Subtotal" = COALESCE($4, "Subtotal"), "TaxTotal" = COALESCE($5, "TaxTotal"),
        "Total" = COALESCE($6, "Total"), "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $7 AND "Id" = $8 AND xmin::text::bigint = $9 AND "Status" = 'Draft'
      RETURNING *, xmin::text::bigint AS "Version"`,
    [dateOnly(payload.dueDate), clean(payload.notes), clean(payload.terms),
      amounts?.subtotal ?? null, amounts?.taxTotal ?? null, amounts?.total ?? null,
      user.businessId, id, requestVersion]);
    if (!rows.length) throw AppError.conflict('stale_version', 'This invoice was changed by someone else. Reload and try again.');
    if (lines !== null) {
      await db.query('DELETE FROM "InvoiceLines" WHERE "BusinessId" = $1 AND "InvoiceId" = $2', [user.businessId, id]);
      await insertLines(db, user.businessId, id, lines);
    }
    await recordAudit(db, user, 'invoice.updated', id);
    const updated = await invoiceRow(db, user, id, allowed);
    return invoiceDto(db, user, updated, allowed);
  });
}

export async function deleteDraftInvoice(pool, transaction, user, id, allowed) {
  await transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${id}`]);
    const current = await invoiceRow(db, user, id, allowed, { lock: true });
    if (current.Status !== 'Draft') {
      throw AppError.conflict('invoice_not_draft', 'Issued invoices cannot be deleted. Void it instead.');
    }
    await recordAudit(db, user, 'invoice.draft_deleted', id, { total: roundNumber(current.Total) });
    await db.query('DELETE FROM "InvoiceLines" WHERE "BusinessId" = $1 AND "InvoiceId" = $2', [user.businessId, id]);
    await db.query('DELETE FROM "Invoices" WHERE "BusinessId" = $1 AND "Id" = $2', [user.businessId, id]);
  });
}

export async function issueDraftInvoice(pool, transaction, user, id, allowed) {
  const businessInfo = await business(pool, user.businessId);
  const today = todayInZone(businessInfo.TimeZoneId);
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${id}`]);
    const current = await invoiceRow(db, user, id, allowed, { lock: true });
    if (current.Status !== 'Draft') {
      throw AppError.conflict('invoice_not_draft', 'Issued invoices cannot be edited. Void it and create a new one, or add a credit note.');
    }
    if (roundNumber(current.Total) <= 0) throw AppError.badRequest('nothing_to_issue', 'An invoice needs a total above zero.');
    if (current.OrderId) {
      const { rows: orders } = await db.query(`
        SELECT "Status" FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2`,
      [user.businessId, current.OrderId]);
      const status = orders[0]?.Status;
      if (['Cancelled', 'Draft', 'Quoted'].includes(status)) {
        throw AppError.conflict('order_not_billable', `The order is ${status}, so this invoice cannot be issued.`);
      }
    }
    const issueDate = today;
    const dueDate = current.DueDate ? dtoDate(current.DueDate) : (() => {
      const date = new Date(`${today}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + 14);
      return date.toISOString().slice(0, 10);
    })();
    if (dueDate < issueDate) throw AppError.badRequest('due_date_before_issue', 'The due date is before today.');
    const year = Number(issueDate.slice(0, 4));
    const { rows: counter } = await db.query(`
      INSERT INTO "DocumentCounters" ("BusinessId", "Kind", "Year", "LastValue")
      VALUES ($1, 'invoice', $2, 1)
      ON CONFLICT ("BusinessId", "Kind", "Year")
      DO UPDATE SET "LastValue" = "DocumentCounters"."LastValue" + 1
      RETURNING "LastValue"`,
    [user.businessId, year]);
    const number = `INV-${year}-${String(counter[0].LastValue).padStart(5, '0')}`;
    const { rows } = await db.query(`
      UPDATE "Invoices" SET "Number" = $1, "Status" = 'Issued', "IssueDate" = $2::date,
        "DueDate" = $3::date, "IssuedAtUtc" = now(), "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $4 AND "Id" = $5 AND xmin::text::bigint = $6 AND "Status" = 'Draft'
      RETURNING *, xmin::text::bigint AS "Version"`,
    [number, issueDate, dueDate, user.businessId, id, current.Version]);
    if (!rows.length) throw AppError.conflict('stale_version', 'This invoice was changed by someone else. Reload and try again.');
    await recordAudit(db, user, 'invoice.issued', id, { number, total: roundNumber(current.Total) });
    const issued = await invoiceRow(db, user, id, allowed);
    return invoiceDto(db, user, issued, allowed);
  });
}

export async function voidInvoice(pool, transaction, user, id, reason, allowed) {
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${id}`]);
    const current = await invoiceRow(db, user, id, allowed, { lock: true });
    if (current.Status === 'Draft') {
      throw AppError.conflict('invoice_is_draft', 'A draft was never issued. Delete it instead.');
    }
    if (current.Status === 'Void') {
      throw AppError.conflict('invoice_already_void', 'This invoice is already void.');
    }
    const { rows: payments } = await db.query(`
      SELECT 1 FROM "Payments" WHERE "BusinessId" = $1 AND "InvoiceId" = $2
        AND "Status" IN ('Pending', 'Verified') LIMIT 1`,
    [user.businessId, id]);
    if (payments.length) {
      throw AppError.conflict('invoice_has_payments', 'This invoice has payments. Reject the pending ones and reverse the verified ones first.');
    }
    const { rows: creditNotes } = await db.query(`
      SELECT 1 FROM "CreditNotes" WHERE "BusinessId" = $1 AND "InvoiceId" = $2 LIMIT 1`,
    [user.businessId, id]);
    if (creditNotes.length) {
      throw AppError.conflict('invoice_has_credit_notes', 'This invoice has credit notes, so it cannot be voided.');
    }
    const { rows } = await db.query(`
      UPDATE "Invoices" SET "Status" = 'Void', "VoidedAtUtc" = now(), "VoidReason" = $1, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $2 AND "Id" = $3 AND xmin::text::bigint = $4 AND "Status" = 'Issued'
      RETURNING "Id"`,
    [reason.trim(), user.businessId, id, current.Version]);
    if (!rows.length) throw AppError.conflict('stale_version', 'This invoice was changed by someone else. Reload and try again.');
    await recordAudit(db, user, 'invoice.voided', id, { number: current.Number, reason: reason.trim() });
    await cancelPlansForVoidedInvoice(db, user, id);
    const updated = await invoiceRow(db, user, id, allowed);
    return invoiceDto(db, user, updated, allowed);
  });
}

export async function addInvoiceCreditNote(pool, transaction, user, id, payload, allowed) {
  await requireInvoiceFeature(pool, user.businessId, 'finance.partial_payments');
  const { TimeZoneId } = await business(pool, user.businessId);
  const year = Number(todayInZone(TimeZoneId).slice(0, 4));
  if (!hasAtMostPlaces(payload.amount, 2)) {
    throw AppError.badRequest('invalid_amount', 'Amounts can have at most 2 decimal places.');
  }
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${id}`]);
    const current = await invoiceRow(db, user, id, allowed, { lock: true });
    if (current.Status !== 'Issued') {
      throw AppError.conflict('invoice_not_issued', 'Credit notes apply to issued invoices only.');
    }
    const balance = subtractMoney(current.Total, current.AmountPaid, current.AmountCredited);
    if (payload.amount > balance) {
      throw AppError.conflict('credit_exceeds_balance',
        `The credit (${payload.amount}) is more than the unpaid balance (${balance}). If the customer already paid, reverse that payment (a refund) first.`);
    }
    const { rows: counter } = await db.query(`
      INSERT INTO "DocumentCounters" ("BusinessId", "Kind", "Year", "LastValue")
      VALUES ($1, 'credit_note', $2, 1)
      ON CONFLICT ("BusinessId", "Kind", "Year")
      DO UPDATE SET "LastValue" = "DocumentCounters"."LastValue" + 1
      RETURNING "LastValue"`,
    [user.businessId, year]);
    const number = `CN-${year}-${String(counter[0].LastValue).padStart(5, '0')}`;
    const creditId = randomUUID();
    await db.query(`
      INSERT INTO "CreditNotes" ("Id", "BusinessId", "CreatedAtUtc", "CreatedByUserId", "InvoiceId", "Number", "Amount", "Reason")
      VALUES ($1, $2, now(), $3, $4, $5, $6, $7)`,
    [creditId, user.businessId, user.userId, id, number, payload.amount, payload.reason.trim()]);
    await recordAudit(db, user, 'invoice.credit_note', id, { number, amount: payload.amount, reason: payload.reason.trim() });
    const updated = await invoiceRow(db, user, id, allowed);
    return invoiceDto(db, user, updated, allowed);
  });
}

// Exposed so the money fixtures can exercise the pure money rules without a database.
export { lineAmounts as computeInvoiceLine, totals as computeInvoiceTotals, allocateDiscount as allocateInvoiceDiscount };
