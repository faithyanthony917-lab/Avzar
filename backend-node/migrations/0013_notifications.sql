-- 0013: in-app notifications (roadmap item A1, patch 1: core).
-- Notifications are per business membership (a person can belong to several businesses), tenant-scoped by composite
-- foreign keys, and idempotent through a unique deduplication key. Text is fixed-template and carries ids only:
-- no measurements, customer names, contact details or amounts.
CREATE TABLE IF NOT EXISTS "Notifications" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "RecipientMembershipId" uuid NOT NULL,
  "Category" character varying(20) NOT NULL,
  "EventType" character varying(60) NOT NULL,
  "Title" character varying(120) NOT NULL,
  "Body" character varying(300) NOT NULL,
  "TargetKind" character varying(24) NULL,
  "TargetId" uuid NULL,
  "DeduplicationKey" character varying(200) NOT NULL,
  "CreatedAtUtc" timestamp with time zone NOT NULL,
  "ReadAtUtc" timestamp with time zone NULL,
  CONSTRAINT "PK_Notifications" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_Notifications_Category" CHECK ("Category" IN ('tasks', 'schedule', 'orders', 'inquiries', 'finance', 'inventory', 'billing')),
  CONSTRAINT "CK_Notifications_TargetKind" CHECK ("TargetKind" IS NULL OR "TargetKind" IN ('task', 'order', 'invoice', 'inquiry', 'material', 'subscription', 'quotation', 'payment')),
  CONSTRAINT "CK_Notifications_Target" CHECK (("TargetKind" IS NULL) = ("TargetId" IS NULL) OR "TargetKind" = 'subscription'),
  CONSTRAINT "FK_Notifications_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_Notifications_Memberships_RecipientMembershipId_BusinessId" FOREIGN KEY ("RecipientMembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "IX_Notifications_Recipient_DeduplicationKey" ON "Notifications" ("BusinessId", "RecipientMembershipId", "DeduplicationKey");
CREATE INDEX IF NOT EXISTS "IX_Notifications_Recipient_Created" ON "Notifications" ("BusinessId", "RecipientMembershipId", "CreatedAtUtc" DESC, "Id" DESC);
CREATE INDEX IF NOT EXISTS "IX_Notifications_Recipient_Unread" ON "Notifications" ("BusinessId", "RecipientMembershipId") WHERE "ReadAtUtc" IS NULL;
CREATE INDEX IF NOT EXISTS "IX_Notifications_CreatedAtUtc" ON "Notifications" ("CreatedAtUtc");

-- One row per (membership, category). A missing row means the defaults in notificationCatalog.js.
-- PushEnabled is stored now and ignored until mobile push (A3) exists.
CREATE TABLE IF NOT EXISTS "NotificationPreferences" (
  "MembershipId" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "Category" character varying(20) NOT NULL,
  "InAppEnabled" boolean NOT NULL,
  "EmailEnabled" boolean NOT NULL,
  "PushEnabled" boolean NOT NULL DEFAULT FALSE,
  "UpdatedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_NotificationPreferences" PRIMARY KEY ("MembershipId", "Category"),
  CONSTRAINT "CK_NotificationPreferences_Category" CHECK ("Category" IN ('tasks', 'schedule', 'orders', 'inquiries', 'finance', 'inventory', 'billing')),
  CONSTRAINT "FK_NotificationPreferences_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_NotificationPreferences_Memberships_MembershipId_BusinessId" FOREIGN KEY ("MembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "IX_NotificationPreferences_BusinessId" ON "NotificationPreferences" ("BusinessId");

-- Quiet hours, in minutes after local midnight in the business time zone. They only delay external channels
-- (email now, push later); the in-app list is never held back.
CREATE TABLE IF NOT EXISTS "NotificationSettings" (
  "MembershipId" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "QuietHoursEnabled" boolean NOT NULL DEFAULT FALSE,
  "QuietStartMinute" integer NOT NULL DEFAULT 1320,
  "QuietEndMinute" integer NOT NULL DEFAULT 420,
  "UpdatedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_NotificationSettings" PRIMARY KEY ("MembershipId"),
  CONSTRAINT "CK_NotificationSettings_Minutes" CHECK ("QuietStartMinute" BETWEEN 0 AND 1439 AND "QuietEndMinute" BETWEEN 0 AND 1439),
  CONSTRAINT "FK_NotificationSettings_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_NotificationSettings_Memberships_MembershipId_BusinessId" FOREIGN KEY ("MembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE
);
