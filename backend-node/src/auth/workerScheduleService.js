import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { notifyLeaveCollision, notifyLeaveDecided, notifyLeaveRequested } from '../notifications/staffEvents.js';

const timePattern = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/;

function utcDateTime(value, field, code = 'invalid_worker_leave') {
  if (typeof value !== 'string' || !/(Z|[+]00:00)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw AppError.badRequest(code, `${field} must use the UTC offset (+00:00).`);
  }
  return new Date(value);
}

function validateUtcRange(fromValue, toValue) {
  const from = utcDateTime(fromValue, 'fromUtc', 'invalid_calendar_range');
  const to = utcDateTime(toValue, 'toUtc', 'invalid_calendar_range');
  if (to <= from || to - from > 366 * 86_400_000) {
    throw AppError.badRequest('invalid_calendar_range', 'Provide a UTC range with an end after the start, no longer than 366 days.');
  }
  return { from, to };
}

function minutesSinceMidnight(value) {
  const [hour, minute, second = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute) + Number(second);
}

function validateLeave(payload) {
  const startsAtUtc = utcDateTime(payload.startsAtUtc, 'StartsAtUtc');
  const endsAtUtc = utcDateTime(payload.endsAtUtc, 'EndsAtUtc');
  const reason = payload.reason.trim();
  if (endsAtUtc <= startsAtUtc || reason.length < 2 || reason.length > 300) {
    throw AppError.badRequest('invalid_worker_leave', 'Leave times must be UTC, the end must be after the start, and the reason must be between 2 and 300 characters.');
  }
  return { startsAtUtc, endsAtUtc, reason };
}

function leaveDto(row) {
  return {
    id: row.Id,
    membershipId: row.MembershipId,
    startsAtUtc: new Date(row.StartsAtUtc).toISOString(),
    endsAtUtc: new Date(row.EndsAtUtc).toISOString(),
    reason: row.Reason,
    status: row.Status,
    reviewNote: row.ReviewNote ?? null,
  };
}

async function audit(db, user, action, entityType, entityId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc",
      "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, $7)`,
  [randomUUID(), action, user.userId, user.businessId, details === null ? null : JSON.stringify(details), entityId, entityType]);
}

async function ensureMembership(db, businessId, membershipId, allowedLocations) {
  const { rows } = await db.query(`
    SELECT m."Id" FROM "Memberships" m
    WHERE m."BusinessId" = $1 AND m."Id" = $2 AND m."Status" = 0
      AND ($3::uuid[] IS NULL OR EXISTS (
        SELECT 1 FROM "MembershipLocations" ml
        WHERE ml."BusinessId" = m."BusinessId" AND ml."MembershipId" = m."Id"
          AND ml."LocationId" = ANY($3::uuid[])
      ))`,
  [businessId, membershipId, allowedLocations]);
  if (!rows.length) throw AppError.notFound('worker_not_found', 'That active worker was not found in this business or your permitted locations.');
}

export async function getWorkerAvailability(db, user, membershipId, allowedLocations) {
  await ensureMembership(db, user.businessId, membershipId, allowedLocations);
  const { rows } = await db.query(`
    SELECT "DayOfWeek", "IsAvailable", "OpensAt", "ClosesAt", "CapacityMinutes"
    FROM "WorkerAvailability"
    WHERE "BusinessId" = $1 AND "MembershipId" = $2
    ORDER BY "DayOfWeek"`,
  [user.businessId, membershipId]);
  return {
    membershipId,
    isConfigured: rows.length > 0,
    days: rows.map((row) => ({
      dayOfWeek: row.DayOfWeek,
      isAvailable: row.IsAvailable,
      opensAt: row.OpensAt,
      closesAt: row.ClosesAt,
      capacityMinutes: row.CapacityMinutes,
    })),
  };
}

export async function setWorkerAvailability(pool, dbTransaction, user, membershipId, days, allowedLocations) {
  await ensureMembership(pool, user.businessId, membershipId, allowedLocations);
  const dayNumbers = new Set(days.map((day) => day.dayOfWeek));
  if (days.length !== 7 || dayNumbers.size !== 7
      || days.some((day) => day.dayOfWeek < 0 || day.dayOfWeek > 6
        || (day.isAvailable && (!day.opensAt || !day.closesAt || !timePattern.test(day.opensAt)
          || !timePattern.test(day.closesAt) || minutesSinceMidnight(day.opensAt) >= minutesSinceMidnight(day.closesAt)
          || day.capacityMinutes < 1 || day.capacityMinutes > 1440))
        || (!day.isAvailable && (day.opensAt != null || day.closesAt != null || day.capacityMinutes !== 0)))) {
    throw AppError.badRequest('invalid_worker_availability', 'Provide exactly one valid availability entry for every weekday (0 Sunday through 6 Saturday).');
  }

  await dbTransaction(pool, async (db) => {
    await db.query('DELETE FROM "WorkerAvailability" WHERE "BusinessId" = $1 AND "MembershipId" = $2',
      [user.businessId, membershipId]);
    for (const day of days) {
      await db.query(`
        INSERT INTO "WorkerAvailability" ("Id", "BusinessId", "MembershipId", "DayOfWeek",
          "IsAvailable", "OpensAt", "ClosesAt", "CapacityMinutes", "CreatedAtUtc")
        VALUES ($1, $2, $3, $4, $5, $6::time, $7::time, $8, now())`,
      [randomUUID(), user.businessId, membershipId, day.dayOfWeek, day.isAvailable,
        day.isAvailable ? day.opensAt : null, day.isAvailable ? day.closesAt : null, day.capacityMinutes]);
    }
    await audit(db, user, 'worker.availability_updated', 'BusinessMembership', membershipId, {
      availableDays: days.filter((day) => day.isAvailable).length,
      dailyCapacityMinutes: days.filter((day) => day.isAvailable).reduce((total, day) => total + day.capacityMinutes, 0),
    });
  });
  return getWorkerAvailability(pool, user, membershipId, allowedLocations);
}

export async function listWorkerLeave(db, user, membershipId, fromUtc, toUtc, allowedLocations) {
  await ensureMembership(db, user.businessId, membershipId, allowedLocations);
  const range = validateUtcRange(fromUtc, toUtc);
  const { rows } = await db.query(`
    SELECT "Id", "MembershipId", "StartsAtUtc", "EndsAtUtc", "Reason", "Status", "ReviewNote"
    FROM "WorkerLeaves"
    WHERE "BusinessId" = $1 AND "MembershipId" = $2
      AND "StartsAtUtc" < $4 AND "EndsAtUtc" > $3
    ORDER BY "StartsAtUtc"`,
  [user.businessId, membershipId, range.from, range.to]);
  return rows.map(leaveDto);
}

async function assertNoApprovedOverlap(db, businessId, membershipId, startsAtUtc, endsAtUtc, excludeId = null) {
  const { rows } = await db.query(`
    SELECT 1 FROM "WorkerLeaves"
    WHERE "BusinessId" = $1 AND "MembershipId" = $2 AND "Status" = 'Approved'
      AND "StartsAtUtc" < $4 AND "EndsAtUtc" > $3
      AND ($5::uuid IS NULL OR "Id" <> $5)
    LIMIT 1`,
  [businessId, membershipId, startsAtUtc, endsAtUtc, excludeId]);
  if (rows.length) throw AppError.conflict('worker_leave_overlap', 'This leave overlaps an existing approved leave interval.');
}

export async function addWorkerLeave(pool, dbTransaction, user, membershipId, payload, allowedLocations) {
  await ensureMembership(pool, user.businessId, membershipId, allowedLocations);
  const leave = validateLeave(payload);
  const row = await dbTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`worker-leave:${user.businessId}:${membershipId}`]);
    await assertNoApprovedOverlap(db, user.businessId, membershipId, leave.startsAtUtc, leave.endsAtUtc);
    const id = randomUUID();
    const { rows } = await db.query(`
      INSERT INTO "WorkerLeaves" ("Id", "BusinessId", "MembershipId", "StartsAtUtc", "EndsAtUtc",
        "Reason", "Status", "CreatedByUserId", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, 'Approved', $7, now())
      RETURNING "Id", "MembershipId", "StartsAtUtc", "EndsAtUtc", "Reason", "Status", "ReviewNote"`,
    [id, user.businessId, membershipId, leave.startsAtUtc, leave.endsAtUtc, leave.reason, user.userId]);
    await audit(db, user, 'worker.leave_added', 'WorkerLeave', id, {
      membershipId, startsAtUtc: leave.startsAtUtc, endsAtUtc: leave.endsAtUtc, reason: leave.reason,
    });
    await notifyLeaveCollision(db, { businessId: user.businessId, leave: rows[0], status: 'Approved', actorUserId: user.userId });
    return rows[0];
  });
  return leaveDto(row);
}

export async function requestMyLeave(pool, dbTransaction, user, payload) {
  const leave = validateLeave(payload);
  const row = await dbTransaction(pool, async (db) => {
    const { rows: members } = await db.query(`
      SELECT "Id" FROM "Memberships"
      WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0
      LIMIT 1`,
    [user.businessId, user.userId]);
    if (!members.length) throw AppError.notFound('worker_not_found', 'No active membership was found in this business.');
    const membershipId = members[0].Id;
    const id = randomUUID();
    const { rows } = await db.query(`
      INSERT INTO "WorkerLeaves" ("Id", "BusinessId", "MembershipId", "StartsAtUtc", "EndsAtUtc",
        "Reason", "Status", "CreatedByUserId", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, 'Pending', $7, now())
      RETURNING "Id", "MembershipId", "StartsAtUtc", "EndsAtUtc", "Reason", "Status", "ReviewNote"`,
    [id, user.businessId, membershipId, leave.startsAtUtc, leave.endsAtUtc, leave.reason, user.userId]);
    await audit(db, user, 'worker.leave_requested', 'WorkerLeave', id, {
      membershipId, startsAtUtc: leave.startsAtUtc, endsAtUtc: leave.endsAtUtc,
    });
    // Step 16a: the managers who review leave are told, and told again when the request collides with planned work.
    const worker = await notifyLeaveRequested(db, { businessId: user.businessId, leave: rows[0], actorUserId: user.userId });
    await notifyLeaveCollision(db, { businessId: user.businessId, leave: rows[0], status: 'Pending', actorUserId: user.userId, worker });
    return rows[0];
  });
  return leaveDto(row);
}

export async function listPendingWorkerLeave(db, user, allowedLocations) {
  const { rows } = await db.query(`
    SELECT l."Id", l."MembershipId", l."StartsAtUtc", l."EndsAtUtc", l."Reason", l."Status", l."ReviewNote"
    FROM "WorkerLeaves" l
    WHERE l."BusinessId" = $1 AND l."Status" = 'Pending'
      AND ($2::uuid[] IS NULL OR EXISTS (
        SELECT 1 FROM "MembershipLocations" ml
        WHERE ml."BusinessId" = l."BusinessId" AND ml."MembershipId" = l."MembershipId"
          AND ml."LocationId" = ANY($2::uuid[])
      ))
    ORDER BY l."StartsAtUtc"`,
  [user.businessId, allowedLocations]);
  return rows.map(leaveDto);
}

export async function reviewWorkerLeave(pool, dbTransaction, user, leaveId, payload, allowedLocations) {
  if (typeof payload.approve !== 'boolean') throw AppError.badRequest('validation_failed', 'Approve must be true or false.');
  const note = payload.note?.trim() || null;
  if (note && note.length > 500) throw AppError.badRequest('invalid_review_note', 'Review note cannot exceed 500 characters.');
  return dbTransaction(pool, async (db) => {
    const { rows } = await db.query(`
      SELECT l."Id", l."MembershipId", l."StartsAtUtc", l."EndsAtUtc", l."Reason", l."Status", l."ReviewNote"
      FROM "WorkerLeaves" l
      WHERE l."BusinessId" = $1 AND l."Id" = $2
        AND ($3::uuid[] IS NULL OR EXISTS (
          SELECT 1 FROM "MembershipLocations" ml
          WHERE ml."BusinessId" = l."BusinessId" AND ml."MembershipId" = l."MembershipId"
            AND ml."LocationId" = ANY($3::uuid[])
        ))
      FOR UPDATE`,
    [user.businessId, leaveId, allowedLocations]);
    if (!rows.length) throw AppError.notFound('worker_leave_not_found', 'That leave request was not found.');
    const leave = rows[0];
    if (leave.Status !== 'Pending') {
      throw AppError.conflict('leave_request_already_reviewed', 'Only pending leave requests can be reviewed.');
    }
    if (payload.approve) {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`worker-leave:${user.businessId}:${leave.MembershipId}`]);
      await assertNoApprovedOverlap(db, user.businessId, leave.MembershipId,
        leave.StartsAtUtc, leave.EndsAtUtc, leave.Id);
    }
    const status = payload.approve ? 'Approved' : 'Rejected';
    const { rows: updated } = await db.query(`
      UPDATE "WorkerLeaves" SET "Status" = $1, "ReviewedByUserId" = $2, "ReviewedAtUtc" = now(),
        "ReviewNote" = $3, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $4 AND "Id" = $5 AND "Status" = 'Pending'
      RETURNING "Id", "MembershipId", "StartsAtUtc", "EndsAtUtc", "Reason", "Status", "ReviewNote"`,
    [status, user.userId, note, user.businessId, leaveId]);
    if (!updated.length) throw AppError.conflict('leave_request_already_reviewed', 'Only pending leave requests can be reviewed.');
    await audit(db, user, payload.approve ? 'worker.leave_approved' : 'worker.leave_rejected', 'WorkerLeave', leaveId, {
      membershipId: leave.MembershipId, reviewNote: note,
    });
    // Step 16a: the worker hears the decision; an approval that overlaps planned work also goes to the managers.
    await notifyLeaveDecided(db, { businessId: user.businessId, leave: updated[0], approved: payload.approve, note, actorUserId: user.userId });
    if (payload.approve) await notifyLeaveCollision(db, { businessId: user.businessId, leave: updated[0], status: 'Approved', actorUserId: user.userId });
    return leaveDto(updated[0]);
  });
}

export async function cancelWorkerLeave(pool, dbTransaction, user, membershipId, leaveId, allowedLocations) {
  await ensureMembership(pool, user.businessId, membershipId, allowedLocations);
  await dbTransaction(pool, async (db) => {
    const { rows } = await db.query(`
      SELECT "Id", "Status" FROM "WorkerLeaves"
      WHERE "BusinessId" = $1 AND "MembershipId" = $2 AND "Id" = $3
      FOR UPDATE`,
    [user.businessId, membershipId, leaveId]);
    if (!rows.length) throw AppError.notFound('worker_leave_not_found', 'That worker leave record was not found.');
    if (rows[0].Status === 'Cancelled') return;
    await db.query(`
      UPDATE "WorkerLeaves" SET "Status" = 'Cancelled', "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $1 AND "MembershipId" = $2 AND "Id" = $3`,
    [user.businessId, membershipId, leaveId]);
    await audit(db, user, 'worker.leave_cancelled', 'WorkerLeave', leaveId);
  });
}

/** Restrict a bearer calendar feed to both its issue-time location snapshot and current assignments. */
export function intersectCalendarFeedLocations(currentLocations, issuedLocations) {
  const current = Array.isArray(currentLocations) ? currentLocations : [];
  if (issuedLocations == null) return [...new Set(current)];
  const issued = new Set(Array.isArray(issuedLocations) ? issuedLocations : []);
  return [...new Set(current.filter((id) => issued.has(id)))];
}

export async function getWorkerCalendar(db, user, membershipId, fromUtc, toUtc, allowedLocations) {
  await ensureMembership(db, user.businessId, membershipId, allowedLocations);
  const range = validateUtcRange(fromUtc, toUtc);
  const { rows } = await db.query(`
    SELECT t."Id", t."OrderId", t."Title", t."Status", t."PlannedStartUtc", t."PlannedEndUtc", t."DeadlineUtc"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."AssignedMembershipId" = $2
      AND t."PlannedStartUtc" IS NOT NULL AND t."PlannedEndUtc" IS NOT NULL
      AND t."PlannedStartUtc" < $4 AND t."PlannedEndUtc" > $3
      AND t."Status" IN ('Scheduled', 'InProgress', 'Paused')
      AND ($5::uuid[] IS NULL OR o."LocationId" = ANY($5::uuid[]))
    ORDER BY t."PlannedStartUtc"`,
  [user.businessId, membershipId, range.from, range.to, allowedLocations]);
  return rows.map((row) => ({
    taskId: row.Id,
    orderId: row.OrderId,
    title: row.Title,
    status: row.Status,
    startUtc: new Date(row.PlannedStartUtc).toISOString(),
    endUtc: new Date(row.PlannedEndUtc).toISOString(),
    deadlineUtc: row.DeadlineUtc ? new Date(row.DeadlineUtc).toISOString() : null,
  }));
}
