// Notifications are persisted inside the business transaction. In-app/email outbox work uses a savepoint; push fan-out
// writes durable per-token delivery rows in the same transaction. The push worker performs network calls only after commit.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { tryNormalize } from '../email/addressRules.js';
import { nextDelayMs } from '../email/retryPolicy.js';
import { getPushSender } from './pushService.js';
import {
  BODY_MAX, CATEGORIES, DEDUPE_KEY_MAX, DEFAULT_QUIET_HOURS, TARGET_KINDS, TITLE_MAX,
  clip, effectiveChannels, isCategory, quietHoursEnd,
} from './notificationCatalog.js';

export const READ_RETENTION_DAYS = 90;
export const UNREAD_RETENTION_DAYS = 180;
export const MAX_PAGE = 50;
export const UNREAD_COUNT_CAP = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECIPIENTS_SQL = `
  SELECT m."Id", m."DisplayName", appUser."Email",
    s."QuietHoursEnabled", s."QuietStartMinute", s."QuietEndMinute", b."TimeZoneId",
    p."InAppEnabled", p."EmailEnabled", p."PushEnabled"
  FROM "Memberships" m
  JOIN "AspNetUsers" appUser ON appUser."Id" = m."UserId"
  JOIN "Businesses" b ON b."Id" = m."BusinessId"
  LEFT JOIN "NotificationSettings" s ON s."MembershipId" = m."Id"
  LEFT JOIN "NotificationPreferences" p ON p."MembershipId" = m."Id" AND p."Category" = $3
  WHERE m."BusinessId" = $1 AND m."Status" = 0
    AND ($2::uuid[] IS NULL OR m."Id" = ANY($2::uuid[]))
    AND ($4::text IS NULL OR m."IsOwner" OR EXISTS (
      SELECT 1 FROM "MembershipRoles" mr
      JOIN "RolePermissions" rp ON rp."RoleId" = mr."RoleId" AND rp."BusinessId" = mr."BusinessId"
      WHERE mr."BusinessId" = m."BusinessId" AND mr."MembershipId" = m."Id" AND rp."Permission" = $4))
    AND ($5::uuid IS NULL OR m."IsOwner" OR EXISTS (
      SELECT 1 FROM "MembershipRoles" mr
      JOIN "RolePermissions" rp ON rp."RoleId" = mr."RoleId" AND rp."BusinessId" = mr."BusinessId"
      WHERE mr."BusinessId" = m."BusinessId" AND mr."MembershipId" = m."Id" AND rp."Permission" = 'locations.all')
      OR EXISTS (
      SELECT 1 FROM "MembershipLocations" ml
      WHERE ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId" AND ml."LocationId" = $5))
    AND ($6::uuid IS NULL OR m."Id" <> $6)
    AND ($7::uuid IS NULL OR m."UserId" <> $7)
    AND ($8::boolean = FALSE OR m."IsOwner")
    AND ($9::boolean = FALSE OR m."IsOwner" OR EXISTS (
      SELECT 1 FROM "MembershipRoles" mr
      JOIN "RolePermissions" rp ON rp."RoleId" = mr."RoleId" AND rp."BusinessId" = mr."BusinessId"
      WHERE mr."BusinessId" = m."BusinessId" AND mr."MembershipId" = m."Id" AND rp."Permission" = 'locations.all'))
  ORDER BY m."Id"`;

const INSERT_NOTIFICATION_SQL = `
  INSERT INTO "Notifications" ("Id","BusinessId","RecipientMembershipId","Category","EventType","Title","Body","TargetKind","TargetId","DeduplicationKey","CreatedAtUtc")
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  ON CONFLICT ("BusinessId", "RecipientMembershipId", "DeduplicationKey") DO NOTHING`;

const INSERT_EMAIL_SQL = `
  INSERT INTO "EmailOutbox" ("Id","Attempts","BusinessId","CreatedAtUtc","NextAttemptUtc","Status","Subject","TemplateKey","TextBody","ToAddress","DeduplicationKey")
  VALUES ($1,0,$2,$3,$4,'Pending',$5,$6,$7,$8,$9)
  ON CONFLICT ("DeduplicationKey") WHERE "DeduplicationKey" IS NOT NULL DO NOTHING`;

const INSERT_NOTIFICATION_OUTBOX_SQL = `
  INSERT INTO "NotificationOutbox" ("Id","BusinessId","RecipientMembershipId","Category","EventType","Title","Body",
    "TargetKind","TargetId","DeduplicationKey","InAppEnabled","EmailToAddress","EmailSubject","EmailTemplateKey",
    "EmailTextBody","EmailDeduplicationKey","EmailNextAttemptUtc","PushEnabled","PushNextAttemptUtc","Status","Attempts","NextAttemptUtc","CreatedAtUtc")
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'Pending',0,$20,$20)
  ON CONFLICT ("BusinessId","RecipientMembershipId","DeduplicationKey") DO NOTHING
  RETURNING *`;


let savepointCounter = 0;

function describeError(error) {
  return error?.constructor?.name ?? 'Error';
}


function validateEvent(event) {
  if (!event || typeof event !== 'object') throw new TypeError('A notification event is required.');
  if (!UUID.test(String(event.businessId ?? ''))) throw new TypeError('businessId must be a UUID.');
  if (!isCategory(event.category)) throw new TypeError(`Unknown notification category: ${event.category}`);
  if (!event.eventType || String(event.eventType).length > 60) throw new TypeError('eventType is required (60 characters at most).');
  if (!String(event.title ?? '').trim() || !String(event.body ?? '').trim()) throw new TypeError('title and body are required.');
  if (!event.dedupeKey || String(event.dedupeKey).length > DEDUPE_KEY_MAX) throw new TypeError(`dedupeKey is required (${DEDUPE_KEY_MAX} characters at most).`);
  const to = event.recipients;
  if (!to || (!Array.isArray(to.membershipIds) && !to.permission && to.ownersOnly !== true)) throw new TypeError('recipients needs membershipIds, a permission, or an owner-only filter; a notification is never broadcast to everyone.');
  if (Array.isArray(to.membershipIds) && to.membershipIds.some((id) => !UUID.test(String(id)))) throw new TypeError('recipients.membershipIds must be UUIDs.');
  if (to.locationId != null && !UUID.test(String(to.locationId))) throw new TypeError('recipients.locationId must be a UUID.');
  if (to.ownersOnly != null && typeof to.ownersOnly !== 'boolean') throw new TypeError('recipients.ownersOnly must be boolean.');
  if (to.locationlessOnly != null && typeof to.locationlessOnly !== 'boolean') throw new TypeError('recipients.locationlessOnly must be boolean.');
  if (event.actorUserId != null && !UUID.test(String(event.actorUserId))) throw new TypeError('actorUserId must be a UUID.');
  if (event.target) {
    if (!TARGET_KINDS.includes(event.target.kind)) throw new TypeError(`Unknown notification target kind: ${event.target.kind}`);
    if (event.target.id != null && !UUID.test(String(event.target.id))) throw new TypeError('target.id must be a UUID.');
  }
  if (event.email) {
    if (!event.email.templateKey || !event.email.subject || typeof event.email.text !== 'function') throw new TypeError('email needs templateKey, subject and a text(recipient) function.');
  }
}

/**
 * Creates the in-app notification (and, when preferences allow, the queued email) for each recipient.
 *
 * event: {
 *   businessId, category, eventType, title, body, dedupeKey,
 *   target?: { kind, id },
 *   recipients: { membershipIds?: uuid[], permission?: string, locationId?: uuid },   // filters combine with AND
 *   actorMembershipId?: uuid,                                                        // never notified about their own action
 *   email?: { templateKey, subject, text(recipient) => string, dedupeKey?(recipient) => string },
 * }
 *
 * In-app rows use dedupeKey as given; email rows use email.dedupeKey(recipient) or `${dedupeKey}:${membershipId}`.
 * Returns { ok, recipients, inApp, email }; channel counts are durable intents accepted by this call.
 */
export async function notify(db, event, { now = new Date(), log = console } = {}) {
  try {
    validateEvent(event);
  } catch (error) {
    log.error?.('Invalid notification event.', { errorType: describeError(error), eventType: event?.eventType });
    return { ok: false, recipients: 0, inApp: 0, email: 0 };
  }

  const to = event.recipients;
  const { rows: people } = await db.query(RECIPIENTS_SQL, [
    event.businessId, Array.isArray(to.membershipIds) ? to.membershipIds : null, event.category,
    to.permission ?? null, to.locationId ?? null, event.actorMembershipId ?? null, event.actorUserId ?? null,
    to.ownersOnly ?? false, to.locationlessOnly ?? false,
  ]);

  const title = clip(event.title, TITLE_MAX);
  const body = clip(event.body, BODY_MAX);
  const target = event.target ?? null;
  const useSavepoint = typeof db?.release === 'function';
  let inApp = 0;
  let email = 0;
  for (const person of people) {
    const channels = effectiveChannels(event.category, person);
    const address = channels.email && event.email ? tryNormalize(person.Email) : null;
    if (!channels.inApp && !address && !channels.push) continue;

    const quiet = quietHoursEnd(now, {
      enabled: person.QuietHoursEnabled ?? DEFAULT_QUIET_HOURS.enabled,
      startMinute: person.QuietStartMinute ?? DEFAULT_QUIET_HOURS.startMinute,
      endMinute: person.QuietEndMinute ?? DEFAULT_QUIET_HOURS.endMinute,
    }, person.TimeZoneId);
    const memberKey = String(person.Id).replaceAll('-', '').toLowerCase();
    const emailKey = address
      ? (event.email.dedupeKey ? event.email.dedupeKey(person) : `${event.dedupeKey}:${memberKey}`).slice(0, DEDUPE_KEY_MAX)
      : null;
    const { rows: queued } = await db.query(INSERT_NOTIFICATION_OUTBOX_SQL, [
      randomUUID(), event.businessId, person.Id, event.category, event.eventType, title, body,
      target?.kind ?? null, target?.id ?? null, event.dedupeKey, channels.inApp,
      address, address ? clip(event.email.subject, 200) : null, address ? event.email.templateKey : null,
      address ? event.email.text(person) : null, emailKey, address ? quiet ?? now : null, channels.push, channels.push ? quiet ?? now : null, now,
    ]);
    const job = queued[0];
    if (!job) continue;
    if (channels.inApp) inApp += 1;
    if (address) email += 1;

    const savepoint = `avzar_notify_${++savepointCounter}`;
    if (useSavepoint) await db.query(`SAVEPOINT ${savepoint}`);
    try {
      await deliverNotificationOutboxJob(db, job, { now, expectedStatus: 'Pending' });
      if (useSavepoint) await db.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      if (useSavepoint) {
        await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {});
        await db.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => {});
      }
      await db.query(`
        UPDATE "NotificationOutbox" SET "NextAttemptUtc" = $3, "LastError" = $2
        WHERE "Id" = $1 AND "Status" = 'Pending'`,
      [job.Id, describeError(error), new Date(now.getTime() + nextDelayMs(1))]);
      log.error?.('Notification delivery failed; the durable outbox will retry.', {
        errorType: describeError(error), ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
        ...(typeof error?.constraint === 'string' ? { constraint: error.constraint } : {}),
        eventType: event.eventType,
      });
    }
  }
  return { ok: true, recipients: people.length, inApp, email };
}

export async function deliverNotificationOutboxJob(db, job, { now = new Date(), expectedStatus = job.Status } = {}) {
  let inApp = 0;
  let email = 0;
  if (job.InAppEnabled) {
    const result = await db.query(INSERT_NOTIFICATION_SQL, [
      randomUUID(), job.BusinessId, job.RecipientMembershipId, job.Category, job.EventType, job.Title, job.Body,
      job.TargetKind, job.TargetId, job.DeduplicationKey, job.CreatedAtUtc,
    ]);
    inApp = result.rowCount ?? 0;
  }
  if (job.EmailToAddress) {
    const result = await db.query(INSERT_EMAIL_SQL, [
      randomUUID(), job.BusinessId, job.CreatedAtUtc, job.EmailNextAttemptUtc, job.EmailSubject,
      job.EmailTemplateKey, job.EmailTextBody, job.EmailToAddress, job.EmailDeduplicationKey,
    ]);
    email = result.rowCount ?? 0;
  }
  if (job.PushEnabled && getPushSender()) {
    const { rows: tokens } = await db.query(`
      SELECT t."Id",t."BusinessId",t."MembershipId",t."SessionId"
      FROM "PushTokens" t
      JOIN "UserSessions" session ON session."Id" = t."SessionId" AND session."BusinessId" = t."BusinessId"
      JOIN "Memberships" m ON m."Id" = t."MembershipId" AND m."BusinessId" = t."BusinessId"
      LEFT JOIN "Appointments" a ON a."BusinessId" = $2 AND a."Id" = $3 AND $4 = 'appointment'
      WHERE t."BusinessId" = $2 AND t."MembershipId" = $5 AND t."Active" = TRUE
        AND session."RevokedAtUtc" IS NULL AND session."AbsoluteExpiresAtUtc" > $1 AND session."IdleExpiresAtUtc" > $1
        AND m."Status" = 0
        AND (COALESCE($4,'') <> 'appointment' OR (a."Id" IS NOT NULL AND a."Status" = 'Scheduled' AND a."StartUtc" > $1))`,
    [now, job.BusinessId, job.TargetId, job.TargetKind, job.RecipientMembershipId]);
    for (const token of tokens) {
      await db.query(`INSERT INTO "PushDeliveries" ("Id","BusinessId","OutboxId","RecipientMembershipId","PushTokenId","Status","Attempts","NextAttemptUtc","ExpiresAtUtc","CreatedAtUtc","UpdatedAtUtc")
        VALUES ($1,$2,$3,$4,$5,'Pending',0,$6,$7,$8,$8) ON CONFLICT ("OutboxId","PushTokenId") DO NOTHING`,
      [randomUUID(), token.BusinessId, job.Id, token.MembershipId, token.Id, job.PushNextAttemptUtc ?? now,
        job.TargetKind === 'appointment' ? (await db.query('SELECT "StartUtc" FROM "Appointments" WHERE "BusinessId"=$1 AND "Id"=$2', [job.BusinessId, job.TargetId])).rows[0]?.StartUtc ?? null : null, now]);
    }
  }
  const result = await db.query(`
    UPDATE "NotificationOutbox" SET "Status" = 'Sent', "LeaseUntilUtc" = NULL,
      "SentAtUtc" = $3, "LastError" = NULL,
      "EmailTextBody" = CASE WHEN "EmailToAddress" IS NULL THEN NULL ELSE '' END
    WHERE "Id" = $1 AND "Status" = $2`, [job.Id, expectedStatus, now]);
  if ((result.rowCount ?? 0) !== 1) throw new Error('NotificationOutboxStateChanged');
  return { inApp, email };
}

function mapNotification(row) {
  return {
    id: row.Id,
    category: row.Category,
    eventType: row.EventType,
    title: row.Title,
    body: row.Body,
    target: row.TargetKind ? { kind: row.TargetKind, id: row.TargetId ?? null } : null,
    createdAtUtc: new Date(row.CreatedAtUtc).toISOString(),
    readAtUtc: row.ReadAtUtc ? new Date(row.ReadAtUtc).toISOString() : null,
    isRead: row.ReadAtUtc != null,
  };
}

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: new Date(row.CreatedAtUtc).toISOString(), id: row.Id })).toString('base64url');
}

export function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof value?.t === 'string' && !Number.isNaN(Date.parse(value.t)) && UUID.test(String(value.id))) return { t: new Date(value.t), id: value.id };
  } catch { /* fall through */ }
  throw AppError.badRequest('invalid_cursor', 'The cursor is not valid.');
}

/** Newest first, keyset-paged. Only the caller's own notifications in the caller's business. */
export async function listNotifications(db, { businessId, membershipId, unread = false, category = null, limit = 20, cursor = null }) {
  if (category !== null && !isCategory(category)) throw AppError.badRequest('invalid_category', 'Unknown notification category.');
  const pageSize = Math.max(1, Math.min(MAX_PAGE, Math.trunc(limit) || 20));
  const after = cursor ? decodeCursor(cursor) : null;
  const { rows } = await db.query(`
    SELECT "Id","Category","EventType","Title","Body","TargetKind","TargetId","CreatedAtUtc","ReadAtUtc"
    FROM "Notifications"
    WHERE "BusinessId" = $1 AND "RecipientMembershipId" = $2
      AND ($3::boolean = FALSE OR "ReadAtUtc" IS NULL)
      AND ($4::text IS NULL OR "Category" = $4)
      AND ($5::timestamptz IS NULL OR ("CreatedAtUtc", "Id") < ($5::timestamptz, $6::uuid))
    ORDER BY "CreatedAtUtc" DESC, "Id" DESC
    LIMIT $7`,
  [businessId, membershipId, Boolean(unread), category, after?.t ?? null, after?.id ?? null, pageSize + 1]);
  const page = rows.slice(0, pageSize);
  return { items: page.map(mapNotification), nextCursor: rows.length > pageSize ? encodeCursor(page[page.length - 1]) : null };
}

/** Unread count, capped so the query stays cheap for a person with a huge backlog. */
export async function unreadCount(db, { businessId, membershipId }) {
  const { rows } = await db.query(`
    SELECT count(*)::int AS "Count" FROM (
      SELECT 1 FROM "Notifications"
      WHERE "BusinessId" = $1 AND "RecipientMembershipId" = $2 AND "ReadAtUtc" IS NULL
      LIMIT $3) unread`,
  [businessId, membershipId, UNREAD_COUNT_CAP]);
  const count = Number(rows[0]?.Count ?? 0);
  return { count, capped: count >= UNREAD_COUNT_CAP };
}

/** Marks one of the caller's own notifications read (idempotent). Someone else's, or another business's, is simply "not found". */
export async function markRead(db, { businessId, membershipId, id, now = new Date() }) {
  if (!UUID.test(String(id))) throw AppError.notFound('notification_not_found', 'Notification not found.');
  const { rows } = await db.query(`
    UPDATE "Notifications" SET "ReadAtUtc" = COALESCE("ReadAtUtc", $4)
    WHERE "Id" = $1 AND "BusinessId" = $2 AND "RecipientMembershipId" = $3
    RETURNING "Id","Category","EventType","Title","Body","TargetKind","TargetId","CreatedAtUtc","ReadAtUtc"`,
  [id, businessId, membershipId, now]);
  if (!rows.length) throw AppError.notFound('notification_not_found', 'Notification not found.');
  return mapNotification(rows[0]);
}

export async function markAllRead(db, { businessId, membershipId, category = null, now = new Date() }) {
  if (category !== null && !isCategory(category)) throw AppError.badRequest('invalid_category', 'Unknown notification category.');
  const result = await db.query(`
    UPDATE "Notifications" SET "ReadAtUtc" = $3
    WHERE "BusinessId" = $1 AND "RecipientMembershipId" = $2 AND "ReadAtUtc" IS NULL AND ($4::text IS NULL OR "Category" = $4)`,
  [businessId, membershipId, now, category]);
  return { updated: result.rowCount ?? 0 };
}

export async function getPreferences(db, { businessId, membershipId, pushAvailable = false } = {}) {
  const [{ rows: prefRows }, { rows: settingRows }] = await Promise.all([
    db.query('SELECT "Category","InAppEnabled","EmailEnabled","PushEnabled" FROM "NotificationPreferences" WHERE "BusinessId" = $1 AND "MembershipId" = $2', [businessId, membershipId]),
    db.query('SELECT "QuietHoursEnabled","QuietStartMinute","QuietEndMinute" FROM "NotificationSettings" WHERE "BusinessId" = $1 AND "MembershipId" = $2', [businessId, membershipId]),
  ]);
  const byCategory = new Map(prefRows.map((row) => [row.Category, row]));
  const setting = settingRows[0];
  return {
    categories: CATEGORIES.map((category) => {
      const channels = effectiveChannels(category, byCategory.get(category));
      return { category, inApp: channels.inApp, email: channels.email, push: channels.push };
    }),
    quietHours: setting
      ? { enabled: setting.QuietHoursEnabled, startMinute: setting.QuietStartMinute, endMinute: setting.QuietEndMinute }
      : { ...DEFAULT_QUIET_HOURS },
    pushAvailable,
  };
}

const pushTokenSchema = z.object({
  token: z.string().trim().min(1).max(200),
  platform: z.enum(['ios', 'android', 'web']).default('ios'),
  deviceName: z.string().trim().max(80).nullish(),
}).strict();

export async function registerPushToken(pool, { businessId, membershipId, sessionId, token, platform = 'ios', deviceName = null, now = new Date() }) {
  const parsed = pushTokenSchema.safeParse({ token, platform, deviceName });
  if (!parsed.success) throw AppError.badRequest('invalid_push_token', parsed.error.issues[0]?.message ?? 'The push token is not valid.');
  if (!UUID.test(String(sessionId ?? ''))) throw AppError.unauthorized('invalid_session', 'A valid signed-in session is required to register push notifications.');
  const device = String(parsed.data.deviceName ?? '').trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query(`SELECT 1 FROM "UserSessions" s JOIN "Memberships" m ON m."UserId"=s."UserId" AND m."BusinessId"=s."BusinessId"
      WHERE s."Id"=$1 AND s."UserId"=(SELECT "UserId" FROM "Memberships" WHERE "Id"=$2 AND "BusinessId"=$3 AND "Status"=0)
        AND s."BusinessId"=$3 AND s."RevokedAtUtc" IS NULL AND s."AbsoluteExpiresAtUtc">$4 AND s."IdleExpiresAtUtc">$4`,
    [sessionId,membershipId,businessId,now]);
    if (!session.rowCount) throw AppError.unauthorized('invalid_session', 'A valid active session is required to register push notifications.');
    await client.query(`UPDATE "PushTokens" SET "Active"=FALSE,"DeactivatedAtUtc"=$2,"DeactivatedReason"='superseded',"UpdatedAtUtc"=$2
      WHERE "Token"=$1 AND "Active"=TRUE`, [parsed.data.token,now]);
    await client.query(`INSERT INTO "PushTokens" ("Id","MembershipId","BusinessId","Token","Platform","DeviceName","Active","CreatedAtUtc","UpdatedAtUtc","SessionId")
      VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$7,$8)`, [randomUUID(),membershipId,businessId,parsed.data.token,parsed.data.platform,device||null,now,sessionId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
  return { ok: true };
}

export async function revokePushToken(pool, { businessId, membershipId, sessionId, token, now = new Date() }) {
  const parsed = pushTokenSchema.pick({ token: true }).safeParse({ token });
  if (!parsed.success) throw AppError.badRequest('invalid_push_token', 'The push token is not valid.');
  const result = await pool.query(`UPDATE "PushTokens" SET "Active"=FALSE,"DeactivatedAtUtc"=$5,"DeactivatedReason"='logout',"UpdatedAtUtc"=$5
    WHERE "BusinessId"=$1 AND "MembershipId"=$2 AND "SessionId"=$3 AND "Token"=$4 AND "Active"=TRUE`,
  [businessId,membershipId,sessionId,parsed.data.token,now]);
  return { ok: true, revoked: result.rowCount ?? 0 };
}

const minute = z.number().int().min(0).max(1439);
export const preferencesSchema = z.object({
  categories: z.array(z.object({
    category: z.enum(CATEGORIES),
    inApp: z.boolean(),
    email: z.boolean(),
    push: z.boolean().optional(),
  }).strict()).max(CATEGORIES.length).optional(),
  quietHours: z.object({ enabled: z.boolean(), startMinute: minute, endMinute: minute }).strict()
    .refine((value) => !value.enabled || value.startMinute !== value.endMinute, { message: 'Quiet hours need different start and end times.' }).optional(),
}).strict().refine((value) => value.categories || value.quietHours, { message: 'Nothing to update.' })
  .refine((value) => !value.categories || new Set(value.categories.map((entry) => entry.category)).size === value.categories.length, { message: 'Each category may appear once.' });

/** Saves only what the body contains; categories it leaves out keep their stored or default values. */
export async function savePreferences(pool, { businessId, membershipId, body, now = new Date() }) {
  const parsed = preferencesSchema.safeParse(body);
  if (!parsed.success) throw AppError.badRequest('invalid_preferences', parsed.error.issues[0]?.message ?? 'The preferences are not valid.');
  const { categories, quietHours } = parsed.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of categories ?? []) {
      await client.query(`
        INSERT INTO "NotificationPreferences" ("MembershipId","BusinessId","Category","InAppEnabled","EmailEnabled","PushEnabled","UpdatedAtUtc")
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT ("MembershipId","Category") DO UPDATE SET "InAppEnabled" = EXCLUDED."InAppEnabled",
          "EmailEnabled" = EXCLUDED."EmailEnabled", "PushEnabled" = EXCLUDED."PushEnabled", "UpdatedAtUtc" = EXCLUDED."UpdatedAtUtc"`,
      [membershipId, businessId, entry.category, entry.inApp, entry.email, entry.push ?? false, now]);
    }
    if (quietHours) {
      await client.query(`
        INSERT INTO "NotificationSettings" ("MembershipId","BusinessId","QuietHoursEnabled","QuietStartMinute","QuietEndMinute","UpdatedAtUtc")
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT ("MembershipId") DO UPDATE SET "QuietHoursEnabled" = EXCLUDED."QuietHoursEnabled",
          "QuietStartMinute" = EXCLUDED."QuietStartMinute", "QuietEndMinute" = EXCLUDED."QuietEndMinute", "UpdatedAtUtc" = EXCLUDED."UpdatedAtUtc"`,
      [membershipId, businessId, quietHours.enabled, quietHours.startMinute, quietHours.endMinute, now]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return getPreferences(pool, { businessId, membershipId });
}

/** Retention: read notifications after 90 days, unread after 180. Returns how many rows were deleted. */
export async function purgeOldNotifications(db, { now = new Date(), batchLimit = 5000 } = {}) {
  const readBefore = new Date(now.getTime() - READ_RETENTION_DAYS * 86_400_000);
  const unreadBefore = new Date(now.getTime() - UNREAD_RETENTION_DAYS * 86_400_000);
  const result = await db.query(`
    DELETE FROM "Notifications" WHERE "Id" IN (
      SELECT "Id" FROM "Notifications"
      WHERE ("ReadAtUtc" IS NOT NULL AND "CreatedAtUtc" < $1) OR "CreatedAtUtc" < $2
      LIMIT $3)`,
  [readBefore, unreadBefore, Math.max(1, Math.min(50_000, Math.trunc(batchLimit)))]);
  const pushBefore = new Date(now.getTime() - 30 * 86_400_000);
  await db.query(`DELETE FROM "PushDeliveries" WHERE "Id" IN (
    SELECT "Id" FROM "PushDeliveries" WHERE "Status" IN ('Accepted','Failed','Skipped')
      AND "UpdatedAtUtc" < $1 AND "LeaseUntilUtc" IS NULL LIMIT $2)`,
  [pushBefore, Math.max(1, Math.min(50_000, Math.trunc(batchLimit)))]).catch((error) => {
    if (error?.code !== '42P01') throw error;
  });
  return result.rowCount ?? 0;
}

/** The caller's membership id in the active business, or null when it is no longer active. */
export async function membershipIdFor(db, user) {
  const { rows } = await db.query('SELECT "Id" FROM "Memberships" WHERE "UserId" = $1 AND "BusinessId" = $2 AND "Status" = 0', [user.userId, user.businessId]);
  return rows[0]?.Id ?? null;
}
