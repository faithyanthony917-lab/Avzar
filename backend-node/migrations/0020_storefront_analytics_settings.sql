-- Move the analytics switch to a Node-only table without changing already-applied migration 0010.
CREATE TABLE IF NOT EXISTS "StorefrontAnalyticsSettings" (
  "BusinessId" uuid NOT NULL,
  "Enabled" boolean NOT NULL,
  "UpdatedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_StorefrontAnalyticsSettings" PRIMARY KEY ("BusinessId"),
  CONSTRAINT "FK_StorefrontAnalyticsSettings_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT
);

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Businesses' AND column_name = 'StorefrontAnalyticsEnabled'
  ) THEN
    EXECUTE 'INSERT INTO "StorefrontAnalyticsSettings" ("BusinessId", "Enabled", "UpdatedAtUtc")
      SELECT "Id", "StorefrontAnalyticsEnabled", now() FROM "Businesses" WHERE TRUE
      ON CONFLICT ("BusinessId") DO NOTHING';
    ALTER TABLE "Businesses" DROP COLUMN "StorefrontAnalyticsEnabled";
  END IF;
END;
$migration$;