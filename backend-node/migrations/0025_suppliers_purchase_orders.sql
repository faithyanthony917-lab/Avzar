CREATE TABLE "Suppliers" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "Name" character varying(160) NOT NULL,
  "ContactName" character varying(120),
  "Email" character varying(254),
  "Phone" character varying(40),
  "Address" character varying(500),
  "Notes" character varying(2000),
  "IsActive" boolean NOT NULL DEFAULT TRUE,
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAtUtc" timestamptz,
  CONSTRAINT "PK_Suppliers" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_Suppliers_Id_BusinessId" UNIQUE ("Id", "BusinessId"),
  CONSTRAINT "FK_Suppliers_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "CK_Suppliers_Name" CHECK (length(trim("Name")) > 0)
);
CREATE INDEX "IX_Suppliers_BusinessId_Name" ON "Suppliers" ("BusinessId", lower("Name"));

CREATE TABLE "PurchaseOrders" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "SupplierId" uuid NOT NULL,
  "LocationId" uuid NOT NULL,
  "OrderNumber" character varying(40) NOT NULL,
  "Status" character varying(20) NOT NULL DEFAULT 'Draft',
  "OrderedAtUtc" timestamptz,
  "ExpectedAtUtc" timestamptz,
  "ReceivedAtUtc" timestamptz,
  "Currency" character varying(3) NOT NULL DEFAULT 'NGN',
  "Subtotal" numeric(14,2) NOT NULL DEFAULT 0,
  "Notes" character varying(2000),
  "CreatedByUserId" uuid,
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAtUtc" timestamptz,
  CONSTRAINT "PK_PurchaseOrders" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_PurchaseOrders_Id_BusinessId" UNIQUE ("Id", "BusinessId"),
  CONSTRAINT "AK_PurchaseOrders_BusinessId_OrderNumber" UNIQUE ("BusinessId", "OrderNumber"),
  CONSTRAINT "FK_PurchaseOrders_Suppliers_SupplierId_BusinessId" FOREIGN KEY ("SupplierId", "BusinessId") REFERENCES "Suppliers" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_PurchaseOrders_Locations_LocationId_BusinessId" FOREIGN KEY ("LocationId", "BusinessId") REFERENCES "Locations" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "CK_PurchaseOrders_Status" CHECK ("Status" IN ('Draft','Ordered','PartiallyReceived','Received','Cancelled')),
  CONSTRAINT "CK_PurchaseOrders_Subtotal" CHECK ("Subtotal" >= 0),
  CONSTRAINT "CK_PurchaseOrders_Currency" CHECK ("Currency" ~ '^[A-Z]{3}$')
);
CREATE INDEX "IX_PurchaseOrders_BusinessId_Status_CreatedAtUtc" ON "PurchaseOrders" ("BusinessId", "Status", "CreatedAtUtc" DESC);

CREATE TABLE "PurchaseOrderItems" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "PurchaseOrderId" uuid NOT NULL,
  "Description" character varying(240) NOT NULL,
  "Sku" character varying(80),
  "QuantityOrdered" numeric(12,3) NOT NULL,
  "QuantityReceived" numeric(12,3) NOT NULL DEFAULT 0,
  "UnitCost" numeric(14,2) NOT NULL,
  "StockItemId" uuid,
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_PurchaseOrderItems" PRIMARY KEY ("Id"),
  CONSTRAINT "FK_PurchaseOrderItems_PurchaseOrders_PurchaseOrderId_BusinessId" FOREIGN KEY ("PurchaseOrderId", "BusinessId") REFERENCES "PurchaseOrders" ("Id", "BusinessId") ON DELETE CASCADE,
  CONSTRAINT "CK_PurchaseOrderItems_Description" CHECK (length(trim("Description")) > 0),
  CONSTRAINT "CK_PurchaseOrderItems_Quantity" CHECK ("QuantityOrdered" > 0 AND "QuantityReceived" >= 0 AND "QuantityReceived" <= "QuantityOrdered"),
  CONSTRAINT "CK_PurchaseOrderItems_UnitCost" CHECK ("UnitCost" >= 0),
  CONSTRAINT "FK_PurchaseOrderItems_Materials_StockItemId_BusinessId" FOREIGN KEY ("StockItemId", "BusinessId") REFERENCES "Materials" ("Id", "BusinessId") ON DELETE RESTRICT
);
CREATE INDEX "IX_PurchaseOrderItems_BusinessId_PurchaseOrderId" ON "PurchaseOrderItems" ("BusinessId", "PurchaseOrderId");
