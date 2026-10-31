-- Durable customer appointment reminders. Consent is checked at enqueue AND immediately before delivery.
CREATE TABLE "CustomerMessageOutbox" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "AppointmentId" uuid NOT NULL,
  "CustomerId" uuid NOT NULL,
  "Channel" character varying(12) NOT NULL,
  "Address" character varying(254) NOT NULL,
  "AppointmentStartUtc" timestamptz NOT NULL,
  "OffsetMinutes" smallint NOT NULL,
  "DueAtUtc" timestamptz NOT NULL,
  "Status" character varying(12) NOT NULL DEFAULT 'Pending',
  "Attempts" integer NOT NULL DEFAULT 0,
  "NextAttemptUtc" timestamptz NOT NULL DEFAULT now(),
  "LeaseUntilUtc" timestamptz,
  "ProviderMessageId" character varying(160),
  "LastError" character varying(100),
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "SentAtUtc" timestamptz,
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_CustomerMessageOutbox" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_CustomerMessageOutbox_Dedupe" UNIQUE ("BusinessId","AppointmentId","CustomerId","Channel","Address","AppointmentStartUtc","OffsetMinutes"),
  CONSTRAINT "FK_CustomerMessageOutbox_Appointments_AppointmentId_BusinessId" FOREIGN KEY ("AppointmentId","BusinessId") REFERENCES "Appointments" ("Id","BusinessId") ON DELETE CASCADE,
  CONSTRAINT "FK_CustomerMessageOutbox_Customers_CustomerId_BusinessId" FOREIGN KEY ("CustomerId","BusinessId") REFERENCES "Customers" ("Id","BusinessId") ON DELETE CASCADE,
  CONSTRAINT "CK_CustomerMessageOutbox_Channel" CHECK ("Channel" IN ('WhatsApp','SMS')),
  CONSTRAINT "CK_CustomerMessageOutbox_Status" CHECK ("Status" IN ('Pending','Leased','Sent','Cancelled','Failed')),
  CONSTRAINT "CK_CustomerMessageOutbox_Offset" CHECK ("OffsetMinutes" IN (1440,120)),
  CONSTRAINT "CK_CustomerMessageOutbox_Attempts" CHECK ("Attempts" >= 0)
);
CREATE INDEX "IX_CustomerMessageOutbox_Due" ON "CustomerMessageOutbox" ("NextAttemptUtc","DueAtUtc","Id") WHERE "Status" IN ('Pending','Leased');
CREATE INDEX "IX_CustomerMessageOutbox_BusinessId_Status" ON "CustomerMessageOutbox" ("BusinessId","Status","CreatedAtUtc" DESC);

CREATE OR REPLACE FUNCTION avzar_queue_customer_appointment_reminders() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preference record;
DECLARE reminder_offset smallint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."Status" = 'Scheduled' THEN
      UPDATE "CustomerMessageOutbox" SET "Status"='Cancelled',"LeaseUntilUtc"=NULL,"UpdatedAtUtc"=now()
      WHERE "BusinessId"=OLD."BusinessId" AND "AppointmentId"=OLD."Id" AND "Status" IN ('Pending','Leased')
        AND (NEW."Status" <> 'Scheduled' OR NEW."StartUtc" <> OLD."StartUtc" OR NEW."CustomerId" <> OLD."CustomerId");
    END IF;
  END IF;
  IF NEW."Status" <> 'Scheduled' OR NEW."StartUtc" <= now() THEN RETURN NEW; END IF;
  FOREACH reminder_offset IN ARRAY ARRAY[1440,120]::smallint[] LOOP
    IF NEW."StartUtc" - make_interval(mins => reminder_offset) <= now() THEN CONTINUE; END IF;
    FOR preference IN
      SELECT p."Channel",p."Address" FROM "CustomerMessagingPreferences" p
      WHERE p."BusinessId"=NEW."BusinessId" AND p."CustomerId"=NEW."CustomerId"
        AND p."ConsentStatus"='OptedIn' AND p."ConsentedAtUtc" IS NOT NULL AND p."OptedOutAtUtc" IS NULL
    LOOP
      INSERT INTO "CustomerMessageOutbox" ("Id","BusinessId","AppointmentId","CustomerId","Channel","Address","AppointmentStartUtc","OffsetMinutes","DueAtUtc")
      VALUES (gen_random_uuid(),NEW."BusinessId",NEW."Id",NEW."CustomerId",preference."Channel",preference."Address",NEW."StartUtc",reminder_offset,NEW."StartUtc" - make_interval(mins => reminder_offset))
      ON CONFLICT ("BusinessId","AppointmentId","CustomerId","Channel","Address","AppointmentStartUtc","OffsetMinutes") DO UPDATE
      SET "Status"='Pending',"Attempts"=0,"NextAttemptUtc"=now(),"LeaseUntilUtc"=NULL,"LastError"=NULL,"UpdatedAtUtc"=now()
      WHERE "CustomerMessageOutbox"."Status"='Cancelled' AND EXCLUDED."DueAtUtc">now();
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "TR_Appointments_CustomerReminders" ON "Appointments";
CREATE TRIGGER "TR_Appointments_CustomerReminders" AFTER INSERT OR UPDATE ON "Appointments"
FOR EACH ROW EXECUTE FUNCTION avzar_queue_customer_appointment_reminders();

-- Consent changes are immediately reflected in queued reminders; a later opt-in does not resurrect old messages.
CREATE OR REPLACE FUNCTION avzar_cancel_opted_out_customer_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."ConsentStatus" <> 'OptedIn' OR NEW."OptedOutAtUtc" IS NOT NULL THEN
    UPDATE "CustomerMessageOutbox" SET "Status"='Cancelled',"LeaseUntilUtc"=NULL,"UpdatedAtUtc"=now()
    WHERE "BusinessId"=NEW."BusinessId" AND "CustomerId"=NEW."CustomerId" AND "Channel"=NEW."Channel"
      AND lower("Address")=lower(NEW."Address") AND "Status" IN ('Pending','Leased');
  ELSE
    INSERT INTO "CustomerMessageOutbox" ("Id","BusinessId","AppointmentId","CustomerId","Channel","Address","AppointmentStartUtc","OffsetMinutes","DueAtUtc")
    SELECT gen_random_uuid(),a."BusinessId",a."Id",a."CustomerId",NEW."Channel",NEW."Address",a."StartUtc",o.offset_minutes,a."StartUtc"-make_interval(mins=>o.offset_minutes)
    FROM "Appointments" a CROSS JOIN (VALUES (1440::smallint),(120::smallint)) o(offset_minutes)
    WHERE a."BusinessId"=NEW."BusinessId" AND a."CustomerId"=NEW."CustomerId" AND a."Status"='Scheduled'
      AND a."StartUtc"-make_interval(mins=>o.offset_minutes)>now()
    ON CONFLICT ("BusinessId","AppointmentId","CustomerId","Channel","Address","AppointmentStartUtc","OffsetMinutes") DO UPDATE
      SET "Status"='Pending',"Attempts"=0,"NextAttemptUtc"=now(),"LeaseUntilUtc"=NULL,"LastError"=NULL,"UpdatedAtUtc"=now()
      WHERE "CustomerMessageOutbox"."Status"='Cancelled' AND EXCLUDED."DueAtUtc">now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "TR_CustomerMessagingPreferences_Outbox" ON "CustomerMessagingPreferences";
CREATE TRIGGER "TR_CustomerMessagingPreferences_Outbox" AFTER INSERT OR UPDATE ON "CustomerMessagingPreferences"
FOR EACH ROW EXECUTE FUNCTION avzar_cancel_opted_out_customer_messages();
