-- Step 16b: durable customer messages about an order or a payment (order amended, order ready, payment receipt).
-- Separate from CustomerMessageOutbox on purpose: that table, its triggers and its unique key are specific to appointment reminders.
-- A row holds references only (customer, channel, address, kind, subject, key); the text is built when the message is sent, from
-- current data, so a stale amount or date is never sent. Consent is checked when the row is queued AND again just before sending.
CREATE TABLE "CustomerEventOutbox" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "CustomerId" uuid NOT NULL,
  "Channel" character varying(12) NOT NULL,
  "Address" character varying(254) NOT NULL,
  "Kind" character varying(24) NOT NULL,
  "SubjectId" uuid NOT NULL,
  "DedupeKey" character varying(160) NOT NULL,
  "Status" character varying(12) NOT NULL DEFAULT 'Pending',
  "Attempts" integer NOT NULL DEFAULT 0,
  "NextAttemptUtc" timestamptz NOT NULL DEFAULT now(),
  "LeaseUntilUtc" timestamptz,
  "ProviderMessageId" character varying(160),
  "LastError" character varying(100),
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "SentAtUtc" timestamptz,
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_CustomerEventOutbox" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_CustomerEventOutbox_Dedupe" UNIQUE ("BusinessId", "DedupeKey", "Channel", "Address"),
  CONSTRAINT "FK_CustomerEventOutbox_Customers_CustomerId_BusinessId" FOREIGN KEY ("CustomerId", "BusinessId") REFERENCES "Customers" ("Id", "BusinessId") ON DELETE CASCADE,
  CONSTRAINT "CK_CustomerEventOutbox_Channel" CHECK ("Channel" IN ('WhatsApp', 'SMS')),
  CONSTRAINT "CK_CustomerEventOutbox_Kind" CHECK ("Kind" IN ('order.amended', 'order.ready', 'payment.receipt')),
  CONSTRAINT "CK_CustomerEventOutbox_Status" CHECK ("Status" IN ('Pending', 'Leased', 'Sent', 'Cancelled', 'Failed')),
  CONSTRAINT "CK_CustomerEventOutbox_Attempts" CHECK ("Attempts" >= 0)
);
CREATE INDEX "IX_CustomerEventOutbox_Due" ON "CustomerEventOutbox" ("NextAttemptUtc", "Id") WHERE "Status" IN ('Pending', 'Leased');
CREATE INDEX "IX_CustomerEventOutbox_Customer" ON "CustomerEventOutbox" ("BusinessId", "CustomerId", "CreatedAtUtc" DESC);

-- A withdrawn consent stops messages that are still waiting, the same way it does for reminders. A later opt-in does not resurrect them.
CREATE OR REPLACE FUNCTION avzar_cancel_opted_out_customer_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."ConsentStatus" <> 'OptedIn' OR NEW."OptedOutAtUtc" IS NOT NULL THEN
    UPDATE "CustomerEventOutbox" SET "Status" = 'Cancelled', "LeaseUntilUtc" = NULL, "UpdatedAtUtc" = now()
    WHERE "BusinessId" = NEW."BusinessId" AND "CustomerId" = NEW."CustomerId" AND "Channel" = NEW."Channel"
      AND lower("Address") = lower(NEW."Address") AND "Status" IN ('Pending', 'Leased');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "TR_CustomerMessagingPreferences_EventOutbox" ON "CustomerMessagingPreferences";
CREATE TRIGGER "TR_CustomerMessagingPreferences_EventOutbox" AFTER INSERT OR UPDATE ON "CustomerMessagingPreferences"
FOR EACH ROW EXECUTE FUNCTION avzar_cancel_opted_out_customer_events();

ALTER TABLE "CustomerEventOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerEventOutbox" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avzar_business_isolation ON "CustomerEventOutbox";
CREATE POLICY avzar_business_isolation ON "CustomerEventOutbox"
  USING ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid);
