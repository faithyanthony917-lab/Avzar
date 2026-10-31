-- Step 15a: online payment of an issued invoice or deposit (Paystack split payment).
--
-- Businesses.PaymentSubaccountCode is the Paystack subaccount the business's own bank account is attached to. It holds only the
-- provider's code: the bank account number is sent to the provider once and is never stored here.
-- InvoicePaymentAttempts records each payment link or checkout started for an invoice. A verified provider payment becomes a
-- row in Payments through the webhook; an attempt never changes an invoice balance by itself.
ALTER TABLE "Businesses" ADD COLUMN "PaymentSubaccountCode" character varying(60);

CREATE TABLE "InvoicePaymentAttempts" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "InvoiceId" uuid NOT NULL,
  "CustomerId" uuid NOT NULL,
  "Reference" character varying(100) NOT NULL,
  "Amount" numeric(18,2) NOT NULL,
  "CurrencyCode" character varying(3) NOT NULL,
  "Status" character varying(20) NOT NULL DEFAULT 'Pending',
  "Source" character varying(10) NOT NULL,
  "IdempotencyKey" character varying(100),
  "RequestedByUserId" uuid,
  "AuthorizationUrl" character varying(2000),
  "ExpiresAtUtc" timestamp with time zone NOT NULL,
  "PaymentId" uuid,
  "FailureReason" character varying(300),
  "CreatedAtUtc" timestamp with time zone NOT NULL DEFAULT now(),
  "UpdatedAtUtc" timestamp with time zone,
  CONSTRAINT "PK_InvoicePaymentAttempts" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_InvoicePaymentAttempts_Amount" CHECK ("Amount" > 0),
  CONSTRAINT "CK_InvoicePaymentAttempts_Status" CHECK ("Status" IN ('Pending', 'Paid', 'Failed', 'NeedsReview')),
  CONSTRAINT "CK_InvoicePaymentAttempts_Source" CHECK ("Source" IN ('Staff', 'Portal')),
  CONSTRAINT "CK_InvoicePaymentAttempts_PaidHasPayment" CHECK ("Status" <> 'Paid' OR "PaymentId" IS NOT NULL)
);

ALTER TABLE "InvoicePaymentAttempts" ADD CONSTRAINT "FK_InvoicePaymentAttempts_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
ALTER TABLE "InvoicePaymentAttempts" ADD CONSTRAINT "FK_InvoicePaymentAttempts_Invoices_InvoiceId_BusinessId" FOREIGN KEY ("InvoiceId", "BusinessId") REFERENCES "Invoices" ("Id", "BusinessId") ON DELETE RESTRICT;
ALTER TABLE "InvoicePaymentAttempts" ADD CONSTRAINT "FK_InvoicePaymentAttempts_Customers_CustomerId_BusinessId" FOREIGN KEY ("CustomerId", "BusinessId") REFERENCES "Customers" ("Id", "BusinessId") ON DELETE RESTRICT;
ALTER TABLE "InvoicePaymentAttempts" ADD CONSTRAINT "FK_InvoicePaymentAttempts_Payments_PaymentId_BusinessId" FOREIGN KEY ("PaymentId", "BusinessId") REFERENCES "Payments" ("Id", "BusinessId") ON DELETE RESTRICT;

-- A provider reference is unique across the whole platform: the webhook finds the business from it.
CREATE UNIQUE INDEX "UX_InvoicePaymentAttempts_Reference" ON "InvoicePaymentAttempts" ("Reference");
CREATE UNIQUE INDEX "UX_InvoicePaymentAttempts_BusinessId_IdempotencyKey" ON "InvoicePaymentAttempts" ("BusinessId", "IdempotencyKey") WHERE "IdempotencyKey" IS NOT NULL;
CREATE INDEX "IX_InvoicePaymentAttempts_BusinessId_InvoiceId" ON "InvoicePaymentAttempts" ("BusinessId", "InvoiceId", "CreatedAtUtc");

-- Same isolation as 0032 (a table created after 0032 does not get it from that migration), plus the key-matched lookup of 0033's kind:
-- the webhook holds only the provider reference and learns the business by reading the attempt it names. SELECT only.
ALTER TABLE "InvoicePaymentAttempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoicePaymentAttempts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avzar_business_isolation ON "InvoicePaymentAttempts";
CREATE POLICY avzar_business_isolation ON "InvoicePaymentAttempts"
  USING ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid);

DROP POLICY IF EXISTS avzar_lookup_invoice_payment_reference ON "InvoicePaymentAttempts";
CREATE POLICY avzar_lookup_invoice_payment_reference ON "InvoicePaymentAttempts" FOR SELECT
  USING ("Reference" = NULLIF(current_setting('app.lookup_invoice_payment_reference', true), ''));
