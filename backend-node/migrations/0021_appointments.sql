CREATE TABLE "Appointments" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "Type" character varying(20) NOT NULL,
  "CustomerId" uuid NOT NULL,
  "OrderId" uuid,
  "LocationId" uuid NOT NULL,
  "AssignedMembershipId" uuid,
  "StartUtc" timestamp with time zone NOT NULL,
  "EndUtc" timestamp with time zone NOT NULL,
  "TimeZoneId" character varying(64) NOT NULL,
  "Status" character varying(20) NOT NULL,
  "Notes" character varying(2000),
  "CancellationReason" character varying(500),
  "CreatedByUserId" uuid,
  "CreatedAtUtc" timestamp with time zone NOT NULL,
  "UpdatedAtUtc" timestamp with time zone,
  CONSTRAINT "PK_Appointments" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_Appointments_Id_BusinessId" UNIQUE ("Id", "BusinessId"),
  CONSTRAINT "CK_Appointments_Type" CHECK ("Type" IN ('Fitting', 'Consultation', 'Collection', 'Delivery')),
  CONSTRAINT "CK_Appointments_Status" CHECK ("Status" IN ('Scheduled', 'Completed', 'Cancelled', 'NoShow')),
  CONSTRAINT "CK_Appointments_Interval" CHECK ("StartUtc" < "EndUtc"),
  CONSTRAINT "FK_Appointments_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_Appointments_Customers_CustomerId_BusinessId" FOREIGN KEY ("CustomerId", "BusinessId") REFERENCES "Customers" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_Appointments_Orders_OrderId_BusinessId" FOREIGN KEY ("OrderId", "BusinessId") REFERENCES "Orders" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_Appointments_Locations_LocationId_BusinessId" FOREIGN KEY ("LocationId", "BusinessId") REFERENCES "Locations" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_Appointments_Memberships_AssignedMembershipId_BusinessId" FOREIGN KEY ("AssignedMembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE RESTRICT
);

INSERT INTO "Appointments" (
  "Id", "BusinessId", "Type", "CustomerId", "OrderId", "LocationId", "AssignedMembershipId",
  "StartUtc", "EndUtc", "TimeZoneId", "Status", "Notes", "CreatedByUserId", "CreatedAtUtc", "UpdatedAtUtc")
SELECT fitting."Id", fitting."BusinessId", 'Fitting', fitting."CustomerId", fitting."OrderId", fitting."LocationId", NULL,
  fitting."ScheduledAtUtc", fitting."ScheduledAtUtc" + make_interval(mins => fitting."DurationMinutes"),
  business."TimeZoneId", fitting."Status", fitting."Notes", fitting."CreatedByUserId", fitting."CreatedAtUtc", fitting."UpdatedAtUtc"
FROM "Fittings" fitting
JOIN "Businesses" business ON business."Id" = fitting."BusinessId";

CREATE INDEX "IX_Appointments_BusinessId_StartUtc" ON "Appointments" ("BusinessId", "StartUtc");
CREATE INDEX "IX_Appointments_BusinessId_CustomerId_StartUtc" ON "Appointments" ("BusinessId", "CustomerId", "StartUtc");
CREATE INDEX "IX_Appointments_BusinessId_AssignedMembershipId_StartUtc" ON "Appointments" ("BusinessId", "AssignedMembershipId", "StartUtc");
CREATE INDEX "IX_Appointments_BusinessId_LocationId_StartUtc" ON "Appointments" ("BusinessId", "LocationId", "StartUtc");

CREATE TABLE "AppointmentReminders" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "AppointmentId" uuid NOT NULL,
  "RecipientMembershipId" uuid NOT NULL,
  "AppointmentStartUtc" timestamp with time zone NOT NULL,
  "OffsetMinutes" smallint NOT NULL,
  "DueAtUtc" timestamp with time zone NOT NULL,
  "Status" character varying(16) NOT NULL DEFAULT 'Pending',
  "Attempts" integer NOT NULL DEFAULT 0,
  "NextAttemptUtc" timestamp with time zone NOT NULL,
  "LeaseUntilUtc" timestamp with time zone,
  "LastError" character varying(400),
  "CreatedAtUtc" timestamp with time zone NOT NULL,
  "SentAtUtc" timestamp with time zone,
  "CancelledAtUtc" timestamp with time zone,
  CONSTRAINT "PK_AppointmentReminders" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_AppointmentReminders_Offset" CHECK ("OffsetMinutes" IN (120, 1440)),
  CONSTRAINT "CK_AppointmentReminders_Status" CHECK ("Status" IN ('Pending', 'Leased', 'Sent', 'Cancelled', 'Failed')),
  CONSTRAINT "CK_AppointmentReminders_Attempts" CHECK ("Attempts" >= 0),
  CONSTRAINT "FK_AppointmentReminders_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_AppointmentReminders_Appointments_AppointmentId_BusinessId" FOREIGN KEY ("AppointmentId", "BusinessId") REFERENCES "Appointments" ("Id", "BusinessId") ON DELETE CASCADE,
  CONSTRAINT "FK_AppointmentReminders_Memberships_RecipientMembershipId_BusinessId" FOREIGN KEY ("RecipientMembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "AK_AppointmentReminders_Dedupe" UNIQUE ("BusinessId", "AppointmentId", "AppointmentStartUtc", "OffsetMinutes")
);
CREATE INDEX "IX_AppointmentReminders_Claim" ON "AppointmentReminders" ("NextAttemptUtc", "DueAtUtc", "Id") WHERE "Status" IN ('Pending', 'Leased');

ALTER TABLE "Notifications" DROP CONSTRAINT "CK_Notifications_TargetKind";
ALTER TABLE "Notifications" ADD CONSTRAINT "CK_Notifications_TargetKind"
  CHECK ("TargetKind" IS NULL OR "TargetKind" IN ('task', 'order', 'invoice', 'inquiry', 'material', 'subscription', 'quotation', 'payment', 'appointment'));
ALTER TABLE "NotificationOutbox" DROP CONSTRAINT "CK_NotificationOutbox_TargetKind";
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "CK_NotificationOutbox_TargetKind"
  CHECK ("TargetKind" IS NULL OR "TargetKind" IN ('task', 'order', 'invoice', 'inquiry', 'material', 'subscription', 'quotation', 'payment', 'appointment'));