import { forEachBusiness, sumResults } from '../db/forEachBusiness.js';
import { suppressionKey } from './addressRules.js';
import { emailOptionsFromEnv } from './options.js';
import { nextDelayMs } from './retryPolicy.js';
import { createEmailTransport } from './transports.js';
import { TransportResult } from './transportResult.js';

const CLAIM_SQL = `
  WITH picked AS (
    SELECT "Id" FROM "EmailOutbox"
    WHERE "Status" = 'Pending' AND "NextAttemptUtc" <= $1
      AND ("LeaseUntilUtc" IS NULL OR "LeaseUntilUtc" < $1)
    ORDER BY "NextAttemptUtc", "CreatedAtUtc"
    LIMIT $3 FOR UPDATE SKIP LOCKED
  )
  UPDATE "EmailOutbox" AS message
  SET "LeaseUntilUtc" = $2, "Attempts" = message."Attempts" + 1
  FROM picked
  WHERE message."Id" = picked."Id"
  RETURNING message."Id" AS id, message."Attempts" AS attempts,
    message."HtmlBody" AS html_body, message."LeaseUntilUtc" AS lease_until,
    message."Subject" AS subject, message."TextBody" AS text_body,
    message."ToAddress" AS to_address`;

function truncate(value, max = 400) {
  return String(value ?? '').slice(0, max);
}

async function finishAttempt(pool, message, result, now, maxAttempts) {
  const updatedAt = now;
  if (result.success) {
    return pool.query(`
      UPDATE "EmailOutbox"
      SET "Status" = 'Sent', "LeaseUntilUtc" = NULL, "UpdatedAtUtc" = $3,
        "SentAtUtc" = $3, "ProviderMessageId" = $4, "LastError" = NULL,
        "TextBody" = '', "HtmlBody" = NULL, "BodyPurgedAtUtc" = $3
      WHERE "Id" = $1 AND "LeaseUntilUtc" = $2`,
    [message.id, message.lease_until, updatedAt, truncate(result.providerMessageId, 200) || null]);
  }

  const error = truncate(result.error || 'Email delivery failed.');
  if (!result.transient || message.attempts >= maxAttempts) {
    const reason = result.transient ? `Gave up after ${message.attempts} attempts: ${error}` : `Rejected: ${error}`;
    return pool.query(`
      UPDATE "EmailOutbox"
      SET "Status" = 'Failed', "LeaseUntilUtc" = NULL, "UpdatedAtUtc" = $3,
        "LastError" = $4, "TextBody" = '', "HtmlBody" = NULL, "BodyPurgedAtUtc" = $3
      WHERE "Id" = $1 AND "LeaseUntilUtc" = $2`,
    [message.id, message.lease_until, updatedAt, truncate(reason)]);
  }

  const nextAttempt = new Date(now.getTime() + nextDelayMs(message.attempts));
  return pool.query(`
    UPDATE "EmailOutbox"
    SET "Status" = 'Pending', "LeaseUntilUtc" = NULL, "UpdatedAtUtc" = $3,
      "NextAttemptUtc" = $4, "LastError" = $5
    WHERE "Id" = $1 AND "LeaseUntilUtc" = $2`,
  [message.id, message.lease_until, updatedAt, nextAttempt, error]);
}

export async function dispatchOnce({ pool, transport, options, now = new Date(), log = console }) {
  if (!pool || !transport || !options) throw new TypeError('pool, transport, and options are required.');
  const leaseUntil = new Date(now.getTime() + options.leaseMinutes * 60_000);
  const { rows } = await pool.query(CLAIM_SQL, [now, leaseUntil, options.batchSize]);

  for (const message of rows) {
    let result;
    const key = suppressionKey(message.to_address);
    const suppressed = await pool.query('SELECT 1 FROM "EmailSuppressions" WHERE "Address" = $1 LIMIT 1', [key]);
    if (suppressed.rowCount > 0 || suppressed.rows.length > 0) {
      result = TransportResult.reject('Recipient is on the suppression list (earlier permanent bounce or complaint)');
    } else {
      try {
        result = await transport.send({
          messageId: message.id,
          to: message.to_address,
          subject: message.subject,
          textBody: message.text_body,
          htmlBody: message.html_body,
        });
        if (!result || typeof result.success !== 'boolean' || typeof result.transient !== 'boolean') {
          result = TransportResult.retry('Transport returned an invalid result');
        }
      } catch (error) {
        result = TransportResult.retry(`Transport threw ${error?.constructor?.name ?? 'Error'}`);
        log.warn?.('Email transport threw; message will be retried.', { messageId: message.id });
      }
    }
    await finishAttempt(pool, message, result, now, options.maxAttempts);
  }

  return rows.length;
}

export function startEmailDispatcher({ pool, env, log = console, transport, schedule = setTimeout, cancel = clearTimeout }) {
  if (!pool || !env?.EMAIL_DISPATCHER_ENABLED) return async () => {};

  const options = emailOptionsFromEnv(env);
  const sender = transport ?? createEmailTransport(options);
  let stopping = false;
  let timer = null;
  let running = null;

  const cycle = async () => {
    if (stopping) return;
    let handled = 0;
    // Messages belong to a business, except account mails (password reset, verification) that are queued before any business is known;
    // those are handled in a platform-scope pass. Without row-level security this is a single unscoped run.
    running = forEachBusiness(pool, () => dispatchOnce({ pool, transport: sender, options, log }), { platform: true, log }).then(sumResults);
    try {
      handled = await running;
    } catch (error) {
      log.error?.('Email dispatch cycle failed; it will retry.', { errorType: error?.constructor?.name ?? 'Error' });
    } finally {
      running = null;
    }
    if (!stopping) {
      const delay = handled >= options.batchSize ? 0 : options.pollSeconds * 1000;
      timer = schedule(() => { timer = null; void cycle(); }, delay);
    }
  };

  void cycle();
  return async () => {
    stopping = true;
    if (timer !== null) cancel(timer);
    await running?.catch(() => {});
  };
}