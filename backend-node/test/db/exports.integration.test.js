// Step 17d: the CSV exports for orders, invoices, payments, appointments and inquiries, over HTTP on real PostgreSQL,
// through a NOSUPERUSER, NOBYPASSRLS role.
// Proves: each export needs the same permission as its list; a bad filter is refused as on the list; the file holds only the
// caller's own business (another business's rows never appear); a location-limited user *with* an assigned location gets only
// the rows of that location; filters narrow the file; text a spreadsheet could read as a formula is guarded; and every export
// writes one audit entry with the row count and the filter names but never the search text.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { addStaff, confirmedOrder, firstLocationId, paidInvoice, signUp, startApp, upgradePlan } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const DAY = 86_400_000;

describe('CSV exports on PostgreSQL (restricted role)', { skip: !url }, () => {
  let db; let role; let api; let owner; let other; let viewer; let limited; let noPerm;
  let mainLocation; let branchLocation; let otherLocation;
  const ids = {};
  const get = (who, path) => api.call('GET', path, { token: who.token });
  const value = async (sql, params) => (await db.pool.query(sql, params)).rows[0];
  const membershipOf = async (who) => (await value(`
    SELECT m."Id" FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id" = m."UserId"
    WHERE u."Email" = $1 AND m."BusinessId" = $2`, [who.email, who.businessId])).Id;
  const interval = (days) => {
    const start = new Date(Date.now() + days * DAY);
    return { startAt: start.toISOString(), endAt: new Date(start.getTime() + 30 * 60_000).toISOString() };
  };
  const addStorefront = async (businessId) => {
    const id = randomUUID();
    await db.pool.query(`INSERT INTO "Storefronts" ("Id","BusinessId","Slug","Name","Status","TemplateKey","DraftJson","DraftRevision","AllowSearchIndexing",
      "WorkflowBooking","WorkflowContact","WorkflowCustomOrder","WorkflowInquiry","CreatedAtUtc")
      VALUES ($1,$2,$3,'Shop','Draft','luxury','{}',1,false,true,true,true,true,now())`, [id, businessId, `ex-${randomUUID().slice(0, 8)}`]);
    return id;
  };
  const addInquiry = (businessId, storefrontId, name, message) => db.pool.query(`
    INSERT INTO "Inquiries" ("Id","BusinessId","StorefrontId","Kind","Status","Name","Email","Message","CreatedAtUtc")
    VALUES ($1,$2,$3,'Inquiry','New',$4,$5,$6, now())`, [randomUUID(), businessId, storefrontId, name, `${randomUUID().slice(0, 6)}@example.test`, message]);
  const issuedInvoice = async (who, orderId) => {
    const draft = await api.call('POST', `/api/invoices/from-order/${orderId}`, { token: who.token, body: { mode: 'Full' } });
    assert.equal(draft.status, 201, draft.text);
    assert.equal((await api.call('POST', `/api/invoices/${draft.body.id}/issue`, { token: who.token })).status, 200);
    return draft.body.id;
  };
  const appointment = async (who, customerId, locationId, days) => {
    const created = await api.call('POST', '/api/appointments', { token: who.token,
      body: { type: 'Consultation', customerId, locationId, assignedMembershipId: await membershipOf(who), ...interval(days) } });
    assert.equal(created.status, 201, created.text);
  };

  before(async () => {
    db = await createTempDatabase(url, 'avzar_export');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    await assertRestrictedRole(role.pool);
    api = await startApp(role.pool);
    owner = await signUp(api, 'ex-owner');
    other = await signUp(api, 'ex-other');
    await upgradePlan(db, owner.businessId, 'starter');
    await upgradePlan(db, other.businessId, 'starter');
    await db.pool.query(`INSERT INTO "EntitlementOverrides" ("Id","BusinessId","CreatedAtUtc","Key","Reason","Value")
      VALUES ($1,$2,now(),'users.max','test fixture: more staff than the plan allows','unlimited')`, [randomUUID(), owner.businessId]);
    const everything = ['orders.view', 'invoices.view', 'payments.view', 'inquiries.view'];
    viewer = await addStaff(api, db, owner, 'ex-viewer', [...everything, 'locations.all']);
    limited = await addStaff(api, db, owner, 'ex-limited', everything.slice(0, 3));
    noPerm = await addStaff(api, db, owner, 'ex-noperm', ['customers.view', 'locations.all']);

    mainLocation = await firstLocationId(db, owner.businessId);
    branchLocation = randomUUID();
    await db.pool.query(`INSERT INTO "Locations" ("Id","BusinessId","Name","IsActive","CreatedAtUtc") VALUES ($1,$2,'Branch',TRUE,now())`, [branchLocation, owner.businessId]);
    await db.pool.query(`INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3)`,
      [await membershipOf(limited), mainLocation, owner.businessId]);
    otherLocation = await firstLocationId(db, other.businessId);

    const main = await confirmedOrder(api, db, owner, mainLocation, 'exa');
    const mainPaid = await paidInvoice(api, owner, main.orderId);
    const branch = await confirmedOrder(api, db, owner, branchLocation, 'exb');
    const branchInvoiceId = await issuedInvoice(owner, branch.orderId);
    const foreign = await confirmedOrder(api, db, other, otherLocation, 'exo');
    const foreignPaid = await paidInvoice(api, other, foreign.orderId);

    ids.mainOrder = (await value('SELECT "OrderNumber" AS n FROM "Orders" WHERE "Id" = $1', [main.orderId])).n;
    ids.branchOrder = (await value('SELECT "OrderNumber" AS n FROM "Orders" WHERE "Id" = $1', [branch.orderId])).n;
    ids.foreignOrder = (await value('SELECT "OrderNumber" AS n FROM "Orders" WHERE "Id" = $1', [foreign.orderId])).n;
    ids.mainInvoice = (await value('SELECT "Number" AS n FROM "Invoices" WHERE "Id" = $1', [mainPaid.invoiceId])).n;
    ids.branchInvoice = (await value('SELECT "Number" AS n FROM "Invoices" WHERE "Id" = $1', [branchInvoiceId])).n;
    ids.foreignInvoice = (await value('SELECT "Number" AS n FROM "Invoices" WHERE "Id" = $1', [foreignPaid.invoiceId])).n;
    ids.mainPayment = (await value('SELECT "Reference" AS n FROM "Payments" WHERE "Id" = $1', [mainPaid.paymentId])).n;
    ids.foreignPayment = (await value('SELECT "Reference" AS n FROM "Payments" WHERE "Id" = $1', [foreignPaid.paymentId])).n;
    ids.mainCustomer = main.customerId; ids.branchCustomer = branch.customerId; ids.foreignCustomer = foreign.customerId;

    await appointment(owner, main.customerId, mainLocation, 5);
    await appointment(owner, branch.customerId, branchLocation, 6);
    await appointment(other, foreign.customerId, otherLocation, 5);

    await addInquiry(owner.businessId, await addStorefront(owner.businessId), 'Request Person', '=cmd|calc');
    await addInquiry(owner.businessId, await addStorefront(owner.businessId), 'Second Person', 'Plain message');
    await addInquiry(other.businessId, await addStorefront(other.businessId), 'Foreign Person', 'Not yours');
  });
  after(async () => { await api?.close(); await role?.close(); await db?.drop(); });

  it('needs the same permission as the list for all five', async () => {
    for (const path of ['orders', 'invoices', 'payments', 'appointments', 'inquiries']) {
      const denied = await get(noPerm, `/api/${path}/export`);
      assert.equal(denied.status, 403, `${path}: ${denied.text}`);
      assert.equal((await get(viewer, `/api/${path}/export`)).status, 200, path);
    }
  });

  it('returns a UTF-8 CSV with a header row', async () => {
    const result = await get(owner, '/api/orders/export');
    assert.equal(result.status, 200);
    assert.match(result.contentType, /^text\/csv/);
    assert.ok(result.text.startsWith('\uFEFFOrder number,Status,Customer,'));
  });

  it('holds the whole of the caller\'s business and nothing of another business', async () => {
    const orders = (await get(owner, '/api/orders/export')).text;
    assert.ok(orders.includes(ids.mainOrder) && orders.includes(ids.branchOrder));
    assert.ok(!orders.includes(ids.foreignOrder));
    const invoices = (await get(owner, '/api/invoices/export')).text;
    assert.ok(invoices.includes(ids.mainInvoice) && invoices.includes(ids.branchInvoice));
    assert.ok(!invoices.includes(ids.foreignInvoice));
    const payments = (await get(owner, '/api/payments/export')).text;
    assert.ok(payments.includes(ids.mainPayment) && !payments.includes(ids.foreignPayment));
    const appointments = (await get(owner, '/api/appointments/export')).text;
    assert.ok(appointments.includes(ids.mainCustomer) && appointments.includes(ids.branchCustomer));
    assert.ok(!appointments.includes(ids.foreignCustomer));
    const requests = (await get(owner, '/api/inquiries/export')).text;
    assert.ok(requests.includes('Request Person') && requests.includes('Second Person'));
    assert.ok(!requests.includes('Foreign Person'));

    const theirs = (await get(other, '/api/orders/export')).text;
    assert.ok(theirs.includes(ids.foreignOrder) && !theirs.includes(ids.mainOrder) && !theirs.includes(ids.branchOrder));
    const theirInvoices = (await get(other, '/api/invoices/export')).text;
    assert.ok(theirInvoices.includes(ids.foreignInvoice) && !theirInvoices.includes(ids.mainInvoice));
  });

  it('gives a location-limited user with an assigned location only that location\'s rows', async () => {
    const orders = (await get(limited, '/api/orders/export')).text;
    assert.ok(orders.includes(ids.mainOrder));
    assert.ok(!orders.includes(ids.branchOrder));
    const invoices = (await get(limited, '/api/invoices/export')).text;
    assert.ok(invoices.includes(ids.mainInvoice) && !invoices.includes(ids.branchInvoice));
    const payments = (await get(limited, '/api/payments/export')).text;
    assert.ok(payments.includes(ids.mainPayment));
    const appointments = (await get(limited, '/api/appointments/export')).text;
    assert.ok(appointments.includes(ids.mainCustomer) && !appointments.includes(ids.branchCustomer));
  });

  it('narrows the file with the list filters', async () => {
    const bySearch = (await get(owner, '/api/orders/export?search=exa')).text;
    assert.ok(bySearch.includes(ids.mainOrder) && !bySearch.includes(ids.branchOrder));
    const outstanding = (await get(owner, '/api/invoices/export?outstanding=true')).text;
    assert.ok(outstanding.includes(ids.branchInvoice) && !outstanding.includes(ids.mainInvoice));
    const atBranch = (await get(owner, `/api/appointments/export?locationId=${branchLocation}`)).text;
    assert.ok(atBranch.includes(ids.branchCustomer) && !atBranch.includes(ids.mainCustomer));
    const none = (await get(owner, '/api/invoices/export?status=Draft')).text;
    assert.equal(none.trimEnd().split('\r\n').length, 1, 'only the header');
  });

  it('refuses bad filters the way the list does', async () => {
    assert.equal((await get(owner, '/api/orders/export?status=shipped')).status, 400);
    assert.equal((await get(owner, '/api/orders/export?pageSize=500')).status, 400);
    assert.equal((await get(owner, '/api/invoices/export?status=Nope')).status, 400);
    assert.equal((await get(owner, '/api/payments/export?from=2026-12-31&to=2026-01-01')).status, 400);
    assert.equal((await get(owner, '/api/appointments/export?type=Nope')).status, 400);
    assert.equal((await get(owner, '/api/inquiries/export?status=Nope')).status, 400);
  });

  it('guards text that a spreadsheet could read as a formula', async () => {
    const requests = (await get(owner, '/api/inquiries/export')).text;
    assert.ok(requests.includes(",'=cmd|calc,"), requests);
  });

  it('writes one audit entry per export with the row count and filter names, never the search text', async () => {
    const before = Number((await value(`SELECT count(*) AS n FROM "AuditLogs" WHERE "BusinessId" = $1 AND "Action" = 'export.orders'`, [owner.businessId])).n);
    assert.equal((await get(owner, '/api/orders/export?search=exa')).status, 200);
    const rows = (await db.pool.query(`SELECT "ActorUserId", "DetailsJson" FROM "AuditLogs" WHERE "BusinessId" = $1 AND "Action" = 'export.orders' ORDER BY "CreatedAtUtc" DESC`, [owner.businessId])).rows;
    assert.equal(rows.length, before + 1);
    assert.equal(rows[0].DetailsJson.rowCount, 1);
    assert.deepEqual(rows[0].DetailsJson.filters, { search: true });
    assert.ok(!JSON.stringify(rows[0].DetailsJson).includes('exa'));
    for (const kind of ['invoices', 'payments', 'appointments', 'inquiries']) {
      assert.ok(Number((await value(`SELECT count(*) AS n FROM "AuditLogs" WHERE "BusinessId" = $1 AND "Action" = $2`, [owner.businessId, `export.${kind}`])).n) >= 1, kind);
    }
  });

  it('changes nothing it reads', async () => {
    const counts = async () => (await db.pool.query(`SELECT
      (SELECT count(*) FROM "Orders") AS orders, (SELECT count(*) FROM "Invoices") AS invoices,
      (SELECT count(*) FROM "Payments") AS payments, (SELECT count(*) FROM "Appointments") AS appointments,
      (SELECT count(*) FROM "Inquiries") AS inquiries`)).rows[0];
    const first = await counts();
    for (const path of ['orders', 'invoices', 'payments', 'appointments', 'inquiries']) await get(owner, `/api/${path}/export`);
    assert.deepEqual(await counts(), first);
  });
});
