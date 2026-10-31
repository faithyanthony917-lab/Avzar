-- 0005: subscription lifecycle (trials, scheduled plan changes, failed-payment grace, suspension).
-- Additive only: nothing is dropped, rewritten or deleted, and existing rows keep their meaning. Idempotent.
--   TrialStartedAtUtc  set once when a business starts its (single) free trial; never cleared.
--   GraceEndsAtUtc     set while Status = 'PastDue': paid access continues until then.
--   SuspendedAtUtc     set when Status becomes 'Expired' after the grace period; Free-plan limits apply, no data is touched.
--   PendingPlanId      plan the subscription switches to when the current paid period ends (a downgrade or cancel to Free).
-- Status values in use: Active, Trialing, PastDue, Expired. Existing code treats every status except 'Expired' as "paid plan applies".
ALTER TABLE "Subscriptions"
  ADD COLUMN IF NOT EXISTS "TrialStartedAtUtc" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "GraceEndsAtUtc" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "SuspendedAtUtc" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "PendingPlanId" uuid;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"Subscriptions"'::regclass AND c.confrelid = '"Plans"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['PendingPlanId']::name[]) THEN
    ALTER TABLE "Subscriptions" ADD CONSTRAINT "FK_Subscriptions_Plans_PendingPlanId" FOREIGN KEY ("PendingPlanId") REFERENCES "Plans" ("Id") ON DELETE RESTRICT;
  END IF;
END $mig$;
