import { adoptTenant, clearTenantLookups, LOOKUP_KINDS, setTenantLookup } from './tenantRlsContext.js';

// Each lookup key names one table and the exact predicate that migration 0033's policy allows. The table and predicate come
// from this constant list, never from request data.
export const TENANT_LOOKUPS = Object.freeze({
  storefront_slug: { table: 'Storefronts', where: '"Slug" = $1' },
  storefront_id: { table: 'Storefronts', where: '"Id" = $1' },
  storefront_redirect_slug: { table: 'StorefrontSlugRedirects', where: '"OldSlug" = $1' },
  storefront_hostname: { table: 'StorefrontDomains', where: '"Hostname" = $1' },
  portal_token_hash: { table: 'CustomerPortalGrants', where: '"TokenHash" = $1' },
  calendar_token_hash: { table: 'CalendarFeedTokens', where: '"TokenHash" = $1' },
  rtw_payment_reference: { table: 'ReadyToWearOrders', where: '"PaymentReference" = $1' },
  invoice_payment_reference: { table: 'InvoicePaymentAttempts', where: '"Reference" = $1' },
  subscription_payment_reference: { table: 'SubscriptionPayments', where: '"ProviderReference" = $1' },
  email_provider_message_id: { table: 'EmailOutbox', where: '"ProviderMessageId" = $1' },
  invitation_token_hash: { table: 'Invitations', where: '"TokenHash" = $1' },
  session_token_hash: { table: 'UserSessions', where: '("CurrentTokenHash" = $1 OR "PreviousTokenHash" = $1)' },
  media_asset_id: { table: 'MediaAssets', where: '"Id" = $1' },
  // user_id has no single business: after the user is verified, the caller reads every Memberships row for that user.
});

// Step 17c: a suspended business (Businesses.IsActive = false) is invisible to the public. These keys come from customer-facing links
// and pages (storefront address, old address, custom hostname, portal link, calendar link, public media). A suspended business makes
// the lookup behave as "no match", so every caller already answers with its own 404 or 401. Payment, email and subscription
// references are deliberately not listed: a provider webhook for money already paid must still be recorded during a suspension.
export const SUSPENDABLE_LOOKUPS = Object.freeze(new Set([
  'storefront_slug', 'storefront_redirect_slug', 'storefront_hostname', 'portal_token_hash', 'calendar_token_hash', 'media_asset_id',
]));

/**
 * Find the business that owns the row a public key names and make it the tenant of this request.
 * Returns the business ID, or null when no row matches (the lookup is then cleared and the caller returns today's 404 or 401).
 * The caller's own query must still apply its own rules (published, not expired, not revoked); this only supplies the tenant.
 * Pass the pool before a transaction starts, or the checked-out client when the transaction is already open: the tenant is then
 * bound for the rest of that transaction as well as for the request.
 */
export async function bindTenantByLookup(poolOrClient, name, value) {
  const isClient = Boolean(poolOrClient?.__tenantRlsContextDecorated);
  // Without the tenant-context wrapper (unit tests with fake pools) there is no row-level security to satisfy, so there is nothing to bind.
  if (!isClient && !poolOrClient?.__tenantRlsContextInstalled) return null;
  const entry = Object.hasOwn(TENANT_LOOKUPS, name) ? TENANT_LOOKUPS[name] : null;
  if (!entry || !Object.hasOwn(LOOKUP_KINDS, name)) throw new TypeError(`No bindable tenant lookup named ${String(name)}`);
  const key = typeof value === 'string' ? value : '';
  const forget = async () => {
    clearTenantLookups();
    if (isClient) await poolOrClient.query('SELECT set_config($1, $2, true)', [`app.lookup_${name}`, '']);
  };
  await setTenantLookup(name, key, isClient ? poolOrClient : undefined);
  if (!key) { await forget(); return null; }
  try {
    const { rows } = await poolOrClient.query(`SELECT "BusinessId" FROM "${entry.table}" WHERE ${entry.where} LIMIT 1`, [key]);
    const businessId = rows[0]?.BusinessId ?? null;
    if (!businessId) { await forget(); return null; }
    // Businesses has no row-level security, so this read works before any tenant is bound. Only a business that is switched off matches.
    if (SUSPENDABLE_LOOKUPS.has(name)) {
      const suspended = await poolOrClient.query('SELECT 1 FROM "Businesses" WHERE "Id" = $1 AND "IsActive" = FALSE', [businessId]);
      if (suspended.rows.length > 0) { await forget(); return null; }
    }
    await adoptTenant(businessId, isClient ? poolOrClient : undefined);
    return businessId;
  } catch (error) {
    // A malformed uuid key is simply "not found". On a client the transaction is already aborted, so nothing more can run on it.
    clearTenantLookups();
    if (error?.code === '22P02') return null;
    throw error;
  }
}

/** A public storefront URL carries a slug that is either current or an old one that redirects. Returns the business of whichever matches. */
export async function bindTenantBySiteSlug(pool, slug) {
  return (await bindTenantByLookup(pool, 'storefront_slug', slug)) ?? (await bindTenantByLookup(pool, 'storefront_redirect_slug', slug));
}
