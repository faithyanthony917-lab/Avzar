-- 0006: quotation events (a quotation sent to the customer, and the customer's approval or decline from the customer portal).
-- Additive only: one new table, nothing existing is changed, dropped or rewritten. Idempotent.
--   Type          Sent | Approved | Declined
--   QuotedAtUtc   the Orders.QuotedAtUtc of the quotation version the event is about. Editing a quoted order clears QuotedAtUtc and
--                 re-issuing sets a new one, so an approval can never carry over to a changed quotation.
--   Total         the order total at the time of the event (a snapshot for the audit trail).
--   ActorUserId   the staff member for Sent; NULL for a customer decision (the customer is identified by the order's customer).
--   Note          optional customer message with a decision (untrusted text; always escaped when shown).
CREATE TABLE IF NOT EXISTS "QuotationEvents" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "OrderId" uuid NOT NULL,
  "Type" character varying(20) NOT NULL,
  "QuotedAtUtc" timestamp with time zone NOT NULL,
  "Total" numeric(18,2) NOT NULL,
  "ActorUserId" uuid,
  "Note" character varying(500),
  "CreatedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_QuotationEvents" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_QuotationEvents_Type" CHECK ("Type" IN ('Sent', 'Approved', 'Declined')),
  CONSTRAINT "FK_QuotationEvents_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_QuotationEvents_Orders_OrderId_BusinessId" FOREIGN KEY ("OrderId", "BusinessId") REFERENCES "Orders" ("Id", "BusinessId") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "IX_QuotationEvents_BusinessId_OrderId_CreatedAtUtc" ON "QuotationEvents" ("BusinessId", "OrderId", "CreatedAtUtc");
