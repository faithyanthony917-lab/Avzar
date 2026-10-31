-- Step-14: a storefront booking request becomes an appointment. A staff member schedules it from the requests screen;
-- the inquiry is marked Converted and points at the appointment it produced. Nullable: older rows and every request
-- that became an order (or was never acted on) have none. The key carries BusinessId so a link cannot cross businesses.
ALTER TABLE "Inquiries" ADD COLUMN "AppointmentId" uuid;

ALTER TABLE "Inquiries" ADD CONSTRAINT "FK_Inquiries_Appointments_AppointmentId_BusinessId"
  FOREIGN KEY ("AppointmentId", "BusinessId") REFERENCES "Appointments" ("Id", "BusinessId") ON DELETE RESTRICT;

-- One appointment comes from at most one request.
CREATE UNIQUE INDEX "UX_Inquiries_AppointmentId" ON "Inquiries" ("AppointmentId") WHERE "AppointmentId" IS NOT NULL;
