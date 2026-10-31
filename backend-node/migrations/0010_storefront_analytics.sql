-- 0010: consent-gated, first-party storefront analytics. Additive only; nothing is dropped or rewritten.
--   StorefrontAnalyticsSettings            per-business switch. No row means off (the default). While it is off nothing is collected.
--                                          A Node-only table, so the EF-owned Businesses table is not altered.
--   StorefrontPageViewDaily                aggregate counters only: one row per storefront, UTC day and path.
--                                          No visitor id, IP address, user agent, referrer or timestamp per view is stored.
--   StorefrontConsentRecords               anonymous consent decisions (version, accepted/rejected, time, storefront).
CREATE TABLE IF NOT EXISTS "StorefrontAnalyticsSettings" (
  "BusinessId" uuid NOT NULL,
  "Enabled" boolean NOT NULL,
  "UpdatedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_StorefrontAnalyticsSettings" PRIMARY KEY ("BusinessId"),
  CONSTRAINT "FK_StorefrontAnalyticsSettings_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "StorefrontPageViewDaily" (
  "BusinessId" uuid NOT NULL,
  "StorefrontId" uuid NOT NULL,
  "Day" date NOT NULL,
  "Path" character varying(200) NOT NULL,
  "Views" integer NOT NULL,
  CONSTRAINT "PK_StorefrontPageViewDaily" PRIMARY KEY ("StorefrontId", "Day", "Path"),
  CONSTRAINT "CK_StorefrontPageViewDaily_Views" CHECK ("Views" > 0),
  CONSTRAINT "FK_StorefrontPageViewDaily_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_StorefrontPageViewDaily_Storefronts_StorefrontId_BusinessId" FOREIGN KEY ("StorefrontId", "BusinessId") REFERENCES "Storefronts" ("Id", "BusinessId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "IX_StorefrontPageViewDaily_BusinessId_Day" ON "StorefrontPageViewDaily" ("BusinessId", "Day");

CREATE TABLE IF NOT EXISTS "StorefrontConsentRecords" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "StorefrontId" uuid NOT NULL,
  "ConsentVersion" integer NOT NULL,
  "Decision" character varying(10) NOT NULL,
  "DecidedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_StorefrontConsentRecords" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_StorefrontConsentRecords_Decision" CHECK ("Decision" IN ('accepted', 'rejected')),
  CONSTRAINT "FK_StorefrontConsentRecords_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_StorefrontConsentRecords_Storefronts_StorefrontId_BusinessId" FOREIGN KEY ("StorefrontId", "BusinessId") REFERENCES "Storefronts" ("Id", "BusinessId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "IX_StorefrontConsentRecords_BusinessId_DecidedAtUtc" ON "StorefrontConsentRecords" ("BusinessId", "DecidedAtUtc");
