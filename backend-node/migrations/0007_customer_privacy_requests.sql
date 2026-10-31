-- Customer data export/deletion requests. Requests are reviewed by the business; no customer or financial records are auto-deleted.
CREATE TABLE IF NOT EXISTS "CustomerPrivacyRequests" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "CustomerId" uuid NOT NULL,
  "Type" character varying(20) NOT NULL,
  "Status" character varying(20) NOT NULL DEFAULT 'Pending',
  "CustomerNote" character varying(500),
  "StaffNote" character varying(500),
  "CreatedAtUtc" timestamp with time zone NOT NULL DEFAULT now(),
  "UpdatedAtUtc" timestamp with time zone,
  "ReviewedAtUtc" timestamp with time zone,
  "ReviewedByUserId" uuid,
  CONSTRAINT "PK_CustomerPrivacyRequests" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_CustomerPrivacyRequests_Type" CHECK ("Type" IN ('Export', 'Deletion')),
  CONSTRAINT "CK_CustomerPrivacyRequests_Status" CHECK ("Status" IN ('Pending', 'Approved', 'Denied', 'Completed')),
  CONSTRAINT "FK_CustomerPrivacyRequests_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_CustomerPrivacyRequests_Customers_CustomerId_BusinessId" FOREIGN KEY ("CustomerId", "BusinessId") REFERENCES "Customers" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_CustomerPrivacyRequests_AspNetUsers_ReviewedByUserId" FOREIGN KEY ("ReviewedByUserId") REFERENCES "AspNetUsers" ("Id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "IX_CustomerPrivacyRequests_BusinessId_Status_CreatedAtUtc"
  ON "CustomerPrivacyRequests" ("BusinessId", "Status", "CreatedAtUtc" DESC);
CREATE INDEX IF NOT EXISTS "IX_CustomerPrivacyRequests_CustomerId_BusinessId_CreatedAtUtc"
  ON "CustomerPrivacyRequests" ("CustomerId", "BusinessId", "CreatedAtUtc" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "UX_CustomerPrivacyRequests_Pending"
  ON "CustomerPrivacyRequests" ("BusinessId", "CustomerId", "Type") WHERE "Status" = 'Pending';
