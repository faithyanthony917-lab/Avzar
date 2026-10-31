-- Step 17c: a platform administrator can suspend and reactivate a business, and old queue rows are removed by a retention job.
--
-- Suspension reuses Businesses.IsActive, which sign-in, the business switcher, token refresh, every authenticated request and the
-- background workers already honour. These two columns only record when and why. Nothing is deleted by a suspension.
ALTER TABLE "Businesses" ADD COLUMN "SuspendedAtUtc" timestamp with time zone;
ALTER TABLE "Businesses" ADD COLUMN "SuspendedReason" character varying(200);

-- Retention (180 days for customer messages, 90 days for the email outbox) reads only finished rows by age. These partial indexes
-- keep that read cheap and leave the queue indexes (Pending and Leased rows) alone.
CREATE INDEX IF NOT EXISTS "IX_CustomerEventOutbox_Retention" ON "CustomerEventOutbox" ("UpdatedAtUtc", "Id") WHERE "Status" IN ('Sent', 'Cancelled', 'Failed');
CREATE INDEX IF NOT EXISTS "IX_CustomerMessageOutbox_Retention" ON "CustomerMessageOutbox" ("UpdatedAtUtc", "Id") WHERE "Status" IN ('Sent', 'Cancelled', 'Failed');
CREATE INDEX IF NOT EXISTS "IX_EmailOutbox_Retention" ON "EmailOutbox" ("CreatedAtUtc", "Id") WHERE "Status" IN ('Sent', 'Failed');
