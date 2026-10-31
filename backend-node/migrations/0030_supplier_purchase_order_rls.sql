-- Enforce tenant context at the database boundary for the new supplier/purchase-order domain.
-- HTTP routes set app.business_id transaction-locally before querying these tables.
-- This deliberately does not enable RLS on legacy tables: those routes have not yet been migrated
-- to transaction-scoped tenant context, and enabling it globally would break existing requests.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Suppliers','PurchaseOrders','PurchaseOrderItems'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'avzar_business_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("BusinessId" = NULLIF(current_setting(''app.business_id'', true), '''')::uuid) WITH CHECK ("BusinessId" = NULLIF(current_setting(''app.business_id'', true), '''')::uuid)',
      'avzar_business_isolation', table_name
    );
  END LOOP;
END $$;
