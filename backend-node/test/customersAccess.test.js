import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';

const env = {
  NODE_ENV: 'test',
  PORT: 8081,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api',
  JWT_AUDIENCE: 'avzar-mobile',
  ACCESS_TOKEN_MINUTES: 10,
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
    return { status: response.status, body, text, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function bearerToken(userId = '00000000-0000-4000-8000-000000000001', businessId = '00000000-0000-4000-8000-000000000002', sessionId = '00000000-0000-4000-8000-000000000003') {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId, sessionId }).token;
}

const tenantOwner = {
  UserId: '00000000-0000-4000-8000-000000000001',
  BusinessId: '00000000-0000-4000-8000-000000000002',
  Email: 'owner@example.test',
  FullName: 'Owner',
  BusinessName: 'Shop',
  TimeZoneId: 'UTC',
  CurrencyCode: 'USD',
  IsOwner: true,
  Permissions: [],
};

function authenticatedPool(domainQuery) {
  async function query(sql, values) {
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM "Memberships"')) return { rows: [tenantOwner] };
    return domainQuery(sql, values);
  }
  return { query, async connect() { return { query, release() {} }; } };
}

describe('customers and measurements', () => {
  it('rejects customer access without customers.view permission', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['orders.view'] }] };
        return { rows: [] };
      },
    };

    const response = await requestApp(createApp(env, pool), '/api/customers', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'forbidden');
  });

  it('allows customers and measurement templates to be listed and created with the correct permissions', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: ['customers.view', 'customers.manage', 'customers.merge', 'measurements.templates', 'measurements.record'] }] };
        if (sql.includes('count(*)::int AS "TotalCount"')) return { rows: [{ TotalCount: 0 }] };
        if (sql.includes('INSERT INTO "Customers"')) return { rows: [{
          Id: values[0], FullName: values[2], Email: values[3], Phone: values[5], AddressLine: values[7],
          City: values[8], Notes: values[9], GarmentPreferences: values[10], Status: 'Active',
          MergedIntoCustomerId: null, Version: 1, CreatedAtUtc: new Date('2025-01-01T00:00:00.000Z'),
        }] };
        if (sql.includes('INSERT INTO "MeasurementTemplates"')) return { rows: [{
          Id: values[0], Name: values[2], Description: values[3], IsActive: values[4],
        }] };
        return { rows: [] };
      },
      connect: async () => ({ query: pool.query, release() {} }),
    };

    const customers = await requestApp(createApp(env, pool), '/api/customers', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(customers.status, 200);
    assert.deepEqual(customers.body.items, []);
    assert.equal(customers.body.totalCount, 0);

    const createCustomer = await requestApp(createApp(env, pool), '/api/customers', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'Nia Adebayo', email: 'nia@example.test', phone: '+2348000000000' }),
    });
    assert.equal(createCustomer.status, 201);
    assert.equal(createCustomer.body.fullName, 'Nia Adebayo');
    assert.equal(createCustomer.body.version, 1);

    const templates = await requestApp(createApp(env, pool), '/api/measurement-templates', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(templates.status, 200);
    assert.equal(Array.isArray(templates.body), true);

    const createTemplate = await requestApp(createApp(env, pool), '/api/measurement-templates', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Classic Shirt', fields: [{ key: 'chest', label: 'Chest', unit: 'cm', isRequired: true }] }),
    });
    assert.equal(createTemplate.status, 201);
    assert.equal(createTemplate.body.name, 'Classic Shirt');
    assert.deepEqual(createTemplate.body.fields.map((field) => field.key), ['chest']);
  });

  it('returns same-business duplicate candidates instead of inserting silently', async () => {
    let inserted = false;
    const pool = authenticatedPool(async (sql) => {
      if (sql.includes('FROM "Customers"') && sql.includes('"NormalizedEmail" = $2')) {
        return { rows: [{
          Id: '00000000-0000-4000-8000-000000000010',
          FullName: 'Existing Customer',
          Email: 'nia@example.test',
          Phone: null,
          NormalizedEmail: 'nia@example.test',
          NormalizedPhone: null,
        }] };
      }
      if (sql.includes('INSERT INTO "Customers"')) inserted = true;
      return { rows: [] };
    });
    const response = await requestApp(createApp(env, pool), '/api/customers', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'Nia Adebayo', email: 'NIA@example.test' }),
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'possible_duplicate');
    assert.equal(response.body.candidates[0].matchedOn, 'email');
    assert.equal(inserted, false);
  });

  it('hides customers outside the active business', async () => {
    let customerQuery;
    const pool = authenticatedPool(async (sql, values) => {
      if (sql.includes('FROM "Customers"') && sql.includes('"Id" = $2')) {
        customerQuery = { sql, values };
        return { rows: [] };
      }
      return { rows: [] };
    });
    const response = await requestApp(createApp(env, pool), '/api/customers/00000000-0000-4000-8000-000000000010', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'customer_not_found');
    assert.match(customerQuery.sql, /"BusinessId" = \$1 AND "Id" = \$2/);
    assert.equal(customerQuery.values[0], tenantOwner.BusinessId);
  });

  it('rejects customer updates with a stale xmin version', async () => {
    const pool = authenticatedPool(async (sql) => {
      if (sql.includes('SELECT') && sql.includes('FROM "Customers"') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          Id: '00000000-0000-4000-8000-000000000010',
          FullName: 'Nia Adebayo',
          Email: 'nia@example.test',
          Phone: null,
          AddressLine: null,
          City: null,
          Notes: null,
          GarmentPreferences: null,
          Status: 'Active',
          MergedIntoCustomerId: null,
          NormalizedEmail: 'nia@example.test',
          NormalizedPhone: null,
          Version: 8,
          CreatedAtUtc: new Date('2025-01-01T00:00:00.000Z'),
        }] };
      }
      return { rows: [] };
    });
    const response = await requestApp(createApp(env, pool), '/api/customers/00000000-0000-4000-8000-000000000010', {
      method: 'PUT',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'Nia Adebayo', email: 'nia@example.test', version: 7 }),
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'stale_version');
  });

  it('validates measurement values against the tenant template before writing', async () => {
    let revisionWritten = false;
    const pool = authenticatedPool(async (sql) => {
      if (sql.includes('FROM "Customers"') && sql.includes('FOR SHARE')) return { rows: [{ Status: 'Active' }] };
      if (sql.includes('FROM "MeasurementTemplates"')) {
        return { rows: [{
          Id: '00000000-0000-4000-8000-000000000020',
          Name: 'Classic Shirt',
          IsActive: true,
          Key: 'chest',
          Label: 'Chest',
          Unit: 'cm',
          MinValue: '20',
          MaxValue: '200',
          IsRequired: true,
          SortOrder: 0,
        }] };
      }
      if (sql.includes('INSERT INTO "MeasurementRevisions"')) revisionWritten = true;
      return { rows: [] };
    });
    const response = await requestApp(createApp(env, pool), '/api/customers/00000000-0000-4000-8000-000000000010/measurements', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: '00000000-0000-4000-8000-000000000020',
        label: 'First fitting',
        values: { chest: 10 },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_measurements');
    assert.equal(revisionWritten, false);
  });

  it('creates a measurement set and its initial revision atomically', async () => {
    const statements = [];
    const pool = authenticatedPool(async (sql) => {
      statements.push(sql);
      if (sql.includes('FROM "Customers"') && sql.includes('FOR SHARE')) return { rows: [{ Status: 'Active' }] };
      if (sql.includes('FROM "MeasurementTemplates"')) {
        return { rows: [{
          Id: '00000000-0000-4000-8000-000000000020',
          Name: 'Classic Shirt',
          IsActive: true,
          Key: 'chest',
          Label: 'Chest',
          Unit: 'cm',
          MinValue: '20',
          MaxValue: '200',
          IsRequired: true,
          SortOrder: 0,
        }] };
      }
      return { rows: [] };
    });
    const response = await requestApp(createApp(env, pool), '/api/customers/00000000-0000-4000-8000-000000000010/measurements', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: '00000000-0000-4000-8000-000000000020',
        label: 'First fitting',
        values: { chest: 42.5 },
      }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.currentRevision, 1);
    assert.deepEqual(response.body.values, [{ key: 'chest', label: 'Chest', unit: 'cm', value: 42.5 }]);
    assert.ok(statements.some((sql) => sql.includes('INSERT INTO "MeasurementSets"')));
    assert.ok(statements.some((sql) => sql.includes('INSERT INTO "MeasurementRevisions"')));
    assert.ok(statements.some((sql) => sql.includes('INSERT INTO "AuditLogs"')));
  });
});
