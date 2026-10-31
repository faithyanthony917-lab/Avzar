-- Step 15b: installment plans. A plan is only a schedule on one issued invoice: a list of dated amounts that add up to what was
-- owed when the plan was made. It never holds money. Payments keep landing on the invoice, and the schedule is read against them,
-- oldest installment first, so the invoice stays the single source of truth for money.
--
-- PaidAtCreation and CreditedAtCreation record what the invoice had already received and been credited when the plan was made.
-- The installments add up to the balance at that moment, so only money and credits that arrive afterwards are read against them.
-- The status of each installment (paid, part paid, due, overdue) is calculated on every read and is never stored here.
CREATE TABLE "InvoiceInstallmentPlans" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "InvoiceId" uuid NOT NULL,
  "Status" character varying(20) NOT NULL DEFAULT 'Active',
  "PaidAtCreation" numeric(18,2) NOT NULL DEFAULT 0,
  "CreditedAtCreation" numeric(18,2) NOT NULL DEFAULT 0,
  "Note" character varying(500),
  "CreatedByUserId" uuid,
  "CreatedAtUtc" timestamp with time zone NOT NULL DEFAULT now(),
  "CancelledByUserId" uuid,
  "CancelledAtUtc" timestamp with time zone,
  "CancelReason" character varying(200),
  CONSTRAINT "PK_InvoiceInstallmentPlans" PRIMARY KEY ("Id"),
  CONSTRAINT "UQ_InvoiceInstallmentPlans_Id_BusinessId" UNIQUE ("Id", "BusinessId"),
  CONSTRAINT "CK_InvoiceInstallmentPlans_Status" CHECK ("Status" IN ('Active', 'Cancelled')),
  CONSTRAINT "CK_InvoiceInstallmentPlans_Baseline" CHECK ("PaidAtCreation" >= 0 AND "CreditedAtCreation" >= 0),
  CONSTRAINT "CK_InvoiceInstallmentPlans_CancelledHasTime" CHECK ("Status" <> 'Cancelled' OR "CancelledAtUtc" IS NOT NULL)
);

ALTER TABLE "InvoiceInstallmentPlans" ADD CONSTRAINT "FK_InvoiceInstallmentPlans_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
ALTER TABLE "InvoiceInstallmentPlans" ADD CONSTRAINT "FK_InvoiceInstallmentPlans_Invoices_InvoiceId_BusinessId" FOREIGN KEY ("InvoiceId", "BusinessId") REFERENCES "Invoices" ("Id", "BusinessId") ON DELETE RESTRICT;

-- One Active plan per invoice; cancelled plans stay as history.
CREATE UNIQUE INDEX "UX_InvoiceInstallmentPlans_InvoiceId_Active" ON "InvoiceInstallmentPlans" ("BusinessId", "InvoiceId") WHERE "Status" = 'Active';
CREATE INDEX "IX_InvoiceInstallmentPlans_BusinessId_InvoiceId" ON "InvoiceInstallmentPlans" ("BusinessId", "InvoiceId", "CreatedAtUtc");

CREATE TABLE "InvoiceInstallments" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "PlanId" uuid NOT NULL,
  "Sequence" integer NOT NULL,
  "DueDate" date NOT NULL,
  "Amount" numeric(18,2) NOT NULL,
  CONSTRAINT "PK_InvoiceInstallments" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_InvoiceInstallments_Amount" CHECK ("Amount" > 0),
  CONSTRAINT "CK_InvoiceInstallments_Sequence" CHECK ("Sequence" >= 1)
);

ALTER TABLE "InvoiceInstallments" ADD CONSTRAINT "FK_InvoiceInstallments_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT;
ALTER TABLE "InvoiceInstallments" ADD CONSTRAINT "FK_InvoiceInstallments_Plans_PlanId_BusinessId" FOREIGN KEY ("PlanId", "BusinessId") REFERENCES "InvoiceInstallmentPlans" ("Id", "BusinessId") ON DELETE CASCADE;
CREATE UNIQUE INDEX "UX_InvoiceInstallments_PlanId_Sequence" ON "InvoiceInstallments" ("PlanId", "Sequence");
CREATE INDEX "IX_InvoiceInstallments_BusinessId_PlanId" ON "InvoiceInstallments" ("BusinessId", "PlanId");

-- Same isolation as 0032 and 0037 (a table created after 0032 does not get it from that migration). No lookup policy is needed:
-- the portal reaches the invoice through its token, which binds the business first.
ALTER TABLE "InvoiceInstallmentPlans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceInstallmentPlans" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avzar_business_isolation ON "InvoiceInstallmentPlans";
CREATE POLICY avzar_business_isolation ON "InvoiceInstallmentPlans"
  USING ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE "InvoiceInstallments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceInstallments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avzar_business_isolation ON "InvoiceInstallments";
CREATE POLICY avzar_business_isolation ON "InvoiceInstallments"
  USING ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("BusinessId" = NULLIF(current_setting('app.business_id', true), '')::uuid);
