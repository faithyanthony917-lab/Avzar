import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyShopSchedule, listShopScheduleVersions, previewShopSchedule } from '../src/auth/productionScheduleService.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const workerId = '00000000-0000-4000-8000-000000000040';
const taskId = '00000000-0000-4000-8000-000000000050';

describe('production schedule service', () => {
  it('builds a database-backed, location-scoped preview with current task versions', async () => {
    const calls = [];
    const db = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes('FROM "Plans" p')) return { rows: [{ PlanCode: 'professional', Value: 'true' }] };
        if (sql.includes('FROM "Businesses"')) return { rows: [{ TimeZoneId: 'UTC' }] };
        if (sql.includes('FROM "BusinessHours"')) return { rows: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          DayOfWeek: dayOfWeek,
          IsOpen: dayOfWeek === 1,
          OpensAt: dayOfWeek === 1 ? '09:00:00' : null,
          ClosesAt: dayOfWeek === 1 ? '17:00:00' : null,
        })) };
        if (sql.includes('FROM "ProductionTasks" t') && sql.includes('JOIN "Orders"') && !sql.includes('FOR UPDATE OF t')) return { rows: [{
          Id: taskId, AssignedMembershipId: workerId, EstimatedMinutes: 45, Priority: 'Urgent',
          DeadlineUtc: null, StageOrder: 1, Version: '7',
        }] };
        if (sql.includes('FROM "TaskDependencies"')) return { rows: [] };
        if (sql.includes('FROM "ProductionTasks"') && sql.includes('NOT (t."Id"')) return { rows: [] };
        if (sql.includes('FROM "BusinessHolidays"')) return { rows: [] };
        if (sql.includes('FROM "WorkerAvailability"')) return { rows: [] };
        if (sql.includes('FROM "WorkerLeaves"')) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await previewShopSchedule(db, { businessId }, {
      startUtc: '2026-06-08T09:00:00Z',
      horizonDays: 5,
    }, ['00000000-0000-4000-8000-000000000060']);

    assert.equal(result.timeZoneId, 'UTC');
    assert.equal(result.isPreviewOnly, true);
    assert.deepEqual(result.taskVersions, { [taskId]: 7 });
    assert.deepEqual(result.scheduled, [{
      taskId,
      startUtc: '2026-06-08T09:00:00.000Z',
      endUtc: '2026-06-08T09:45:00.000Z',
      version: 7,
    }]);
    const taskQuery = calls.find(({ sql }) => sql.includes('FROM "ProductionTasks" t') && sql.includes('JOIN "Orders"'));
    assert.match(taskQuery.sql, /o\."LocationId" = ANY\(\$2::uuid\[\]\)/);
    assert.equal(taskQuery.values[0], businessId);
    assert.deepEqual(taskQuery.values[1], ['00000000-0000-4000-8000-000000000060']);
  });

  it('rejects a non-UTC schedule start before querying the database', async () => {
    let called = false;
    await assert.rejects(
      previewShopSchedule({ query: async () => { called = true; return { rows: [] }; } }, { businessId }, {
        startUtc: '2026-06-08T10:00:00+01:00',
        horizonDays: 1,
      }, null),
      (error) => error.code === 'schedule_start_must_be_utc',
    );
    assert.equal(called, false);
  });

  it('denies scheduling when the active plan does not include it', async () => {
    const db = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ PlanCode: 'free', Value: 'false' }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    await assert.rejects(
      previewShopSchedule(db, { businessId }, {
        startUtc: '2026-06-08T09:00:00Z',
        horizonDays: 1,
      }, null),
      (error) => error.code === 'feature_not_in_plan',
    );
  });

  it('lists immutable schedule versions with only slots in the caller location scope', async () => {
    let query;
    const result = await listShopScheduleVersions({
      query: async (sql, values) => {
        query = { sql, values };
        return { rows: [{
          Id: '00000000-0000-4000-8000-000000000070', VersionNumber: 3,
          StartUtc: '2026-06-08T00:00:00.000Z', HorizonDays: 5, TimeZoneId: 'UTC',
          PublishedAtUtc: '2026-06-07T12:00:00.000Z', PublishedByUserId: '00000000-0000-4000-8000-000000000099',
          TaskCount: 1, SlotsJson: [{ taskId, title: 'Finish jacket', locationId: '00000000-0000-4000-8000-000000000060' }],
        }] };
      },
    }, { businessId }, ['00000000-0000-4000-8000-000000000060']);

    assert.equal(query.values[0], businessId);
    assert.deepEqual(query.values[1], ['00000000-0000-4000-8000-000000000060']);
    assert.match(query.sql, /jsonb_array_elements\(v\."SlotsJson"\)/);
    assert.equal(result[0].versionNumber, 3);
    assert.equal(result[0].taskCount, 1);
    assert.equal(result[0].slots[0].title, 'Finish jacket');
  });

  it('notifies each assigned worker once when a validated schedule is published', async () => {
    const calls = [];
    const db = {
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('FROM "Plans" p')) return { rows: [{ PlanCode: 'professional', Value: 'true' }] };
        if (sql.includes('FROM "Businesses"')) return { rows: [{ TimeZoneId: 'UTC' }] };
        if (sql.includes('FROM "BusinessHours"')) return { rows: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          DayOfWeek: dayOfWeek, IsOpen: dayOfWeek === 1, OpensAt: dayOfWeek === 1 ? '09:00:00' : null,
          ClosesAt: dayOfWeek === 1 ? '17:00:00' : null,
        })) };
        if (sql.includes('FROM "ProductionTasks" t') && sql.includes('JOIN "Orders"') && !sql.includes('FOR UPDATE OF t')) return { rows: [{
          Id: taskId, AssignedMembershipId: workerId, EstimatedMinutes: 45, Priority: 'Urgent', DeadlineUtc: null,
          StageOrder: 1, Version: '7',
        }] };
        if (sql.includes('FROM "TaskDependencies"')) return { rows: [] };
        if (sql.includes('FROM "ProductionTasks"') && sql.includes('NOT (t."Id"')) return { rows: [] };
        if (sql.includes('FROM "BusinessHolidays"')) return { rows: [] };
        if (sql.includes('FROM "WorkerAvailability"')) return { rows: [] };
        if (sql.includes('FROM "WorkerLeaves"')) return { rows: [] };
        if (sql.includes('FOR UPDATE OF t')) return { rows: [{
          Id: taskId, Status: 'Pending', AssignedMembershipId: workerId, PlannedStartUtc: null, PlannedEndUtc: null,
          Title: 'Finish jacket', OrderNumber: 'AVZ-1001', LocationId: '00000000-0000-4000-8000-000000000060', Version: '7',
        }] };
        if (sql.includes('UPDATE "ProductionTasks" SET "PlannedStartUtc"')) return { rows: [{ Id: taskId }], rowCount: 1 };
        if (sql.includes('INSERT INTO "TaskEvents"')) return { rows: [] };
        if (sql.includes('SELECT COALESCE(MAX("VersionNumber")')) return { rows: [{ VersionNumber: 1 }] };
        if (sql.includes('INSERT INTO "ShopScheduleVersions"')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO "AuditLogs"')) return { rows: [], rowCount: 1 };
        if (sql.includes('FROM "Memberships" m') && sql.includes('NotificationPreferences')) return { rows: [{
          Id: workerId, DisplayName: 'Worker', Email: null, TimeZoneId: 'UTC', QuietHoursEnabled: false,
          InAppEnabled: true, EmailEnabled: false, PushEnabled: false,
        }] };
        if (sql.includes('INSERT INTO "NotificationOutbox"')) return { rows: [{
          Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4],
          Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
          InAppEnabled: values[10], EmailToAddress: values[11], EmailSubject: values[12], EmailTemplateKey: values[13],
          EmailTextBody: values[14], EmailDeduplicationKey: values[15], EmailNextAttemptUtc: values[16],
          Status: 'Pending', CreatedAtUtc: values[17],
        }], rowCount: 1 };
        if (sql.includes('INSERT INTO "Notifications"')) return { rows: [], rowCount: 1 };
        if (sql.includes('UPDATE "NotificationOutbox"')) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const user = { businessId, userId: '00000000-0000-4000-8000-000000000099' };
    const request = { startUtc: '2026-06-08T09:00:00Z', horizonDays: 5 };
    const preview = await previewShopSchedule(db, user, request, null);
    const result = await applyShopSchedule(db, user, {
      ...request, reason: 'Published after manager review', expectedTaskVersions: preview.taskVersions, expectedSlots: preview.scheduled,
    }, null, async (_pool, work) => work(db));

    assert.equal(result.updatedTasks, 1);
    assert.equal(result.versionNumber, 1);
    assert.equal(result.notificationsQueued, true);
    const versionInsert = calls.find((call) => call.sql.includes('INSERT INTO "ShopScheduleVersions"'));
    assert.ok(versionInsert);
    assert.deepEqual(JSON.parse(versionInsert.values[7]), [{
      taskId, title: 'Finish jacket', orderNumber: 'AVZ-1001',
      locationId: '00000000-0000-4000-8000-000000000060', assignedMembershipId: workerId,
      startUtc: '2026-06-08T09:00:00.000Z', endUtc: '2026-06-08T09:45:00.000Z',
    }]);
    const audit = calls.find((call) => call.sql.includes('INSERT INTO "AuditLogs"'));
    assert.ok(audit);
    assert.equal(JSON.parse(audit.values[4]).reason, 'Published after manager review');
    const notices = calls.filter((call) => call.sql.includes('INSERT INTO "NotificationOutbox"'));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].values[3], 'schedule');
    assert.equal(notices[0].values[4], 'schedule.published');
    assert.equal(notices[0].values[8], taskId);
  });
});
