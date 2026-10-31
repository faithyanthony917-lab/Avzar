CREATE TABLE "TaskWorkerRequests" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "TaskId" uuid NOT NULL,
  "RequestedByMembershipId" uuid NOT NULL,
  "Type" character varying(24) NOT NULL,
  "Status" character varying(20) NOT NULL,
  "Message" character varying(2000) NOT NULL,
  "PlannedMinutes" integer,
  "ActualMinutes" integer,
  "ReviewedByUserId" uuid,
  "ReviewNote" character varying(1000),
  "CreatedAtUtc" timestamp with time zone NOT NULL,
  "ReviewedAtUtc" timestamp with time zone,
  CONSTRAINT "PK_TaskWorkerRequests" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_TaskWorkerRequests_Type" CHECK ("Type" IN ('Assistance', 'Reassignment', 'Discrepancy')),
  CONSTRAINT "CK_TaskWorkerRequests_Status" CHECK ("Status" IN ('Pending', 'Accepted', 'Declined')),
  CONSTRAINT "CK_TaskWorkerRequests_Minutes" CHECK (("PlannedMinutes" IS NULL OR "PlannedMinutes" > 0) AND ("ActualMinutes" IS NULL OR "ActualMinutes" > 0)),
  CONSTRAINT "CK_TaskWorkerRequests_Discrepancy" CHECK (("Type" = 'Discrepancy' AND "PlannedMinutes" IS NOT NULL AND "ActualMinutes" IS NOT NULL) OR ("Type" <> 'Discrepancy' AND "PlannedMinutes" IS NULL AND "ActualMinutes" IS NULL)),
  CONSTRAINT "FK_TaskWorkerRequests_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_TaskWorkerRequests_ProductionTasks_TaskId_BusinessId" FOREIGN KEY ("TaskId", "BusinessId") REFERENCES "ProductionTasks" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_TaskWorkerRequests_Memberships_RequestedByMembershipId_BusinessId" FOREIGN KEY ("RequestedByMembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE RESTRICT
);
CREATE INDEX "IX_TaskWorkerRequests_BusinessId_Status_CreatedAtUtc" ON "TaskWorkerRequests" ("BusinessId", "Status", "CreatedAtUtc" DESC);
CREATE INDEX "IX_TaskWorkerRequests_TaskId_BusinessId" ON "TaskWorkerRequests" ("TaskId", "BusinessId");
CREATE UNIQUE INDEX "IX_TaskWorkerRequests_PendingTaskType" ON "TaskWorkerRequests" ("BusinessId", "TaskId", "Type") WHERE "Status" = 'Pending';
