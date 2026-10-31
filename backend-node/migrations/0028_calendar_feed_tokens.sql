CREATE TABLE "CalendarFeedTokens" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "MembershipId" uuid NOT NULL,
  "TokenHash" character varying(64) NOT NULL,
  "AllowedLocationIds" uuid[],
  "ExpiresAtUtc" timestamptz,
  "RevokedAtUtc" timestamptz,
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "LastUsedAtUtc" timestamptz,
  CONSTRAINT "PK_CalendarFeedTokens" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_CalendarFeedTokens_TokenHash" UNIQUE ("TokenHash"),
  CONSTRAINT "FK_CalendarFeedTokens_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE CASCADE,
  CONSTRAINT "FK_CalendarFeedTokens_Memberships_MembershipId_BusinessId" FOREIGN KEY ("MembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE,
  CONSTRAINT "CK_CalendarFeedTokens_Hash" CHECK ("TokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CK_CalendarFeedTokens_Locations" CHECK ("AllowedLocationIds" IS NULL OR cardinality("AllowedLocationIds") <= 500)
);
CREATE INDEX "IX_CalendarFeedTokens_BusinessId_MembershipId" ON "CalendarFeedTokens" ("BusinessId", "MembershipId") WHERE "RevokedAtUtc" IS NULL;
