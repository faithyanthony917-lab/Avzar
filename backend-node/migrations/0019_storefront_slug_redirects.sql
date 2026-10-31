CREATE TABLE "StorefrontSlugRedirects" (
  "OldSlug" character varying(40) NOT NULL,
  "StorefrontId" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "CreatedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_StorefrontSlugRedirects" PRIMARY KEY ("OldSlug"),
  CONSTRAINT "FK_StorefrontSlugRedirects_Storefronts" FOREIGN KEY ("StorefrontId", "BusinessId")
    REFERENCES "Storefronts" ("Id", "BusinessId") ON DELETE CASCADE
);
CREATE INDEX "IX_StorefrontSlugRedirects_StorefrontId_BusinessId"
  ON "StorefrontSlugRedirects" ("StorefrontId", "BusinessId");