import {
  clearTenantLookups, runWithTenantRlsContext, setTenantLookup, setTenantRlsContext,
} from './tenantRlsContext.js';

// A user can belong to several businesses, and every tenant table is isolated by business. These helpers do the work that spans
// a user's businesses (sessions, memberships) without ever widening a policy: reads use the user_id lookup (SELECT only, set after
// the user was verified); writes run once per business, each under that business's own context.
// With a pool that has no tenant wrapper (unit tests with fakes) there is no row-level security, so each helper runs the work once.

export const isRlsPool = (db) => Boolean(db?.__tenantRlsContextInstalled);
export const isRlsClient = (db) => Boolean(db?.__tenantRlsContextDecorated);
export const isRlsHandle = (db) => isRlsPool(db) || isRlsClient(db);

/** Make this request's tenant the given business, when the database enforces row-level security. The caller must already have verified it. */
export function useBusiness(db, businessId) {
  if (isRlsHandle(db) && businessId) setTenantRlsContext(businessId);
}

const MEMBERSHIP_BUSINESSES = 'SELECT DISTINCT "BusinessId" FROM "Memberships" WHERE "UserId" = $1';

/** Every business this user has a membership row in (any status). Only call it for a user ID that has been verified. */
export async function userBusinessIds(db, userId) {
  if (!isRlsHandle(db)) return [];
  if (isRlsClient(db)) {
    // Inside an open transaction: the key lives and dies with this transaction.
    await db.query("SELECT set_config('app.lookup_user_id', $1, true)", [userId]);
    try { return (await db.query(MEMBERSHIP_BUSINESSES, [userId])).rows.map((row) => row.BusinessId); }
    finally { await db.query("SELECT set_config('app.lookup_user_id', '', true)"); }
  }
  return runWithTenantRlsContext(async () => {
    setTenantLookup('user_id', userId);
    try { return (await db.query(MEMBERSHIP_BUSINESSES, [userId])).rows.map((row) => row.BusinessId); }
    finally { clearTenantLookups(); }
  });
}

/**
 * Run fn(db, businessId) once for each business the user belongs to, each time under that business's context, and return the results.
 * On a pool each run has its own isolated context. On a client inside a transaction the business is switched with a
 * transaction-local setting, and the previous one is restored afterwards, so the whole thing stays one atomic transaction.
 */
export async function forEachUserBusiness(db, userId, fn) {
  if (!isRlsHandle(db)) return [await fn(db, null)];
  const ids = await userBusinessIds(db, userId);
  const results = [];
  if (isRlsClient(db)) {
    const previous = (await db.query("SELECT current_setting('app.business_id', true) AS value")).rows[0]?.value ?? '';
    try {
      for (const id of ids) {
        await db.query("SELECT set_config('app.business_id', $1, true)", [id]);
        results.push(await fn(db, id));
      }
    } finally {
      await db.query("SELECT set_config('app.business_id', $1, true)", [previous]);
    }
    return results;
  }
  for (const id of ids) {
    results.push(await runWithTenantRlsContext(async () => {
      setTenantRlsContext(id);
      return fn(db, id);
    }));
  }
  return results;
}

/** Read memberships (all businesses) for a verified user: the user_id key makes only that user's Memberships rows visible. */
export async function withUserLookup(db, userId, fn) {
  if (!isRlsPool(db)) return fn();
  return runWithTenantRlsContext(async () => {
    setTenantLookup('user_id', userId);
    try { return await fn(); } finally { clearTenantLookups(); }
  });
}
