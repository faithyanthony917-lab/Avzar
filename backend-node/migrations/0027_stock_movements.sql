-- Preserve the stock ledger shape already consumed by inventoryService and add purchase-receipt metadata.
CREATE TABLE IF NOT EXISTS "StockMovements" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "MaterialId" uuid NOT NULL,
  "Kind" character varying(20) NOT NULL,
  "Quantity" numeric(18,3) NOT NULL,
  "OnHandAfter" numeric(18,3) NOT NULL,
  "ReservedAfter" numeric(18,3) NOT NULL,
  "OrderId" uuid,
  "TaskId" uuid,
  "ActorUserId" uuid,
  "Note" character varying(500),
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAtUtc" timestamptz,
  "LocationId" uuid,
  "MovementType" character varying(20),
  "QuantityDelta" numeric(18,3),
  "UnitCost" numeric(14,2),
  "ReferenceType" character varying(30),
  "ReferenceId" uuid,
  "IdempotencyKey" character varying(120),
  "Reason" character varying(500),
  "CreatedByUserId" uuid,
  CONSTRAINT "PK_StockMovements" PRIMARY KEY ("Id"),
  CONSTRAINT "FK_StockMovements_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_StockMovements_Materials_MaterialId_BusinessId" FOREIGN KEY ("MaterialId", "BusinessId") REFERENCES "Materials" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "CK_StockMovements_Quantity" CHECK ("Quantity" >= 0),
  CONSTRAINT "CK_StockMovements_OnHand" CHECK ("OnHandAfter" >= 0 AND "ReservedAfter" >= 0 AND "ReservedAfter" <= "OnHandAfter"),
  CONSTRAINT "CK_StockMovements_MovementType" CHECK ("MovementType" IS NULL OR "MovementType" IN ('Receipt','Issue','Adjustment','Return','TransferIn','TransferOut')),
  CONSTRAINT "CK_StockMovements_QuantityDelta" CHECK ("QuantityDelta" IS NULL OR "QuantityDelta" <> 0),
  CONSTRAINT "CK_StockMovements_UnitCost" CHECK ("UnitCost" IS NULL OR "UnitCost" >= 0),
  CONSTRAINT "CK_StockMovements_Idempotency" CHECK ("IdempotencyKey" IS NULL OR length(trim("IdempotencyKey")) > 0)
);
-- The baseline already creates the legacy ledger on fresh databases; adopted historical EF databases do not.
-- Add only the purchase-receipt extension when the legacy table already exists.
ALTER TABLE "StockMovements" ADD COLUMN IF NOT EXISTS "LocationId" uuid;
ALTER TABLE "StockMovements" ADD COLUMN IF NOT EXISTS "MovementType" character varying(20);
ALTER TABLE "StockMovements" ADD COLUMN IF NOT EXISTS "QuantityDelta" numeric(18,3);
ALTER TABLE "StockMovements" ADD COLUMN IF NOT EXISTS "UnitCost" numeric(14,2);
ALTER TABLE "StockMovements" ADD COLUMN IF NOT EXISTS "ReferenceType" character varying(30);
ALTER TABLE "StockMovements" ADD COLUMN IF NOT EXISTS "ReferenceId" uuid;
ALTER TABLE "StockMovements" ADD COLUMN IF NOT EXISTS "IdempotencyKey" character varying(120);
ALTER TABLE "StockMovements" ADD COLUMN IF NOT EXISTS "Reason" character varying(500);
ALTER TABLE "StockMovements" ADD COLUMN IF NOT EXISTS "CreatedByUserId" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_StockMovements_Businesses_BusinessId' AND conrelid='"StockMovements"'::regclass) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "FK_StockMovements_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_StockMovements_Materials_MaterialId_BusinessId' AND conrelid='"StockMovements"'::regclass) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "FK_StockMovements_Materials_MaterialId_BusinessId" FOREIGN KEY ("MaterialId", "BusinessId") REFERENCES "Materials" ("Id", "BusinessId") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CK_StockMovements_Quantity' AND conrelid='"StockMovements"'::regclass) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "CK_StockMovements_Quantity" CHECK ("Quantity" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CK_StockMovements_OnHand' AND conrelid='"StockMovements"'::regclass) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "CK_StockMovements_OnHand" CHECK ("OnHandAfter" >= 0 AND "ReservedAfter" >= 0 AND "ReservedAfter" <= "OnHandAfter");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CK_StockMovements_MovementType' AND conrelid='"StockMovements"'::regclass) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "CK_StockMovements_MovementType" CHECK ("MovementType" IS NULL OR "MovementType" IN ('Receipt','Issue','Adjustment','Return','TransferIn','TransferOut'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CK_StockMovements_QuantityDelta' AND conrelid='"StockMovements"'::regclass) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "CK_StockMovements_QuantityDelta" CHECK ("QuantityDelta" IS NULL OR "QuantityDelta" <> 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CK_StockMovements_UnitCost' AND conrelid='"StockMovements"'::regclass) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "CK_StockMovements_UnitCost" CHECK ("UnitCost" IS NULL OR "UnitCost" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CK_StockMovements_Idempotency' AND conrelid='"StockMovements"'::regclass) THEN
    ALTER TABLE "StockMovements" ADD CONSTRAINT "CK_StockMovements_Idempotency" CHECK ("IdempotencyKey" IS NULL OR length(trim("IdempotencyKey")) > 0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "IX_StockMovements_BusinessId" ON "StockMovements" ("BusinessId");
CREATE INDEX IF NOT EXISTS "IX_StockMovements_BusinessId_MaterialId_CreatedAtUtc" ON "StockMovements" ("BusinessId", "MaterialId", "CreatedAtUtc" DESC);
CREATE INDEX IF NOT EXISTS "IX_StockMovements_MaterialId_BusinessId" ON "StockMovements" ("MaterialId", "BusinessId");
CREATE UNIQUE INDEX IF NOT EXISTS "UX_StockMovements_BusinessId_IdempotencyKey" ON "StockMovements" ("BusinessId", "IdempotencyKey") WHERE "IdempotencyKey" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "IX_StockMovements_BusinessId_LocationId_CreatedAtUtc" ON "StockMovements" ("BusinessId", "LocationId", "CreatedAtUtc" DESC);
