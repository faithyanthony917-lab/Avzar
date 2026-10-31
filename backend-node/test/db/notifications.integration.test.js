import { installTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import {
  after as nodeAfter,
  before as nodeBefore,
  beforeEach as nodeBeforeEach,
  describe,
  it as nodeIt,
} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import {
  listNotifications,
  markRead,
  notify,
  purgeOldNotifications,
  savePreferences,
  unreadCount,
  registerPushToken,
} from '../../src/notifications/notificationService.js';
import { configurePushSender } from '../../src/notifications/pushService.js';
import { dispatchNotificationOutboxOnce } from '../../src/notifications/notificationOutboxWorker.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';

const url = process.env.DATABASE_URL;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const silent = { error() {}, info() {} };

let sqlTraceId = 0;
let testTraceId = 0;

function traceError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    detail: error?.detail ?? null,
    constraint: error?.constraint ?? null,
    stack: error?.stack ?? null,
  };
}

function instrumentSqlQueries(target, label) {
  if (target.__notificationsSqlTracing) return target;

  Object.defineProperty(target, '__notificationsSqlTracing', { value: true });

  const originalQuery = target.query.bind(target);

  target.query = (...args) => {
    const id = ++sqlTraceId;
    const sql =
      typeof args[0] === 'string'
        ? args[0]
        : args[0]?.text ?? '[query text unavailable]';
    const params =
      typeof args[0] === 'object' && args[0] !== null
        ? args[0].values ?? args[1] ?? []
        : args[1] ?? [];
    const started = Date.now();

    console.error(`[notifications.integration] SQL #${id} ${label}: START`, {
      sql: String(sql).replace(/\s+/g, ' ').trim(),
      params,
    });

    let pending;
    try {
      pending = originalQuery(...args);
    } catch (error) {
      console.error(
        `[notifications.integration] SQL #${id} ${label}: SYNC ERROR`,
        traceError(error),
      );
      throw error;
    }

    return Promise.resolve(pending).then(
      (result) => {
        console.error(
          `[notifications.integration] SQL #${id} ${label}: COMPLETE`,
          {
            durationMs: Date.now() - started,
            rowCount: result?.rowCount ?? null,
          },
        );
        return result;
      },
      (error) => {
        console.error(
          `[notifications.integration] SQL #${id} ${label}: FAILED`,
          { durationMs: Date.now() - started, ...traceError(error) },
        );
        throw error;
      },
    );
  };

  return target;
}

// Instrument checked-out clients only. Do not wrap pool.query here:
// installTenantRlsContext already decorates both pool.query and pool.connect.
// pool.query is traced separately (see instrumentPoolQuery) so a call that
// never obtains a connection is still visible in the log.
function instrumentSqlPool(target) {
  const originalConnect = target.connect.bind(target);

  target.connect = function instrumentedConnect(...args) {
    const result = originalConnect(...args);

    if (typeof args[0] === 'function') {
      return result;
    }

    return Promise.resolve(result).then((client) => {
      instrumentSqlQueries(client, `client-${++sqlTraceId}`);
      return client;
    });
  };

  return target;
}

// Traces every pool.query call at the moment it is CALLED (before a
// connection is acquired), reports pool stats, and warns if it is still
// pending after 3 seconds. Apply this outermost.
function instrumentPoolQuery(target) {
  const original = target.query.bind(target);

  target.query = (...args) => {
    // Callback-style calls are passed through untouched.
    if (typeof args[args.length - 1] === 'function') return original(...args);

    const id = ++sqlTraceId;
    const sql =
      typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '[unavailable]';
    const stats = () => ({
      totalConnections: target.totalCount,
      idleConnections: target.idleCount,
      waitingRequests: target.waitingCount,
    });
    const started = Date.now();

    console.error(`[notifications.integration] POOL.QUERY #${id}: CALLED`, {
      sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 200),
      ...stats(),
    });

    const watchdog = setTimeout(() => {
      console.error(
        `[notifications.integration] POOL.QUERY #${id}: STILL PENDING after 3s`,
        stats(),
      );
    }, 3000);
    watchdog.unref?.();

    let pending;
    try {
      pending = original(...args);
    } catch (error) {
      clearTimeout(watchdog);
      console.error(
        `[notifications.integration] POOL.QUERY #${id}: SYNC ERROR`,
        traceError(error),
      );
      throw error;
    }

    return Promise.resolve(pending).then(
      (result) => {
        clearTimeout(watchdog);
        console.error(`[notifications.integration] POOL.QUERY #${id}: DONE`, {
          durationMs: Date.now() - started,
          rowCount: result?.rowCount ?? null,
          ...stats(),
        });
        return result;
      },
      (error) => {
        clearTimeout(watchdog);
        console.error(`[notifications.integration] POOL.QUERY #${id}: FAILED`, {
          durationMs: Date.now() - started,
          ...stats(),
          ...traceError(error),
        });
        throw error;
      },
    );
  };

  return target;
}

function it(name, options, testFn) {
  if (typeof options === 'function') {
    testFn = options;
    options = undefined;
  }

  const wrapped = async (t) => {
    const id = ++testTraceId;
    const started = Date.now();

    console.error(`[notifications.integration] TEST #${id} START: ${name}`);

    try {
      const result = await testFn(t);
      console.error(`[notifications.integration] TEST #${id} PASS: ${name}`, {
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      console.error(`[notifications.integration] TEST #${id} FAIL: ${name}`, {
        durationMs: Date.now() - started,
        ...traceError(error),
      });
      throw error;
    }
  };

  return options === undefined
    ? nodeIt(name, wrapped)
    : nodeIt(name, options, wrapped);
}

function tracedHook(name, registerHook, callback) {
  registerHook(async (t) => {
    const started = Date.now();
    console.error(`[notifications.integration] HOOK START: ${name}`);

    try {
      const result = await callback(t);
      console.error(`[notifications.integration] HOOK COMPLETE: ${name}`, {
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      console.error(`[notifications.integration] HOOK FAILED: ${name}`, {
        durationMs: Date.now() - started,
        ...traceError(error),
      });
      throw error;
    }
  });
}

describe(
  'notifications on PostgreSQL',
  { skip: !url, timeout: 120_000 },
  () => {
    let db;
    let pool;
    const world = {};

    async function seedBusiness(label, timeZone = 'UTC') {
      const businessId = randomUUID();

      console.error(`[notifications.integration] seedBusiness ${label}: START`, {
        totalConnections: pool.totalCount,
        idleConnections: pool.idleCount,
        waitingRequests: pool.waitingCount,
      });

      const diagnostic = setTimeout(async () => {
        console.error(
          `[notifications.integration] seedBusiness ${label}: taking over 3 seconds`,
        );

        const { default: Client } = await import('pg');
        const admin = new Client({ connectionString: db.url });

        try {
          await admin.connect();
          const { rows } = await admin.query(`
          SELECT pid, state, wait_event_type, wait_event, query_start,
                 pg_blocking_pids(pid) AS blocking_pids,
                 left(query, 240) AS query
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state <> 'idle'
          ORDER BY query_start
        `);
          console.error(
            `[notifications.integration] seedBusiness ${label}: PostgreSQL activity`,
            rows,
          );
        } catch (error) {
          console.error(
            `[notifications.integration] seedBusiness ${label}: diagnostic failed`,
            traceError(error),
          );
        } finally {
          await admin.end().catch(() => {});
        }
      }, 3000);

      diagnostic.unref?.();

      try {
        const client = await pool.connect();
        try {
          await client.query(`SET statement_timeout = '10000ms'`);
          await client.query(
            `INSERT INTO "Businesses"
            ("Id","Name","IsActive","TimeZoneId","CurrencyCode","CreatedAtUtc")
           VALUES ($1,$2,TRUE,$3,'NGN',now())`,
            [businessId, `Shop ${label}`, timeZone],
          );
        } finally {
          await client.query('RESET statement_timeout').catch(() => {});
          client.release();
        }
      } finally {
        clearTimeout(diagnostic);
      }

      console.error(`[notifications.integration] seedBusiness ${label}: COMPLETE`);
      return businessId;
    }

    async function seedMember(
      businessId,
      label,
      {
        owner = false,
        permissions = [],
        email = `${label}@example.test`,
      } = {},
    ) {
      const userId = randomUUID();
      const membershipId = randomUUID();

      async function seedQuery(step, sql, values) {
        console.error(`[notifications.integration] seedMember ${label}: ${step} START`, {
          totalConnections: pool.totalCount,
          idleConnections: pool.idleCount,
          waitingRequests: pool.waitingCount,
        });

        const client = await pool.connect();
        try {
          await client.query(`SET statement_timeout = '10000ms'`);
          const result = await client.query(sql, values);
          console.error(`[notifications.integration] seedMember ${label}: ${step} COMPLETE`);
          return result;
        } catch (error) {
          console.error(`[notifications.integration] seedMember ${label}: ${step} FAILED`, traceError(error));
          throw error;
        } finally {
          await client.query('RESET statement_timeout').catch(() => {});
          client.release();
        }
      }

      await seedQuery(
        'AspNetUsers INSERT',
        `INSERT INTO "AspNetUsers"
        ("Id","Email","NormalizedEmail","UserName","NormalizedUserName",
         "FullName","EmailConfirmed","PhoneNumberConfirmed","TwoFactorEnabled",
         "LockoutEnabled","AccessFailedCount","SecurityStamp","ConcurrencyStamp",
         "CreatedAtUtc")
       VALUES ($1,$2,$3,$2,$3,$4,TRUE,FALSE,FALSE,FALSE,0,'s','c',now())`,
        [userId, email, email.toUpperCase(), label],
      );

      await seedQuery(
        'Memberships INSERT',
        `INSERT INTO "Memberships"
        ("Id","BusinessId","CreatedAtUtc","DisplayName","IsOwner","Status","UserId")
       VALUES ($1,$2,now(),$3,$4,0,$5)`,
        [membershipId, businessId, label, owner, userId],
      );

      if (permissions.length) {
        const roleId = randomUUID();

        await seedQuery(
          'BusinessRoles INSERT',
          `INSERT INTO "BusinessRoles"
          ("Id","BusinessId","Name","IsSystem","CreatedAtUtc")
         VALUES ($1,$2,$3,FALSE,now())`,
          [roleId, businessId, `role-${label}`],
        );

        await seedQuery(
          'MembershipRoles INSERT',
          `INSERT INTO "MembershipRoles" ("MembershipId","RoleId","BusinessId")
         VALUES ($1,$2,$3)`,
          [membershipId, roleId, businessId],
        );

        for (const permission of permissions) {
          await seedQuery(
            `RolePermissions INSERT (${permission})`,
            `INSERT INTO "RolePermissions" ("RoleId","BusinessId","Permission")
           VALUES ($1,$2,$3)`,
            [roleId, businessId, permission],
          );
        }
      }

      return { userId, membershipId };
    }

    const event = (businessId, recipients, extra = {}) => ({
      businessId,
      category: 'orders',
      eventType: 'order.confirmed',
      title: 'Order confirmed',
      body: 'An order was confirmed.',
      dedupeKey: `order.confirmed:${randomUUID()}`,
      recipients,
      ...extra,
    });

    tracedHook('setup', nodeBefore, async () => {
      console.error('[notifications.integration] setup: creating temporary database');
      db = await createTempDatabase(url, 'avzar_notif');

      console.error('[notifications.integration] setup: installing tenant context');
      // Order matters: pool.query tracing is outermost so it sees every call,
      // including ones that never get a connection.
      pool = instrumentPoolQuery(
        instrumentSqlPool(installTenantRlsContext(db.pool)),
      );

      console.error('[notifications.integration] setup: applying migrations');
      await migrate(pool, MIGRATIONS_DIR, quiet);
      console.error('[notifications.integration] setup: migrations complete');

      world.a = await seedBusiness('A');
      world.b = await seedBusiness('B');

      world.alice = await seedMember(world.a, 'alice', {
        permissions: ['orders.manage'],
      });
      world.bob = await seedMember(world.a, 'bob', {
        permissions: ['orders.manage'],
      });
      world.carol = await seedMember(world.a, 'carol', {
        permissions: ['invoices.manage'],
      });
      world.owner = await seedMember(world.a, 'owner', { owner: true });
      world.dave = await seedMember(world.b, 'dave', {
        permissions: ['orders.manage'],
      });

      console.error('[notifications.integration] setup: complete');
    });

    tracedHook('teardown', nodeAfter, async () => {
      console.error('[notifications.integration] teardown: dropping temporary database');
      await db?.drop();
      console.error('[notifications.integration] teardown: complete');
    });

    async function clearNotificationTable(table) {
      const tag = `[notifications.integration] beforeEach: DELETE ${table}`;

      console.error(`${tag}: acquiring connection`, {
        totalConnections: pool.totalCount,
        idleConnections: pool.idleCount,
        waitingRequests: pool.waitingCount,
      });

      let client;

      const diagnostic = setTimeout(async () => {
        console.error(`${tag}: still waiting after 3 seconds`, {
          totalConnections: pool.totalCount,
          idleConnections: pool.idleCount,
          waitingRequests: pool.waitingCount,
        });

        const { default: Client } = await import('pg');
        const admin = new Client({ connectionString: db.url });

        try {
          await admin.connect();
          const { rows } = await admin.query(`
          SELECT pid, state, wait_event_type, wait_event, query_start,
                 pg_blocking_pids(pid) AS blocking_pids,
                 left(query, 240) AS query
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state <> 'idle'
          ORDER BY query_start
        `);
          console.error(`${tag}: PostgreSQL activity`, rows);
        } catch (error) {
          console.error(`${tag}: diagnostic failed`, traceError(error));
        } finally {
          await admin.end().catch(() => {});
        }
      }, 3000);

      diagnostic.unref?.();

      try {
        client = await pool.connect();
        console.error(`${tag}: connection acquired`);
        await client.query(`SET statement_timeout = '10000ms'`);
        console.error(`${tag}: query started`);
        await client.query(`DELETE FROM "${table}"`);
        console.error(`${tag}: query complete`);
      } catch (error) {
        console.error(`${tag}: FAILED`, traceError(error));
        throw error;
      } finally {
        clearTimeout(diagnostic);
        if (client) {
          await client.query('RESET statement_timeout').catch(() => {});
          client.release();
        }
      }
    }

    tracedHook('beforeEach cleanup', nodeBeforeEach, async () => {
      console.error('[notifications.integration] beforeEach: clearing notification tables');

      for (const table of [
        'NotificationOutbox',
        'Notifications',
        'NotificationPreferences',
        'NotificationSettings',
        'EmailOutbox',
      ]) {
        await clearNotificationTable(table);
      }

      console.error('[notifications.integration] beforeEach: notification tables cleared');
    });

    it('migrates cleanly and creates the notification tables with their keys and indexes', async () => {
      const { rows } = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'NotificationOutbox','Notifications','NotificationPreferences',
          'NotificationSettings','PushTokens','PushDeliveries'
        )
      ORDER BY 1
    `);

      assert.deepEqual(rows.map((r) => r.table_name), [
        'NotificationOutbox',
        'NotificationPreferences',
        'NotificationSettings',
        'Notifications',
        'PushDeliveries',
        'PushTokens',
      ]);

      const idx = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'Notifications'`,
      );
      assert.ok(idx.rows.some((r) => r.indexname === 'IX_Notifications_Recipient_DeduplicationKey'));
      assert.ok(idx.rows.some((r) => r.indexname === 'IX_Notifications_Recipient_Unread'));

      const outboxIndexes = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'NotificationOutbox'`,
      );
      assert.ok(outboxIndexes.rows.some((r) => r.indexname === 'IX_NotificationOutbox_Recipient_DeduplicationKey'));
      assert.ok(outboxIndexes.rows.some((r) => r.indexname === 'IX_NotificationOutbox_Claim'));
    });

    it('refuses a notification whose recipient belongs to a different business (composite foreign key)', async () => {
      await assert.rejects(
        pool.query(
          `INSERT INTO "Notifications"
          ("Id","BusinessId","RecipientMembershipId","Category","EventType",
           "Title","Body","DeduplicationKey","CreatedAtUtc")
         VALUES ($1,$2,$3,'orders','x','t','b','k',now())`,
          [randomUUID(), world.b, world.alice.membershipId],
        ),
        /FK_Notifications_Memberships/,
      );

      await assert.rejects(
        pool.query(
          `INSERT INTO "NotificationPreferences"
          ("MembershipId","BusinessId","Category","InAppEnabled","EmailEnabled","UpdatedAtUtc")
         VALUES ($1,$2,'orders',TRUE,FALSE,now())`,
          [world.alice.membershipId, world.b],
        ),
        /FK_NotificationPreferences_Memberships/,
      );

      await assert.rejects(
        pool.query(
          `INSERT INTO "NotificationOutbox"
          ("Id","BusinessId","RecipientMembershipId","Category","EventType",
           "Title","Body","DeduplicationKey","InAppEnabled","NextAttemptUtc","CreatedAtUtc")
         VALUES ($1,$2,$3,'orders','x','t','b','k',TRUE,now(),now())`,
          [randomUUID(), world.b, world.alice.membershipId],
        ),
        /FK_NotificationOutbox_Memberships/,
      );

      await assert.rejects(
        pool.query(
          `INSERT INTO "Notifications"
          ("Id","BusinessId","RecipientMembershipId","Category","EventType",
           "Title","Body","DeduplicationKey","CreatedAtUtc")
         VALUES ($1,$2,$3,'weather','x','t','b','k',now())`,
          [randomUUID(), world.a, world.alice.membershipId],
        ),
        /CK_Notifications_Category/,
      );
    });

    it('is idempotent: the same event twice, and the same event raced from several connections, creates one row per recipient', async () => {
      const ev = event(world.a, {
        membershipIds: [world.alice.membershipId, world.bob.membershipId],
      });

      const first = await notify(pool, ev, { now: NOW, log: silent });
      const second = await notify(pool, ev, { now: NOW, log: silent });
      assert.deepEqual([first.inApp, second.inApp], [2, 0]);

      const racing = event(world.a, { membershipIds: [world.alice.membershipId] });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => notify(pool, racing, { now: NOW, log: silent })),
      );

      assert.equal(results.reduce((sum, result) => sum + result.inApp, 0), 1);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM "Notifications"')).rows[0].n,
        3,
      );
    });

    it('finds recipients by permission, includes owners, excludes the actor and never leaks into another business', async () => {
      const result = await notify(
        pool,
        event(
          world.a,
          { permission: 'orders.manage' },
          { actorMembershipId: world.alice.membershipId },
        ),
        { now: NOW, log: silent },
      );

      assert.equal(result.recipients, 2);

      const { rows } = await pool.query(
        'SELECT "RecipientMembershipId" AS id, "BusinessId" AS biz FROM "Notifications" ORDER BY 1',
      );

      assert.deepEqual(
        rows.map((r) => r.id).sort(),
        [world.bob.membershipId, world.owner.membershipId].sort(),
      );
      assert.ok(rows.every((r) => r.biz === world.a));
    });

    it('limits recipients to people with access to the location (owners and locations.all always have it)', async () => {
      const locationId = randomUUID();
      const otherLocation = randomUUID();

      for (const id of [locationId, otherLocation]) {
        await pool.query(
          `INSERT INTO "Locations"
          ("Id","BusinessId","Name","IsActive","CreatedAtUtc")
         VALUES ($1,$2,$3,TRUE,now())`,
          [id, world.a, `Loc ${id.slice(0, 4)}`],
        );
      }

      await pool.query(
        `INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId")
       VALUES ($1,$2,$3)`,
        [world.alice.membershipId, locationId, world.a],
      );
      await pool.query(
        `INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId")
       VALUES ($1,$2,$3)`,
        [world.bob.membershipId, otherLocation, world.a],
      );

      await notify(
        pool,
        event(world.a, { permission: 'orders.manage', locationId }),
        { now: NOW, log: silent },
      );

      const { rows } = await pool.query(
        'SELECT "RecipientMembershipId" AS id FROM "Notifications"',
      );

      assert.deepEqual(
        rows.map((r) => r.id).sort(),
        [world.alice.membershipId, world.owner.membershipId].sort(),
      );

      await pool.query('DELETE FROM "MembershipLocations"');
      await pool.query('DELETE FROM "Locations"');
    });

    it('writes the in-app row and the email row together, honouring preferences and quiet hours', async () => {
      await savePreferences(pool, {
        businessId: world.a,
        membershipId: world.alice.membershipId,
        now: NOW,
        body: {
          categories: [{ category: 'orders', inApp: true, email: true }],
          quietHours: { enabled: true, startMinute: 11 * 60, endMinute: 13 * 60 },
        },
      });

      const mail = {
        templateKey: 'order.confirmed',
        subject: 'An order was confirmed',
        text: () => 'Open Avzar to view it.',
      };

      const result = await notify(
        pool,
        event(
          world.a,
          { membershipIds: [world.alice.membershipId, world.bob.membershipId] },
          { email: mail },
        ),
        { now: NOW, log: silent },
      );

      assert.deepEqual([result.inApp, result.email], [2, 1]);

      const { rows } = await pool.query(
        'SELECT "ToAddress","NextAttemptUtc","Status","DeduplicationKey" FROM "EmailOutbox"',
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].ToAddress, 'alice@example.test');
      assert.equal(new Date(rows[0].NextAttemptUtc).toISOString(), '2026-10-20T13:00:00.000Z');
      assert.equal(rows[0].Status, 'Pending');
    });

    it('commits with the surrounding transaction and rolls back with it', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await notify(
          client,
          event(world.a, { membershipIds: [world.alice.membershipId] }),
          { now: NOW, log: silent },
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM "Notifications"')).rows[0].n,
        0,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM "NotificationOutbox"')).rows[0].n,
        0,
      );
    });

    it('retains a failed in-app delivery and retries it exactly once from the outbox', async () => {
      const ev = event(world.a, { membershipIds: [world.alice.membershipId] });

      await pool.query(`
      CREATE FUNCTION avzar_test_fail_notification_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected notification insert failure';
      END;
      $$
    `);

      await pool.query(`
      CREATE TRIGGER avzar_test_fail_notification_insert
      BEFORE INSERT ON "Notifications"
      FOR EACH ROW EXECUTE FUNCTION avzar_test_fail_notification_insert()
    `);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const first = await notify(client, ev, { now: NOW, log: silent });
        assert.equal(first.ok, true);
        await client.query('COMMIT');
      } finally {
        client.release();
        await pool.query('DROP TRIGGER avzar_test_fail_notification_insert ON "Notifications"');
        await pool.query('DROP FUNCTION avzar_test_fail_notification_insert()');
      }

      const pending = await pool.query(
        `SELECT "Id","Status","LastError","NextAttemptUtc"
       FROM "NotificationOutbox"
       WHERE "DeduplicationKey" = $1`,
        [ev.dedupeKey],
      );

      assert.equal(pending.rowCount, 1);
      assert.equal(pending.rows[0].Status, 'Pending');
      assert.equal(pending.rows[0].LastError, 'DatabaseError');
      assert.equal(new Date(pending.rows[0].NextAttemptUtc).toISOString(), '2026-10-20T12:00:30.000Z');

      const retried = await dispatchNotificationOutboxOnce(pool, {
        now: new Date(NOW.getTime() + 60_000),
        log: silent,
      });
      assert.deepEqual(retried, { claimed: 1, sent: 1, retried: 0, failed: 0 });

      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM "Notifications"')).rows[0].n,
        1,
      );

      const repeated = await dispatchNotificationOutboxOnce(pool, {
        now: new Date(NOW.getTime() + 120_000),
        log: silent,
      });
      assert.deepEqual(repeated, { claimed: 0, sent: 0, retried: 0, failed: 0 });

      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM "Notifications"')).rows[0].n,
        1,
      );
    });

    it('lists, counts and marks read only for the owner of the row, across businesses and colleagues', async () => {
      await notify(pool, event(world.a, { membershipIds: [world.alice.membershipId] }), { now: NOW, log: silent });
      await notify(pool, event(world.a, { membershipIds: [world.alice.membershipId] }), { now: new Date(NOW.getTime() + 1000), log: silent });
      await notify(pool, event(world.a, { membershipIds: [world.bob.membershipId] }), { now: NOW, log: silent });

      const mine = { businessId: world.a, membershipId: world.alice.membershipId };
      const page = await listNotifications(pool, { ...mine, limit: 1 });
      assert.equal(page.items.length, 1);
      assert.ok(page.nextCursor);

      const next = await listNotifications(pool, {
        ...mine,
        limit: 1,
        cursor: page.nextCursor,
      });
      assert.equal(next.items.length, 1);
      assert.notEqual(next.items[0].id, page.items[0].id);
      assert.equal(next.nextCursor, null);

      assert.deepEqual(await unreadCount(pool, mine), { count: 2, capped: false });
      assert.deepEqual(
        await unreadCount(pool, {
          businessId: world.b,
          membershipId: world.dave.membershipId,
        }),
        { count: 0, capped: false },
      );

      await assert.rejects(
        markRead(pool, { businessId: world.a, membershipId: world.bob.membershipId, id: page.items[0].id }),
        { status: 404 },
      );
      await assert.rejects(
        markRead(pool, { businessId: world.b, membershipId: world.dave.membershipId, id: page.items[0].id }),
        { status: 404 },
      );

      assert.equal((await markRead(pool, { ...mine, id: page.items[0].id, now: NOW })).isRead, true);
      assert.equal((await unreadCount(pool, mine)).count, 1);
      assert.equal((await listNotifications(pool, { ...mine, unread: true })).items.length, 1);
    });

    it('purges read rows after 90 days and unread rows after 180, and nothing newer', async () => {
      const insert = (age, read) => {
        const id = randomUUID();
        return pool.query(
          `INSERT INTO "Notifications"
          ("Id","BusinessId","RecipientMembershipId","Category","EventType",
           "Title","Body","DeduplicationKey","CreatedAtUtc","ReadAtUtc")
         VALUES ($1,$2,$3,'orders','e','t','b',$4,$5,$6)`,
          [
            id,
            world.a,
            world.alice.membershipId,
            `retention:${id}`,
            new Date(NOW.getTime() - age * 86_400_000),
            read ? NOW : null,
          ],
        );
      };

      await insert(100, true);
      await insert(100, false);
      await insert(200, false);
      await insert(10, true);

      assert.equal(await purgeOldNotifications(pool, { now: NOW }), 2);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM "Notifications"')).rows[0].n,
        2,
      );
    });

    it('deleting a membership removes its notifications and preferences (cascade)', async () => {
      const temp = await seedMember(world.a, 'temp');

      await notify(pool, event(world.a, { membershipIds: [temp.membershipId] }), { now: NOW, log: silent });
      await savePreferences(pool, {
        businessId: world.a,
        membershipId: temp.membershipId,
        body: { categories: [{ category: 'orders', inApp: false, email: false }] },
      });

      await pool.query('DELETE FROM "Memberships" WHERE "Id" = $1', [temp.membershipId]);

      assert.equal(
        (await pool.query(
          'SELECT count(*)::int AS n FROM "Notifications" WHERE "RecipientMembershipId" = $1',
          [temp.membershipId],
        )).rows[0].n,
        0,
      );
      assert.equal(
        (await pool.query(
          'SELECT count(*)::int AS n FROM "NotificationOutbox" WHERE "RecipientMembershipId" = $1',
          [temp.membershipId],
        )).rows[0].n,
        0,
      );
      assert.equal(
        (await pool.query(
          'SELECT count(*)::int AS n FROM "NotificationPreferences" WHERE "MembershipId" = $1',
          [temp.membershipId],
        )).rows[0].n,
        0,
      );
    });

    it('stores push deliveries transactionally and never fans out across businesses', async () => {
      const sessionId = randomUUID();
      const token = `ExponentPushToken[${randomUUID()}]`;
      const expires = new Date(Date.now() + 86_400_000);

      await pool.query(
        `INSERT INTO "UserSessions"
        ("Id","AbsoluteExpiresAtUtc","BusinessId","CreatedAtUtc","CurrentTokenHash",
         "DeviceName","IdleExpiresAtUtc","LastUsedAtUtc","UserId")
       VALUES ($1,$2,$3,now(),'test-hash','integration test',$2,now(),$4)`,
        [sessionId, expires, world.a, world.alice.userId],
      );

      await registerPushToken(pool, {
        businessId: world.a,
        membershipId: world.alice.membershipId,
        sessionId,
        token,
        platform: 'android',
      });

      await savePreferences(pool, {
        businessId: world.a,
        membershipId: world.alice.membershipId,
        body: {
          categories: [{ category: 'orders', inApp: true, email: false, push: true }],
        },
      });

      configurePushSender(
        { EXPO_ACCESS_TOKEN: 'test-token' },
        async () => ({
          ok: true,
          json: async () => ({ data: [{ status: 'ok', id: 'ticket-test' }] }),
        }),
      );

      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await notify(
            client,
            event(world.a, { membershipIds: [world.alice.membershipId] }),
            { now: NOW, log: silent },
          );

          const pending = await client.query(
            'SELECT count(*)::int AS count FROM "PushDeliveries" WHERE "BusinessId"=$1',
            [world.a],
          );
          assert.equal(pending.rows[0].count, 1);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }

        const rolledBack = await pool.query(
          'SELECT count(*)::int AS count FROM "PushDeliveries" WHERE "BusinessId"=$1',
          [world.a],
        );
        assert.equal(rolledBack.rows[0].count, 0);

        await notify(pool, event(world.a, { membershipIds: [world.alice.membershipId] }), { now: NOW, log: silent });
        const ownBusiness = await pool.query(
          'SELECT count(*)::int AS count FROM "PushDeliveries" WHERE "BusinessId"=$1',
          [world.a],
        );
        assert.equal(ownBusiness.rows[0].count, 1);

        await notify(pool, event(world.b, { membershipIds: [world.dave.membershipId] }), { now: NOW, log: silent });
        const otherBusiness = await pool.query(
          'SELECT count(*)::int AS count FROM "PushDeliveries" WHERE "BusinessId"=$1',
          [world.b],
        );
        assert.equal(otherBusiness.rows[0].count, 0);

        await pool.query(
          `UPDATE "UserSessions"
         SET "RevokedAtUtc"=now(),"RevokedReason"='logout'
         WHERE "Id"=$1`,
          [sessionId],
        );

        const deactivated = await pool.query(
          'SELECT "Active","DeactivatedReason" FROM "PushTokens" WHERE "Token"=$1',
          [token],
        );
        assert.equal(deactivated.rows[0].Active, false);
        assert.equal(deactivated.rows[0].DeactivatedReason, 'logout');
      } finally {
        configurePushSender({ EXPO_ACCESS_TOKEN: '' });
        await pool.query('DELETE FROM "PushTokens" WHERE "Token"=$1', [token]);
        await pool.query('DELETE FROM "UserSessions" WHERE "Id"=$1', [sessionId]);
      }
    });
  },
);
