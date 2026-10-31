import { bindTenantByLookup } from '../db/tenantLookup.js';
import { runWithTenantPlatformScope } from '../db/tenantRlsContext.js';
import { withFreshTenantContext } from '../db/forEachBusiness.js';
import { isRlsPool } from '../db/userScope.js';
import { parseSecret, verify } from './svix.js';

const deliveryStatus = Object.freeze({
  'email.delivery_delayed': 'Delayed',
  'email.delivered': 'Delivered',
  'email.bounced': 'Bounced',
  'email.complained': 'Complained',
});

const rank = Object.freeze({ Delayed: 1, Delivered: 2, Bounced: 3, Complained: 3 });

function clean(value, max) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const result = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return result ? result.slice(0, max) : null;
}

function parseEvent(body) {
  try {
    const root = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    if (!root || typeof root !== 'object' || Array.isArray(root) || typeof root.type !== 'string') return null;
    const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : {};
    const bounce = data.bounce && typeof data.bounce === 'object' && !Array.isArray(data.bounce) ? data.bounce : {};
    return {
      type: root.type,
      emailId: typeof data.email_id === 'string' ? data.email_id : null,
      detail: clean(bounce.message, 300),
      bounceType: clean(bounce.type, 30),
    };
  } catch {
    return null;
  }
}

export async function handleResendWebhook({ pool, secret, id, timestamp, signature, body, now = Date.now(), log = console }) {
  const key = parseSecret(secret);
  if (!key) return 'disabled';
  if (!verify(key, id, timestamp, signature, body, now)) return 'invalid_signature';

  const event = parseEvent(body);
  if (!event) return 'ignored';
  const status = deliveryStatus[event.type];
  if (!status || !event.emailId || event.emailId.length > 200) return 'ignored';

  const outcome = await withFreshTenantContext(pool, async () => {
    // The provider's message ID is the key. A message queued for a business is read and updated under that business; account mails
    // (password reset, verification) belong to no business and are reached only through the platform scope.
    if (!isRlsPool(pool) || await bindTenantByLookup(pool, 'email_provider_message_id', event.emailId)) return applyDelivery(pool, event, status, now);
    return runWithTenantPlatformScope(() => applyDelivery(pool, event, status, now));
  });
  if (outcome === 'unknown_message') log.warn?.(JSON.stringify({ level: 'warn', event: 'resend_webhook_unknown_message', emailId: event.emailId, type: event.type }));
  return outcome;
}

async function applyDelivery(pool, event, status, now) {
  let suppressionReason = null;
  if (event.type === 'email.complained') suppressionReason = 'Complained';
  if (event.type === 'email.bounced' && event.bounceType?.toLowerCase() === 'permanent') suppressionReason = 'Bounced';

  if (suppressionReason) {
    await pool.query(`
      INSERT INTO "EmailSuppressions" ("Id","CreatedAtUtc","Address","Reason")
      SELECT gen_random_uuid(),now(),lower(btrim("ToAddress")),$2
      FROM "EmailOutbox" WHERE "ProviderMessageId" = $1
      ORDER BY "CreatedAtUtc" LIMIT 1
      ON CONFLICT ("Address") DO NOTHING`, [event.emailId, suppressionReason]);
  }

  const replaceable = Object.keys(rank).filter((candidate) => rank[candidate] < rank[status]);
  const changed = await pool.query(`
    UPDATE "EmailOutbox"
    SET "DeliveryStatus" = $2, "DeliveryUpdatedAtUtc" = to_timestamp($3 / 1000.0), "DeliveryDetail" = $4
    WHERE "ProviderMessageId" = $1
      AND ("DeliveryStatus" IS NULL OR "DeliveryStatus" = ANY($5::text[]))`,
  [event.emailId, status, now, event.detail, replaceable]);
  if (changed.rowCount > 0) return 'applied';

  const known = await pool.query('SELECT 1 FROM "EmailOutbox" WHERE "ProviderMessageId" = $1 LIMIT 1', [event.emailId]);
  return known.rows.length ? 'no_change' : 'unknown_message';
}
