-- Sender-wide message stops. One Twilio sender number serves every shop, so a customer's STOP reply to that number stops
-- the number for all of them. A stop is therefore keyed by channel and address only and has no BusinessId and no row-level
-- security, like EmailSuppressions. Application-layer isolation: rows are written only by the inbound Twilio webhook and by a
-- provider refusal at send time, and are read only to answer "may this address be messaged at all".
-- A START reply lifts a stop (LiftedAtUtc) but never restores any business's consent; that needs staff to record OptedIn again.
CREATE TABLE "MessagingSuppressions" (
  "Id" uuid NOT NULL,
  "Channel" character varying(12) NOT NULL,
  "Address" character varying(254) NOT NULL,
  "Source" character varying(24) NOT NULL,
  "CreatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  "LiftedAtUtc" timestamptz,
  "UpdatedAtUtc" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_MessagingSuppressions" PRIMARY KEY ("Id"),
  CONSTRAINT "CK_MessagingSuppressions_Channel" CHECK ("Channel" IN ('WhatsApp','SMS')),
  CONSTRAINT "CK_MessagingSuppressions_Source" CHECK ("Source" IN ('SmsStop','ProviderRefusal')),
  CONSTRAINT "CK_MessagingSuppressions_Address" CHECK (length(trim("Address")) > 0)
);
-- At most one standing (not lifted) stop per channel and address; lifted rows stay as history.
CREATE UNIQUE INDEX "IX_MessagingSuppressions_Standing" ON "MessagingSuppressions" ("Channel", lower("Address")) WHERE "LiftedAtUtc" IS NULL;
