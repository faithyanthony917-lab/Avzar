-- 0014: durable morning and end-of-day worker summaries (roadmap item A2).
-- One run is unique per membership, summary type, and business-local date. The event ledger prevents TaskEvents
-- from being included more than once for a worker and summary type, even if a job is reclaimed after a crash.
ALTER TABLE "TaskEvents" ADD CONSTRAINT "AK_TaskEvents_Id_BusinessId" UNIQUE ("Id", "BusinessId");

CREATE TABLE "WorkerSummaryJobs" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "RecipientMembershipId" uuid NOT NULL,
  "SummaryType" character varying(20) NOT NULL,
  "SummaryDate" date NOT NULL,
  "ScheduledAtUtc" timestamp with time zone NOT NULL,
  "WindowStartUtc" timestamp with time zone NOT NULL,
  "WindowEndUtc" timestamp with time zone NOT NULL,
  "Status" character varying(16) NOT NULL DEFAULT 'Pending',
  "Attempts" integer NOT NULL DEFAULT 0,
  "NextAttemptUtc" timestamp with time zone NOT NULL,
  "LeaseUntilUtc" timestamp with time zone,
  "LastError" character varying(400),
  "CreatedAtUtc" timestamp with time zone NOT NULL,
  "SentAtUtc" timestamp with time zone,
  CONSTRAINT "PK_WorkerSummaryJobs" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_WorkerSummaryJobs_Id_Business_Membership_Type" UNIQUE ("Id", "BusinessId", "RecipientMembershipId", "SummaryType"),
  CONSTRAINT "AK_WorkerSummaryJobs_Daily" UNIQUE ("BusinessId", "RecipientMembershipId", "SummaryType", "SummaryDate"),
  CONSTRAINT "CK_WorkerSummaryJobs_Type" CHECK ("SummaryType" IN ('morning', 'end_of_day')),
  CONSTRAINT "CK_WorkerSummaryJobs_Status" CHECK ("Status" IN ('Pending', 'Leased', 'Sent', 'Failed')),
  CONSTRAINT "CK_WorkerSummaryJobs_Attempts" CHECK ("Attempts" >= 0),
  CONSTRAINT "CK_WorkerSummaryJobs_Window" CHECK ("WindowEndUtc" > "WindowStartUtc"),
  CONSTRAINT "FK_WorkerSummaryJobs_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_WorkerSummaryJobs_Memberships_RecipientMembershipId_BusinessId" FOREIGN KEY ("RecipientMembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE
);
CREATE INDEX "IX_WorkerSummaryJobs_Claim" ON "WorkerSummaryJobs" ("NextAttemptUtc", "ScheduledAtUtc")
  WHERE "Status" IN ('Pending', 'Leased');
CREATE INDEX "IX_WorkerSummaryJobs_Business_Date" ON "WorkerSummaryJobs" ("BusinessId", "SummaryDate" DESC);

CREATE TABLE "WorkerSummaryEvents" (
  "BusinessId" uuid NOT NULL,
  "RecipientMembershipId" uuid NOT NULL,
  "SummaryType" character varying(20) NOT NULL,
  "SummaryJobId" uuid NOT NULL,
  "EventId" uuid NOT NULL,
  "TaskId" uuid NOT NULL,
  "EventType" character varying(40) NOT NULL,
  "EventAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_WorkerSummaryEvents" PRIMARY KEY ("BusinessId", "RecipientMembershipId", "SummaryType", "EventId"),
  CONSTRAINT "FK_WorkerSummaryEvents_Jobs" FOREIGN KEY ("SummaryJobId", "BusinessId", "RecipientMembershipId", "SummaryType") REFERENCES "WorkerSummaryJobs" ("Id", "BusinessId", "RecipientMembershipId", "SummaryType") ON DELETE CASCADE,
  CONSTRAINT "FK_WorkerSummaryEvents_Memberships" FOREIGN KEY ("RecipientMembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE,
  CONSTRAINT "FK_WorkerSummaryEvents_TaskEvents" FOREIGN KEY ("EventId", "BusinessId") REFERENCES "TaskEvents" ("Id", "BusinessId") ON DELETE RESTRICT
);
CREATE INDEX "IX_WorkerSummaryEvents_Job" ON "WorkerSummaryEvents" ("SummaryJobId", "EventAtUtc", "EventId");