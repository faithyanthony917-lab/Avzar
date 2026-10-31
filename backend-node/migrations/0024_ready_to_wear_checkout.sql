-- Ready-to-wear stock is separate from tailoring materials. Quantities are integers and reservations are durable.
CREATE UNIQUE INDEX IF NOT EXISTS "UX_Designs_Id_BusinessId" ON "Designs" ("Id", "BusinessId");
CREATE UNIQUE INDEX IF NOT EXISTS "UX_Storefronts_Id_BusinessId" ON "Storefronts" ("Id", "BusinessId");
CREATE TABLE IF NOT EXISTS "ReadyToWearVariants" (
  "Id" uuid NOT NULL PRIMARY KEY,
  "BusinessId" uuid NOT NULL,
  "DesignId" uuid NOT NULL,
  "SKU" varchar(80) NOT NULL,
  "Size" varchar(40),
  "Colour" varchar(60),
  "OnHand" integer NOT NULL DEFAULT 0,
  "Reserved" integer NOT NULL DEFAULT 0,
  "IsActive" boolean NOT NULL DEFAULT TRUE,
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CK_ReadyToWearVariants_Stock" CHECK ("OnHand" >= 0 AND "Reserved" >= 0 AND "Reserved" <= "OnHand"),
  CONSTRAINT "UQ_ReadyToWearVariants_Business_Id" UNIQUE ("BusinessId", "Id"),
  CONSTRAINT "UQ_ReadyToWearVariants_Id_Business" UNIQUE ("Id", "BusinessId"),
  CONSTRAINT "UQ_ReadyToWearVariants_SKU" UNIQUE ("BusinessId", "SKU"),
  CONSTRAINT "FK_ReadyToWearVariants_Design_Business" FOREIGN KEY ("DesignId", "BusinessId") REFERENCES "Designs" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_ReadyToWearVariants_Business" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "IX_ReadyToWearVariants_Design_Active" ON "ReadyToWearVariants" ("BusinessId", "DesignId", "IsActive");

CREATE TABLE IF NOT EXISTS "ReadyToWearOrders" (
  "Id" uuid NOT NULL PRIMARY KEY,
  "BusinessId" uuid NOT NULL,
  "StorefrontId" uuid NOT NULL,
  "CustomerName" varchar(120) NOT NULL,
  "Email" varchar(254) NOT NULL,
  "Phone" varchar(40),
  "Status" varchar(24) NOT NULL DEFAULT 'PendingPayment',
  "CurrencyCode" varchar(3) NOT NULL DEFAULT 'NGN',
  "AmountMinor" bigint NOT NULL,
  "PaymentReference" varchar(100) NOT NULL UNIQUE,
  "IdempotencyKey" varchar(120) NOT NULL,
  "RequestHash" varchar(64) NOT NULL,
  "AuthorizationUrl" text,
  "ExpiresAtUtc" timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "PaidAtUtc" timestamptz,
  CONSTRAINT "CK_ReadyToWearOrders_Status" CHECK ("Status" IN ('PendingPayment','Paid','Cancelled','Expired')),
  CONSTRAINT "CK_ReadyToWearOrders_Amount" CHECK ("AmountMinor" > 0),
  CONSTRAINT "UQ_ReadyToWearOrders_Id_Business" UNIQUE ("Id", "BusinessId"),
  CONSTRAINT "UQ_ReadyToWearOrders_Idempotency" UNIQUE ("BusinessId", "IdempotencyKey"),
  CONSTRAINT "FK_ReadyToWearOrders_Business" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_ReadyToWearOrders_Storefront_Business" FOREIGN KEY ("StorefrontId", "BusinessId") REFERENCES "Storefronts" ("Id", "BusinessId") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "IX_ReadyToWearOrders_Status_Created" ON "ReadyToWearOrders" ("Status", "CreatedAtUtc");

CREATE TABLE IF NOT EXISTS "ReadyToWearOrderItems" (
  "Id" uuid NOT NULL PRIMARY KEY,
  "BusinessId" uuid NOT NULL,
  "OrderId" uuid NOT NULL,
  "VariantId" uuid NOT NULL,
  "DesignId" uuid NOT NULL,
  "ProductName" varchar(120) NOT NULL,
  "VariantLabel" varchar(120) NOT NULL,
  "Quantity" integer NOT NULL,
  "UnitPriceMinor" bigint NOT NULL,
  CONSTRAINT "CK_ReadyToWearOrderItems_Quantity" CHECK ("Quantity" > 0),
  CONSTRAINT "CK_ReadyToWearOrderItems_Price" CHECK ("UnitPriceMinor" > 0),
  CONSTRAINT "FK_ReadyToWearOrderItems_Order_Business" FOREIGN KEY ("OrderId", "BusinessId") REFERENCES "ReadyToWearOrders" ("Id", "BusinessId") ON DELETE CASCADE,
  CONSTRAINT "FK_ReadyToWearOrderItems_Variant_Business" FOREIGN KEY ("VariantId", "BusinessId") REFERENCES "ReadyToWearVariants" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_ReadyToWearOrderItems_Design_Business" FOREIGN KEY ("DesignId", "BusinessId") REFERENCES "Designs" ("Id", "BusinessId") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "ReadyToWearReservations" (
  "Id" uuid NOT NULL PRIMARY KEY,
  "BusinessId" uuid NOT NULL,
  "OrderId" uuid NOT NULL,
  "VariantId" uuid NOT NULL,
  "Quantity" integer NOT NULL,
  "Status" varchar(16) NOT NULL DEFAULT 'Reserved',
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CK_ReadyToWearReservations_Quantity" CHECK ("Quantity" > 0),
  CONSTRAINT "CK_ReadyToWearReservations_Status" CHECK ("Status" IN ('Reserved','Consumed','Released')),
  CONSTRAINT "UQ_ReadyToWearReservations_Order_Variant" UNIQUE ("OrderId", "VariantId"),
  CONSTRAINT "FK_ReadyToWearReservations_Order_Business" FOREIGN KEY ("OrderId", "BusinessId") REFERENCES "ReadyToWearOrders" ("Id", "BusinessId") ON DELETE CASCADE,
  CONSTRAINT "FK_ReadyToWearReservations_Variant_Business" FOREIGN KEY ("VariantId", "BusinessId") REFERENCES "ReadyToWearVariants" ("Id", "BusinessId") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "IX_ReadyToWearReservations_Status" ON "ReadyToWearReservations" ("Status", "CreatedAtUtc");
