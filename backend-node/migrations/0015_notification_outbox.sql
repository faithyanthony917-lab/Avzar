-- 0015: durable, per-recipient notification delivery intents (A1 reliability follow-up).
CREATE TABLE "NotificationOutbox" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "RecipientMembershipId" uuid NOT NULL,
  "Category" character varying(20) NOT NULL,
  "EventType" character varying(60) NOT NULL,
  "Title" character varying(120) NOT NULL,
  "Body" character varying(300) NOT NULL,
  "TargetKind" character varying(24),
  "TargetId" uuid,
  "DeduplicationKey" character varying(200) NOT NULL,
  "InAppEnabled" boolean NOT NULL,
  "EmailToAddress" character varying(320),
  "EmailSubject" character varying(200),
  "EmailTemplateKey" character varying(100),
  "EmailTextBody" text,
  "EmailDeduplicationKey" character varying(200),
  "EmailNextAttemptUtc" timestamp with time zone,
  "Status" character varying(16) NOT NULL DEFAULT 'Pending',
  "Attempts" integer NOT NULL DEFAULT 0,
  "NextAttemptUtc" timestamp with time zone NOT NULL,
  "LeaseUntilUtc" timestamp with time zone,
  "LastError" character varying(400),
  "CreatedAtUtc" timestamp with time zone NOT NULL,
  "SentAtUtc" timestamp with time zone,
  CONSTRAINT "PK_NotificationOutbox" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_NotificationOutbox_Category" CHECK ("Category" IN ('tasks', 'schedule', 'orders', 'inquiries', 'finance', 'inventory', 'billing')),
  CONSTRAINT "CK_NotificationOutbox_TargetKind" CHECK ("TargetKind" IS NULL OR "TargetKind" IN ('task', 'order', 'invoice', 'inquiry', 'material', 'subscription', 'quotation', 'payment')),
  CONSTRAINT "CK_NotificationOutbox_Target" CHECK (("TargetKind" IS NULL) = ("TargetId" IS NULL) OR "TargetKind" = 'subscription'),
  CONSTRAINT "CK_NotificationOutbox_Channel" CHECK ("InAppEnabled" OR "EmailToAddress" IS NOT NULL),
  CONSTRAINT "CK_NotificationOutbox_Email" CHECK (
    ("EmailToAddress" IS NULL AND "EmailSubject" IS NULL AND "EmailTemplateKey" IS NULL
      AND "EmailTextBody" IS NULL AND "EmailDeduplicationKey" IS NULL AND "EmailNextAttemptUtc" IS NULL)
    OR ("EmailToAddress" IS NOT NULL AND "EmailSubject" IS NOT NULL AND "EmailTemplateKey" IS NOT NULL
      AND "EmailTextBody" IS NOT NULL AND "EmailDeduplicationKey" IS NOT NULL AND "EmailNextAttemptUtc" IS NOT NULL)),
  CONSTRAINT "CK_NotificationOutbox_Status" CHECK ("Status" IN ('Pending', 'Leased', 'Sent', 'Failed')),
  CONSTRAINT "CK_NotificationOutbox_Attempts" CHECK ("Attempts" >= 0),
  CONSTRAINT "FK_NotificationOutbox_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_NotificationOutbox_Memberships_Recipient_Business" FOREIGN KEY ("RecipientMembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "IX_NotificationOutbox_Recipient_DeduplicationKey"
  ON "NotificationOutbox" ("BusinessId", "RecipientMembershipId", "DeduplicationKey");
CREATE INDEX "IX_NotificationOutbox_Claim"
  ON "NotificationOutbox" ("NextAttemptUtc", "CreatedAtUtc") WHERE "Status" IN ('Pending', 'Leased');