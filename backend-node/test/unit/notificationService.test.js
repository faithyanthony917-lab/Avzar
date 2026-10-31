import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCursor, encodeCursor, listNotifications, markAllRead, markRead, notify, purgeOldNotifications, unreadCount } from '../../src/notifications/notificationService.js';

const business = '00000000-0000-4000-8000-0000000000b1';
const alice = '00000000-0000-4000-8000-0000000000a1';
const bob = '00000000-0000-4000-8000-0000000000a2';
const actor = '00000000-0000-4000-8000-0000000000a3';
const task = '00000000-0000-4000-8000-0000000000c1';
const NOW = new Date('2026-10-20T12:00:00Z');
const silent = { error() {}, info() {} };

// Fake database: records every statement and answers by SQL substring. `release` makes it behave like a transaction client.
function fakeDb({ people = [], insertCounts = {}, failOn = null, client = false, pushTokens = [] } = {}) {
  const calls = [];
  const outbox = [];
  const db = {
    pushTokens,
    calls, outbox,
    async query(sql, values = []) {
      calls.push({ sql: sql.trim(), values });
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      if (sql.includes('FROM "Memberships" m')) return { rows: people };
      if (sql.includes('INSERT INTO "NotificationOutbox"')) {
        if (insertCounts.outbox === 0) return { rowCount: 0, rows: [] };
        const duplicate = outbox.some((job) => job.BusinessId === values[1] && job.RecipientMembershipId === values[2]
          && job.DeduplicationKey === values[9]);
        if (duplicate) return { rowCount: 0, rows: [] };
        const job = {
          Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4],
          Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
          InAppEnabled: values[10], EmailToAddress: values[11], EmailSubject: values[12], EmailTemplateKey: values[13],
          EmailTextBody: values[14], EmailDeduplicationKey: values[15], EmailNextAttemptUtc: values[16],
          PushEnabled: values[17], PushNextAttemptUtc: values[18],
          Status: 'Pending', Attempts: 0, NextAttemptUtc: values[19], CreatedAtUtc: values[19],
        };
        outbox.push(job);
        return { rowCount: 1, rows: [job] };
      }
      if (sql.includes('INSERT INTO "Notifications"')) return { rowCount: insertCounts.inApp ?? 1, rows: [] };
      if (sql.includes('INSERT INTO "EmailOutbox"')) return { rowCount: insertCounts.email ?? 1, rows: [] };
      if (sql.includes('SET "NextAttemptUtc" = $3')) {
        const job = outbox.find((row) => row.Id === values[0] && row.Status === 'Pending');
        if (job) { job.LastError = values[1]; job.NextAttemptUtc = values[2]; }
        return { rowCount: job ? 1 : 0, rows: [] };
      }
      if (sql.includes('UPDATE "NotificationOutbox"')) {
        const job = outbox.find((row) => row.Id === values[0] && row.Status === values[1]);
        if (job) { job.Status = 'Sent'; job.SentAtUtc = values[2]; job.EmailTextBody = ''; }
        return { rowCount: job ? 1 : 0, rows: [] };
      }
      if (sql.includes('FROM "PushTokens"')) {
        return { rows: pushTokens.filter((token) => token.BusinessId === values[0] && token.MembershipId === values[1] && token.Active).map((token) => ({ Token: token.Token, Platform: token.Platform, DeviceName: token.DeviceName })) };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  if (client) db.release = () => {};
  return db;
}

const person = (id, extra = {}) => ({ Id: id, DisplayName: 'Person', Email: `${id.slice(-2)}@example.test`, TimeZoneId: 'UTC', ...extra });
const event = (extra = {}) => ({
  businessId: business, category: 'tasks', eventType: 'task.assigned', title: 'Task assigned', body: "Task 'Hem trousers' was assigned to you.",
  dedupeKey: `task.assigned:${task}:v1`, target: { kind: 'task', id: task }, recipients: { membershipIds: [alice] }, ...extra,
});
const sqlOf = (db, needle) => db.calls.filter((call) => call.sql.includes(needle));

describe('notify()', () => {
  it('writes one in-app row per recipient with ids only and the given dedupe key', async () => {
    const db = fakeDb({ people: [person(alice), person(bob)] });
    const result = await notify(db, event({ recipients: { membershipIds: [alice, bob] } }), { now: NOW, log: silent });
    assert.deepEqual(result, { ok: true, recipients: 2, inApp: 2, email: 0 });
    const inserts = sqlOf(db, 'INSERT INTO "Notifications"');
    assert.equal(inserts.length, 2);
    assert.deepEqual(inserts[0].values.slice(1), [business, alice, 'tasks', 'task.assigned', 'Task assigned', "Task 'Hem trousers' was assigned to you.", 'task', task, `task.assigned:${task}:v1`, NOW]);
    assert.match(inserts[0].sql, /ON CONFLICT \("BusinessId", "RecipientMembershipId", "DeduplicationKey"\) DO NOTHING/);
  });

  it('counts only rows that were really inserted, so a repeated event adds nothing', async () => {
    const db = fakeDb({ people: [person(alice)], insertCounts: { outbox: 0 } });
    const result = await notify(db, event({ email: { templateKey: 'task.assignment', subject: 'S', text: () => 'T' } }), { now: NOW, log: silent });
    assert.deepEqual(result, { ok: true, recipients: 1, inApp: 0, email: 0 });
  });

  it('skips the in-app row when the person turned in-app off for the category', async () => {
    const db = fakeDb({ people: [person(alice, { InAppEnabled: false, EmailEnabled: true })] });
    const result = await notify(db, event({ email: { templateKey: 'task.assignment', subject: 'S', text: () => 'T' } }), { now: NOW, log: silent });
    assert.equal(result.inApp, 0);
    assert.equal(result.email, 1);
    assert.equal(sqlOf(db, 'INSERT INTO "Notifications"').length, 0);
  });

  it('queues email only when the event has an email, the preference allows it and the address is acceptable', async () => {
    const mail = { templateKey: 'task.assignment', subject: 'A production task has been assigned to you', text: (p) => `Hello ${p.DisplayName}`, dedupeKey: (p) => `task.assignment:${p.Id}` };
    // tasks defaults to email on
    let db = fakeDb({ people: [person(alice)] });
    assert.equal((await notify(db, event({ email: mail }), { now: NOW, log: silent })).email, 1);
    const [email] = sqlOf(db, 'INSERT INTO "EmailOutbox"');
    assert.deepEqual(email.values.slice(1, 4), [business, NOW, NOW]);
    assert.equal(email.values[5], 'task.assignment');
    assert.equal(email.values[6], 'Hello Person');
    assert.equal(email.values[8], `task.assignment:${alice}`);
    assert.match(email.sql, /ON CONFLICT \("DeduplicationKey"\) WHERE "DeduplicationKey" IS NOT NULL DO NOTHING/);
    // email preference off
    db = fakeDb({ people: [person(alice, { EmailEnabled: false })] });
    assert.equal((await notify(db, event({ email: mail }), { now: NOW, log: silent })).email, 0);
    // category without email by default
    db = fakeDb({ people: [person(alice)] });
    assert.equal((await notify(db, event({ category: 'orders', email: mail }), { now: NOW, log: silent })).email, 0);
    // no email on the event
    db = fakeDb({ people: [person(alice)] });
    assert.equal((await notify(db, event(), { now: NOW, log: silent })).email, 0);
    // unusable address
    db = fakeDb({ people: [person(alice, { Email: 'not an address' })] });
    assert.equal((await notify(db, event({ email: mail }), { now: NOW, log: silent })).email, 0);
  });

  it('defaults the email dedupe key to the event key plus the recipient', async () => {
    const db = fakeDb({ people: [person(alice)] });
    await notify(db, event({ email: { templateKey: 'task.assignment', subject: 'S', text: () => 'T' } }), { now: NOW, log: silent });
    assert.equal(sqlOf(db, 'INSERT INTO "EmailOutbox"')[0].values[8], `task.assigned:${task}:v1:${alice.replaceAll('-', '')}`);
  });

  it('holds email back until quiet hours end, in the business time zone, but never the in-app row', async () => {
    const quiet = { QuietHoursEnabled: true, QuietStartMinute: 22 * 60, QuietEndMinute: 7 * 60, TimeZoneId: 'Africa/Lagos' };
    const db = fakeDb({ people: [person(alice, quiet)] });
    const late = new Date('2026-10-20T21:30:00Z'); // 22:30 in Lagos
    await notify(db, event({ email: { templateKey: 'task.assignment', subject: 'S', text: () => 'T' } }), { now: late, log: silent });
    const [email] = sqlOf(db, 'INSERT INTO "EmailOutbox"');
    assert.equal(email.values[2].toISOString(), late.toISOString(), 'CreatedAtUtc is now');
    assert.equal(email.values[3].toISOString(), '2026-10-21T06:00:00.000Z', 'NextAttemptUtc is the end of quiet hours');
    assert.equal(sqlOf(db, 'INSERT INTO "Notifications"')[0].values[10].toISOString(), late.toISOString());
  });

  it('passes the actor, permission and location filters to the recipient query, and never broadcasts without a recipient rule', async () => {
    const location = '00000000-0000-4000-8000-0000000000d1';
    const db = fakeDb({ people: [] });
    await notify(db, event({ recipients: { permission: 'tasks.manage', locationId: location }, actorMembershipId: actor }), { now: NOW, log: silent });
    const [query] = sqlOf(db, 'FROM "Memberships" m');
    assert.deepEqual(query.values, [business, null, 'tasks', 'tasks.manage', location, actor, null, false, false]);
    assert.match(query.sql, /m\."Status" = 0/);
    assert.match(query.sql, /m\."BusinessId" = \$1/);

    const bare = fakeDb();
    const result = await notify(bare, event({ recipients: {} }), { now: NOW, log: silent });
    assert.equal(result.ok, false);
    assert.equal(bare.calls.length, 0, 'nothing is queried for an invalid event');
  });

  it('supports an explicit owner-only recipient filter for lifecycle notices', async () => {
    const db = fakeDb({ people: [] });
    await notify(db, event({ recipients: { ownersOnly: true } }), { now: NOW, log: silent });
    const [query] = sqlOf(db, 'FROM "Memberships" m');
    assert.equal(query.values[7], true);
    assert.match(query.sql, /m\."IsOwner"/);
  });

  it('restricts locationless resource notices to owners and locations.all holders', async () => {
    const db = fakeDb({ people: [] });
    await notify(db, event({ recipients: { permission: 'inventory.view', locationlessOnly: true } }), { now: NOW, log: silent });
    const [query] = sqlOf(db, 'FROM "Memberships" m');
    assert.equal(query.values[8], true);
    assert.match(query.sql, /rp\."Permission" = 'locations\.all'/);
  });

  it('rejects bad input without throwing and without touching the database', async () => {
    const cases = [
      event({ businessId: 'nope' }), event({ category: 'weather' }), event({ title: ' ' }), event({ dedupeKey: '' }),
      event({ dedupeKey: 'k'.repeat(201) }), event({ target: { kind: 'secret', id: task } }), event({ target: { kind: 'task', id: 'x' } }),
      event({ recipients: { membershipIds: ['x'] } }), event({ email: { templateKey: 'a', subject: 'b' } }), null,
    ];
    for (const bad of cases) {
      const db = fakeDb();
      assert.equal((await notify(db, bad, { now: NOW, log: silent })).ok, false);
      assert.equal(db.calls.length, 0);
    }
  });

  it('shortens over-long titles and bodies instead of failing', async () => {
    const db = fakeDb({ people: [person(alice)] });
    await notify(db, event({ title: 'T'.repeat(400), body: 'B'.repeat(900) }), { now: NOW, log: silent });
    const values = sqlOf(db, 'INSERT INTO "Notifications"')[0].values;
    assert.equal(values[5].length, 120);
    assert.equal(values[6].length, 300);
  });

  it('queues push intent without making a network request inside the business transaction', async () => {
    const originalFetch = global.fetch;
    let networkCalls = 0;
    global.fetch = async () => { networkCalls += 1; throw new Error('network must not run inside notify'); };
    try {
      const db = fakeDb({ people: [person(alice, { InAppEnabled: false, EmailEnabled: false, PushEnabled: true })] });
      const result = await notify(db, event({ recipients: { membershipIds: [alice] } }), { now: NOW, log: silent });
      assert.deepEqual(result, { ok: true, recipients: 1, inApp: 0, email: 0 });
      const outboxInsert = sqlOf(db, 'INSERT INTO "NotificationOutbox"')[0];
      assert.equal(outboxInsert.values[17], true);
      assert.equal(outboxInsert.values[18].toISOString(), NOW.toISOString());
      assert.equal(networkCalls, 0);
      assert.equal(sqlOf(db, 'INSERT INTO "PushDeliveries"').length, 0, 'no delivery rows are created without a configured sender');
    } finally { global.fetch = originalFetch; }
  });

  it('runs inside a savepoint on a transaction client and releases it on success', async () => {
    const db = fakeDb({ people: [person(alice)], client: true });
    await notify(db, event(), { now: NOW, log: silent });
    const statements = db.calls.map((call) => call.sql.split(' ')[0] + ' ' + (call.sql.split(' ')[1] ?? ''));
    assert.ok(db.calls.findIndex((call) => call.sql.includes('INSERT INTO "NotificationOutbox"')) < db.calls.findIndex((call) => /^SAVEPOINT avzar_notify_\d+$/.test(call.sql)));
    assert.match(db.calls.at(-1).sql, /^RELEASE SAVEPOINT avzar_notify_\d+$/);
    assert.ok(statements.length > 2);
  });

  it('keeps a durable pending job when immediate in-app delivery fails', async () => {
    const logged = [];
    const db = fakeDb({ people: [person(alice)], failOn: 'INSERT INTO "Notifications"', client: true });
    const result = await notify(db, event(), { now: NOW, log: { error: (...args) => logged.push(args) } });
    assert.deepEqual(result, { ok: true, recipients: 1, inApp: 1, email: 0 });
    assert.equal(db.outbox.length, 1);
    assert.equal(db.outbox[0].Status, 'Pending');
    assert.equal(db.outbox[0].DeduplicationKey, `task.assigned:${task}:v1`);
    assert.equal(db.outbox[0].LastError, 'Error');
    assert.equal(db.outbox[0].NextAttemptUtc.toISOString(), '2026-10-20T12:00:30.000Z');
    assert.ok(db.calls.some((call) => /^ROLLBACK TO SAVEPOINT avzar_notify_\d+$/.test(call.sql)));
    assert.ok(db.calls.some((call) => /^RELEASE SAVEPOINT/.test(call.sql)));
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0][1], { errorType: 'Error', eventType: 'task.assigned' });
  });

  it('propagates failure to persist the durable intent so the enclosing business transaction can roll back', async () => {
    const db = fakeDb({ people: [person(alice)], failOn: 'INSERT INTO "NotificationOutbox"', client: true });
    await assert.rejects(notify(db, event(), { now: NOW, log: silent }), /boom/);
    assert.equal(sqlOf(db, 'INSERT INTO "Notifications"').length, 0);
    assert.equal(sqlOf(db, 'SAVEPOINT').length, 0);
  });

  it('does not use a savepoint on a bare pool', async () => {
    const db = fakeDb({ people: [person(alice)] });
    await notify(db, event(), { now: NOW, log: silent });
    assert.equal(sqlOf(db, 'SAVEPOINT').length, 0);
  });
});

describe('reading and marking notifications', () => {
  const row = (n, extra = {}) => ({ Id: `00000000-0000-4000-8000-00000000000${n}`, Category: 'tasks', EventType: 'task.assigned', Title: 'T', Body: 'B', TargetKind: 'task', TargetId: task, CreatedAtUtc: new Date(`2026-10-20T12:0${n}:00Z`), ReadAtUtc: null, ...extra });

  it('pages newest first with a keyset cursor and scopes every query to the caller', async () => {
    const calls = [];
    const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [row(3), row(2), row(1)] }; } };
    const page = await listNotifications(db, { businessId: business, membershipId: alice, limit: 2 });
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].isRead, false);
    assert.deepEqual(page.items[0].target, { kind: 'task', id: task });
    assert.ok(page.nextCursor);
    assert.deepEqual(decodeCursor(page.nextCursor), { t: new Date('2026-10-20T12:02:00Z'), id: row(2).Id });
    assert.deepEqual(calls[0].values.slice(0, 2), [business, alice]);
    assert.equal(calls[0].values[6], 3, 'fetches one extra row to know whether another page exists');
    assert.match(calls[0].sql, /"BusinessId" = \$1 AND "RecipientMembershipId" = \$2/);
  });

  it('has no next cursor on the last page, clamps the limit and rejects a bad category or cursor', async () => {
    const db = { query: async () => ({ rows: [row(1)] }) };
    assert.equal((await listNotifications(db, { businessId: business, membershipId: alice, limit: 500 })).nextCursor, null);
    await assert.rejects(listNotifications(db, { businessId: business, membershipId: alice, category: 'nope' }), { code: 'invalid_category' });
    await assert.rejects(listNotifications(db, { businessId: business, membershipId: alice, cursor: 'garbage' }), { code: 'invalid_cursor' });
    assert.deepEqual(decodeCursor(encodeCursor(row(1))).id, row(1).Id);
  });

  it('counts unread for the caller only and reports when the cap was hit', async () => {
    const calls = [];
    let count = 4;
    const db = { query: async (sql, values) => { calls.push(values); return { rows: [{ Count: count }] }; } };
    assert.deepEqual(await unreadCount(db, { businessId: business, membershipId: alice }), { count: 4, capped: false });
    assert.deepEqual(calls[0].slice(0, 2), [business, alice]);
    count = 1000;
    assert.deepEqual(await unreadCount(db, { businessId: business, membershipId: alice }), { count: 1000, capped: true });
  });

  it('marks read only the caller\'s own row; someone else\'s or a malformed id is "not found"', async () => {
    const calls = [];
    const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: values[2] === alice ? [row(1, { ReadAtUtc: NOW })] : [] }; } };
    const own = await markRead(db, { businessId: business, membershipId: alice, id: row(1).Id, now: NOW });
    assert.equal(own.isRead, true);
    assert.match(calls[0].sql, /WHERE "Id" = \$1 AND "BusinessId" = \$2 AND "RecipientMembershipId" = \$3/);
    await assert.rejects(markRead(db, { businessId: business, membershipId: bob, id: row(1).Id }), { status: 404, code: 'notification_not_found' });
    await assert.rejects(markRead(db, { businessId: business, membershipId: alice, id: 'not-a-uuid' }), { status: 404 });
    assert.equal(calls.length, 2, 'a malformed id never reaches the database');
  });

  it('marks everything read for the caller, optionally within a category', async () => {
    const calls = [];
    const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rowCount: 3 }; } };
    assert.deepEqual(await markAllRead(db, { businessId: business, membershipId: alice, category: 'orders', now: NOW }), { updated: 3 });
    assert.deepEqual(calls[0].values, [business, alice, NOW, 'orders']);
    await assert.rejects(markAllRead(db, { businessId: business, membershipId: alice, category: 'x' }), { code: 'invalid_category' });
  });

  it('purges read rows after 90 days and unread rows after 180', async () => {
    const calls = [];
    const db = { query: async (sql, values) => { calls.push(values); return { rowCount: 7 }; } };
    assert.equal(await purgeOldNotifications(db, { now: NOW }), 7);
    assert.equal(calls[0][0].toISOString(), '2026-07-22T12:00:00.000Z');
    assert.equal(calls[0][1].toISOString(), '2026-04-23T12:00:00.000Z');
  });
});
