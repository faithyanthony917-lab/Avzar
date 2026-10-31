// Step 17b: platform administrator services with a pool that records what is asked. No database needed.
// Isolation under a restricted role is proved in test/db/platformAdmin.integration.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configurationFlags, decodeCursor, encodeCursor, getPlatformBusiness, getPlatformHealth, listPlatformAuditLogs, listPlatformBusinesses, lookupPlatformUser, reactivatePlatformBusiness, suspendPlatformBusiness } from '../src/auth/platformAdminService.js';

const admin = 'ops@example.test';
const allow = [admin];
const A = '00000000-0000-4000-8000-0000000000a1';
const U = '00000000-0000-4000-8000-0000000000c1';

function recordingPool(answer = () => ({ rows: [] })) {
  const calls = [];
  return { calls, query: async (sql, values = []) => { calls.push({ sql: String(sql), values }); return answer(String(sql), values); } };
}
const refused = (fn) => assert.rejects(fn, (error) => error.code === 'platform_admin_required' && error.status === 403);

describe('platform admin services', () => {
  it('every service refuses a person who is not on the allowlist, before touching the database', async () => {
    const pool = recordingPool();
    await refused(() => listPlatformBusinesses(pool, 'tenant@example.test', allow, {}));
    await refused(() => getPlatformBusiness(pool, 'tenant@example.test', allow, A));
    await refused(() => lookupPlatformUser(pool, 'tenant@example.test', allow, 'a@b.test'));
    await refused(() => listPlatformAuditLogs(pool, 'tenant@example.test', allow, {}));
    await refused(() => getPlatformHealth(pool, {}, 'tenant@example.test', allow));
    await refused(() => listPlatformBusinesses(pool, undefined, allow, {}));
    assert.equal(pool.calls.length, 0);
  });

  it('cursors round-trip and a malformed one is a 400', () => {
    const row = { CreatedAtUtc: '2026-10-31T10:00:00.000Z', Id: A };
    assert.deepEqual(decodeCursor(encodeCursor(row)), { t: '2026-10-31T10:00:00.000Z', id: A });
    assert.equal(decodeCursor(undefined), null);
    assert.throws(() => decodeCursor('not-a-cursor'), (e) => e.code === 'invalid_cursor' && e.status === 400);
    assert.throws(() => decodeCursor(Buffer.from(JSON.stringify({ t: 'x', id: 'y' })).toString('base64url')), (e) => e.code === 'invalid_cursor');
  });

  it('the business list reads Businesses only, escapes search wildcards, and returns a next cursor only when there is more', async () => {
    const rows = [3, 2, 1].map((n) => ({ Id: `00000000-0000-4000-8000-00000000000${n}`, Name: `Shop ${n}`, ContactEmail: null, CurrencyCode: 'NGN', TimeZoneId: 'UTC', IsActive: true, CreatedAtUtc: new Date(2026, 9, n) }));
    const pool = recordingPool(() => ({ rows }));
    const page = await listPlatformBusinesses(pool, admin, allow, { q: '50%_off', limit: 2 });
    assert.equal(page.items.length, 2);
    assert.ok(page.next);
    assert.equal(pool.calls[0].values[0], '%50\\%\\_off%');
    assert.equal(pool.calls[0].values[3], 3, 'one extra row is asked for to know whether there is a next page');
    assert.match(pool.calls[0].sql, /FROM "Businesses"/);
    assert.doesNotMatch(pool.calls[0].sql, /Customers|Orders/);
    const last = await listPlatformBusinesses(recordingPool(() => ({ rows: rows.slice(0, 1) })), admin, allow, { limit: 2 });
    assert.equal(last.next, null);
  });

  it('a business detail for an unknown or malformed ID is 404 and writes no audit entry', async () => {
    const pool = recordingPool();
    await assert.rejects(() => getPlatformBusiness(pool, admin, allow, 'nope'), (e) => e.code === 'business_not_found');
    await assert.rejects(() => getPlatformBusiness(pool, admin, allow, A), (e) => e.code === 'business_not_found');
    assert.equal(pool.calls.some((c) => c.sql.includes('PlatformAuditLogs')), false);
  });

  it('a business detail holds counts and the owner only, and leaves one audit entry', async () => {
    const pool = recordingPool((sql) => {
      if (sql.includes('FROM "Businesses"')) return { rows: [{ Id: A, Name: 'Taratara', ContactEmail: 'hi@t.test', CurrencyCode: 'NGN', TimeZoneId: 'UTC', IsActive: true, CreatedAtUtc: new Date(), UpdatedAtUtc: null }] };
      if (sql.includes('"activeStaff"')) return { rows: [{ activeStaff: 3, locations: 1, customers: 40, orders: 12, ordersLast30Days: 5, invoices: 9, storageBytes: '2048' }] };
      if (sql.includes('"IsOwner"')) return { rows: [{ Email: 'owner@t.test', FullName: 'Ada' }] };
      if (sql.includes('FROM "Subscriptions"')) return { rows: [{ Code: 'starter', Name: 'Starter', Status: 'Active', CurrentPeriodEndUtc: null }] };
      return { rows: [] };
    });
    const detail = await getPlatformBusiness(pool, admin, allow, A);
    assert.equal(detail.usage.customers, 40);
    assert.equal(detail.usage.storageBytes, 2048);
    assert.equal(detail.owner.email, 'owner@t.test');
    assert.equal(detail.plan.code, 'starter');
    const sqlAll = pool.calls.map((c) => c.sql).join('\n');
    assert.doesNotMatch(sqlAll, /"FullName" FROM "Customers"|"Customers" WHERE|Phone|PasswordHash/);
    const audits = pool.calls.filter((c) => c.sql.includes('INSERT INTO "PlatformAuditLogs"'));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].values[2], 'platform.business.viewed');
    assert.equal(audits[0].values[4], A);
  });

  it('a user lookup rejects a bad address, audits without the address, and never selects secrets', async () => {
    const pool = recordingPool((sql) => {
      if (sql.includes('FROM "AspNetUsers"')) return { rows: [{ Id: U, Email: 'ada@t.test', FullName: 'Ada', EmailConfirmed: true, TwoFactorEnabled: true, LockoutEnd: null, AccessFailedCount: 0, CreatedAtUtc: new Date() }] };
      if (sql.includes('FROM "Memberships"')) return { rows: [{ Id: 'm1', BusinessId: A, IsOwner: true, Status: 0, DisplayName: 'Ada', BusinessName: 'Taratara', BusinessActive: true }] };
      return { rows: [] };
    });
    await assert.rejects(() => lookupPlatformUser(pool, admin, allow, 'no-at-sign'), (e) => e.code === 'invalid_email');
    const found = await lookupPlatformUser(pool, admin, allow, ' ADA@t.test ');
    assert.equal(found.memberships[0].businessName, 'Taratara');
    assert.equal(found.memberships[0].active, true);
    assert.equal(found.lockedUntilUtc, null);
    assert.equal(pool.calls[0].values[0], 'ADA@T.TEST');
    const audit = pool.calls.find((c) => c.sql.includes('INSERT INTO "PlatformAuditLogs"'));
    assert.equal(audit.values[2], 'platform.user.lookup');
    assert.doesNotMatch(JSON.stringify(audit.values), /ada@t\.test/i);
    assert.doesNotMatch(pool.calls.map((c) => c.sql).join('\n'), /PasswordHash|SecurityStamp|PhoneNumber/);
  });

  it('an unknown account is 404 and the lookup is still audited as not found', async () => {
    const pool = recordingPool();
    await assert.rejects(() => lookupPlatformUser(pool, admin, allow, 'ghost@t.test'), (e) => e.code === 'user_not_found');
    const audit = pool.calls.find((c) => c.sql.includes('INSERT INTO "PlatformAuditLogs"'));
    assert.deepEqual(JSON.parse(audit.values[5]), { found: false });
  });

  it('a locked account shows the lock end; an expired lock does not', async () => {
    const make = (end) => recordingPool((sql) => sql.includes('FROM "AspNetUsers"')
      ? { rows: [{ Id: U, Email: 'a@t.test', FullName: 'A', EmailConfirmed: true, TwoFactorEnabled: false, LockoutEnd: end, AccessFailedCount: 5, CreatedAtUtc: new Date() }] } : { rows: [] });
    const future = new Date(Date.now() + 600_000);
    assert.deepEqual((await lookupPlatformUser(make(future), admin, allow, 'a@t.test')).lockedUntilUtc, future);
    assert.equal((await lookupPlatformUser(make(new Date(Date.now() - 1000)), admin, allow, 'a@t.test')).lockedUntilUtc, null);
  });

  it('the audit list filters in SQL and pages by cursor', async () => {
    const rows = [1, 2, 3].map((n) => ({ Id: `00000000-0000-4000-8000-00000000000${n}`, ActorEmail: admin, Action: 'platform.business.viewed', EntityType: 'Business', EntityId: A, DetailsJson: null, CreatedAtUtc: new Date(2026, 9, n) }));
    const pool = recordingPool(() => ({ rows }));
    const page = await listPlatformAuditLogs(pool, admin, allow, { action: 'platform.business.viewed', actor: ' OPS@example.test ', limit: 2 });
    assert.equal(page.items.length, 2);
    assert.deepEqual(page.items[0].details, {});
    assert.ok(page.next);
    assert.equal(pool.calls[0].values[0], 'platform.business.viewed');
    assert.equal(pool.calls[0].values[1], 'ops@example.test');
  });

  it('the health report shows whether a setting is present, never its value', async () => {
    const env = { NODE_ENV: 'production', EMAIL_PROVIDER: 'resend', STORAGE_PROVIDER: 's3', STORAGE_S3_BUCKET: 'b', STORAGE_S3_ACCESS_KEY: 'AKIA-secret', STORAGE_S3_SECRET_KEY: 'super-secret',
      BILLING_PAYSTACK_SECRET_KEY: 'sk_live_secret', META_WHATSAPP_APP_SECRET: 'x', META_WHATSAPP_VERIFY_TOKEN: '' };
    const flags = Object.fromEntries(configurationFlags(env).map((f) => [f.key, f.set]));
    assert.equal(flags.paystack, true);
    assert.equal(flags.s3, true);
    assert.equal(flags.meta_webhook, false, 'a half-set pair is not set');
    assert.equal(flags.resend_webhook, false);
    const pool = recordingPool((sql) => sql.includes('avzar_schema_migrations') ? { rows: [{ n: 43, latest: '0043_platform_admin_read.sql' }] }
      : sql.includes('GROUP BY') ? { rows: [{ kind: 'notification', status: 'Failed', n: 2 }, { kind: 'email', status: 'Sent', n: 7 }] } : { rows: [{ '?column?': 1 }] });
    const report = await getPlatformHealth(pool, env, admin, allow);
    assert.equal(report.database.ok, true);
    assert.equal(report.migrations.applied, 43);
    assert.deepEqual(report.queues.find((q) => q.kind === 'notification').statuses, { Failed: 2 });
    assert.deepEqual(report.queues.find((q) => q.kind === 'push').statuses, {});
    assert.doesNotMatch(JSON.stringify(report), /AKIA|super-secret|sk_live/);
  });

  it('a failing database check is reported, not thrown', async () => {
    const pool = { query: async () => { throw new Error('down'); } };
    const report = await getPlatformHealth(pool, {}, admin, allow);
    assert.equal(report.database.ok, false);
    assert.equal(report.migrations, null);
    assert.equal(report.queues, null);
  });
});

describe('suspend and reactivate (step 17c)', () => {
  const OTHER = '00000000-0000-4000-8000-0000000000b2';
  const reason = 'Chargeback dispute under review';
  const code = (c, status) => (error) => error.code === c && error.status === status;

  it('both refuse a person who is not on the allowlist, before touching the database', async () => {
    const pool = recordingPool();
    await refused(() => suspendPlatformBusiness(pool, 'tenant@example.test', allow, OTHER, A, reason));
    await refused(() => reactivatePlatformBusiness(pool, 'tenant@example.test', allow, A));
    assert.equal(pool.calls.length, 0);
  });

  it('suspend checks the ID, the reason and the signed-in business before any write', async () => {
    const pool = recordingPool();
    await assert.rejects(() => suspendPlatformBusiness(pool, admin, allow, OTHER, 'not-a-uuid', reason), code('business_not_found', 404));
    await assert.rejects(() => suspendPlatformBusiness(pool, admin, allow, OTHER, A, '  ab '), code('invalid_reason', 400));
    await assert.rejects(() => suspendPlatformBusiness(pool, admin, allow, OTHER, A, 'x'.repeat(201)), code('invalid_reason', 400));
    await assert.rejects(() => suspendPlatformBusiness(pool, admin, allow, OTHER, A, undefined), code('invalid_reason', 400));
    await assert.rejects(() => suspendPlatformBusiness(pool, admin, allow, A.toUpperCase(), A, reason), code('cannot_suspend_own_business', 409));
    assert.equal(pool.calls.length, 0);
  });

  it('suspend is one statement that switches the business off and writes the audit entry with the reason', async () => {
    const pool = recordingPool(() => ({ rows: [{ Id: A, SuspendedAtUtc: new Date('2026-10-31T10:00:00Z') }] }));
    const result = await suspendPlatformBusiness(pool, admin, allow, OTHER, A, `  ${reason}  `);
    assert.equal(pool.calls.length, 1);
    const { sql, values } = pool.calls[0];
    assert.match(sql, /UPDATE "Businesses" SET "IsActive" = FALSE, "SuspendedAtUtc" = now\(\)/);
    assert.match(sql, /WHERE "Id" = \$1 AND "IsActive" = TRUE/);
    assert.match(sql, /INSERT INTO "PlatformAuditLogs"/);
    assert.match(sql, /'platform\.business\.suspended'/);
    assert.equal(values[0], A);
    assert.equal(values[1], reason, 'the reason is trimmed');
    assert.equal(values[3], admin);
    assert.deepEqual(JSON.parse(values[4]), { reason });
    assert.deepEqual(result, { id: A, isActive: false, suspendedAtUtc: new Date('2026-10-31T10:00:00Z'), suspendedReason: reason });
    assert.doesNotMatch(sql, /Customers|Orders|Invoices/);
  });

  it('suspending an unknown business is 404 and an already suspended one is 409', async () => {
    const none = recordingPool(() => ({ rows: [] }));
    await assert.rejects(() => suspendPlatformBusiness(none, admin, allow, OTHER, A, reason), code('business_not_found', 404));
    const already = recordingPool((sql) => (sql.includes('WITH changed') ? { rows: [] } : { rows: [{ IsActive: false }] }));
    await assert.rejects(() => suspendPlatformBusiness(already, admin, allow, OTHER, A, reason), code('already_suspended', 409));
  });

  it('reactivate is one statement that switches the business on, clears the reason and audits the earlier one', async () => {
    const pool = recordingPool(() => ({ rows: [{ Id: A }] }));
    const result = await reactivatePlatformBusiness(pool, admin, allow, A);
    assert.equal(pool.calls.length, 1);
    const { sql, values } = pool.calls[0];
    assert.match(sql, /"IsActive" = TRUE, "SuspendedAtUtc" = NULL, "SuspendedReason" = NULL/);
    assert.match(sql, /"IsActive" = FALSE FOR UPDATE/);
    assert.match(sql, /'platform\.business\.reactivated'/);
    assert.match(sql, /previousReason/);
    assert.equal(values[0], A);
    assert.equal(values[2], admin);
    assert.deepEqual(result, { id: A, isActive: true, suspendedAtUtc: null, suspendedReason: null });
  });

  it('reactivating an unknown business is 404, a business that is not suspended is 409, a malformed ID is 404', async () => {
    await assert.rejects(() => reactivatePlatformBusiness(recordingPool(() => ({ rows: [] })), admin, allow, A), code('business_not_found', 404));
    const active = recordingPool((sql) => (sql.includes('WITH before') ? { rows: [] } : { rows: [{ IsActive: true }] }));
    await assert.rejects(() => reactivatePlatformBusiness(active, admin, allow, A), code('not_suspended', 409));
    await assert.rejects(() => reactivatePlatformBusiness(recordingPool(), admin, allow, 'nope'), code('business_not_found', 404));
  });

  it('the business detail carries the suspension fields', async () => {
    const detailRow = { Id: A, Name: 'Shop', ContactEmail: null, CurrencyCode: 'NGN', TimeZoneId: 'UTC', IsActive: false, CreatedAtUtc: new Date(), UpdatedAtUtc: null, SuspendedAtUtc: new Date('2026-10-31T10:00:00Z'), SuspendedReason: reason };
    const pool = recordingPool((sql) => {
      if (sql.includes('FROM "Businesses" WHERE "Id"=$1')) return { rows: [detailRow] };
      if (sql.includes('"activeStaff"')) return { rows: [{ activeStaff: 0, locations: 0, customers: 0, orders: 0, ordersLast30Days: 0, invoices: 0, storageBytes: '0' }] };
      return { rows: [] };
    });
    const detail = await getPlatformBusiness(pool, admin, allow, A);
    assert.equal(detail.isActive, false);
    assert.equal(detail.suspendedReason, reason);
    assert.ok(detail.suspendedAtUtc);
  });
});
