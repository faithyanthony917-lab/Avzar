// Step 17c: retention for the message queues.
//   - Customer messages (CustomerMessageOutbox reminders and CustomerEventOutbox order and payment messages): finished rows
//     (Sent, Cancelled or Failed) are removed 180 days after their last change.
//   - EmailOutbox: finished rows (Sent or Failed) are removed 90 days after they were created. A sent email already lost its body
//     when it was sent; this removes the row itself (address, subject, provider ID).
// Never touched: Pending and Leased rows (still to be sent), platform audit logs, notifications (their own 90/180 day purge) and
// everything else. Each business is cleaned inside its own tenant context; EmailOutbox rows that belong to no business
// (password reset and verification mail) are cleaned in the platform scope that forEachBusiness adds.
import { forEachBusiness, sumResults } from '../db/forEachBusiness.js';
import { isRlsPool } from '../db/userScope.js';

export const CUSTOMER_MESSAGE_RETENTION_DAYS = 180;
export const EMAIL_OUTBOX_RETENTION_DAYS = 90;
export const RETENTION_BATCH = 5000;
const MAX_BATCHES_PER_TABLE = 10;
const DAY_MS = 86_400_000;

// Table, age column and finished statuses come from this constant list, never from request data.
const TARGETS = Object.freeze([
  { key: 'customerEvents', table: 'CustomerEventOutbox', ageColumn: 'UpdatedAtUtc', statuses: ['Sent', 'Cancelled', 'Failed'], days: CUSTOMER_MESSAGE_RETENTION_DAYS, customer: true },
  { key: 'customerReminders', table: 'CustomerMessageOutbox', ageColumn: 'UpdatedAtUtc', statuses: ['Sent', 'Cancelled', 'Failed'], days: CUSTOMER_MESSAGE_RETENTION_DAYS, customer: true },
  { key: 'emails', table: 'EmailOutbox', ageColumn: 'CreatedAtUtc', statuses: ['Sent', 'Failed'], days: EMAIL_OUTBOX_RETENTION_DAYS, customer: false },
]);

async function purgeTarget(db, target, now, batch) {
  const before = new Date(now.getTime() - target.days * DAY_MS);
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TABLE; i += 1) {
    const result = await db.query(
      `DELETE FROM "${target.table}" WHERE "Id" IN (
         SELECT "Id" FROM "${target.table}" WHERE "Status" = ANY($1::text[]) AND "${target.ageColumn}" < $2
         ORDER BY "${target.ageColumn}", "Id" LIMIT $3)`,
      [target.statuses, before, batch]);
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < batch) break;
  }
  return deleted;
}

/**
 * One pass for the scope the caller is already in: one business, the platform scope, or (a pool with no row-level security, as in
 * unit tests) everything. Returns how many rows were removed from each table.
 */
export async function purgeOldQueueRows(pool, { businessId = null, now = new Date(), batch = RETENTION_BATCH } = {}) {
  // The platform run has no tenant, so the customer tables show no rows there; skip them rather than ask.
  const platformRun = businessId === null && isRlsPool(pool);
  const result = { customerEvents: 0, customerReminders: 0, emails: 0 };
  for (const target of TARGETS) {
    if (platformRun && target.customer) continue;
    result[target.key] = await purgeTarget(pool, target, now, batch);
  }
  return result;
}

export async function runRetentionOnce(pool, { now = new Date(), batch = RETENTION_BATCH, log = console } = {}) {
  const results = await forEachBusiness(pool, (businessId) => purgeOldQueueRows(pool, { businessId, now, batch }), { platform: true, log });
  return sumResults(results);
}

export function startRetentionWorker({ pool, enabled = true, pollSeconds = 6 * 3600, startupDelayMs = 120_000, log = console, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!pool || !enabled) return async () => {};
  let stopped = false; let timer = null; let running = null;
  const cycle = async () => {
    if (stopped) return;
    running = runRetentionOnce(pool, { log });
    try {
      const result = await running;
      const total = (result.customerEvents ?? 0) + (result.customerReminders ?? 0) + (result.emails ?? 0);
      if (total) log.info?.('Retention pass removed finished queue rows.', result);
    } catch (error) { log.error?.('Retention pass failed.', { errorType: error?.constructor?.name ?? 'Error' }); }
    finally { running = null; }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, Math.max(60, pollSeconds) * 1000);
  };
  timer = schedule(() => { timer = null; void cycle(); }, Math.max(0, startupDelayMs));
  return async () => { stopped = true; if (timer !== null) cancel(timer); await running?.catch(() => {}); };
}
