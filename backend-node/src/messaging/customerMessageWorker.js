import { randomUUID } from 'node:crypto';
import { forEachBusiness, sumResults } from '../db/forEachBusiness.js';
import { nextDelayMs } from '../email/retryPolicy.js';
import { createConfiguredMessagingProvider, customerMessagingConsent } from './provider.js';
import { messagingSigningSecret, unsubscribeUrl } from './optOut.js';
import { buildMessageText } from './templateCatalog.js';
import { buildWhatsAppTemplate } from './whatsappTemplates.js';
import { recordMessagingSuppression } from './suppressions.js';

export const CUSTOMER_MESSAGE_BATCH_SIZE = 50;
export const CUSTOMER_MESSAGE_MAX_ATTEMPTS = 6;
export const CUSTOMER_MESSAGE_LEASE_MS = 60_000;

export async function dispatchCustomerMessagesOnce(pool, {
  provider = createConfiguredMessagingProvider(), env = {}, now = new Date(), batchLimit = CUSTOMER_MESSAGE_BATCH_SIZE,
  leaseMs = CUSTOMER_MESSAGE_LEASE_MS, maxAttempts = CUSTOMER_MESSAGE_MAX_ATTEMPTS, log = console,
} = {}) {
  if (!pool) throw new TypeError('pool is required.');
  const signingSecret = messagingSigningSecret(env);
  const limit = Math.max(1, Math.min(200, Math.trunc(batchLimit) || CUSTOMER_MESSAGE_BATCH_SIZE));
  await pool.query(`UPDATE "CustomerMessageOutbox" SET "Status"='Failed',"LeaseUntilUtc"=NULL,"LastError"='LeaseExpired',"UpdatedAtUtc"=$1 WHERE "Status"='Leased' AND "LeaseUntilUtc"<$1 AND "Attempts">=$2`, [now,maxAttempts]);
  const leaseUntil = new Date(now.getTime() + Math.max(10_000, leaseMs));
  const { rows: jobs } = await pool.query(`
    WITH picked AS (
      SELECT q."Id" FROM "CustomerMessageOutbox" q
      JOIN "Appointments" a ON a."Id"=q."AppointmentId" AND a."BusinessId"=q."BusinessId"
      JOIN "Businesses" b ON b."Id"=q."BusinessId"
      WHERE q."Attempts"<$4 AND q."DueAtUtc"<=$1 AND q."NextAttemptUtc"<=$1
        AND a."Status"='Scheduled' AND a."StartUtc"=q."AppointmentStartUtc" AND a."StartUtc">$1 AND b."IsActive"=TRUE
        AND ((q."Status"='Pending') OR (q."Status"='Leased' AND q."LeaseUntilUtc"<$1))
      ORDER BY q."DueAtUtc",q."Id" LIMIT $3 FOR UPDATE OF q SKIP LOCKED
    )
    UPDATE "CustomerMessageOutbox" q SET "Status"='Leased',"LeaseUntilUtc"=$2,"Attempts"=q."Attempts"+1,"UpdatedAtUtc"=$1
    FROM picked WHERE q."Id"=picked."Id"
    RETURNING q.*`, [now,leaseUntil,limit,maxAttempts]);
  const result = { claimed: jobs.length, sent: 0, cancelled: 0, retried: 0, failed: 0 };
  for (const job of jobs) {
    try {
      const check = await pool.query(`SELECT a."Status",a."StartUtc",a."Type",a."TimeZoneId",c."FullName",b."Name" AS "BusinessName"
        FROM "Appointments" a JOIN "Customers" c ON c."Id"=a."CustomerId" AND c."BusinessId"=a."BusinessId"
        JOIN "Businesses" b ON b."Id"=a."BusinessId"
        WHERE a."Id"=$1 AND a."BusinessId"=$2 AND c."Id"=$3 AND b."IsActive"=TRUE`, [job.AppointmentId,job.BusinessId,job.CustomerId]);
      const appt = check.rows[0];
      const permitted = appt && appt.Status === 'Scheduled' && new Date(appt.StartUtc).getTime() === new Date(job.AppointmentStartUtc).getTime()
        && new Date(appt.StartUtc) > now && await customerMessagingConsent(pool, { businessId: job.BusinessId, customerId: job.CustomerId, channel: job.Channel, address: job.Address });
      if (!permitted) {
        await pool.query(`UPDATE "CustomerMessageOutbox" SET "Status"='Cancelled',"LeaseUntilUtc"=NULL,"UpdatedAtUtc"=$2 WHERE "Id"=$1 AND "Status"='Leased' AND "LeaseUntilUtc"=$3`, [job.Id,now,job.LeaseUntilUtc]);
        result.cancelled++; continue;
      }
      const when = new Intl.DateTimeFormat('en-GB', { timeZone: appt.TimeZoneId || 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(appt.StartUtc));
      const hours = job.OffsetMinutes === 1440 ? 'tomorrow' : 'in about two hours';
      // Every message carries a way out: SMS says "Reply STOP" and both channels carry a personal unsubscribe link.
      let link = null;
      if (signingSecret) {
        const preference = await pool.query(`SELECT "Id" FROM "CustomerMessagingPreferences" WHERE "BusinessId"=$1 AND "CustomerId"=$2 AND "Channel"=$3 AND lower("Address")=lower($4) LIMIT 1`, [job.BusinessId,job.CustomerId,job.Channel,job.Address]);
        if (preference.rows[0]) link = unsubscribeUrl(env, signingSecret, { businessId: job.BusinessId, preferenceId: preference.rows[0].Id });
      }
      const optOut = [job.Channel === 'SMS' ? 'Reply STOP to opt out.' : null, link ? `Unsubscribe: ${link}` : null].filter(Boolean).join(' ');
      // Step 16c: the business's saved wording for this channel, else the default (identical to the wording before 16c).
      const reminderValues = { business: appt.BusinessName, type: String(appt.Type).toLowerCase(), timing: hours, when };
      const reminderText = await buildMessageText(pool, { businessId: job.BusinessId, kind: 'appointment.reminder', channel: job.Channel, values: reminderValues });
      // Step 16d: WhatsApp uses the Meta-approved template; SMS keeps the (possibly customised) text.
      const template = job.Channel === 'WhatsApp' ? buildWhatsAppTemplate({ kind: 'appointment.reminder', values: reminderValues, optOutLink: link, env }) : undefined;
      const sent = await provider.send({ channel: job.Channel, to: job.Address, text: `${reminderText}${optOut ? ` ${optOut}` : ''}`, idempotencyKey: `avzar-appointment-${job.Id}`, template });
      const updated = await pool.query(`UPDATE "CustomerMessageOutbox" SET "Status"='Sent',"LeaseUntilUtc"=NULL,"ProviderMessageId"=$4,"SentAtUtc"=$2,"UpdatedAtUtc"=$2,"LastError"=NULL WHERE "Id"=$1 AND "Status"='Leased' AND "LeaseUntilUtc"=$3`, [job.Id,now,job.LeaseUntilUtc,sent.providerMessageId]);
      if (!updated.rowCount) throw new Error('CustomerMessageLeaseLost');
      result.sent++;
    } catch (error) {
      const refused = error?.code === 'recipient_opted_out';
      if (refused) await recordMessagingSuppression(pool, { channel: job.Channel, address: job.Address, source: 'ProviderRefusal' }).catch(() => {});
      const attemptsExhausted = job.Attempts >= maxAttempts;
      const retryable = error?.retryable !== false;
      const status = refused ? 'Cancelled' : attemptsExhausted || !retryable ? 'Failed' : 'Pending';
      await pool.query(`UPDATE "CustomerMessageOutbox" SET "Status"=$3,"LeaseUntilUtc"=NULL,"NextAttemptUtc"=$4,"LastError"=$5,"UpdatedAtUtc"=$6 WHERE "Id"=$1 AND "Status"='Leased' AND "LeaseUntilUtc"=$2`, [job.Id,job.LeaseUntilUtc,status,new Date(now.getTime() + nextDelayMs(job.Attempts)),String(error?.code ?? error?.constructor?.name ?? 'Error').slice(0,100),now]);
      result[status === 'Failed' ? 'failed' : status === 'Cancelled' ? 'cancelled' : 'retried']++;
      log.error?.('Customer appointment message delivery failed.', { messageId: job.Id, errorType: error?.constructor?.name ?? 'Error' });
    }
  }
  return result;
}

export function startCustomerMessageWorker({ pool, env, enabled = true, pollSeconds = 15, startupDelayMs = 20_000, log = console, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!pool || !enabled) return async () => {};
  const provider = createConfiguredMessagingProvider(env);
  let stopped = false; let timer = null; let running = null;
  const cycle = async () => {
    if (stopped) return;
    running = forEachBusiness(pool, () => dispatchCustomerMessagesOnce(pool, { provider, env, log }), { log }).then(sumResults);
    try { const result = await running; if (result.claimed) log.info?.('Customer message cycle completed.', result); }
    catch (error) { log.error?.('Customer message cycle failed.', { errorType: error?.constructor?.name ?? 'Error' }); }
    finally { running = null; }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, Math.max(1,pollSeconds) * 1000);
  };
  timer = schedule(() => { timer = null; void cycle(); }, Math.max(0,startupDelayMs));
  return async () => { stopped = true; if (timer !== null) cancel(timer); await running?.catch(() => {}); };
}
