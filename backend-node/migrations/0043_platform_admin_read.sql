-- Step 17b: platform-administrator read access across businesses.
-- The platform screens (failed jobs, queue depth) must list rows of every business. With forced row-level security the API role
-- sees only the current business, so each queue table gets one extra SELECT-only policy that opens while the transaction-local
-- setting app.platform_admin_read = 'on'. The application sets it only inside the platform-admin services, after the
-- PLATFORM_ADMIN_EMAILS check. There is no INSERT, UPDATE or DELETE policy: a retry writes inside that row's own business context.
-- No new table, column or key, so no adoption sums change. Policies other than avzar_business_isolation: 15 before, 20 after.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['NotificationOutbox','PushDeliveries','WorkerSummaryJobs','AppointmentReminders','EmailOutbox'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS avzar_platform_admin_read ON %I', t);
    EXECUTE format($p$CREATE POLICY avzar_platform_admin_read ON %I FOR SELECT USING (current_setting('app.platform_admin_read', true) = 'on')$p$, t);
  END LOOP;
END $$;
