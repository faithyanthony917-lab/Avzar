-- Platform operations: globally scoped flags and auditable platform-admin actions.
CREATE TABLE IF NOT EXISTS "PlatformFeatureFlags" (
  "Key" varchar(80) NOT NULL PRIMARY KEY,
  "Description" varchar(240) NOT NULL,
  "Enabled" boolean NOT NULL DEFAULT FALSE,
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedByEmail" varchar(256)
);

INSERT INTO "PlatformFeatureFlags" ("Key", "Description", "Enabled") VALUES
  ('ready_to_wear_checkout', 'Enable ready-to-wear checkout', FALSE),
  ('whatsapp_notifications', 'Enable WhatsApp notification provider', FALSE),
  ('sms_notifications', 'Enable SMS notification provider', FALSE)
ON CONFLICT ("Key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "PlatformAuditLogs" (
  "Id" uuid NOT NULL PRIMARY KEY,
  "ActorEmail" varchar(256) NOT NULL,
  "Action" varchar(100) NOT NULL,
  "EntityType" varchar(80) NOT NULL,
  "EntityId" varchar(160),
  "DetailsJson" jsonb,
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "IX_PlatformAuditLogs_CreatedAtUtc" ON "PlatformAuditLogs" ("CreatedAtUtc" DESC);
