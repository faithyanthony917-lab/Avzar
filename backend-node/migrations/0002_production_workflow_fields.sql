ALTER TABLE "Workflows"
  ADD COLUMN IF NOT EXISTS "GarmentCategories" text[] NOT NULL DEFAULT '{}';

ALTER TABLE "Stages"
  ADD COLUMN IF NOT EXISTS "CompletionChecks" text[] NOT NULL DEFAULT '{}';

ALTER TABLE "ProductionTasks"
  ADD COLUMN IF NOT EXISTS "RequiredChecks" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "CompletedChecks" text[] NOT NULL DEFAULT '{}';
