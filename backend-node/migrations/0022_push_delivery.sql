-- 0022: session-owned push tokens and durable, retryable per-message push delivery.
ALTER TABLE "PushTokens" ADD COLUMN IF NOT EXISTS "SessionId" uuid;
ALTER TABLE "PushTokens" ADD COLUMN IF NOT EXISTS "DeactivatedAtUtc" timestamptz;
ALTER TABLE "PushTokens" ADD COLUMN IF NOT EXISTS "DeactivatedReason" varchar(40);
ALTER TABLE "PushTokens" ADD COLUMN IF NOT EXISTS "LastSuccessAtUtc" timestamptz;
ALTER TABLE "PushTokens" DROP CONSTRAINT IF EXISTS "FK_PushTokens_UserSessions_SessionId";
ALTER TABLE "PushTokens" ADD CONSTRAINT "FK_PushTokens_UserSessions_SessionId" FOREIGN KEY ("SessionId") REFERENCES "UserSessions"("Id") ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "UX_PushTokens_Id_Business_Membership" ON "PushTokens" ("Id", "BusinessId", "MembershipId");
CREATE UNIQUE INDEX IF NOT EXISTS "UX_PushTokens_Id_Business" ON "PushTokens" ("Id", "BusinessId");
DROP INDEX IF EXISTS "IX_PushTokens_Membership_Business_Token";
-- Legacy tokens were not session-bound; require a fresh registration instead of allowing them to outlive an owner session.
UPDATE "PushTokens" SET "Active"=FALSE,"DeactivatedAtUtc"=COALESCE("DeactivatedAtUtc",now()),
  "DeactivatedReason"=COALESCE("DeactivatedReason",'session_revoked'),"UpdatedAtUtc"=now()
WHERE "Active"=TRUE AND "SessionId" IS NULL;
WITH duplicates AS (
  SELECT "Id", row_number() OVER (PARTITION BY "Token" ORDER BY "UpdatedAtUtc" DESC,"CreatedAtUtc" DESC,"Id") AS rn
  FROM "PushTokens" WHERE "Active"=TRUE
)
UPDATE "PushTokens" t SET "Active"=FALSE,"DeactivatedAtUtc"=now(),"DeactivatedReason"='superseded',"UpdatedAtUtc"=now()
FROM duplicates d WHERE t."Id"=d."Id" AND d.rn>1;
CREATE UNIQUE INDEX IF NOT EXISTS "UX_PushTokens_Active_Token" ON "PushTokens" ("Token") WHERE "Active" = TRUE;

ALTER TABLE "NotificationOutbox" ADD COLUMN IF NOT EXISTS "PushEnabled" boolean NOT NULL DEFAULT FALSE;
ALTER TABLE "NotificationOutbox" ADD COLUMN IF NOT EXISTS "PushNextAttemptUtc" timestamptz;
ALTER TABLE "NotificationOutbox" DROP CONSTRAINT IF EXISTS "CK_NotificationOutbox_Channel";
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "CK_NotificationOutbox_Channel" CHECK ("InAppEnabled" OR "EmailToAddress" IS NOT NULL OR "PushEnabled");
ALTER TABLE "NotificationOutbox" DROP CONSTRAINT IF EXISTS "CK_NotificationOutbox_TargetKind";
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "CK_NotificationOutbox_TargetKind" CHECK ("TargetKind" IS NULL OR "TargetKind" IN ('task','order','invoice','inquiry','material','subscription','quotation','payment','appointment'));
CREATE UNIQUE INDEX IF NOT EXISTS "UX_NotificationOutbox_Id_Business" ON "NotificationOutbox" ("Id", "BusinessId");

CREATE TABLE IF NOT EXISTS "PushDeliveries" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "OutboxId" uuid NOT NULL,
  "RecipientMembershipId" uuid NOT NULL,
  "PushTokenId" uuid NOT NULL,
  "Status" varchar(16) NOT NULL DEFAULT 'Pending',
  "Attempts" integer NOT NULL DEFAULT 0,
  "NextAttemptUtc" timestamptz NOT NULL,
  "LeaseUntilUtc" timestamptz,
  "ExpiresAtUtc" timestamptz,
  "ProviderTicketId" varchar(200),
  "ProviderStatus" varchar(40),
  "ErrorCode" varchar(80),
  "CreatedAtUtc" timestamptz NOT NULL,
  "UpdatedAtUtc" timestamptz NOT NULL,
  "AcceptedAtUtc" timestamptz,
  CONSTRAINT "PK_PushDeliveries" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_PushDeliveries_Status" CHECK ("Status" IN ('Pending','Leased','Accepted','Failed','Skipped')),
  CONSTRAINT "CK_PushDeliveries_Attempts" CHECK ("Attempts" >= 0),
  CONSTRAINT "FK_PushDeliveries_Outbox_Business" FOREIGN KEY ("OutboxId","BusinessId") REFERENCES "NotificationOutbox"("Id","BusinessId") ON DELETE CASCADE,
  CONSTRAINT "FK_PushDeliveries_Membership_Business" FOREIGN KEY ("RecipientMembershipId","BusinessId") REFERENCES "Memberships"("Id","BusinessId") ON DELETE CASCADE,
  CONSTRAINT "FK_PushDeliveries_Token_Business_Membership" FOREIGN KEY ("PushTokenId","BusinessId","RecipientMembershipId") REFERENCES "PushTokens"("Id","BusinessId","MembershipId") ON DELETE CASCADE,
  CONSTRAINT "UQ_PushDeliveries_Outbox_Token" UNIQUE ("OutboxId","PushTokenId")
);
CREATE INDEX IF NOT EXISTS "IX_PushDeliveries_Claim" ON "PushDeliveries" ("NextAttemptUtc","CreatedAtUtc") WHERE "Status" IN ('Pending','Leased');
CREATE INDEX IF NOT EXISTS "IX_PushDeliveries_Retention" ON "PushDeliveries" ("UpdatedAtUtc") WHERE "Status" IN ('Accepted','Failed','Skipped');

-- Any revocation path (logout, refresh-token reuse, account security action, session expiry) deactivates its devices.
CREATE OR REPLACE FUNCTION avzar_deactivate_push_tokens_for_revoked_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."RevokedAtUtc" IS NULL AND NEW."RevokedAtUtc" IS NOT NULL THEN
    UPDATE "PushTokens" SET "Active" = FALSE, "DeactivatedAtUtc" = NEW."RevokedAtUtc",
      "DeactivatedReason" = CASE
        WHEN NEW."RevokedReason" IN ('logout','revoked_by_user') THEN 'logout'
        WHEN NEW."RevokedReason" IN ('account_inactive','membership_inactive') THEN 'user_removed'
        ELSE 'session_revoked' END,
      "UpdatedAtUtc" = NEW."RevokedAtUtc"
    WHERE "SessionId" = NEW."Id" AND "Active" = TRUE;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "TR_UserSessions_DeactivatePushTokens" ON "UserSessions";
CREATE TRIGGER "TR_UserSessions_DeactivatePushTokens" AFTER UPDATE OF "RevokedAtUtc" ON "UserSessions"
FOR EACH ROW EXECUTE FUNCTION avzar_deactivate_push_tokens_for_revoked_session();

CREATE OR REPLACE FUNCTION avzar_deactivate_push_tokens_for_inactive_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."Status" = 0 AND NEW."Status" <> 0 THEN
    UPDATE "PushTokens" SET "Active"=FALSE,"DeactivatedAtUtc"=now(),"DeactivatedReason"='user_removed',"UpdatedAtUtc"=now()
    WHERE "MembershipId"=NEW."Id" AND "BusinessId"=NEW."BusinessId" AND "Active"=TRUE;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "TR_Memberships_DeactivatePushTokens" ON "Memberships";
CREATE TRIGGER "TR_Memberships_DeactivatePushTokens" AFTER UPDATE OF "Status" ON "Memberships"
FOR EACH ROW EXECUTE FUNCTION avzar_deactivate_push_tokens_for_inactive_membership();
