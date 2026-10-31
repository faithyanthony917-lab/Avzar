-- Step-08c: staff consent screen. A staff member who records OptedIn must say how the customer agreed; that note and the
-- user who recorded the change are kept on the consent row. Both are nullable: rows written earlier have neither.
ALTER TABLE "CustomerMessagingPreferences"
  ADD COLUMN "ConsentNote" character varying(500),
  ADD COLUMN "ConsentRecordedByUserId" uuid;
