import { describeErrorShape } from '../http/errors.js';
import { isRlsPool } from './userScope.js';
import { runWithTenantPlatformScope, runWithTenantRlsContext, setTenantRlsContext } from './tenantRlsContext.js';

// Background workers have no signed token, so they start with no tenant. Under row-level security (migrations 0032 and 0033) a query
// with no tenant sees nothing, so every worker cycle runs once per business, each run inside that business's own context.
// This is the pattern notificationOutboxWorker and appointmentReminderWorker already used, extracted so every worker shares it.
// With a pool that has no tenant wrapper (unit tests with fake pools) there is no row-level security, so the work runs once, unscoped.

/** Every business ID, in a stable order. Businesses is the tenant directory and has no BusinessId column, so it can be listed without a context. */
export async function listBusinessIds(pool) {
  const { rows } = await pool.query('SELECT "Id" FROM "Businesses" ORDER BY "Id"');
  return rows.map((row) => row.Id);
}

/**
 * Run fn(businessId) once per business, each under that business's context, and return the results in business order.
 * A business whose run throws is logged and skipped so one broken tenant cannot stall the rest; when every run fails the first error is
 * rethrown so the worker's own cycle handler reports it.
 * With { platform: true } one more run follows with businessId null and the platform scope on, for rows that belong to no business
 * (EmailOutbox reset and verification mails). On a pool without the wrapper there is a single unscoped run, which already sees every row.
 */
export async function forEachBusiness(pool, fn, { platform = false, log = console } = {}) {
  if (!isRlsPool(pool)) return [await fn(null)];
  const results = [];
  const failures = [];
  const attempt = async (label, run) => {
    try { results.push(await run()); } catch (error) {
      failures.push(error);
      log.error?.('A worker run failed for one scope; the other scopes continue.', { scope: label, errorType: error?.constructor?.name ?? 'Error', error: describeErrorShape(error) });
    }
  };
  for (const businessId of await listBusinessIds(pool)) {
    await attempt(businessId, () => runWithTenantRlsContext(async () => {
      setTenantRlsContext(businessId);
      return fn(businessId);
    }));
  }
  if (platform) await attempt('platform', () => runWithTenantPlatformScope(() => fn(null)));
  if (failures.length && !results.length) throw failures[0];
  return results;
}

/** Combine per-business results: numbers add up, arrays concatenate, booleans are OR-ed, other fields keep the last value. */
export function sumResults(results) {
  const list = results.filter((value) => value !== undefined && value !== null);
  if (!list.length) return 0;
  if (list.every((value) => typeof value === 'number')) return list.reduce((total, value) => total + value, 0);
  const total = {};
  for (const item of list) {
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
      else if (Array.isArray(value)) total[key] = [...(total[key] ?? []), ...value];
      else if (typeof value === 'boolean') total[key] = Boolean(total[key]) || value;
      else total[key] = value;
    }
  }
  return total;
}

/** A webhook or other request-less handler starts from a clean tenant context, so nothing it binds can leak into its caller. */
export function withFreshTenantContext(pool, fn) {
  return isRlsPool(pool) ? runWithTenantRlsContext(fn) : fn();
}
