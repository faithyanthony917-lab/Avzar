import { forEachBusiness, sumResults } from '../db/forEachBusiness.js';
import { nextDelayMs } from '../email/retryPolicy.js';
import { getPushSender } from './pushService.js';

export const PUSH_DELIVERY_MAX_ATTEMPTS = 6;
export const PUSH_DELIVERY_BATCH_SIZE = 100;
export const PUSH_DELIVERY_LEASE_MS = 5 * 60_000;

function ticketError(ticket) {
  const details = ticket?.details;
  return typeof details?.error === 'string' ? details.error.slice(0, 80) : 'ExpoTicketError';
}

async function settle(pool, delivery, outcome, now) {
  await pool.query(`UPDATE "PushDeliveries" SET "Status"=$3,"LeaseUntilUtc"=NULL,"ProviderTicketId"=$4,
    "ProviderStatus"=$5,"ErrorCode"=$6,"AcceptedAtUtc"=$7,"UpdatedAtUtc"=$8
    WHERE "Id"=$1 AND "Status"='Leased' AND "LeaseUntilUtc"=$2`,
  [delivery.Id, delivery.LeaseUntilUtc, outcome.status, outcome.ticketId ?? null, outcome.providerStatus ?? null,
    outcome.errorCode ?? null, outcome.status === 'Accepted' ? now : null, now]);
}

async function retry(pool, delivery, error, now, maxAttempts) {
  const exhausted = delivery.Attempts >= maxAttempts;
  const code = error?.status === 429 ? 'ProviderRateLimited' : error?.status >= 500 ? 'ProviderUnavailable' : (error?.code ?? error?.constructor?.name ?? 'Error');
  await pool.query(`UPDATE "PushDeliveries" SET "Status"=$3,"LeaseUntilUtc"=NULL,"NextAttemptUtc"=$4,
    "ErrorCode"=$5,"UpdatedAtUtc"=$6 WHERE "Id"=$1 AND "Status"='Leased' AND "LeaseUntilUtc"=$2`,
  [delivery.Id, delivery.LeaseUntilUtc, exhausted ? 'Failed' : 'Pending', new Date(now.getTime() + nextDelayMs(delivery.Attempts)), String(code).slice(0,80), now]);
  return exhausted ? 'failed' : 'retried';
}

export async function dispatchPushDeliveriesOnce(pool, { sender = getPushSender(), now = new Date(), batchLimit = PUSH_DELIVERY_BATCH_SIZE,
  leaseMs = PUSH_DELIVERY_LEASE_MS, maxAttempts = PUSH_DELIVERY_MAX_ATTEMPTS, log = console } = {}) {
  if (!pool) throw new TypeError('pool is required.');
  if (!sender || typeof sender.send !== 'function') return { claimed: 0, accepted: 0, retried: 0, failed: 0, skipped: 0 };
  const limit = Math.max(1, Math.min(1000, Math.trunc(batchLimit) || PUSH_DELIVERY_BATCH_SIZE));
  await pool.query(`UPDATE "PushDeliveries" SET "Status"='Failed',"LeaseUntilUtc"=NULL,"ErrorCode"='LeaseExpired',"UpdatedAtUtc"=$1
    WHERE "Status"='Leased' AND "LeaseUntilUtc"<$1 AND "Attempts">=$2`, [now, maxAttempts]);
  const leaseUntil = new Date(now.getTime() + Math.max(10_000, leaseMs));
  const { rows } = await pool.query(`WITH picked AS (
    SELECT d."Id" FROM "PushDeliveries" d WHERE d."Attempts"<$4 AND ((d."Status"='Pending' AND d."NextAttemptUtc"<=$1) OR (d."Status"='Leased' AND d."LeaseUntilUtc"<$1))
    ORDER BY d."NextAttemptUtc",d."CreatedAtUtc",d."Id" LIMIT $3 FOR UPDATE SKIP LOCKED
  ) UPDATE "PushDeliveries" d SET "Status"='Leased',"LeaseUntilUtc"=$2,"Attempts"=d."Attempts"+1,"UpdatedAtUtc"=$1
    FROM picked WHERE d."Id"=picked."Id" RETURNING d.*`, [now, leaseUntil, limit, maxAttempts]);
  const result = { claimed: rows.length, accepted: 0, retried: 0, failed: 0, skipped: 0 };
  for (const delivery of rows) {
    try {
      const { rows: eligible } = await pool.query(`SELECT d."ExpiresAtUtc",t."Token",t."Active",t."SessionId",t."MembershipId",t."BusinessId",
        s."RevokedAtUtc",s."AbsoluteExpiresAtUtc",s."IdleExpiresAtUtc",m."Status" AS "MembershipStatus",
        o."Category",o."EventType",o."TargetKind",o."TargetId",a."Status" AS "AppointmentStatus",a."StartUtc" AS "AppointmentStartUtc",
        COALESCE(p."PushEnabled",FALSE) AS "PushPreferenceEnabled"
        FROM "PushDeliveries" d JOIN "PushTokens" t ON t."Id"=d."PushTokenId" AND t."BusinessId"=d."BusinessId" AND t."MembershipId"=d."RecipientMembershipId"
        JOIN "UserSessions" s ON s."Id"=t."SessionId" AND s."BusinessId"=t."BusinessId"
        JOIN "Memberships" m ON m."Id"=t."MembershipId" AND m."BusinessId"=t."BusinessId"
        JOIN "NotificationOutbox" o ON o."Id"=d."OutboxId" AND o."BusinessId"=d."BusinessId"
        LEFT JOIN "NotificationPreferences" p ON p."BusinessId"=d."BusinessId" AND p."MembershipId"=d."RecipientMembershipId" AND p."Category"=o."Category"
        LEFT JOIN "Appointments" a ON a."BusinessId"=d."BusinessId" AND a."Id"=o."TargetId" AND o."TargetKind"='appointment'
        WHERE d."Id"=$1`, [delivery.Id]);
      const item = eligible[0];
      const appointmentInvalid = item?.TargetKind === 'appointment' && (!item.AppointmentStatus || item.AppointmentStatus !== 'Scheduled'
        || !item.ExpiresAtUtc || !item.AppointmentStartUtc || new Date(item.AppointmentStartUtc).getTime() !== new Date(item.ExpiresAtUtc).getTime());
      if (!item || !item.Active || item.MembershipStatus !== 0 || !item.PushPreferenceEnabled || item.RevokedAtUtc
        || new Date(item.AbsoluteExpiresAtUtc) <= now || new Date(item.IdleExpiresAtUtc) <= now
        || (item.ExpiresAtUtc && new Date(item.ExpiresAtUtc) <= now) || appointmentInvalid) {
        await settle(pool, delivery, { status: 'Skipped', providerStatus: 'IneligibleOrExpired', errorCode: item?.ExpiresAtUtc && new Date(item.ExpiresAtUtc) <= now ? 'Expired' : 'Ineligible' }, now);
        result.skipped += 1; continue;
      }
      const tickets = await sender.send([{ to: item.Token, title: genericTitle(item.EventType), body: genericBody(item.EventType),
        data: { category: item.Category, targetKind: item.TargetKind, targetId: item.TargetId, eventType: item.EventType } }]);
      const ticket = tickets?.[0];
      if (ticket?.status === 'ok') {
        await settle(pool, delivery, { status: 'Accepted', ticketId: ticket.id, providerStatus: 'ok' }, now);
        await pool.query(`UPDATE "PushTokens" SET "LastSuccessAtUtc"=$2,"UpdatedAtUtc"=$2 WHERE "Id"=$1`, [delivery.PushTokenId, now]);
        result.accepted += 1;
      } else {
        const code = ticketError(ticket);
        if (code === 'DeviceNotRegistered') {
          await pool.query(`UPDATE "PushTokens" SET "Active"=FALSE,"DeactivatedAtUtc"=$2,"DeactivatedReason"='device_not_registered',"UpdatedAtUtc"=$2 WHERE "Id"=$1`, [delivery.PushTokenId, now]);
          await settle(pool, delivery, { status: 'Failed', providerStatus: ticket?.status ?? 'error', errorCode: code }, now);
          result.failed += 1;
        } else if (ticket?.details?.error === 'MessageRateExceeded') {
          const outcome = await retry(pool, delivery, Object.assign(new Error(code), { code, status: 429 }), now, maxAttempts);
          result[outcome] += 1;
        } else {
          await settle(pool, delivery, { status: 'Failed', providerStatus: ticket?.status ?? 'error', errorCode: code }, now);
          result.failed += 1;
        }
      }
    } catch (error) {
      const status = Number(error?.status);
      if (Number.isFinite(status) && status > 0 && status < 500 && status !== 429) {
        await settle(pool, delivery, { status: 'Failed', providerStatus: 'http_error', errorCode: `Http${status}` }, now);
        result.failed += 1;
      } else {
        const outcome = await retry(pool, delivery, error, now, maxAttempts);
        result[outcome] += 1;
      }
      log.error?.('Push delivery attempt failed.', { deliveryId: delivery.Id, errorType: error?.constructor?.name ?? 'Error' });
    }
  }
  return result;
}

function genericTitle(eventType) {
  if (String(eventType).startsWith('task.')) return 'Production task update';
  if (String(eventType).startsWith('stock.')) return 'Inventory update';
  if (String(eventType).startsWith('appointment.')) return 'Appointment reminder';
  return 'Avzar notification';
}
function genericBody(eventType) {
  if (eventType === 'task.assignment') return 'A production task has been assigned to you.';
  if (eventType === 'task.due-soon') return 'A production task is due soon.';
  if (eventType === 'task.overdue') return 'A production task is overdue.';
  if (String(eventType).startsWith('stock.')) return 'A material is at or below its reorder level.';
  if (String(eventType).startsWith('appointment.')) return 'You have an upcoming appointment.';
  return 'You have an update in Avzar. Open the app to review it.';
}

export function startPushDeliveryWorker({ pool, enabled = true, pollSeconds = 10, startupDelayMs = 30_000, log = console, schedule = setTimeout, cancel = clearTimeout, sender = getPushSender() } = {}) {
  if (!pool || !enabled || !sender) return async () => {};
  let stopped = false; let timer = null; let running = null;
  const cycle = async () => {
    if (stopped) return;
    running = forEachBusiness(pool, () => dispatchPushDeliveriesOnce(pool, { sender, log }), { log }).then(sumResults);
    try { const result = await running; if (result.claimed) log.info?.('Push delivery cycle completed.', result); }
    catch (error) { log.error?.('Push delivery cycle failed.', { errorType: error?.constructor?.name ?? 'Error' }); }
    finally { running = null; }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, Math.max(1,pollSeconds)*1000);
  };
  timer = schedule(() => { timer = null; void cycle(); }, Math.max(0,startupDelayMs));
  return async () => { stopped = true; if (timer !== null) cancel(timer); await running?.catch(() => {}); };
}
