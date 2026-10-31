// Step-09c: the public and token-keyed request paths that rls-public-flows did not cover, exercised over HTTP against real PostgreSQL
// as a NOSUPERUSER, NOBYPASSRLS role. Fixtures and row counts use the superuser pool; the app only ever sees the restricted pool.
// Covered here: redirect-slug and hostname lookups, public inquiry, quotation and privacy links, calendar feed, analytics consent and
// event, ready-to-wear checkout, and the public media lookup. Every path also gets a cross-business or wrong-key negative.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { runWithTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import { openMedia } from '../../src/auth/mediaService.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { confirmedOrder, firstLocationId, signUp, startApp } from './httpHarness.js';
import { assertRestrictedRole, createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
const hex = (id) => id.replaceAll('-', '');

describe('public and token-keyed HTTP paths under a restricted role', { skip: !url }, () => {
  let db; let role; let api;
  let A; let B; let siteA; let siteB;
  const slugs = { a: 'ra-shop', b: 'rb-shop', aNew: 'ra-shop-new' };
  const provider = {
    isConfigured: () => true,
    initialize: async (input) => ({ authorizationUrl: `https://pay.example.test/${input.reference}` }),
    verify: async (reference) => ({ status: 'pending', reference }),
    verifySignature: () => false,
  };

  async function publishStorefront(owner, name, slug) {
    const created = await api.call('POST', '/api/storefronts', { token: owner.token, body: { name, slug } });
    assert.equal(created.status, 201, created.text);
    const published = await api.call('POST', `/api/storefronts/${created.body.id}/publish`, { token: owner.token, body: {} });
    assert.equal(published.status, 200, published.text);
    return created.body;
  }
  async function insertDesign(businessId, { visibility = 'Public', slug = `d-${randomBytes(3).toString('hex')}` } = {}) {
    const id = randomUUID();
    await db.pool.query(`
      INSERT INTO "Designs" ("Id","BusinessId","CreatedAtUtc","IsFeatured","Kind","Name","Slug","Status","Visibility","BasePrice","CurrencyCode")
      VALUES ($1,$2,now(),FALSE,'ReadyMade','Kaftan','${slug}','Active',$3,15000,'NGN')`, [id, businessId, visibility]);
    return id;
  }
  async function insertAsset(businessId, purpose = 'DesignImage') {
    const id = randomUUID();
    await db.pool.query(`
      INSERT INTO "MediaAssets" ("Id","BusinessId","ContentType","CreatedAtUtc","Height","OriginalFileName","Purpose","Sha256","SizeBytes","Width")
      VALUES ($1,$2,'image/webp',now(),10,'a.webp',$3,$4,100,10)`, [id, businessId, purpose, randomBytes(32).toString('hex')]);
    return id;
  }
  const attach = (designId, assetId, businessId) => db.pool.query(
    'INSERT INTO "DesignImages" ("DesignId","MediaAssetId","BusinessId","SortOrder") VALUES ($1,$2,$3,0)', [designId, assetId, businessId]);

  before(async () => {
    db = await createTempDatabase(url, 'avzar_rls_http');
    await migrate(db.pool, MIGRATIONS_DIR, quiet);
    await syncPlans(db.pool);
    role = await createRestrictedAppPool(db);
    api = await startApp(role.pool, { PUBLIC_BASE_URL: 'https://shop.example.test' }, { billingProvider: provider });
    A = await signUp(api, 'rlsa');
    B = await signUp(api, 'rlsb');
    siteA = await publishStorefront(A, 'RA Shop', slugs.a);
    siteB = await publishStorefront(B, 'RB Shop', slugs.b);
  });
  after(async () => {
    await api?.close();
    await role?.close();
    await db?.drop();
  });

  it('the application pool is a restricted role', async () => {
    await assertRestrictedRole(role.pool);
  });

  it('an old slug redirects to the renamed site, and resolve-slug finds only published sites', async () => {
    const current = await api.call('GET', `/api/storefronts/${siteA.id}`, { token: A.token });
    assert.equal(current.status, 200, current.text);
    const renamed = await api.call('PUT', `/api/storefronts/${siteA.id}/slug`, { token: A.token, body: { version: current.body.version, slug: slugs.aNew } });
    assert.equal(renamed.status, 200, renamed.text);
    const old = await api.call('GET', `/public/sites/${slugs.a}/designs`, { redirect: 'manual' });
    assert.equal(old.status, 308);
    assert.equal(old.location, `/public/sites/${slugs.aNew}/designs`);
    assert.deepEqual((await api.call('GET', `/public/resolve-slug/${slugs.a}`)).body, { slug: slugs.aNew });
    assert.deepEqual((await api.call('GET', `/public/resolve-slug/${slugs.b}`)).body, { slug: slugs.b });
    assert.equal((await api.call('GET', '/public/resolve-slug/no-such-shop')).status, 404);
    assert.equal((await api.call('GET', `/public/sites/${slugs.aNew}/designs`)).status, 200);
    // A third business, with no storefront yet (the free plan allows one, so B would be refused for the limit first), cannot take the retired slug.
    const third = await signUp(api, 'rlsc');
    const taken = await api.call('POST', '/api/storefronts', { token: third.token, body: { name: 'Squatter', slug: slugs.a } });
    assert.equal(taken.status, 409, taken.text);
    assert.equal(taken.body.code, 'slug_taken');
    // Step-09c3: the availability check must see other businesses' rows. A live address of another business is refused on create too.
    for (const slug of [slugs.b, slugs.aNew]) {
      const live = await api.call('POST', '/api/storefronts', { token: third.token, body: { name: 'Squatter', slug } });
      assert.equal(live.status, 409, live.text);
      assert.equal(live.body.code, 'slug_taken');
    }
    // ... and a rename onto another business's retired or live address is refused, leaving both sites as they were.
    const bNow = await api.call('GET', `/api/storefronts/${siteB.id}`, { token: B.token });
    assert.equal(bNow.status, 200, bNow.text);
    for (const slug of [slugs.a, slugs.aNew]) {
      const attempt = await api.call('PUT', `/api/storefronts/${siteB.id}/slug`, { token: B.token, body: { version: bNow.body.version, slug } });
      assert.equal(attempt.status, 409, attempt.text);
      assert.equal(attempt.body.code, 'slug_taken');
    }
    const aStill = await api.call('GET', `/public/sites/${slugs.a}/designs`, { redirect: 'manual' });
    assert.equal(aStill.status, 308);
    assert.equal(aStill.location, `/public/sites/${slugs.aNew}/designs`);
    assert.deepEqual((await api.call('GET', `/public/resolve-slug/${slugs.b}`)).body, { slug: slugs.b });
    const rows = await db.pool.query('SELECT "Slug", "BusinessId" FROM "Storefronts" ORDER BY "Slug"');
    assert.deepEqual(rows.rows.map((r) => [r.Slug, r.BusinessId]), [[slugs.aNew, A.businessId], [slugs.b, B.businessId]].sort());
  });

  it('a verified custom hostname resolves to its own site; pending and unknown hostnames do not', async () => {
    await db.pool.query(`
      INSERT INTO "PlanEntitlements" ("PlanId","Key","Value") SELECT "PlanId", 'storefront.custom_domain', 'true' FROM "Subscriptions" WHERE "BusinessId" = $1
      ON CONFLICT ("PlanId","Key") DO UPDATE SET "Value" = 'true'`, [A.businessId]);
    const domain = (storefrontId, businessId, hostname, status) => db.pool.query(`
      INSERT INTO "StorefrontDomains" ("Id","BusinessId","CreatedAtUtc","Hostname","Status","StorefrontId","VerificationToken")
      VALUES ($1,$2,now(),$3,$4,$5,'token')`, [randomUUID(), businessId, hostname, status, storefrontId]);
    await domain(siteA.id, A.businessId, 'shop.ra.example.test', 'Verified');
    await domain(siteB.id, B.businessId, 'shop.rb.example.test', 'Pending');
    assert.equal((await api.call('GET', '/public/domains/allowed?domain=shop.ra.example.test')).status, 200);
    const resolved = await api.call('GET', '/public/resolve?host=shop.ra.example.test');
    assert.equal(resolved.status, 200, resolved.text);
    assert.deepEqual(resolved.body, { slug: slugs.aNew });
    assert.equal((await api.call('GET', '/public/resolve?host=SHOP.RA.EXAMPLE.TEST.')).status, 200);
    assert.equal((await api.call('GET', '/public/resolve?host=shop.rb.example.test')).status, 404);
    assert.equal((await api.call('GET', '/public/domains/allowed?domain=unknown.example.test')).status, 404);
  });

  it('a public inquiry lands in the storefront\'s own business only', async () => {
    const send = (slug, email) => api.call('POST', `/public/sites/${slug}/inquiries`, { body: { kind: 'Inquiry', name: 'Ada Visitor', email, message: 'I would like a quote.' } });
    assert.equal((await send(slugs.aNew, 'inquiry-a@example.test')).status, 202);
    assert.equal((await send(slugs.b, 'inquiry-b@example.test')).status, 202);
    const rows = (await db.pool.query('SELECT "BusinessId","Email" FROM "Inquiries" ORDER BY "Email"')).rows;
    assert.deepEqual(rows.map((r) => [r.Email, r.BusinessId]), [['inquiry-a@example.test', A.businessId], ['inquiry-b@example.test', B.businessId]]);
    const unknown = await send('no-such-shop', 'inquiry-x@example.test');
    assert.equal(unknown.status, 404);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "Inquiries"')).rows[0].n, 2);
  });

  it('the quotation link and the privacy request link work with the customer\'s token and reject any other', async () => {
    const locationId = await firstLocationId(db, A.businessId);
    const { customerId } = await confirmedOrder(api, db, A, locationId, 'rlsq');
    const email = (await db.pool.query(`SELECT "TextBody" FROM "EmailOutbox" WHERE "BusinessId" = $1 AND "TemplateKey" = 'quotation_sent' ORDER BY "CreatedAtUtc" DESC LIMIT 1`, [A.businessId])).rows[0];
    const token = /customer-portal#([A-Za-z0-9_-]+)/.exec(email.TextBody)?.[1];
    assert.ok(token);
    const listed = await api.call('POST', '/api/customer-portal/privacy-requests/list', { body: { token } });
    assert.equal(listed.status, 200, listed.text);
    const created = await api.call('POST', '/api/customer-portal/privacy-requests', { body: { token, type: 'Export', note: 'Please send me a copy.' } });
    assert.equal(created.status, 201, created.text);
    const again = await api.call('POST', '/api/customer-portal/privacy-requests', { body: { token, type: 'Export' } });
    assert.equal(again.status, 200, again.text);
    const staff = await api.call('GET', `/api/customers/${customerId}/privacy-requests`, { token: A.token });
    assert.equal(staff.status, 200, staff.text);
    assert.match(staff.text, /Export/);
    const foreign = await api.call('GET', `/api/customers/${customerId}/privacy-requests`, { token: B.token });
    assert.ok([200, 404].includes(foreign.status));
    assert.doesNotMatch(foreign.text, /Export/);
    const stranger = randomBytes(32).toString('base64url');
    for (const [path, body] of [['/api/customer-portal/quotations', { token: stranger }], ['/api/customer-portal/privacy-requests/list', { token: stranger }]]) {
      const rejected = await api.call('POST', path, { body });
      assert.equal(rejected.status, 401, path);
      assert.equal(rejected.body.code, 'portal_link_invalid');
    }
  });

  it('a calendar feed shows only its own worker\'s business, and a revoked or unknown feed is 404', async () => {
    const locationId = await firstLocationId(db, A.businessId);
    const membership = async (owner) => (await db.pool.query(`SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = (SELECT "Id" FROM "AspNetUsers" WHERE "Email" = $2)`, [owner.businessId, owner.email])).rows[0].Id;
    const membershipA = await membership(A);
    const membershipB = await membership(B);
    await db.pool.query('INSERT INTO "MembershipLocations" ("MembershipId","LocationId","BusinessId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [membershipA, locationId, A.businessId]);
    const appointment = async (owner, membershipId, type, notes) => {
      const customer = await api.call('POST', '/api/customers', { token: owner.token, body: { fullName: `${type} customer`, email: `${type.toLowerCase()}-${randomBytes(3).toString('hex')}@example.test` } });
      assert.equal(customer.status, 201, customer.text);
      const start = new Date(Date.now() + 4 * 86_400_000);
      const created = await api.call('POST', '/api/appointments', { token: owner.token, body: {
        type, customerId: customer.body.id, locationId: await firstLocationId(db, owner.businessId), assignedMembershipId: membershipId,
        startAt: start.toISOString(), endAt: new Date(start.getTime() + 45 * 60_000).toISOString(), notes } });
      assert.equal(created.status, 201, created.text);
    };
    await appointment(A, membershipA, 'Fitting', 'a-fitting-note');
    await appointment(B, membershipB, 'Delivery', 'b-secret-note');
    const feed = await api.call('POST', `/api/workers/${membershipA}/schedule/calendar-feed`, { token: A.token });
    assert.equal(feed.status, 201, feed.text);
    const read = await api.call('GET', feed.body.urlPath);
    assert.equal(read.status, 200, read.text);
    assert.match(read.contentType ?? '', /text\/calendar/);
    assert.match(read.text, /Fitting appointment/);
    assert.doesNotMatch(read.text, /Delivery appointment|b-secret-note/);
    assert.doesNotMatch(read.text, /a-fitting-note/, 'appointment notes must not appear in a calendar feed');
    // The feed list shows metadata only (never the link), is scoped to the business, and shows revocation.
    const listed = await api.call('GET', `/api/workers/${membershipA}/schedule/calendar-feeds`, { token: A.token });
    assert.equal(listed.status, 200, listed.text);
    const mine = listed.body.find((item) => item.id === feed.body.id);
    assert.ok(mine, 'the new feed is listed');
    assert.equal(mine.revokedAtUtc, null);
    assert.ok(mine.lastUsedAtUtc, 'reading the feed records its last use');
    assert.doesNotMatch(JSON.stringify(listed.body), /token|hash|\.ics/i);
    const foreignList = await api.call('GET', `/api/workers/${membershipA}/schedule/calendar-feeds`, { token: B.token });
    assert.ok([403, 404].includes(foreignList.status), `got ${foreignList.status}`);
    assert.equal((await api.call('GET', `/api/calendar-feeds/${randomBytes(32).toString('base64url')}.ics`)).status, 404);
    assert.equal((await api.call('GET', '/api/calendar-feeds/short.ics')).status, 404);
    // Another business cannot revoke this feed; its owner can.
    const foreignRevoke = await api.call('DELETE', `/api/workers/${membershipA}/schedule/calendar-feed/${feed.body.id}`, { token: B.token });
    assert.ok([403, 404].includes(foreignRevoke.status), `got ${foreignRevoke.status}`);
    assert.equal((await api.call('GET', feed.body.urlPath)).status, 200);
    assert.equal((await api.call('DELETE', `/api/workers/${membershipA}/schedule/calendar-feed/${feed.body.id}`, { token: A.token })).status, 204);
    assert.equal((await api.call('GET', feed.body.urlPath)).status, 404);
    const afterRevoke = await api.call('GET', `/api/workers/${membershipA}/schedule/calendar-feeds`, { token: A.token });
    assert.equal(afterRevoke.status, 200, afterRevoke.text);
    assert.ok(afterRevoke.body.find((item) => item.id === feed.body.id)?.revokedAtUtc, 'a revoked feed shows when it was revoked');
  });

  it('analytics consent and page views are recorded per storefront and a token is not valid on another site', async () => {
    for (const owner of [A, B]) {
      const enabled = await api.call('PUT', '/api/business/storefront-analytics/settings', { token: owner.token, body: { enabled: true } });
      assert.equal(enabled.status, 200, enabled.text);
    }
    const consent = await api.call('POST', `/api/storefront-analytics/${slugs.aNew}/consent`, { body: { version: 2, decision: 'accepted' } });
    assert.equal(consent.status, 202, consent.text);
    assert.equal(consent.body.recorded, true);
    const token = consent.body.consentToken;
    assert.ok(token);
    const view = await api.call('POST', `/api/storefront-analytics/${slugs.aNew}/event`, { body: { type: 'page_view', path: '/', consentToken: token } });
    assert.equal(view.status, 202, view.text);
    assert.equal(view.body.collected, true);
    const elsewhere = await api.call('POST', `/api/storefront-analytics/${slugs.b}/event`, { body: { type: 'page_view', path: '/', consentToken: token } });
    assert.equal(elsewhere.status, 403);
    assert.equal(elsewhere.body.code, 'consent_required');
    assert.equal((await api.call('POST', '/api/storefront-analytics/no-such-shop/consent', { body: { version: 2, decision: 'accepted' } })).status, 404);
    const revoked = await api.call('POST', `/api/storefront-analytics/${slugs.aNew}/consent`, { body: { version: 2, decision: 'rejected', consentToken: token } });
    assert.equal(revoked.status, 202, revoked.text);
    const afterRevoke = await api.call('POST', `/api/storefront-analytics/${slugs.aNew}/event`, { body: { type: 'page_view', path: '/', consentToken: token } });
    assert.equal(afterRevoke.status, 403);
  });

  it('ready-to-wear checkout reserves stock in the storefront\'s business only and replays idempotently', async () => {
    await db.pool.query(`UPDATE "PlatformFeatureFlags" SET "Enabled" = TRUE WHERE "Key" = 'ready_to_wear_checkout'`);
    const designA = await insertDesign(A.businessId);
    const designB = await insertDesign(B.businessId);
    const variant = async (businessId, designId) => {
      const id = randomUUID();
      await db.pool.query(`INSERT INTO "ReadyToWearVariants" ("Id","BusinessId","DesignId","SKU","OnHand","Reserved") VALUES ($1,$2,$3,$4,5,0)`, [id, businessId, designId, `SKU-${randomBytes(3).toString('hex')}`]);
      return id;
    };
    const variantA = await variant(A.businessId, designA);
    const variantB = await variant(B.businessId, designB);
    const stock = async (id) => (await db.pool.query('SELECT "OnHand","Reserved" FROM "ReadyToWearVariants" WHERE "Id" = $1', [id])).rows[0];
    const listing = await api.call('GET', `/api/public/sites/${slugs.aNew}/ready-to-wear`);
    assert.equal(listing.status, 200, listing.text);
    assert.ok(!listing.text.includes(variantB), 'another business\'s variant must not be listed');
    const key = `idem-${randomUUID()}`;
    const body = { customerName: 'Ada Buyer', email: 'ada@example.test', items: [{ variantId: variantA, quantity: 2 }] };
    const first = await api.call('POST', `/api/public/sites/${slugs.aNew}/ready-to-wear/checkout`, { body, headers: { 'idempotency-key': key } });
    assert.equal(first.status, 201, first.text);
    assert.match(first.body.authorizationUrl, /^https:\/\/pay\.example\.test\/avzar_rtw_/);
    assert.deepEqual(await stock(variantA), { OnHand: 5, Reserved: 2 });
    const replay = await api.call('POST', `/api/public/sites/${slugs.aNew}/ready-to-wear/checkout`, { body, headers: { 'idempotency-key': key } });
    assert.equal(replay.status, 201, replay.text);
    assert.deepEqual(await stock(variantA), { OnHand: 5, Reserved: 2 });
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM "ReadyToWearOrders" WHERE "BusinessId" = $1', [A.businessId])).rows[0].n, 1);
    // A variant of another business cannot be bought through this storefront, and nothing is reserved.
    const crossed = await api.call('POST', `/api/public/sites/${slugs.aNew}/ready-to-wear/checkout`, {
      body: { ...body, items: [{ variantId: variantB, quantity: 1 }] }, headers: { 'idempotency-key': `idem-${randomUUID()}` } });
    assert.ok(crossed.status >= 400 && crossed.status < 500, `got ${crossed.status}: ${crossed.text}`);
    assert.deepEqual(await stock(variantB), { OnHand: 5, Reserved: 0 });
    const unknown = await api.call('POST', '/api/public/sites/no-such-shop/ready-to-wear/checkout', { body, headers: { 'idempotency-key': `idem-${randomUUID()}` } });
    assert.equal(unknown.status, 404);
  });

  it('the public media lookup returns a public design image and nothing else', async () => {
    const reads = [];
    const storage = { openRead: async (key) => { reads.push(key); return Readable.from([Buffer.from('image-bytes')]); } };
    const open = (id, variant = 'md') => runWithTenantRlsContext(() => openMedia(role.pool, storage, null, id, variant, true));
    const publicDesign = await insertDesign(A.businessId);
    const privateDesign = await insertDesign(B.businessId, { visibility: 'Private' });
    const publicAsset = await insertAsset(A.businessId);
    const privateAsset = await insertAsset(B.businessId);
    const photoAsset = await insertAsset(A.businessId, 'TaskProgressPhoto');
    await attach(publicDesign, publicAsset, A.businessId);
    await attach(privateDesign, privateAsset, B.businessId);
    await attach(publicDesign, photoAsset, A.businessId);
    const file = await open(publicAsset);
    assert.equal(file.contentType, 'image/webp');
    assert.deepEqual(reads, [`${hex(A.businessId)}/${hex(publicAsset)}/md.webp`]);
    const notFound = (error) => { assert.equal(error.code, 'media_not_found'); return true; };
    await assert.rejects(() => open(privateAsset), notFound);
    await assert.rejects(() => open(photoAsset), notFound);
    await assert.rejects(() => open(randomUUID()), notFound);
    await assert.rejects(() => open(publicAsset, 'huge'), notFound);
    assert.equal(reads.length, 1, 'storage must be read only for the public image');
  });
});
