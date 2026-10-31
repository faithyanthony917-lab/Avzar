import { forEachBusiness, sumResults } from '../db/forEachBusiness.js';
import { nextDelayMs } from '../email/retryPolicy.js';
import { createConfiguredMessagingProvider, customerMessagingConsent } from './provider.js';
import { messagingSigningSecret, unsubscribeUrl } from './optOut.js';
import { recordMessagingSuppression } from './suppressions.js';
import { describeCustomerEvent } from './customerEvents.js';
import { buildWhatsAppTemplate } from './whatsappTemplates.js';

export const CUSTOMER_EVENT_BATCH_SIZE = 50;
export const CUSTOMER_EVENT_MAX_ATTEMPTS = 6;
export const CUSTOMER_EVENT_LEASE_MS = 60_000;

// Same lease and retry rules as the appointment reminder worker. Before every send the consent record and the order or payment are
// read again, so a message queued yesterday never goes out after the customer opted out or after the facts changed.
export async function dispatchCustomerEventsOnce(pool, {
  provider = createConfiguredMessagingProvider(), env = {}, now = new Date(), batchLimit = CUSTOMER_EVENT_BATCH_SIZE,
  leaseMs = CUSTOMER_EVENT_LEASE_MS, maxAttempts = CUSTOMER_EVENT_MAX_ATTEMPTS, log = console,
} = {}) {
  if (!pool) throw new TypeError('pool is required.');
  const signingSecret = messagingSigningSecret(env);
  const limit = Math.max(1, Math.min(200, Math.trunc(batchLimit) || CUSTOMER_EVENT_BATCH_SIZE));
  await pool.query(`UPDATE "CustomerEventOutbox" SET "Status"='Failed',"LeaseUntilUtc"=NULL,"LastError"='LeaseExpired',"UpdatedAtUtc"=$1 WHERE "Status"='Leased' AND "LeaseUntilUtc"<$1 AND "Attempts">=$2`, [now, maxAttempts]);
  const leaseUntil = new Date(now.getTime() + Math.max(10_000, leaseMs));
  const { rows: jobs } = await pool.query(`
    WITH picked AS (
      SELECT q."Id" FROM "CustomerEventOutbox" q
      JOIN "Businesses" b ON b."Id"=q."BusinessId"
      WHERE q."Attempts"<$4 AND q."NextAttemptUtc"<=$1 AND b."IsActive"=TRUE
        AND ((q."Status"='Pending') OR (q."Status"='Leased' AND q."LeaseUntilUtc"<$1))
      ORDER BY q."CreatedAtUtc",q."Id" LIMIT $3 FOR UPDATE OF q SKIP LOCKED
    )
    UPDATE "CustomerEventOutbox" q SET "Status"='Leased',"LeaseUntilUtc"=$2,"Attempts"=q."Attempts"+1,"UpdatedAtUtc"=$1
    FROM picked WHERE q."Id"=picked."Id"
    RETURNING q.*`, [now, leaseUntil, limit, maxAttempts]);
  const result = { claimed: jobs.length, sent: 0, cancelled: 0, retried: 0, failed: 0 };
  for (const job of jobs) {
    try {
      const consent = await customerMessagingConsent(pool, { businessId: job.BusinessId, customerId: job.CustomerId, channel: job.Channel, address: job.Address });
      const described = consent ? await describeCustomerEvent(pool, job) : { eligible: false };
      if (!consent || !described.eligible) {
        await pool.query(`UPDATE "CustomerEventOutbox" SET "Status"='Cancelled',"LeaseUntilUtc"=NULL,"UpdatedAtUtc"=$2 WHERE "Id"=$1 AND "Status"='Leased' AND "LeaseUntilUtc"=$3`, [job.Id, now, job.LeaseUntilUtc]);
        result.cancelled++; continue;
      }
      // Every message carries a way out: SMS says "Reply STOP" and both channels carry a personal unsubscribe link.
      let link = null;
      if (signingSecret) {
        const preference = await pool.query(`SELECT "Id" FROM "CustomerMessagingPreferences" WHERE "BusinessId"=$1 AND "CustomerId"=$2 AND "Channel"=$3 AND lower("Address")=lower($4) LIMIT 1`, [job.BusinessId, job.CustomerId, job.Channel, job.Address]);
        if (preference.rows[0]) link = unsubscribeUrl(env, signingSecret, { businessId: job.BusinessId, preferenceId: preference.rows[0].Id });
      }
      const optOut = [job.Channel === 'SMS' ? 'Reply STOP to opt out.' : null, link ? `Unsubscribe: ${link}` : null].filter(Boolean).join(' ');
      // Step 16d: WhatsApp starts the conversation with a Meta-approved template (same facts, opt-out link as the last variable).
      const template = job.Channel === 'WhatsApp' ? buildWhatsAppTemplate({ kind: described.kind ?? job.Kind, values: described.values, optOutLink: link, env }) : undefined;
      const sent = await provider.send({ channel: job.Channel, to: job.Address, text: `${described.text}${optOut ? ` ${optOut}` : ''}`, idempotencyKey: `avzar-customer-event-${job.Id}`, template });
      const updated = await pool.query(`UPDATE "CustomerEventOutbox" SET "Status"='Sent',"LeaseUntilUtc"=NULL,"ProviderMessageId"=$4,"SentAtUtc"=$2,"UpdatedAtUtc"=$2,"LastError"=NULL WHERE "Id"=$1 AND "Status"='Leased' AND "LeaseUntilUtc"=$3`, [job.Id, now, job.LeaseUntilUtc, sent.providerMessageId]);
      if (!updated.rowCount) throw new Error('CustomerEventLeaseLost');
      result.sent++;
    } catch (error) {
      const refused = error?.code === 'recipient_opted_out';
      if (refused) await recordMessagingSuppression(pool, { channel: job.Channel, address: job.Address, source: 'ProviderRefusal' }).catch(() => {});
      const attemptsExhausted = job.Attempts >= maxAttempts;
      const retryable = error?.retryable !== false;
      const status = refused ? 'Cancelled' : attemptsExhausted || !retryable ? 'Failed' : 'Pending';
      await pool.query(`UPDATE "CustomerEventOutbox" SET "Status"=$3,"LeaseUntilUtc"=NULL,"NextAttemptUtc"=$4,"LastError"=$5,"UpdatedAtUtc"=$6 WHERE "Id"=$1 AND "Status"='Leased' AND "LeaseUntilUtc"=$2`, [job.Id, job.LeaseUntilUtc, status, new Date(now.getTime() + nextDelayMs(job.Attempts)), String(error?.code ?? error?.constructor?.name ?? 'Error').slice(0, 100), now]);
      result[status === 'Failed' ? 'failed' : status === 'Cancelled' ? 'cancelled' : 'retried']++;
      log.error?.('Customer event message delivery failed.', { messageId: job.Id, errorType: error?.constructor?.name ?? 'Error' });
    }
  }
  return result;
}

export function startCustomerEventWorker({ pool, env, enabled = true, pollSeconds = 15, startupDelayMs = 25_000, log = console, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!pool || !enabled) return async () => {};
  const provider = createConfiguredMessagingProvider(env);
  let stopped = false; let timer = null; let running = null;
  const cycle = async () => {
    if (stopped) return;
    running = forEachBusiness(pool, () => dispatchCustomerEventsOnce(pool, { provider, env, log }), { log }).then(sumResults);
    try { const result = await running; if (result.claimed) log.info?.('Customer event message cycle completed.', result); }
    catch (error) { log.error?.('Customer event message cycle failed.', { errorType: error?.constructor?.name ?? 'Error' }); }
    finally { running = null; }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, Math.max(1, pollSeconds) * 1000);
  };
  timer = schedule(() => { timer = null; void cycle(); }, Math.max(0, startupDelayMs));
  return async () => { stopped = true; if (timer !== null) cancel(timer); await running?.catch(() => {}); };
}
