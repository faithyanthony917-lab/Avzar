-- Step 16c: editable wording for the messages customers receive (order amended, order ready, payment receipt, appointment reminder).
-- One row per business, kind and channel. No row means the default wording in code (src/messaging/templateCatalog.js), so this
-- migration changes nothing that is sent today. The opt-out line is never part of a template: the sender always appends it.
CREATE TABLE "NotificationTemplates" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "Kind" character varying(32) NOT NULL,
  "Channel" character varying(12) NOT NULL,
  "Body" character varying(600) NOT NULL,
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedByUserId" uuid,
  CONSTRAINT "PK_NotificationTemplates" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_NotificationTemplates_Business_Kind_Channel" UNIQUE ("BusinessId", "Kind", "Channel"),
  CONSTRAINT "CK_NotificationTemplates_Kind" CHECK ("Kind" IN ('order.amended', 'order.ready', 'payment.receipt', 'appointment.reminder')),
  CONSTRAINT "CK_NotificationTemplates_Channel" CHECK ("Channel" IN ('WhatsApp', 'SMS')),
  CONSTRAINT "CK_NotificationTemplates_Body" CHECK (char_length(btrim("Body")) >= 1)
);

ALTER TABLE "NotificationTemplates" ADD CONSTRAINT "FK_NotificationTemplates_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;

ALTER TABLE "NotificationTemplates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationTemplates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avzar_business_isolation ON "NotificationTemplates";
CREATE POLICY avzar_business_isolation ON "NotificationTemplates"
  USING ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid);
