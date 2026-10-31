-- 0004: fresh-database correctness. Idempotent: adopted EF databases already have all of this and are left unchanged.
-- (a) Designs primitive collections that the EF-snapshot generator skipped (PrimitiveCollection<List<string>>).
ALTER TABLE "Designs"
  ADD COLUMN IF NOT EXISTS "Tags" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "Fabrics" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "Colours" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "Sizes" text[] NOT NULL DEFAULT '{}';

-- (b) Foreign keys the baseline generator skipped (snapshot entries written without spaces between chained calls).
-- Each is added only if no foreign key with the same table, referenced table and column list exists, whatever its name.

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"WorkerAvailability"'::regclass AND c.confrelid = '"Businesses"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['BusinessId']::name[]) THEN
    ALTER TABLE "WorkerAvailability" ADD CONSTRAINT "FK_WorkerAvailability_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"WorkerAvailability"'::regclass AND c.confrelid = '"Memberships"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['MembershipId','BusinessId']::name[]) THEN
    ALTER TABLE "WorkerAvailability" ADD CONSTRAINT "FK_WorkerAvailability_Memberships_MembershipId_BusinessId" FOREIGN KEY ("MembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"WorkerLeaves"'::regclass AND c.confrelid = '"Businesses"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['BusinessId']::name[]) THEN
    ALTER TABLE "WorkerLeaves" ADD CONSTRAINT "FK_WorkerLeaves_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"WorkerLeaves"'::regclass AND c.confrelid = '"Memberships"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['MembershipId','BusinessId']::name[]) THEN
    ALTER TABLE "WorkerLeaves" ADD CONSTRAINT "FK_WorkerLeaves_Memberships_MembershipId_BusinessId" FOREIGN KEY ("MembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"Materials"'::regclass AND c.confrelid = '"Businesses"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['BusinessId']::name[]) THEN
    ALTER TABLE "Materials" ADD CONSTRAINT "FK_Materials_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"Materials"'::regclass AND c.confrelid = '"Locations"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['LocationId','BusinessId']::name[]) THEN
    ALTER TABLE "Materials" ADD CONSTRAINT "FK_Materials_Locations_LocationId_BusinessId" FOREIGN KEY ("LocationId", "BusinessId") REFERENCES "Locations" ("Id", "BusinessId") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"StockMovements"'::regclass AND c.confrelid = '"Businesses"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['BusinessId']::name[]) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "FK_StockMovements_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"StockMovements"'::regclass AND c.confrelid = '"Materials"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['MaterialId','BusinessId']::name[]) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "FK_StockMovements_Materials_MaterialId_BusinessId" FOREIGN KEY ("MaterialId", "BusinessId") REFERENCES "Materials" ("Id", "BusinessId") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"OwnershipTransferChallenges"'::regclass AND c.confrelid = '"Businesses"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['BusinessId']::name[]) THEN
    ALTER TABLE "OwnershipTransferChallenges" ADD CONSTRAINT "FK_OwnershipTransferChallenges_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"OwnershipTransferChallenges"'::regclass AND c.confrelid = '"Memberships"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['NewOwnerMembershipId','BusinessId']::name[]) THEN
    ALTER TABLE "OwnershipTransferChallenges" ADD CONSTRAINT "FK_OwnershipTransferChallenges_Memberships_NewOwnerMembershipId" FOREIGN KEY ("NewOwnerMembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"CustomerPortalGrants"'::regclass AND c.confrelid = '"Businesses"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['BusinessId']::name[]) THEN
    ALTER TABLE "CustomerPortalGrants" ADD CONSTRAINT "FK_CustomerPortalGrants_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"CustomerPortalGrants"'::regclass AND c.confrelid = '"Customers"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['CustomerId','BusinessId']::name[]) THEN
    ALTER TABLE "CustomerPortalGrants" ADD CONSTRAINT "FK_CustomerPortalGrants_Customers_CustomerId_BusinessId" FOREIGN KEY ("CustomerId", "BusinessId") REFERENCES "Customers" ("Id", "BusinessId") ON DELETE CASCADE;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"SubscriptionPayments"'::regclass AND c.confrelid = '"Businesses"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['BusinessId']::name[]) THEN
    ALTER TABLE "SubscriptionPayments" ADD CONSTRAINT "FK_SubscriptionPayments_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = '"SubscriptionPayments"'::regclass AND c.confrelid = '"Plans"'::regclass
    AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['PlanId']::name[]) THEN
    ALTER TABLE "SubscriptionPayments" ADD CONSTRAINT "FK_SubscriptionPayments_Plans_PlanId" FOREIGN KEY ("PlanId") REFERENCES "Plans" ("Id") ON DELETE RESTRICT;
  END IF;
END $mig$;
