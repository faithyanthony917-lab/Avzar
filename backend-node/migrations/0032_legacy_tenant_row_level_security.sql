-- Apply tenant isolation at PostgreSQL's boundary to every public table that carries BusinessId.
-- Access is denied when app.business_id is unset. HTTP authentication binds this setting from the
-- verified token, and db/tenantRlsContext.js applies it transaction-locally on every checked-out
-- connection. Never use session-level SET for this value: pooled connections are reused.
DO $$
DECLARE
  tenant_table record;
  policy_name constant text := 'avzar_business_isolation';
BEGIN
  FOR tenant_table IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'BusinessId'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, tenant_table.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("BusinessId" = NULLIF(current_setting(''app.business_id'', true), '''')::uuid) WITH CHECK ("BusinessId" = NULLIF(current_setting(''app.business_id'', true), '''')::uuid)',
      policy_name, tenant_table.table_name
    );
  END LOOP;
END $$;
