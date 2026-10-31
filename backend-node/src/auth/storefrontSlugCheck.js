import { AppError } from '../http/errors.js';
import { setTenantLookup } from '../db/tenantRlsContext.js';

// A storefront address must be unique across every business, but row-level security hides other businesses' storefronts and retired
// addresses from the business that is asking. These helpers let the availability check see the one row it asks about (migration 0033's
// key-matched lookup policies, SELECT only) without changing which business the request belongs to.

const SLUG_LOOKUPS = ['storefront_slug', 'storefront_redirect_slug'];
const SLUG_CONSTRAINTS = new Set(['IX_Storefronts_Slug', 'PK_StorefrontSlugRedirects']);

/**
 * Run `check` (queries on `client`, inside an open transaction) with the lookup keys for `slug` set, so a row of any business with
 * that exact address or retired address is visible to it. The keys are removed afterwards, even when `check` throws.
 * A client without the tenant-context wrapper (unit tests with fake pools) has no row-level security to satisfy: `check` just runs.
 */
export async function withStorefrontSlugVisible(client, slug, check) {
  if (!client?.__tenantRlsContextDecorated) return check();
  try {
    for (const name of SLUG_LOOKUPS) await setTenantLookup(name, slug, client);
    return await check();
  } finally {
    for (const name of SLUG_LOOKUPS) setTenantLookup(name, '');
    // After a failed statement the transaction is aborted and this cannot run; the keys are transaction-local and die with it.
    await client.query("SELECT set_config('app.lookup_storefront_slug', '', true), set_config('app.lookup_storefront_redirect_slug', '', true)").catch(() => {});
  }
}

/** The AppError for a unique violation on a storefront address (two requests raced, or the check could not see the other row); otherwise null. */
export function slugTakenFrom(error) {
  if (error?.code !== '23505' || !SLUG_CONSTRAINTS.has(error?.constraint)) return null;
  return AppError.conflict('slug_taken', 'That web address is already taken. Choose another.');
}

/** For `.catch(...)` on the statements that write a storefront address. */
export function rethrowSlugTaken(error) {
  throw slugTakenFrom(error) ?? error;
}
