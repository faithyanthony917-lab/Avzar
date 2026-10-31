-- Step 16a: a notification about a leave request can point at the leave record, so the target-kind checks on Notifications and
-- NotificationOutbox gain 'leave'. Nothing else changes: no column, no row, no policy. Forward-only; the older kinds stay as they were.
ALTER TABLE "Notifications" DROP CONSTRAINT IF EXISTS "CK_Notifications_TargetKind";
ALTER TABLE "Notifications" ADD CONSTRAINT "CK_Notifications_TargetKind"
  CHECK ("TargetKind" IS NULL OR "TargetKind" IN ('task', 'order', 'invoice', 'inquiry', 'material', 'subscription', 'quotation', 'payment', 'appointment', 'leave'));
ALTER TABLE "NotificationOutbox" DROP CONSTRAINT IF EXISTS "CK_NotificationOutbox_TargetKind";
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "CK_NotificationOutbox_TargetKind"
  CHECK ("TargetKind" IS NULL OR "TargetKind" IN ('task', 'order', 'invoice', 'inquiry', 'material', 'subscription', 'quotation', 'payment', 'appointment', 'leave'));
