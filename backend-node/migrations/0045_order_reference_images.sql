-- Step 18a: reference images on an order (a customer's inspiration photos, a sketch, a fabric swatch).
-- One row links an order to an image in MediaAssets (Purpose 'OrderReferenceImage'). The image belongs to the order, not to a line:
-- an order amendment can delete and re-create lines, and the images must survive that. They are private to the business: they never
-- appear in the media library, on the public storefront, or as a logo (the media queries exclude the purpose, as for task photos).
-- At most 10 images per order (enforced in the service under a row lock on the order).
CREATE TABLE "OrderReferenceImages" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "OrderId" uuid NOT NULL,
  "MediaAssetId" uuid NOT NULL,
  "UploadedByUserId" uuid,
  "Caption" character varying(500),
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_OrderReferenceImages" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_OrderReferenceImages_Business_Media" UNIQUE ("BusinessId", "MediaAssetId"),
  CONSTRAINT "FK_OrderReferenceImages_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_OrderReferenceImages_Orders_OrderId_BusinessId" FOREIGN KEY ("OrderId", "BusinessId") REFERENCES "Orders" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_OrderReferenceImages_MediaAssets_MediaAssetId_BusinessId" FOREIGN KEY ("MediaAssetId", "BusinessId") REFERENCES "MediaAssets" ("Id", "BusinessId") ON DELETE RESTRICT
);
CREATE INDEX "IX_OrderReferenceImages_BusinessId_OrderId_CreatedAtUtc" ON "OrderReferenceImages" ("BusinessId", "OrderId", "CreatedAtUtc");

ALTER TABLE "OrderReferenceImages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderReferenceImages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avzar_business_isolation ON "OrderReferenceImages";
CREATE POLICY avzar_business_isolation ON "OrderReferenceImages"
  USING ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid);
