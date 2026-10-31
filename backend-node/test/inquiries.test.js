import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

const userId = '00000000-0000-4000-8000-000000000001';
const businessId = '00000000-0000-4000-8000-000000000002';
const otherBusinessId = '00000000-0000-4000-8000-000000000020';
const inquiryId = '00000000-0000-4000-8000-000000000003';
const designId = '00000000-0000-4000-8000-000000000004';
const locationId = '00000000-0000-4000-8000-000000000007';
const otherLocationId = '00000000-0000-4000-8000-000000000008';
const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    return { status: response.status, body };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function bearer(permissions = ['inquiries.view', 'inquiries.manage']) {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId, sessionId: '00000000-0000-4000-8000-000000000005' }).token;
}

function makePool({ permissions = ['inquiries.view', 'inquiries.manage'], site = true, workflowInquiry = true, design = true, detail = true } = {}) {
  const statements = [];
  const inquiry = {
    Id: inquiryId, Kind: 'Inquiry', Status: 'New', Name: 'Jane Doe', Email: 'jane@example.test', Phone: null,
    Message: 'I would like a custom dress.', DesignId: null, DesignNameSnapshot: null, GarmentType: null, Budget: null,
    PreferredDate: null, EventDate: null, ConvertedOrderId: null, InternalNote: null,
    CreatedAtUtc: '2026-10-17T10:00:00.000Z', HandledAtUtc: null,
  };
    const query = async (sql, values = []) => {
      statements.push({ sql, values });
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Memberships"')) return { rows: [{
        UserId: userId, BusinessId: businessId, Email: 'staff@example.test', FullName: 'Staff',
        BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: permissions,
      }] };
    if (sql.includes('FROM "Storefronts"')) return { rows: site ? [{
      Id: '00000000-0000-4000-8000-000000000006', BusinessId: businessId,
      WorkflowInquiry: workflowInquiry, WorkflowBooking: false, WorkflowCustomOrder: false, WorkflowContact: true,
    }] : [] };
    if (sql.includes('FROM "Designs"')) return { rows: design ? [{ Name: 'Evening dress' }] : [] };
    if (sql.includes('SELECT count(*)::int AS "Count"')) return { rows: [{ Count: 0 }] };
    if (sql.includes('SELECT count(*)::int AS "TotalCount"')) return { rows: [{ TotalCount: 1 }] };
    if (sql.includes('SELECT "Status", count(*)::int AS "Count"')) return { rows: [{ Status: 'New', Count: 1 }] };
    if (sql.includes('FROM "Inquiries"') && sql.includes('"Message"')) return { rows: detail ? [inquiry] : [] };
    if (sql.includes('FROM "Inquiries"') && sql.includes('SELECT "Id", "Status"')) return { rows: detail ? [{ Id: inquiryId, Status: 'New' }] : [] };
    if (sql.includes('UPDATE "Inquiries"')) return { rows: [{ ...inquiry, Status: values[2], InternalNote: values[3], HandledAtUtc: '2026-10-18T10:00:00.000Z' }] };
    return { rows: [], rowCount: 1 };
  };
  return {
    statements,
    query,
    async connect() {
      return {
        query: async (sql, values = []) => {
          statements.push({ sql, values });
          if (sql.includes('FROM "Memberships" m') && sql.includes('NotificationPreferences')) return { rows: [{
            Id: '00000000-0000-4000-8000-000000000099', DisplayName: 'Staff', Email: null,
            TimeZoneId: 'UTC', QuietHoursEnabled: false, InAppEnabled: true, EmailEnabled: false, PushEnabled: false,
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
          if (sql.includes('SELECT "Id", "Status" FROM "Inquiries"')) return { rows: detail ? [{ Id: inquiryId, Status: 'New' }] : [] };
          if (sql.includes('UPDATE "Inquiries"')) return { rows: [{ ...inquiry, Status: values[2], InternalNote: values[3] }] };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
  };
}

function conversionPool({ permissions = ['inquiries.manage'], inquiryBusiness = businessId, allowedLocation = locationId, planLimit = '10' } = {}) {
  const statements = [];
  const createdOrders = [];
  let inquiryStatus = 'New';
  let createdCustomerId = null;
  const inquiry = {
    Id: inquiryId, Status: 'New', Name: 'Jane Doe', Email: 'jane@example.test', Phone: null,
    Message: 'Please make a custom dress.', DesignId: null, DesignNameSnapshot: null, GarmentType: 'Dress',
  };
  const query = async (sql, values = []) => {
    statements.push({ sql, values });
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Memberships"')) return { rows: [{
        UserId: userId, BusinessId: businessId, Email: 'staff@example.test', FullName: 'Staff',
        BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: permissions,
      }] };
    if (sql.includes('FROM "MembershipLocations"')) return { rows: allowedLocation ? [{ LocationId: allowedLocation }] : [] };
    return { rows: [] };
  };
  return {
    statements, createdOrders,
    query,
    async connect() {
      return {
        async query(sql, values = []) {
          statements.push({ sql, values });
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('FROM "Inquiries"') && sql.includes('FOR UPDATE')) {
            return { rows: inquiryBusiness === businessId ? [{ ...inquiry, Status: inquiryStatus }] : [] };
          }
          if (sql.includes('FROM "Customers"') && sql.includes('"NormalizedEmail"')) {
            return { rows: createdCustomerId ? [{ Id: createdCustomerId }] : [] };
          }
          if (sql.includes('"MembershipLocations"')) return { rows: allowedLocation ? [{ LocationId: allowedLocation }] : [] };
          if (sql.includes('FROM "Locations"')) return { rows: values[1] === locationId ? [{ '?column?': 1 }] : [] };
          if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: planLimit }] };
          if (sql.includes('SELECT count(*)::bigint AS "Count" FROM "Customers"')) return { rows: [{ Count: 0 }] };
          if (sql.trimStart().startsWith('INSERT INTO "Customers"')) {
            createdCustomerId = values[0];
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT "Id", "Status" FROM "Customers"')) {
            return { rows: createdCustomerId ? [{ Id: createdCustomerId, Status: 'Active' }] : [] };
          }
          if (sql.trimStart().startsWith('INSERT INTO "UsageCounters"')) return { rows: planLimit === '0' ? [] : [{ Count: 1 }] };
          if (sql.includes('FROM "UsageCounters"')) return { rows: [{ Count: 0 }] };
          if (sql.includes('FROM "Orders"') && sql.includes('"IdempotencyKey"')) return { rows: [] };
          if (sql.includes('FROM "Businesses"') && sql.includes('"Today"')) return { rows: [{ CurrencyCode: 'USD', Today: '2026-10-18' }] };
          if (sql.trimStart().startsWith('INSERT INTO "OrderCounters"')) return { rows: [{ LastValue: 1 }] };
          if (sql.trimStart().startsWith('INSERT INTO "Orders"')) {
            createdOrders.push({ id: values[0], idempotencyKey: values[15] });
            return { rows: [], rowCount: 1 };
          }
          if (sql.trimStart().startsWith('INSERT INTO "OrderGarments"')) return { rows: [], rowCount: 1 };
          if (sql.trimStart().startsWith('INSERT INTO "AuditLogs"')) return { rows: [], rowCount: 1 };
          if (sql.includes('FROM "Orders" o JOIN "Customers"')) return { rows: [{
            Id: createdOrders.at(-1)?.id, OrderNumber: 'ORD-2026-00001', Status: 'Draft', CustomerId: createdCustomerId,
            CustomerName: 'Jane Doe', LocationId: locationId, PromisedDate: '2026-11-01', Priority: 'Normal',
            DeliveryMethod: 'Collection', CurrencyCode: 'USD', Subtotal: '125.50', Discount: '0.00', Total: '125.50', Version: 1,
          }] };
          if (sql.includes('FROM "OrderGarments"')) return { rows: [{
            Id: '00000000-0000-4000-8000-000000000009', LineNumber: 1, Name: 'Dress', Quantity: 1,
            UnitPrice: '125.50', LineTotal: '125.50',
          }] };
          if (sql.includes('FROM "ProductionTasks"')) return { rows: [] };
          if (sql.trimStart().startsWith('UPDATE "Inquiries"')) {
            inquiryStatus = 'Converted';
            return { rows: [{
              Id: inquiryId, Kind: 'Inquiry', Status: inquiryStatus, Name: inquiry.Name, Email: inquiry.Email, Phone: inquiry.Phone,
              Message: inquiry.Message, DesignId: null, DesignNameSnapshot: null, GarmentType: inquiry.GarmentType, Budget: null,
              PreferredDate: null, EventDate: null, ConvertedOrderId: values[2], InternalNote: null,
              CreatedAtUtc: '2026-10-17T10:00:00.000Z', HandledAtUtc: '2026-10-18T10:00:00.000Z',
            }] };
          }
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
  };
}

describe('public inquiry submission', () => {
  const valid = { name: 'Jane Doe', email: 'jane@example.test', message: 'I would like a custom dress.' };

  it('accepts a valid inquiry and stores it against the published site business', async () => {
    const pool = makePool();
    const result = await requestApp(createApp(env, pool), '/public/sites/shop/inquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
    });
    assert.equal(result.status, 202);
    assert.equal(result.body.received, true);
    const insert = pool.statements.find(({ sql }) => sql.includes('INSERT INTO "Inquiries"'));
    assert.ok(insert);
    assert.equal(insert.values[1], businessId);
    assert.equal(insert.values[3], 'Inquiry');
    assert.equal(insert.values[4], 'Jane Doe');
    const notice = pool.statements.find(({ sql }) => sql.includes('INSERT INTO "NotificationOutbox"'));
    assert.equal(notice.values[1], businessId);
    assert.equal(notice.values[3], 'inquiries');
    assert.equal(notice.values[4], 'inquiry.new');
    assert.equal(notice.values[8], insert.values[0]);
  });

  it('silently drops honeypot submissions and rejects invalid or uncontactable requests', async () => {
    const botPool = makePool();
    const bot = await requestApp(createApp(env, botPool), '/public/sites/shop/inquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...valid, website: 'bot-value' }),
    });
    assert.equal(bot.status, 202);
    assert.equal(botPool.statements.some(({ sql }) => sql.includes('INSERT INTO "Inquiries"')), false);

    const invalid = await requestApp(createApp(env, makePool()), '/public/sites/shop/inquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...valid, kind: 'Unknown' }),
    });
    assert.equal(invalid.status, 400);

    const noContact = await requestApp(createApp(env, makePool()), '/public/sites/shop/inquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jane Doe', message: 'Please contact me.' }),
    });
    assert.equal(noContact.status, 400);
    assert.equal(noContact.body.code, 'contact_required');
  });

  it('requires a published site, an enabled workflow, and a public same-business design', async () => {
    const missingSite = await requestApp(createApp(env, makePool({ site: false })), '/public/sites/shop/inquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
    });
    assert.equal(missingSite.status, 404);

    const disabled = await requestApp(createApp(env, makePool({ workflowInquiry: false })), '/public/sites/shop/inquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
    });
    assert.equal(disabled.status, 409);

    const unknownDesign = await requestApp(createApp(env, makePool({ design: false })), '/public/sites/shop/inquiries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...valid, designId }),
    });
    assert.equal(unknownDesign.status, 400);
    assert.equal(unknownDesign.body.code, 'unknown_design');
  });

  it('limits public inquiry submissions to five per minute per client', async () => {
    const app = createApp(env, makePool());
    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(await requestApp(app, '/public/sites/shop/inquiries', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid),
      }));
    }
    assert.deepEqual(responses.map((response) => response.status), [202, 202, 202, 202, 202, 429]);
  });
});

describe('public storefront rendering', () => {
  it('renders only visible content from the published version snapshot', async () => {
    const pageId = '00000000-0000-4000-8000-000000000010';
    const hiddenPageId = '00000000-0000-4000-8000-000000000011';
    const pool = {
      async query(sql) {
        if (sql.includes('FROM "Storefronts" s')) return { rows: [{
          Name: 'Atelier', Slug: 'atelier', BusinessId: businessId, ContactEmail: 'hello@example.test',
          ContactPhone: null, Address: null, OpeningHours: null, WorkflowInquiry: true, WorkflowBooking: false,
          WorkflowCustomOrder: false, WorkflowContact: true, AllowSearchIndexing: true, VersionNumber: 2,
          BusinessName: 'Tailor Shop', CurrencyCode: 'USD',
          DocumentJson: {
            schemaVersion: 1, templateKey: 'standard', theme: { preset: 'clean-professional' }, branding: {},
            archive: [{ id: 'private-archive' }],
            pages: [
              { id: pageId, kind: 'home', slug: '', title: 'Home', visible: true, seo: {}, sections: [
                { id: 'visible-section', visible: true }, { id: 'hidden-section', visible: false },
              ] },
              { id: hiddenPageId, kind: 'custom', slug: 'draft-page', title: 'Hidden', visible: false, sections: [] },
            ],
            navigation: [
              { label: 'Home', pageId, visible: true },
              { label: 'Draft', pageId: hiddenPageId, visible: true },
              { label: 'Hidden nav', pageId, visible: false },
            ],
          },
        }] };
        return { rows: [] };
      },
    };
    const result = await requestApp(createApp(env, pool), '/public/sites/atelier');
    assert.equal(result.status, 200);
    assert.equal(result.body.versionNumber, 2);
    assert.equal(result.body.isPreview, false);
    assert.equal(result.body.businessName, 'Tailor Shop');
    assert.deepEqual(result.body.workflows, ['inquiry', 'contact']);
    assert.deepEqual(result.body.document.archive, []);
    assert.deepEqual(result.body.document.pages.map((page) => page.id), [pageId]);
    assert.deepEqual(result.body.document.pages[0].sections.map((section) => section.id), ['visible-section']);
    assert.deepEqual(result.body.document.navigation.map((item) => item.label), ['Home']);
    assert.equal(result.body.theme.headingFont, 'Montserrat');
  });

  it('does not expose a draft-only storefront', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const result = await requestApp(createApp(env, pool), '/public/sites/not-published');
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'site_not_found');
  });
});

describe('authenticated inquiry management', () => {
  it('pages same-business inquiries, returns summary and detail, and audits status changes', async () => {
    const pool = makePool();
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const list = await requestApp(createApp(env, pool), '/api/inquiries?page=1&pageSize=10', { headers });
    assert.equal(list.status, 200);
    assert.equal(list.body.totalCount, 1);
    assert.equal(list.body.items[0].name, 'Jane Doe');

    const summary = await requestApp(createApp(env, pool), '/api/inquiries/summary', { headers });
    assert.deepEqual(summary.body, { new: 1, reviewed: 0, converted: 0, rejected: 0 });

    const detail = await requestApp(createApp(env, pool), `/api/inquiries/${inquiryId}`, { headers });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.id, inquiryId);

    const update = await requestApp(createApp(env, pool), `/api/inquiries/${inquiryId}`, {
      method: 'PUT', headers, body: JSON.stringify({ status: 'Reviewed', internalNote: 'Called customer.' }),
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.status, 'Reviewed');
    assert.ok(pool.statements.some(({ sql }) => sql.includes("'inquiry.updated'")));
  });

  it('denies unauthenticated and unauthorized access and hides cross-business inquiry ids', async () => {
    const missingAuth = await requestApp(createApp(env, makePool()), '/api/inquiries');
    assert.equal(missingAuth.status, 401);

    const forbidden = await requestApp(createApp(env, makePool({ permissions: ['customers.view'] })), '/api/inquiries', {
      headers: { authorization: `Bearer ${bearer(['customers.view'])}` },
    });
    assert.equal(forbidden.status, 403);

    const crossBusiness = await requestApp(createApp(env, makePool({ detail: false })), `/api/inquiries/${inquiryId}`, {
      headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(crossBusiness.status, 404);
  });

  it('converts an inquiry into one draft order with the C# request and response shape', async () => {
    const pool = conversionPool();
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const result = await requestApp(createApp(env, pool), `/api/inquiries/${inquiryId}/convert`, {
      method: 'POST', headers,
      body: JSON.stringify({ locationId, promisedDate: '2026-11-01', unitPrice: 125.5 }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'Converted');
    assert.equal(result.body.convertedOrderId, pool.createdOrders[0].id);
    assert.equal(pool.createdOrders.length, 1);
    assert.equal(pool.createdOrders[0].idempotencyKey, `inquiry-${inquiryId.replaceAll('-', '')}`);
    assert.ok(pool.statements.some(({ sql }) => sql === 'BEGIN'));
    assert.ok(pool.statements.some(({ sql }) => sql.trimStart().startsWith('INSERT INTO "UsageCounters"')));

    const retry = await requestApp(createApp(env, pool), `/api/inquiries/${inquiryId}/convert`, {
      method: 'POST', headers,
      body: JSON.stringify({ locationId, promisedDate: '2026-11-01', unitPrice: 125.5 }),
    });
    assert.equal(retry.status, 409);
    assert.equal(retry.body.code, 'not_convertible');
    assert.equal(pool.createdOrders.length, 1);
  });

  it('validates conversion input and enforces authentication, permission, tenant, and location scope', async () => {
    const path = `/api/inquiries/${inquiryId}/convert`;
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const invalid = await requestApp(createApp(env, conversionPool()), path, {
      method: 'POST', headers, body: JSON.stringify({ locationId, promisedDate: '2026-02-30', unitPrice: 1.001 }),
    });
    assert.equal(invalid.status, 400);

    const unauthenticated = await requestApp(createApp(env, conversionPool()), path, {
      method: 'POST', headers: { authorization: 'Bearer invalid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ locationId, promisedDate: '2026-11-01', unitPrice: 1 }),
    });
    assert.equal(unauthenticated.status, 401);

    const forbidden = await requestApp(createApp(env, conversionPool({ permissions: ['inquiries.view'] })), path, {
      method: 'POST', headers: { ...headers, authorization: `Bearer ${bearer(['inquiries.view'])}` },
      body: JSON.stringify({ locationId, promisedDate: '2026-11-01', unitPrice: 1 }),
    });
    assert.equal(forbidden.status, 403);

    const crossBusiness = await requestApp(createApp(env, conversionPool({ inquiryBusiness: otherBusinessId })), path, {
      method: 'POST', headers, body: JSON.stringify({ locationId, promisedDate: '2026-11-01', unitPrice: 1 }),
    });
    assert.equal(crossBusiness.status, 404);

    const crossLocation = await requestApp(createApp(env, conversionPool({ allowedLocation: otherLocationId })), path, {
      method: 'POST', headers, body: JSON.stringify({ locationId, promisedDate: '2026-11-01', unitPrice: 1 }),
    });
    assert.equal(crossLocation.status, 403);
    assert.equal(crossLocation.body.code, 'location_forbidden');
  });

  it('honors the monthly order plan limit without leaving a partial conversion', async () => {
    const pool = conversionPool({ planLimit: '0' });
    const result = await requestApp(createApp(env, pool), `/api/inquiries/${inquiryId}/convert`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ locationId, promisedDate: '2026-11-01', unitPrice: 125.5 }),
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'plan_limit_reached');
    assert.equal(pool.createdOrders.length, 0);
    assert.equal(pool.statements.some(({ sql }) => sql.trimStart().startsWith('UPDATE "Inquiries"')), false);
    assert.ok(pool.statements.some(({ sql }) => sql === 'ROLLBACK'));
  });
});