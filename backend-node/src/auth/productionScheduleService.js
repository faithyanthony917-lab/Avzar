import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { planProductionSchedule } from './productionSchedulePlanner.js';
import { notify } from '../notifications/notificationService.js';

const parseInstant = (value) => new Date(value);

function assertUtc(value) {
  if (typeof value !== 'string' || !/(Z|[+]00:00)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw AppError.badRequest('schedule_start_must_be_utc', 'StartUtc must use the UTC offset (+00:00).');
  }
}

function validateHorizon(horizonDays) {
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366) {
    throw AppError.badRequest('invalid_schedule_horizon', 'HorizonDays must be between 1 and 366.');
  }
}

export async function previewShopSchedule(db, user, request, allowedLocations) {
  const businessId = user.businessId;
  assertUtc(request.startUtc);
  validateHorizon(request.horizonDays);
  const startUtc = parseInstant(request.startUtc);
  const endUtc = new Date(startUtc.getTime() + request.horizonDays * 86_400_000);

  const { rows: entitlementRows } = await db.query(`
    SELECT p."Code" AS "PlanCode", COALESCE(override."Value", pe."Value", 'false') AS "Value"
    FROM "Plans" p
    LEFT JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id" AND pe."Key" = $2
    LEFT JOIN LATERAL (
      SELECT o."Value" FROM "EntitlementOverrides" o
      WHERE o."BusinessId" = $1 AND o."Key" = $2
        AND (o."ExpiresAtUtc" IS NULL OR o."ExpiresAtUtc" > now())
      ORDER BY o."CreatedAtUtc" DESC LIMIT 1
    ) override ON TRUE
    WHERE p."Id" = COALESCE(
      (SELECT s."PlanId" FROM "Subscriptions" s
        WHERE s."BusinessId" = $1 AND s."Status" <> 'Expired' LIMIT 1),
      (SELECT free."Id" FROM "Plans" free WHERE free."Code" = 'free' LIMIT 1)
    )`,
  [businessId, 'scheduling.shop']);
  if (!entitlementRows.length) {
    throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');
  }
  const entitlement = String(entitlementRows[0].Value ?? '').trim();
  if (entitlement !== 'true') {
    throw AppError.forbidden('feature_not_in_plan', 'Your current plan does not include the shop-wide schedule.');
  }

  const { rows: businesses } = await db.query(
    'SELECT "TimeZoneId" FROM "Businesses" WHERE "Id" = $1',
    [businessId],
  );
  if (!businesses.length) throw AppError.notFound('business_not_found', 'Business not found.');
  const timeZone = businesses[0].TimeZoneId;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw AppError.conflict('invalid_business_time_zone', 'The business time zone is not available on this server.');
  }

  const { rows: weeklyHours } = await db.query(`
    SELECT "DayOfWeek", "IsOpen", "OpensAt", "ClosesAt"
    FROM "BusinessHours" WHERE "BusinessId" = $1 ORDER BY "DayOfWeek"`,
  [businessId]);
  const { rows: candidates } = await db.query(`
    SELECT t."Id", t."AssignedMembershipId", t."EstimatedMinutes", t."Priority", t."DeadlineUtc",
      t."StageOrder", t.xmin::text::bigint AS "Version"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."Status" IN ('Pending', 'Scheduled')
      AND ($2::uuid[] IS NULL OR o."LocationId" = ANY($2::uuid[]))`,
  [businessId, allowedLocations]);
  const taskIds = candidates.map((task) => task.Id);
  const { rows: dependencies } = taskIds.length ? await db.query(`
    SELECT d."TaskId", d."DependsOnTaskId"
    FROM "TaskDependencies" d
    WHERE d."BusinessId" = $1 AND d."TaskId" = ANY($2::uuid[])`,
  [businessId, taskIds]) : { rows: [] };
  const dependencyIds = [...new Set(dependencies.map((row) => row.DependsOnTaskId))];
  const { rows: satisfied } = dependencyIds.length ? await db.query(`
    SELECT "Id" FROM "ProductionTasks"
    WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[]) AND "Status" IN ('Completed', 'Cancelled')`,
  [businessId, dependencyIds]) : { rows: [] };
  const satisfiedIds = new Set(satisfied.map((row) => row.Id));
  const depsByTask = new Map();
  for (const dependency of dependencies) {
    const values = depsByTask.get(dependency.TaskId) ?? [];
    if (!satisfiedIds.has(dependency.DependsOnTaskId)) values.push(dependency.DependsOnTaskId);
    depsByTask.set(dependency.TaskId, values);
  }

  const { rows: reservations } = await db.query(`
    SELECT t."AssignedMembershipId" AS "MembershipId", t."PlannedStartUtc" AS "StartUtc",
      t."PlannedEndUtc" AS "EndUtc"
    FROM "ProductionTasks" t
    WHERE t."BusinessId" = $1 AND NOT (t."Id" = ANY($2::uuid[]))
      AND t."AssignedMembershipId" IS NOT NULL AND t."PlannedStartUtc" IS NOT NULL AND t."PlannedEndUtc" IS NOT NULL
      AND t."Status" IN ('Scheduled', 'InProgress', 'Paused')`,
  [businessId, taskIds]);
  const { rows: holidays } = await db.query(`
    SELECT "Date" FROM "BusinessHolidays"
    WHERE "BusinessId" = $1 AND "Date" >= ($2::timestamptz AT TIME ZONE $3)::date
      AND "Date" <= ($4::timestamptz AT TIME ZONE $3)::date`,
  [businessId, startUtc, timeZone, endUtc]);
  const membershipIds = [...new Set(candidates.map((task) => task.AssignedMembershipId).filter(Boolean))];
  const { rows: availability } = membershipIds.length ? await db.query(`
    SELECT "MembershipId", "DayOfWeek", "OpensAt", "ClosesAt", "CapacityMinutes", "IsAvailable"
    FROM "WorkerAvailability" WHERE "BusinessId" = $1 AND "MembershipId" = ANY($2::uuid[])`,
  [businessId, membershipIds]) : { rows: [] };
  const { rows: leaves } = membershipIds.length ? await db.query(`
    SELECT "MembershipId", "StartsAtUtc" AS "StartUtc", "EndsAtUtc" AS "EndUtc"
    FROM "WorkerLeaves" WHERE "BusinessId" = $1 AND "MembershipId" = ANY($2::uuid[])
      AND "Status" = 'Approved' AND "StartsAtUtc" < $4 AND "EndsAtUtc" > $3`,
  [businessId, membershipIds, startUtc, endUtc]) : { rows: [] };

  let plan;
  try {
    plan = planProductionSchedule({
      candidates: candidates.map((task) => ({
        id: task.Id,
        assignedMembershipId: task.AssignedMembershipId,
        estimatedMinutes: task.EstimatedMinutes,
        priorityRank: 3 - ({ Low: 0, Normal: 1, High: 2, Urgent: 3 }[task.Priority] ?? 1),
        deadlineUtc: task.DeadlineUtc ? parseInstant(task.DeadlineUtc) : null,
        stageOrder: task.StageOrder,
        dependsOnTaskIds: depsByTask.get(task.Id) ?? [],
      })),
      reservations: reservations.map((row) => ({
        membershipId: row.MembershipId, startUtc: row.StartUtc, endUtc: row.EndUtc,
      })),
      weeklyHours: weeklyHours.map((row) => ({
        dayOfWeek: row.DayOfWeek, isOpen: row.IsOpen,
        opensAt: row.OpensAt, closesAt: row.ClosesAt,
      })),
      holidays: holidays.map((row) => String(row.Date).slice(0, 10)),
      timeZone,
      startUtc,
      horizonDays: request.horizonDays,
      workerAvailability: availability.map((row) => ({
        membershipId: row.MembershipId, dayOfWeek: row.DayOfWeek,
        opensAt: row.OpensAt, closesAt: row.ClosesAt,
        capacityMinutes: row.CapacityMinutes, isAvailable: row.IsAvailable,
      })),
      workerLeave: leaves.map((row) => ({
        membershipId: row.MembershipId, startUtc: row.StartUtc, endUtc: row.EndUtc, isLeave: true,
      })),
    });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw AppError.conflict('schedule_cannot_be_planned', error.message);
  }

  const versions = Object.fromEntries(candidates.map((task) => [task.Id, Number(task.Version)]));
  return {
    startUtc: startUtc.toISOString(),
    horizonDays: request.horizonDays,
    timeZoneId: timeZone,
    scheduled: plan.scheduled.map((slot) => ({
      ...slot,
      startUtc: slot.startUtc.toISOString(),
      endUtc: slot.endUtc.toISOString(),
      version: versions[slot.taskId],
    })),
    unscheduled: plan.unscheduled,
    taskVersions: versions,
    isPreviewOnly: true,
  };
}

export async function listShopScheduleVersions(db, user, allowedLocations) {
  const { rows } = await db.query(`
    SELECT v."Id", v."VersionNumber", v."StartUtc", v."HorizonDays", v."TimeZoneId",
      v."PublishedAtUtc", v."PublishedByUserId", slot_data."TaskCount", slot_data."SlotsJson"
    FROM "ShopScheduleVersions" v
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS "TaskCount",
        COALESCE(jsonb_agg(slot ORDER BY (slot->>'startUtc')::timestamptz), '[]'::jsonb) AS "SlotsJson"
      FROM jsonb_array_elements(v."SlotsJson") slot
      WHERE $2::uuid[] IS NULL OR (slot->>'locationId')::uuid = ANY($2::uuid[])
    ) slot_data
    WHERE v."BusinessId" = $1 AND ($2::uuid[] IS NULL OR slot_data."TaskCount" > 0)
    ORDER BY v."VersionNumber" DESC
    LIMIT 25`, [user.businessId, allowedLocations]);
  return rows.map((row) => ({
    id: row.Id,
    versionNumber: Number(row.VersionNumber),
    startUtc: new Date(row.StartUtc).toISOString(),
    horizonDays: row.HorizonDays,
    timeZoneId: row.TimeZoneId,
    publishedAtUtc: new Date(row.PublishedAtUtc).toISOString(),
    publishedByUserId: row.PublishedByUserId,
    taskCount: Number(row.TaskCount),
    slots: row.SlotsJson,
  }));
}

export async function applyShopSchedule(pool, user, request, allowedLocations, transaction) {
  assertUtc(request.startUtc);
  validateHorizon(request.horizonDays);
  if (typeof request.reason !== 'string' || request.reason.trim().length < 3 || request.reason.trim().length > 500) {
    throw AppError.badRequest('schedule_reason_required', 'Provide a reason for publishing or overriding the shop schedule (3–500 characters).');
  }
  if (!Object.keys(request.expectedTaskVersions ?? {}).length || !request.expectedSlots?.length) {
    throw AppError.badRequest('schedule_preview_required', 'Submit the task versions and proposed slots returned by the schedule preview.');
  }
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`shop-schedule:${user.businessId}`]);
    const preview = await previewShopSchedule(db, user, request, allowedLocations);
    const expectedVersions = request.expectedTaskVersions;
    const versionEntries = Object.entries(expectedVersions);
    if (versionEntries.length !== Object.keys(preview.taskVersions).length
        || versionEntries.some(([id, version]) => preview.taskVersions[id] !== version)) {
      throw AppError.conflict('schedule_preview_stale', 'Tasks changed after this preview. Generate a new preview before applying it.');
    }
    if (preview.unscheduled.length || preview.scheduled.length !== versionEntries.length) {
      throw AppError.conflict('schedule_has_unscheduled_tasks', 'The plan contains tasks that cannot be scheduled. Resolve them and generate a new preview before applying the schedule.');
    }
    const sortSlots = (slots) => [...slots].sort((a, b) => a.taskId.localeCompare(b.taskId));
    const expectedSlots = sortSlots(request.expectedSlots);
    const currentSlots = sortSlots(preview.scheduled);
    if (expectedSlots.length !== currentSlots.length || expectedSlots.some((slot, index) =>
      slot.taskId !== currentSlots[index].taskId
      || new Date(slot.startUtc).getTime() !== new Date(currentSlots[index].startUtc).getTime()
      || new Date(slot.endUtc).getTime() !== new Date(currentSlots[index].endUtc).getTime()
      || slot.version !== currentSlots[index].version)) {
      throw AppError.conflict('schedule_preview_stale', 'The proposed times or scheduling inputs changed after preview. Generate a new preview before applying the schedule.');
    }

    const taskIds = currentSlots.map((slot) => slot.taskId);
    const { rows: tasks } = await db.query(`
      SELECT t."Id", t."Status", t."AssignedMembershipId", t."PlannedStartUtc", t."PlannedEndUtc",
        t."Title", o."OrderNumber", o."LocationId", t.xmin::text::bigint AS "Version"
      FROM "ProductionTasks" t
      JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
      WHERE t."BusinessId" = $1 AND t."Id" = ANY($2::uuid[])
      FOR UPDATE OF t`,
    [user.businessId, taskIds]);
    if (tasks.length !== taskIds.length) {
      throw AppError.conflict('schedule_preview_stale', 'The task set changed after preview. Generate a new preview.');
    }
    const byId = new Map(tasks.map((task) => [task.Id, task]));
    const appliedAt = new Date().toISOString();
    for (const slot of currentSlots) {
      const task = byId.get(slot.taskId);
      if (!task || Number(task.Version) !== expectedVersions[slot.taskId]) {
        throw AppError.conflict('schedule_preview_stale', 'A task changed after preview. Generate a new preview before applying the schedule.');
      }
      if (!['Pending', 'Scheduled'].includes(task.Status)) {
        throw AppError.conflict('schedule_task_state_changed', 'A task is no longer eligible for scheduling. Generate a new preview.');
      }
      const { rows: updated } = await db.query(`
        UPDATE "ProductionTasks" SET "PlannedStartUtc" = $1, "PlannedEndUtc" = $2, "Status" = 'Scheduled',
          "UpdatedByUserId" = $3, "UpdatedAtUtc" = $4
        WHERE "BusinessId" = $5 AND "Id" = $6 AND xmin::text::bigint = $7
          AND "Status" IN ('Pending', 'Scheduled')
        RETURNING "Id"`,
      [slot.startUtc, slot.endUtc, user.userId, appliedAt, user.businessId, slot.taskId, expectedVersions[slot.taskId]]);
      if (!updated.length) {
        throw AppError.conflict('schedule_preview_stale', 'A task changed while the schedule was being applied. Generate a new preview and try again.');
      }
      await db.query(`
        INSERT INTO "TaskEvents" ("Id", "ActorUserId", "BusinessId", "CreatedAtUtc", "DataJson",
          "FromStatus", "Note", "TaskId", "ToStatus", "Type")
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'Shop schedule applied.', $7, 'Scheduled', 'schedule_applied')`,
      [randomUUID(), user.userId, user.businessId, appliedAt, JSON.stringify({
        previousStartUtc: task.PlannedStartUtc,
        previousEndUtc: task.PlannedEndUtc,
        plannedStartUtc: slot.startUtc,
        plannedEndUtc: slot.endUtc,
        appliedAtUtc: appliedAt,
      }), task.Status, slot.taskId]);
    }
    const { rows: versionRows } = await db.query(`
      SELECT COALESCE(MAX("VersionNumber"), 0) + 1 AS "VersionNumber"
      FROM "ShopScheduleVersions" WHERE "BusinessId" = $1`, [user.businessId]);
    const versionNumber = Number(versionRows[0].VersionNumber);
    const versionId = randomUUID();
    const slotsSnapshot = currentSlots.map((slot) => {
      const task = byId.get(slot.taskId);
      return {
        taskId: slot.taskId,
        title: task.Title,
        orderNumber: task.OrderNumber,
        locationId: task.LocationId,
        assignedMembershipId: task.AssignedMembershipId,
        startUtc: slot.startUtc,
        endUtc: slot.endUtc,
      };
    });
    await db.query(`
      INSERT INTO "ShopScheduleVersions" ("Id", "BusinessId", "VersionNumber", "StartUtc", "HorizonDays",
        "TimeZoneId", "TaskCount", "SlotsJson", "PublishedByUserId", "PublishedAtUtc")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [versionId, user.businessId, versionNumber, preview.startUtc, preview.horizonDays, preview.timeZoneId,
      slotsSnapshot.length, JSON.stringify(slotsSnapshot), user.userId, appliedAt]);
    await db.query(`
      INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
      VALUES ($1, 'shop_schedule.published', $2, $3, $4, $5::jsonb, $6, 'ShopScheduleVersion')`,
    [randomUUID(), user.userId, user.businessId, appliedAt, JSON.stringify({
      versionNumber, taskCount: slotsSnapshot.length, reason: request.reason.trim(),
      startUtc: preview.startUtc, horizonDays: preview.horizonDays,
    }), versionId]);
    const assigned = new Map();
    for (const task of tasks) {
      if (task.AssignedMembershipId && !assigned.has(task.AssignedMembershipId)) assigned.set(task.AssignedMembershipId, task.Id);
    }
    let notificationsQueued = 0;
    for (const [membershipId, taskId] of assigned) {
      const result = await notify(db, {
        businessId: user.businessId, category: 'schedule', eventType: 'schedule.published', title: 'Schedule published',
        body: 'A new shop schedule has been published.',
        dedupeKey: `schedule.published:${user.businessId}:${appliedAt}:${membershipId}`,
        target: { kind: 'task', id: taskId }, recipients: { membershipIds: [membershipId] }, actorUserId: user.userId,
        email: {
          templateKey: 'schedule.published', subject: 'A new shop schedule was published',
          text: () => 'A new shop schedule was published. Open Avzar to review your assignments.',
        },
      });
      notificationsQueued += result.inApp + result.email;
    }
    return {
      versionId, versionNumber, updatedTasks: tasks.length, appliedAtUtc: appliedAt,
      notificationsQueued: notificationsQueued > 0,
    };
  });
}
