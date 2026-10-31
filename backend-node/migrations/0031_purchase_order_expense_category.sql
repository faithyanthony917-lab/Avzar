-- Optional category lets a received purchase-order shipment create its expense atomically with stock receipt.
ALTER TABLE "PurchaseOrders" ADD COLUMN "ExpenseCategoryId" uuid;
ALTER TABLE "PurchaseOrders" ADD CONSTRAINT "FK_PurchaseOrders_ExpenseCategories_ExpenseCategoryId_BusinessId"
  FOREIGN KEY ("ExpenseCategoryId", "BusinessId") REFERENCES "ExpenseCategories" ("Id", "BusinessId") ON DELETE RESTRICT;
CREATE INDEX "IX_PurchaseOrders_ExpenseCategoryId_BusinessId" ON "PurchaseOrders" ("ExpenseCategoryId", "BusinessId") WHERE "ExpenseCategoryId" IS NOT NULL;
