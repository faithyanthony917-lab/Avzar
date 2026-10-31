-- 0012: server-enforced revocation for anonymous storefront analytics consent grants.
-- Stores only a one-way token hash, tenant/storefront scope, expiry and revocation state; no visitor identifiers.
CREATE TABLE IF NOT EXISTS "StorefrontConsentTokenGrants" (
  "TokenHash" character varying(64) NOT NULL,
  "BusinessId" uuid NOT NULL,
  "StorefrontId" uuid NOT NULL,
  "ConsentVersion" integer NOT NULL,
  "ExpiresAtUtc" timestamp with time zone NOT NULL,
  "RevokedAtUtc" timestamp with time zone NULL,
  CONSTRAINT "PK_StorefrontConsentTokenGrants" PRIMARY KEY ("TokenHash"),
  CONSTRAINT "FK_StorefrontConsentTokenGrants_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_StorefrontConsentTokenGrants_Storefronts_StorefrontId_BusinessId" FOREIGN KEY ("StorefrontId", "BusinessId") REFERENCES "Storefronts" ("Id", "BusinessId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "IX_StorefrontConsentTokenGrants_StorefrontId_ExpiresAtUtc" ON "StorefrontConsentTokenGrants" ("StorefrontId", "ExpiresAtUtc");
