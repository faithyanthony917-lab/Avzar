-- Step 16d: a customer can now stop WhatsApp messages by replying STOP to the shared sender number, as they can for SMS.
-- That stop is recorded in MessagingSuppressions with its own source, so the allowed sources gain 'WhatsAppStop'.
-- No table, column or key is added; every existing row stays valid.
ALTER TABLE "MessagingSuppressions" DROP CONSTRAINT "CK_MessagingSuppressions_Source";
ALTER TABLE "MessagingSuppressions" ADD CONSTRAINT "CK_MessagingSuppressions_Source" CHECK ("Source" IN ('SmsStop','WhatsAppStop','ProviderRefusal'));
