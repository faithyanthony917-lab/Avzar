-- Keep Node-only privacy requests compatible with the schema-parity rule:
-- application code supplies Status and CreatedAtUtc explicitly.
ALTER TABLE "CustomerPrivacyRequests"
  ALTER COLUMN "Status" DROP DEFAULT,
  ALTER COLUMN "CreatedAtUtc" DROP DEFAULT;
