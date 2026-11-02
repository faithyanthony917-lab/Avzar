-- Step 18b: task approval. A workflow stage can require a manager's sign-off before its task counts as done.
-- Stages.RequiresApproval is off by default, so every existing workflow behaves as before.
-- A task that needs approval goes InProgress -> AwaitingApproval (worker submits) -> Completed (manager approves)
-- or Paused (manager rejects with a note). Dependent tasks and the order stay waiting until the approval.
ALTER TABLE "Stages" ADD COLUMN "RequiresApproval" boolean NOT NULL DEFAULT false;
ALTER TABLE "ProductionTasks"
  ADD COLUMN "ApprovalNote" character varying(500),
  ADD COLUMN "ApprovalDecidedByUserId" uuid,
  ADD COLUMN "ApprovalDecidedAtUtc" timestamp with time zone;
