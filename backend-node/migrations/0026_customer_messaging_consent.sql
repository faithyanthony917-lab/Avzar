CREATE TABLE "CustomerMessagingPreferences" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "CustomerId" uuid NOT NULL,
  "Channel" character varying(12) NOT NULL,
  "Address" character varying(254) NOT NULL,
  "ConsentStatus" character varying(12) NOT NULL DEFAULT 'Unknown',
  "ConsentSource" character varying(40),
  "ConsentedAtUtc" timestamptz,
  "OptedOutAtUtc" timestamptz,
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_CustomerMessagingPreferences" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_CustomerMessagingPreferences_Id_BusinessId" UNIQUE ("Id", "BusinessId"),
  CONSTRAINT "AK_CustomerMessagingPreferences_Customer_Channel_Address" UNIQUE ("BusinessId", "CustomerId", "Channel", "Address"),
  CONSTRAINT "FK_CustomerMessagingPreferences_Customers_CustomerId_BusinessId" FOREIGN KEY ("CustomerId", "BusinessId") REFERENCES "Customers" ("Id", "BusinessId") ON DELETE CASCADE,
  CONSTRAINT "CK_CustomerMessagingPreferences_Channel" CHECK ("Channel" IN ('WhatsApp','SMS')),
  CONSTRAINT "CK_CustomerMessagingPreferences_Consent" CHECK ("ConsentStatus" IN ('Unknown','OptedIn','OptedOut')),
  CONSTRAINT "CK_CustomerMessagingPreferences_Address" CHECK (length(trim("Address")) > 0),
  CONSTRAINT "CK_CustomerMessagingPreferences_ConsentDates" CHECK (("ConsentStatus" <> 'OptedIn' OR "ConsentedAtUtc" IS NOT NULL) AND ("ConsentStatus" <> 'OptedOut' OR "OptedOutAtUtc" IS NOT NULL))
);
CREATE INDEX "IX_CustomerMessagingPreferences_Eligible" ON "CustomerMessagingPreferences" ("BusinessId", "Channel", "CustomerId") WHERE "ConsentStatus" = 'OptedIn';
