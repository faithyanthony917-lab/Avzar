-- Lookup policies for 0032's FORCE row-level security.
--
-- 0032 denies every row when app.business_id is unset. Some requests legitimately start with a secret or a public key (a public
-- storefront slug, a portal or calendar token hash, a webhook payment reference, a user id after credentials were verified) and only
-- learn the business by reading the row that key names. Each policy below lets SELECT see exactly the rows whose key equals one
-- transaction-local setting, app.lookup_<name>. The application sets that setting only when it holds the key; it then reads
-- "BusinessId" from the row it found and sets app.business_id. Policies are permissive, so they widen 0032's SELECT rule only for that
-- key and never grant INSERT, UPDATE or DELETE. Never use session-level SET for these values: pooled connections are reused.
-- Keep the key list in sync with src/db/tenantLookup.js (test/tenantLookup.test.js checks it).

DROP POLICY IF EXISTS avzar_lookup_storefront_slug ON "Storefronts";
CREATE POLICY avzar_lookup_storefront_slug ON "Storefronts" FOR SELECT
  USING ("Slug" = NULLIF(current_setting('app.lookup_storefront_slug', true), ''));

DROP POLICY IF EXISTS avzar_lookup_storefront_id ON "Storefronts";
CREATE POLICY avzar_lookup_storefront_id ON "Storefronts" FOR SELECT
  USING ("Id" = NULLIF(current_setting('app.lookup_storefront_id', true), '')::uuid);

DROP POLICY IF EXISTS avzar_lookup_storefront_redirect_slug ON "StorefrontSlugRedirects";
CREATE POLICY avzar_lookup_storefront_redirect_slug ON "StorefrontSlugRedirects" FOR SELECT
  USING ("OldSlug" = NULLIF(current_setting('app.lookup_storefront_redirect_slug', true), ''));

DROP POLICY IF EXISTS avzar_lookup_storefront_hostname ON "StorefrontDomains";
CREATE POLICY avzar_lookup_storefront_hostname ON "StorefrontDomains" FOR SELECT
  USING ("Hostname" = NULLIF(current_setting('app.lookup_storefront_hostname', true), ''));

DROP POLICY IF EXISTS avzar_lookup_portal_token_hash ON "CustomerPortalGrants";
CREATE POLICY avzar_lookup_portal_token_hash ON "CustomerPortalGrants" FOR SELECT
  USING ("TokenHash" = NULLIF(current_setting('app.lookup_portal_token_hash', true), ''));

DROP POLICY IF EXISTS avzar_lookup_calendar_token_hash ON "CalendarFeedTokens";
CREATE POLICY avzar_lookup_calendar_token_hash ON "CalendarFeedTokens" FOR SELECT
  USING ("TokenHash" = NULLIF(current_setting('app.lookup_calendar_token_hash', true), ''));

DROP POLICY IF EXISTS avzar_lookup_rtw_payment_reference ON "ReadyToWearOrders";
CREATE POLICY avzar_lookup_rtw_payment_reference ON "ReadyToWearOrders" FOR SELECT
  USING ("PaymentReference" = NULLIF(current_setting('app.lookup_rtw_payment_reference', true), ''));

DROP POLICY IF EXISTS avzar_lookup_subscription_payment_reference ON "SubscriptionPayments";
CREATE POLICY avzar_lookup_subscription_payment_reference ON "SubscriptionPayments" FOR SELECT
  USING ("ProviderReference" = NULLIF(current_setting('app.lookup_subscription_payment_reference', true), ''));

DROP POLICY IF EXISTS avzar_lookup_email_provider_message_id ON "EmailOutbox";
CREATE POLICY avzar_lookup_email_provider_message_id ON "EmailOutbox" FOR SELECT
  USING ("ProviderMessageId" = NULLIF(current_setting('app.lookup_email_provider_message_id', true), ''));

-- Set only after credentials, a refresh token or a signed link have proved who the user is.
DROP POLICY IF EXISTS avzar_lookup_user_id ON "Memberships";
CREATE POLICY avzar_lookup_user_id ON "Memberships" FOR SELECT
  USING ("UserId" = NULLIF(current_setting('app.lookup_user_id', true), '')::uuid);

DROP POLICY IF EXISTS avzar_lookup_invitation_token_hash ON "Invitations";
CREATE POLICY avzar_lookup_invitation_token_hash ON "Invitations" FOR SELECT
  USING ("TokenHash" = NULLIF(current_setting('app.lookup_invitation_token_hash', true), ''));

DROP POLICY IF EXISTS avzar_lookup_session_token_hash ON "UserSessions";
CREATE POLICY avzar_lookup_session_token_hash ON "UserSessions" FOR SELECT
  USING (
    "CurrentTokenHash" = NULLIF(current_setting('app.lookup_session_token_hash', true), '')
    OR "PreviousTokenHash" = NULLIF(current_setting('app.lookup_session_token_hash', true), '')
  );

DROP POLICY IF EXISTS avzar_lookup_media_asset_id ON "MediaAssets";
CREATE POLICY avzar_lookup_media_asset_id ON "MediaAssets" FOR SELECT
  USING ("Id" = NULLIF(current_setting('app.lookup_media_asset_id', true), '')::uuid);

-- "EmailOutbox"."BusinessId" is nullable: password-reset and confirmation mails are queued before any business is known.
-- 0032's policy can never match a NULL BusinessId. Those rows are reachable only while app.platform_scope = 'on', which the
-- account service and the email dispatcher set; it exposes nothing else.
DROP POLICY IF EXISTS avzar_platform_scope_email ON "EmailOutbox";
CREATE POLICY avzar_platform_scope_email ON "EmailOutbox" FOR ALL
  USING ("BusinessId" IS NULL AND current_setting('app.platform_scope', true) = 'on')
  WITH CHECK ("BusinessId" IS NULL AND current_setting('app.platform_scope', true) = 'on');
