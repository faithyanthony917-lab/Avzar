-- Node-owned overlay for inventory active state; EF-owned Materials remains unchanged.
CREATE TABLE IF NOT EXISTS "NodeMaterialStates" (
  "BusinessId" uuid NOT NULL,
  "MaterialId" uuid NOT NULL,
  "IsActive" boolean NOT NULL DEFAULT true,
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedByUserId" uuid NOT NULL,
  PRIMARY KEY ("BusinessId", "MaterialId")
);
CREATE INDEX IF NOT EXISTS "IX_NodeMaterialStates_BusinessId_IsActive" ON "NodeMaterialStates" ("BusinessId", "IsActive");
