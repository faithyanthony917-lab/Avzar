// Step-12a: read-only views for managers over production work that already exists: an overview ("needs attention" and
// "today"), a per-worker workload and forecast, a shop-wide calendar, and leave that collides with planned tasks.
// Nothing here writes. Every query is scoped to the caller's business and to the locations the caller may see.
// All calculation rules live in workloadReport.js (pure, unit-tested); this file only reads rows and shapes the answer.
import { AppError } from '../http/errors.js';
import { requireFlag } from './entitlementService.js';
import { PRODUCTION_ACTIVE } from './orderTransitions.js';
import {
  LOAD_STATUSES, addDays, buildWorkload, dayRangeUtc, isRealDate, localDate, taskFlags,
} from './workloadReport.js';

const MAX_CALENDAR_ROWS = 500;
const MAX_LEAVES = 200;
const MAX_TASKS_PER_LEAVE = 50;
const SHOWN_STATUSES = ['Scheduled', 'InProgress', 'Paused', 'Blocked'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function allowedLocations(pool, user) {
  if (user.isOwner || user.permissions.includes('locations.all')) return null;
  const { rows } = await pool.query(`
    SELECT DISTINCT ml."LocationId"
    FROM "Memberships" m
    JOIN "MembershipLocations" ml ON ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId"
    WHERE m."UserId" = $1 AND m."BusinessId" = $2 AND m."Status" = 0`,
  [user.userId, user.businessId]);
  return rows.map((row) => row.LocationId);
}

export { allowedLocations as productionViewLocations };
export { businessZone as productionBusinessZone };

async function businessZone(pool, businessId) {
  const { rows } = await pool.query('SELECT "TimeZoneId" FROM "Businesses" WHERE "Id" = $1', [businessId]);
  if (!rows.length) throw AppError.notFound('business_not_found', 'Business not found.');
  const timeZone = rows[0].TimeZoneId;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw AppError.conflict('invalid_business_time_zone', 'The business time zone is not available on this server.');
  }
  return timeZone;
}

function parseFromDate(value, today) {
  if (value === undefined || value === '') return today;
  if (typeof value !== 'string' || !isRealDate(value)) {
    throw AppError.badRequest('invalid_range', 'from must be a real date in YYYY-MM-DD format.');
  }
  return value;
}

function parseDays(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const days = typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    throw AppError.badRequest('invalid_range', 'days must be a whole number from 1 to 31.');
  }
  return days;
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

function leavesByWorker(rows) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.MembershipId) ?? [];
    list.push({ startUtc: row.StartUtc, endUtc: row.EndUtc });
    map.set(row.MembershipId, list);
  }
  return map;
}

async function approvedLeaves(pool, businessId, membershipIds, startUtc, endUtc) {
  if (!membershipIds.length) return [];
  const { rows } = await pool.query(`
    SELECT "MembershipId", "StartsAtUtc" AS "StartUtc", "EndsAtUtc" AS "EndUtc"
    FROM "WorkerLeaves"
    WHERE "BusinessId" = $1 AND "MembershipId" = ANY($2::uuid[]) AND "Status" = 'Approved'
      AND "StartsAtUtc" < $4 AND "EndsAtUtc" > $3`,
  [businessId, membershipIds, startUtc, endUtc]);
  return rows;
}

function taskDto(row, flags) {
  return {
    taskId: row.Id,
    orderId: row.OrderId,
    orderNumber: row.OrderNumber,
    title: row.Title,
    stageName: row.StageName,
    status: row.Status,
    priority: row.Priority,
    membershipId: row.AssignedMembershipId,
    workerName: row.WorkerName ?? null,
    startUtc: iso(row.PlannedStartUtc),
    endUtc: iso(row.PlannedEndUtc),
    deadlineUtc: iso(row.DeadlineUtc),
    estimatedMinutes: row.EstimatedMinutes,
    flags,
  };
}

function toFlagInput(row) {
  return {
    status: row.Status,
    membershipId: row.AssignedMembershipId,
    estimatedMinutes: row.EstimatedMinutes,
    deadlineUtc: row.DeadlineUtc,
    plannedStartUtc: row.PlannedStartUtc,
    plannedEndUtc: row.PlannedEndUtc,
  };
}

/** Counts of open tasks (in orders that are in production) that need a manager's attention. */
async function attentionCounts(pool, businessId, allowed, now) {
  const { rows } = await pool.query(`
    SELECT
      count(*)::int AS "OpenTasks",
      count(*) FILTER (WHERE t."DeadlineUtc" IS NOT NULL AND t."DeadlineUtc" < $4)::int AS "Overdue",
      count(*) FILTER (WHERE t."Status" = 'Blocked')::int AS "Blocked",
      count(*) FILTER (WHERE t."AssignedMembershipId" IS NULL)::int AS "Unassigned",
      count(*) FILTER (WHERE t."EstimatedMinutes" IS NULL)::int AS "NoEstimate",
      count(*) FILTER (WHERE t."PlannedEndUtc" IS NOT NULL AND t."DeadlineUtc" IS NOT NULL
        AND t."PlannedEndUtc" > t."DeadlineUtc")::int AS "LateAgainstDeadline",
      count(*) FILTER (WHERE t."PlannedStartUtc" IS NOT NULL AND t."PlannedEndUtc" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "WorkerLeaves" l
        WHERE l."BusinessId" = t."BusinessId" AND l."MembershipId" = t."AssignedMembershipId" AND l."Status" = 'Approved'
          AND l."StartsAtUtc" < t."PlannedEndUtc" AND l."EndsAtUtc" > t."PlannedStartUtc"))::int AS "InsideLeave"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."Status" NOT IN ('Completed', 'Cancelled')
      AND o."Status" = ANY($2::text[])
      AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))`,
  [businessId, [...PRODUCTION_ACTIVE], allowed, now]);
  const row = rows[0];
  return {
    openTasks: row.OpenTasks,
    overdue: row.Overdue,
    blocked: row.Blocked,
    unassigned: row.Unassigned,
    noEstimate: row.NoEstimate,
    lateAgainstDeadline: row.LateAgainstDeadline,
    insideLeave: row.InsideLeave,
  };
}

/** Needs-attention counts plus today's planned tasks by worker. Not plan-gated: it reads data every plan has. */
export async function getProductionOverview(pool, user, allowed, now = new Date()) {
  const businessId = user.businessId;
  const timeZone = await businessZone(pool, businessId);
  const today = localDate(now, timeZone);
  const { startUtc, endUtc } = dayRangeUtc(today, timeZone);
  const attention = await attentionCounts(pool, businessId, allowed, now);

  const { rows } = await pool.query(`
    SELECT t."Id", t."OrderId", o."OrderNumber", t."Title", t."StageName", t."Status", t."Priority",
      t."AssignedMembershipId", m."DisplayName" AS "WorkerName", t."PlannedStartUtc", t."PlannedEndUtc",
      t."DeadlineUtc", t."EstimatedMinutes"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    LEFT JOIN "Memberships" m ON m."BusinessId" = t."BusinessId" AND m."Id" = t."AssignedMembershipId"
    WHERE t."BusinessId" = $1 AND t."Status" = ANY($2::text[])
      AND t."PlannedStartUtc" IS NOT NULL AND t."PlannedEndUtc" IS NOT NULL
      AND t."PlannedStartUtc" < $4 AND t."PlannedEndUtc" > $3
      AND ($5::uuid[] IS NULL OR o."LocationId" = ANY($5::uuid[]))
    ORDER BY t."PlannedStartUtc", t."Id"
    LIMIT ${MAX_CALENDAR_ROWS + 1}`,
  [businessId, SHOWN_STATUSES, startUtc, endUtc, allowed]);
  const truncated = rows.length > MAX_CALENDAR_ROWS;
  const shown = truncated ? rows.slice(0, MAX_CALENDAR_ROWS) : rows;
  const leaves = leavesByWorker(await approvedLeaves(pool, businessId,
    [...new Set(shown.map((row) => row.AssignedMembershipId).filter(Boolean))], startUtc, endUtc));

  const groups = new Map();
  for (const row of shown) {
    const key = row.AssignedMembershipId ?? 'unassigned';
    const group = groups.get(key) ?? { membershipId: row.AssignedMembershipId, displayName: row.WorkerName ?? null, tasks: [] };
    group.tasks.push(taskDto(row, taskFlags(toFlagInput(row), { now, leavesByWorker: leaves })));
    groups.set(key, group);
  }
  return {
    asOfUtc: now.toISOString(),
    timeZoneId: timeZone,
    today,
    scopedToLocations: allowed !== null,
    attention,
    todayByWorker: [...groups.values()],
    todayTruncated: truncated,
  };
}

/** Planned minutes against capacity per worker and local day, plus a forecast. Needs the shop-wide schedule plan feature. */
export async function getWorkload(pool, user, allowed, query, now = new Date()) {
  const businessId = user.businessId;
  await requireFlag(pool, businessId, 'scheduling.shop');
  const timeZone = await businessZone(pool, businessId);
  const today = localDate(now, timeZone);
  const fromDate = parseFromDate(query.from, today);
  const days = parseDays(query.days, 14);
  const lastDate = addDays(fromDate, days - 1);
  const rangeStart = dayRangeUtc(fromDate, timeZone).startUtc;
  const rangeEnd = dayRangeUtc(lastDate, timeZone).endUtc;

  const { rows: workerRows } = await pool.query(`
    SELECT m."Id", m."DisplayName"
    FROM "Memberships" m
    WHERE m."BusinessId" = $1 AND m."Status" = 0
      AND ($2::uuid[] IS NULL OR EXISTS (
        SELECT 1 FROM "MembershipLocations" ml
        WHERE ml."BusinessId" = m."BusinessId" AND ml."MembershipId" = m."Id" AND ml."LocationId" = ANY($2::uuid[])))
      AND (EXISTS (SELECT 1 FROM "WorkerAvailability" a WHERE a."BusinessId" = m."BusinessId" AND a."MembershipId" = m."Id")
        OR EXISTS (SELECT 1 FROM "ProductionTasks" t WHERE t."BusinessId" = m."BusinessId"
          AND t."AssignedMembershipId" = m."Id" AND t."Status" NOT IN ('Completed', 'Cancelled')))
    ORDER BY m."DisplayName", m."Id"
    LIMIT 200`,
  [businessId, allowed]);
  const workers = workerRows.map((row) => ({ membershipId: row.Id, displayName: row.DisplayName }));
  const ids = workers.map((worker) => worker.membershipId);

  // One query at a time: each uses its own pooled connection, and a manager screen should not take seven at once.
  const hours = await pool.query(`SELECT "DayOfWeek", "IsOpen", "OpensAt", "ClosesAt" FROM "BusinessHours" WHERE "BusinessId" = $1`, [businessId]);
  const holidays = await pool.query(`SELECT to_char("Date", 'YYYY-MM-DD') AS "Date" FROM "BusinessHolidays"
    WHERE "BusinessId" = $1 AND "Date" >= $2::date AND "Date" <= $3::date`, [businessId, fromDate, lastDate]);
  const availability = ids.length ? await pool.query(`SELECT "MembershipId", "DayOfWeek", "OpensAt", "ClosesAt", "CapacityMinutes", "IsAvailable"
    FROM "WorkerAvailability" WHERE "BusinessId" = $1 AND "MembershipId" = ANY($2::uuid[])`, [businessId, ids]) : { rows: [] };
  const leaves = await approvedLeaves(pool, businessId, ids, rangeStart, rangeEnd);
  const tasks = ids.length ? await pool.query(`
    SELECT t."AssignedMembershipId" AS "MembershipId", t."Status", t."PlannedStartUtc", t."PlannedEndUtc"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."AssignedMembershipId" = ANY($2::uuid[]) AND t."Status" = ANY($3::text[])
      AND t."PlannedStartUtc" IS NOT NULL AND t."PlannedEndUtc" IS NOT NULL
      AND t."PlannedStartUtc" < $5 AND t."PlannedEndUtc" > $4
      AND ($6::uuid[] IS NULL OR o."LocationId" = ANY($6::uuid[]))`,
  [businessId, ids, [...LOAD_STATUSES], rangeStart, rangeEnd, allowed]) : { rows: [] };
  const unplanned = ids.length ? await pool.query(`
    SELECT t."AssignedMembershipId" AS "MembershipId", count(*)::int AS "Tasks",
      COALESCE(sum(t."EstimatedMinutes"), 0)::int AS "Minutes"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."AssignedMembershipId" = ANY($2::uuid[]) AND t."Status" = 'Pending'
      AND t."PlannedStartUtc" IS NULL AND t."EstimatedMinutes" IS NOT NULL
      AND o."Status" = ANY($3::text[]) AND ($4::uuid[] IS NULL OR o."LocationId" = ANY($4::uuid[]))
    GROUP BY t."AssignedMembershipId"`,
  [businessId, ids, [...PRODUCTION_ACTIVE], allowed]) : { rows: [] };
  const attention = await attentionCounts(pool, businessId, allowed, now);

  const report = buildWorkload({
    fromDate,
    days,
    timeZone,
    weeklyHours: hours.rows.map((row) => ({
      dayOfWeek: row.DayOfWeek, isOpen: row.IsOpen, opensAt: row.OpensAt, closesAt: row.ClosesAt,
    })),
    holidays: holidays.rows.map((row) => row.Date),
    workers,
    availability: availability.rows.map((row) => ({
      membershipId: row.MembershipId, dayOfWeek: row.DayOfWeek, isAvailable: row.IsAvailable,
      opensAt: row.OpensAt, closesAt: row.ClosesAt, capacityMinutes: row.CapacityMinutes,
    })),
    leaves: leaves.map((row) => ({ membershipId: row.MembershipId, startUtc: row.StartUtc, endUtc: row.EndUtc })),
    tasks: tasks.rows.map((row) => ({
      membershipId: row.MembershipId, status: row.Status, plannedStartUtc: row.PlannedStartUtc, plannedEndUtc: row.PlannedEndUtc,
    })),
  });

  const unplannedByWorker = new Map(unplanned.rows.map((row) => [row.MembershipId, row]));
  const unplannedMinutes = unplanned.rows.reduce((sum, row) => sum + row.Minutes, 0);
  return {
    timeZoneId: timeZone,
    fromDate,
    days: report.days,
    scopedToLocations: allowed !== null,
    workers: report.workers.map((worker) => ({
      ...worker,
      unplannedTasks: unplannedByWorker.get(worker.membershipId)?.Tasks ?? 0,
      unplannedMinutes: unplannedByWorker.get(worker.membershipId)?.Minutes ?? 0,
    })),
    forecast: {
      totalCapacityMinutes: report.totalCapacityMinutes,
      totalPlannedMinutes: report.totalPlannedMinutes,
      unplannedMinutes,
      shortfallMinutes: Math.max(0, report.totalPlannedMinutes + unplannedMinutes - report.totalCapacityMinutes),
      overDays: report.workers.reduce((sum, worker) => sum + worker.overDays, 0),
      unassignedTasks: attention.unassigned,
      tasksWithoutEstimate: attention.noEstimate,
    },
  };
}

/** Shop-wide planned slots for a window of days, with a flag set per slot. Needs the shop-wide schedule plan feature. */
export async function getProductionCalendar(pool, user, allowed, query, now = new Date()) {
  const businessId = user.businessId;
  await requireFlag(pool, businessId, 'scheduling.shop');
  const timeZone = await businessZone(pool, businessId);
  const today = localDate(now, timeZone);
  const fromDate = parseFromDate(query.from, today);
  const days = parseDays(query.days, 7);
  const membershipId = query.membershipId === undefined || query.membershipId === '' ? null : query.membershipId;
  if (membershipId !== null && (typeof membershipId !== 'string' || !UUID.test(membershipId))) {
    throw AppError.badRequest('invalid_membership', 'membershipId must be a valid ID.');
  }
  const rangeStart = dayRangeUtc(fromDate, timeZone).startUtc;
  const rangeEnd = dayRangeUtc(addDays(fromDate, days - 1), timeZone).endUtc;

  const { rows } = await pool.query(`
    SELECT t."Id", t."OrderId", o."OrderNumber", t."Title", t."StageName", t."Status", t."Priority",
      t."AssignedMembershipId", m."DisplayName" AS "WorkerName", t."PlannedStartUtc", t."PlannedEndUtc",
      t."DeadlineUtc", t."EstimatedMinutes"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    LEFT JOIN "Memberships" m ON m."BusinessId" = t."BusinessId" AND m."Id" = t."AssignedMembershipId"
    WHERE t."BusinessId" = $1 AND t."Status" = ANY($2::text[])
      AND t."PlannedStartUtc" IS NOT NULL AND t."PlannedEndUtc" IS NOT NULL
      AND t."PlannedStartUtc" < $4 AND t."PlannedEndUtc" > $3
      AND ($5::uuid IS NULL OR t."AssignedMembershipId" = $5::uuid)
      AND ($6::uuid[] IS NULL OR o."LocationId" = ANY($6::uuid[]))
    ORDER BY t."PlannedStartUtc", t."Id"
    LIMIT ${MAX_CALENDAR_ROWS + 1}`,
  [businessId, [...SHOWN_STATUSES, 'Completed'], rangeStart, rangeEnd, membershipId, allowed]);
  const truncated = rows.length > MAX_CALENDAR_ROWS;
  const shown = truncated ? rows.slice(0, MAX_CALENDAR_ROWS) : rows;
  const leaves = leavesByWorker(await approvedLeaves(pool, businessId,
    [...new Set(shown.map((row) => row.AssignedMembershipId).filter(Boolean))], rangeStart, rangeEnd));
  return {
    timeZoneId: timeZone,
    fromDate,
    days,
    scopedToLocations: allowed !== null,
    truncated,
    slots: shown.map((row) => taskDto(row, taskFlags(toFlagInput(row), { now, leavesByWorker: leaves }))),
  };
}

/** Pending and approved leave that has not ended, each with the planned tasks it collides with. Not plan-gated. */
export async function getLeaveConflicts(pool, user, allowed, now = new Date()) {
  const { rows } = await pool.query(`
    WITH leaves AS (
      SELECT l."Id", l."BusinessId", l."MembershipId", l."StartsAtUtc", l."EndsAtUtc", l."Reason", l."Status"
      FROM "WorkerLeaves" l
      WHERE l."BusinessId" = $1 AND l."Status" IN ('Pending', 'Approved') AND l."EndsAtUtc" > $2
        AND ($3::uuid[] IS NULL OR EXISTS (
          SELECT 1 FROM "MembershipLocations" ml
          WHERE ml."BusinessId" = l."BusinessId" AND ml."MembershipId" = l."MembershipId" AND ml."LocationId" = ANY($3::uuid[])))
      ORDER BY l."StartsAtUtc", l."Id"
      LIMIT ${MAX_LEAVES}
    )
    SELECT l."Id" AS "LeaveId", l."MembershipId", m."DisplayName" AS "WorkerName", l."StartsAtUtc", l."EndsAtUtc",
      l."Reason", l."Status", task."Id" AS "TaskId", task."Title", task."OrderNumber", task."TaskStatus",
      task."PlannedStartUtc", task."PlannedEndUtc"
    FROM leaves l
    LEFT JOIN "Memberships" m ON m."BusinessId" = l."BusinessId" AND m."Id" = l."MembershipId"
    LEFT JOIN LATERAL (
      SELECT t."Id", t."Title", t."Status" AS "TaskStatus", t."PlannedStartUtc", t."PlannedEndUtc", o."OrderNumber"
      FROM "ProductionTasks" t
      JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
      WHERE t."BusinessId" = l."BusinessId" AND t."AssignedMembershipId" = l."MembershipId"
        AND t."Status" IN ('Scheduled', 'InProgress', 'Paused')
        AND t."PlannedStartUtc" < l."EndsAtUtc" AND t."PlannedEndUtc" > l."StartsAtUtc"
        AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
      ORDER BY t."PlannedStartUtc", t."Id"
      LIMIT ${MAX_TASKS_PER_LEAVE + 1}
    ) task ON TRUE
    ORDER BY l."StartsAtUtc", l."Id", task."PlannedStartUtc", task."Id"`,
  [user.businessId, now, allowed]);

  const byLeave = new Map();
  for (const row of rows) {
    const leave = byLeave.get(row.LeaveId) ?? {
      leaveId: row.LeaveId,
      membershipId: row.MembershipId,
      workerName: row.WorkerName ?? null,
      startsAtUtc: iso(row.StartsAtUtc),
      endsAtUtc: iso(row.EndsAtUtc),
      reason: row.Reason,
      status: row.Status,
      affectedTaskCount: 0,
      affectedTasksTruncated: false,
      affectedTasks: [],
    };
    if (row.TaskId) {
      if (leave.affectedTasks.length < MAX_TASKS_PER_LEAVE) {
        leave.affectedTasks.push({
          taskId: row.TaskId, title: row.Title, orderNumber: row.OrderNumber, status: row.TaskStatus,
          startUtc: iso(row.PlannedStartUtc), endUtc: iso(row.PlannedEndUtc),
        });
      } else leave.affectedTasksTruncated = true;
    }
    byLeave.set(row.LeaveId, leave);
  }
  const leaves = [...byLeave.values()].map((leave) => ({ ...leave, affectedTaskCount: leave.affectedTasks.length }));
  return { asOfUtc: now.toISOString(), scopedToLocations: allowed !== null, leaves };
}
