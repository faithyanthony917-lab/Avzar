-- 0016: store Expo/Apple/Android device tokens per active member so push notifications can be sent later.
CREATE TABLE IF NOT EXISTS "PushTokens" (
  "Id" uuid NOT NULL,
  "MembershipId" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "Token" character varying(200) NOT NULL,
  "Platform" character varying(16) NOT NULL DEFAULT 'ios',
  "DeviceName" character varying(80),
  "Active" boolean NOT NULL DEFAULT TRUE,
  "CreatedAtUtc" timestamp with time zone NOT NULL,
  "UpdatedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_PushTokens" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_PushTokens_Platform" CHECK ("Platform" IN ('ios', 'android', 'web')),
  CONSTRAINT "FK_PushTokens_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_PushTokens_Memberships_MembershipId_BusinessId" FOREIGN KEY ("MembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "IX_PushTokens_Membership_Business_Token" ON "PushTokens" ("MembershipId", "BusinessId", "Token");
CREATE INDEX IF NOT EXISTS "IX_PushTokens_Active" ON "PushTokens" ("BusinessId", "MembershipId") WHERE "Active" = TRUE;
