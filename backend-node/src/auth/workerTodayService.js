// Step-12c: what the signed-in worker has planned today, and their own leave (pending and approved) for today and the next
// 14 days. Read-only. Only the caller's own rows are returned: tasks assigned to the caller's membership and leave of that
// membership, inside the caller's business. "Today" is the business-local day.
import { AppError } from '../http/errors.js';
import { productionBusinessZone } from './productionViewService.js';
import { addDays, dayRangeUtc, localDate } from './workloadReport.js';

export const MAX_TODAY_TASKS = 100;
export const UPCOMING_LEAVE_DAYS = 14;
const MAX_LEAVES = 50;
const iso = (value) => (value ? new Date(value).toISOString() : null);

export async function getMyToday(pool, user, now = new Date()) {
  const { rows: membershipRows } = await pool.query(`
    SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0`,
  [user.businessId, user.userId]);
  if (!membershipRows.length) throw AppError.forbidden('no_active_membership', 'Your account is not an active member of this business.');
  const membershipId = membershipRows[0].Id;

  const timeZone = await productionBusinessZone(pool, user.businessId);
  const today = localDate(now, timeZone);
  const { startUtc, endUtc } = dayRangeUtc(today, timeZone);
  const leaveWindowEnd = dayRangeUtc(addDays(today, UPCOMING_LEAVE_DAYS + 1), timeZone).startUtc;

  const { rows: taskRows } = await pool.query(`
    SELECT t."Id", t."OrderId", o."OrderNumber", t."Title", t."StageName", t."Status", t."Priority",
      t."PlannedStartUtc", t."PlannedEndUtc", t."DeadlineUtc", t."EstimatedMinutes"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."AssignedMembershipId" = $2 AND t."Status" <> 'Cancelled'
      AND t."PlannedStartUtc" IS NOT NULL AND t."PlannedEndUtc" IS NOT NULL
      AND t."PlannedStartUtc" < $4 AND t."PlannedEndUtc" > $3
    ORDER BY t."PlannedStartUtc", t."Id"
    LIMIT ${MAX_TODAY_TASKS + 1}`,
  [user.businessId, membershipId, startUtc, endUtc]);
  const tasksTruncated = taskRows.length > MAX_TODAY_TASKS;

  const { rows: leaveRows } = await pool.query(`
    SELECT "Id", "StartsAtUtc", "EndsAtUtc", "Reason", "Status"
    FROM "WorkerLeaves"
    WHERE "BusinessId" = $1 AND "MembershipId" = $2 AND "Status" IN ('Pending', 'Approved')
      AND "EndsAtUtc" > $3 AND "StartsAtUtc" < $4
    ORDER BY "StartsAtUtc", "Id"
    LIMIT ${MAX_LEAVES}`,
  [user.businessId, membershipId, startUtc, leaveWindowEnd]);

  const leave = leaveRows.map((row) => ({
    leaveId: row.Id,
    startsAtUtc: iso(row.StartsAtUtc),
    endsAtUtc: iso(row.EndsAtUtc),
    reason: row.Reason,
    status: row.Status,
  }));
  const onLeaveToday = leaveRows.some((row) => row.Status === 'Approved'
    && new Date(row.StartsAtUtc) < endUtc && new Date(row.EndsAtUtc) > startUtc);

  return {
    asOfUtc: now.toISOString(),
    timeZoneId: timeZone,
    today,
    onLeaveToday,
    tasksTruncated,
    tasks: (tasksTruncated ? taskRows.slice(0, MAX_TODAY_TASKS) : taskRows).map((row) => ({
      taskId: row.Id,
      orderId: row.OrderId,
      orderNumber: row.OrderNumber,
      title: row.Title,
      stageName: row.StageName,
      status: row.Status,
      priority: row.Priority,
      startUtc: iso(row.PlannedStartUtc),
      endUtc: iso(row.PlannedEndUtc),
      deadlineUtc: iso(row.DeadlineUtc),
      estimatedMinutes: row.EstimatedMinutes ?? null,
    })),
    leave,
  };
}
