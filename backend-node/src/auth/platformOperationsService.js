import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { withTransaction } from './accountService.js';

function requirePlatformAdmin(email, configuredEmails) {
  const allowed = new Set(configuredEmails.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (!email || !allowed.has(email.trim().toLowerCase())) throw AppError.forbidden('platform_admin_required', 'Platform administrator access is required.');
}

export async function listPlatformFeatureFlags(pool, userEmail, configuredEmails) {
  requirePlatformAdmin(userEmail, configuredEmails);
  const { rows } = await pool.query(`SELECT "Key","Description","Enabled","UpdatedAtUtc","UpdatedByEmail"
    FROM "PlatformFeatureFlags" ORDER BY "Key"`);
  return rows.map((row) => ({ key: row.Key, description: row.Description, enabled: row.Enabled,
    updatedAtUtc: row.UpdatedAtUtc, updatedByEmail: row.UpdatedByEmail }));
}

export async function updatePlatformFeatureFlag(pool, userEmail, configuredEmails, key, enabled) {
  requirePlatformAdmin(userEmail, configuredEmails);
  return withTransaction(pool, async (db) => {
    const { rows } = await db.query(`UPDATE "PlatformFeatureFlags" SET "Enabled"=$2,"UpdatedAtUtc"=now(),"UpdatedByEmail"=$3
      WHERE "Key"=$1 RETURNING "Key","Enabled"`, [key, enabled, userEmail.trim().toLowerCase()]);
    if (!rows.length) throw AppError.notFound('feature_flag_not_found', 'Feature flag was not found.');
    await db.query(`INSERT INTO "PlatformAuditLogs" ("Id","ActorEmail","Action","EntityType","EntityId","DetailsJson")
      VALUES ($1,$2,'platform.feature_flag.updated','PlatformFeatureFlag',$3,$4::jsonb)`,
    [randomUUID(), userEmail.trim().toLowerCase(), key, JSON.stringify({ enabled })]);
    return { key: rows[0].Key, enabled: rows[0].Enabled };
  });
}

export async function listPlatformBackgroundJobs(pool, userEmail, configuredEmails, { limit = 100, status } = {}) {
  requirePlatformAdmin(userEmail, configuredEmails);
  const take = Math.min(250, Math.max(1, Number(limit) || 100));
  const { rows } = await pool.query(`
    (SELECT 'notification'::text AS "kind", o."Id"::text AS "id", o."BusinessId"::text AS "businessId",
      o."EventType" AS "eventType", o."Status" AS "status", o."Attempts" AS "attempts",
      o."NextAttemptUtc" AS "nextAttemptUtc", o."CreatedAtUtc" AS "createdAtUtc", o."LastError" AS "lastError"
     FROM "NotificationOutbox" o WHERE ($1::text IS NULL OR o."Status"=$1))
    UNION ALL
    (SELECT 'push'::text, d."Id"::text, d."BusinessId"::text, o."EventType", d."Status", d."Attempts",
      d."NextAttemptUtc", d."CreatedAtUtc", d."ErrorCode"
     FROM "PushDeliveries" d JOIN "NotificationOutbox" o ON o."Id"=d."OutboxId" AND o."BusinessId"=d."BusinessId"
     WHERE ($1::text IS NULL OR d."Status"=$1))
    UNION ALL
    (SELECT 'worker-summary'::text, j."Id"::text, j."BusinessId"::text, j."SummaryType", j."Status", j."Attempts",
      j."NextAttemptUtc", j."CreatedAtUtc", j."LastError"
     FROM "WorkerSummaryJobs" j WHERE ($1::text IS NULL OR j."Status"=$1))
    UNION ALL
    (SELECT 'appointment-reminder'::text, r."Id"::text, r."BusinessId"::text, 'appointment.reminder'::text, r."Status", r."Attempts",
      r."NextAttemptUtc", r."CreatedAtUtc", r."LastError"
     FROM "AppointmentReminders" r WHERE ($1::text IS NULL OR r."Status"=$1))
    UNION ALL
    (SELECT 'email'::text, e."Id"::text, COALESCE(e."BusinessId"::text,'platform'), COALESCE(e."TemplateKey",'email'), e."Status", e."Attempts",
      e."NextAttemptUtc", e."CreatedAtUtc", e."LastError"
     FROM "EmailOutbox" e WHERE ($1::text IS NULL OR e."Status"=$1))
    ORDER BY "createdAtUtc" DESC LIMIT $2`, [status ?? null, take]);
  return { items: rows.map((r) => ({ kind: r.kind, id: r.id, businessId: r.businessId, eventType: r.eventType,
    status: r.status, attempts: Number(r.attempts), nextAttemptUtc: r.nextAttemptUtc, createdAtUtc: r.createdAtUtc,
    lastError: r.lastError ? String(r.lastError).slice(0, 100) : null })), limit: take };
}

export async function retryPlatformNotification(pool, userEmail, configuredEmails, kind, id) {
  requirePlatformAdmin(userEmail, configuredEmails);
  return withTransaction(pool, async (db) => {
    const table = kind === 'push' ? 'PushDeliveries' : kind === 'notification' ? 'NotificationOutbox' : null;
    if (!table) throw AppError.badRequest('invalid_job_kind', 'Choose notification or push.');
    const { rows } = await db.query(`SELECT "Id","BusinessId","Status" FROM "${table}" WHERE "Id"=$1 FOR UPDATE`, [id]);
    if (!rows.length) throw AppError.notFound('job_not_found', 'Background job was not found.');
    if (rows[0].Status !== 'Failed') throw AppError.conflict('job_not_failed', 'Only failed jobs can be retried.');
    if (kind === 'notification') {
      await db.query(`UPDATE "NotificationOutbox" SET "Status"='Pending',"Attempts"=0,"NextAttemptUtc"=now(),
        "LeaseUntilUtc"=NULL,"LastError"=NULL WHERE "Id"=$1 AND "Status"='Failed'`, [id]);
    } else {
      await db.query(`UPDATE "PushDeliveries" SET "Status"='Pending',"Attempts"=0,"NextAttemptUtc"=now(),
        "LeaseUntilUtc"=NULL,"ErrorCode"=NULL,"ProviderStatus"=NULL,"ProviderTicketId"=NULL,"AcceptedAtUtc"=NULL,"UpdatedAtUtc"=now()
        WHERE "Id"=$1 AND "Status"='Failed'`, [id]);
    }
    await db.query(`INSERT INTO "PlatformAuditLogs" ("Id","ActorEmail","Action","EntityType","EntityId","DetailsJson")
      VALUES ($1,$2,'platform.notification.retry','BackgroundJob',$3,$4::jsonb)`,
    [randomUUID(), userEmail.trim().toLowerCase(), `${kind}:${id}`, JSON.stringify({ kind, businessId: rows[0].BusinessId })]);
    return { id, kind, status: 'Pending' };
  });
}
