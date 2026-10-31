import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { newCsrfToken } from '../src/security/csrf.js';

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

function holidayPool({ owner = true, permissions = ['business.settings'], storedBusinessId = '00000000-0000-4000-8000-000000000002' } = {}) {
  const calls = [];
  async function query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) return { rows: [{
      UserId: values[0], Email: 'owner@example.test', FullName: 'Owner', BusinessId: values[1], BusinessName: 'Shop',
      TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: owner, Permissions: permissions,
    }] };
    return { rows: [], rowCount: 1 };
  }
  return {
    calls,
    query,
    connect: async () => ({
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes('FROM "BusinessHolidays" WHERE "BusinessId" = $1 AND "Date" = $2')) return { rows: [] };
        if (sql.includes('count(*)::int AS "Count" FROM "BusinessHolidays"')) return { rows: [{ Count: 0 }] };
        if (sql.includes('INSERT INTO "BusinessHolidays"')) return { rows: [{ Id: values[0], Date: values[2], Name: values[3] }] };
        if (sql.includes('DELETE FROM "BusinessHolidays"')) return { rows: values[1] === storedBusinessId ? [{ Id: values[0] }] : [] };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  };
}

function brandingPool({ mediaExists = true } = {}) {
  const calls = [];
  const businessRow = { Id: '00000000-0000-4000-8000-000000000002', Name: 'Shop', TimeZoneId: 'UTC', BrandColor: null, LogoMediaId: null, ContactPhone: null, ContactEmail: null, TaxNumber: null, PdfFooterNote: null };
  return {
    calls,
    query: async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('JOIN "AspNetUsers" u ON u."Id" = m."UserId"')) return { rows: [{
        UserId: values[0], Email: 'owner@example.test', FullName: 'Owner', BusinessId: values[1], BusinessName: 'Shop',
        TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: ['business.settings'],
      }] };
      if (sql.includes('FROM "Businesses"')) return { rows: [businessRow] };
      return { rows: [], rowCount: 1 };
    },
    connect: async () => ({
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes('FROM "MediaAssets"')) return { rows: mediaExists ? [{ '?column?': 1 }] : [] };
        if (sql.includes('FROM "Businesses"') && sql.includes('FOR UPDATE')) return { rows: [businessRow] };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  };
}

function putBranding(pool, body) {
  return requestApp(createApp(env, pool), '/api/business/branding', {
    method: 'PUT',
    headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('business settings', () => {
  it('rejects business settings access without the business.settings permission', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
        return { rows: [] };
      },
    };
    const response = await requestApp(createApp(env, pool), '/api/business/branding', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'forbidden');
  });

  it('allows business.settings to read branding and schedule data', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: ['business.settings'] }] };
        if (sql.includes('FROM "Businesses"')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000002', Name: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD' }] };
        return { rows: [] };
      },
    };

    const branding = await requestApp(createApp(env, pool), '/api/business/branding', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(branding.status, 200);
    assert.equal(branding.body.businessId, '00000000-0000-4000-8000-000000000002');

    const schedule = await requestApp(createApp(env, pool), '/api/business/schedule', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(schedule.status, 200);
    assert.equal(schedule.body.timeZoneId, 'UTC');
  });

  it('creates tenant-scoped holidays and rejects invalid dates', async () => {
    const pool = holidayPool();
    const created = await requestApp(createApp(env, pool), '/api/business/schedule/holidays', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-25', name: '  Christmas  ' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.date, '2026-12-25');
    assert.equal(created.body.name, 'Christmas');
    const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO "BusinessHolidays"'));
    assert.equal(insert.values[1], '00000000-0000-4000-8000-000000000002');

    const invalid = await requestApp(createApp( env, holidayPool()), '/api/business/schedule/holidays', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-02-30', name: 'Invalid date' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'validation_failed');
  });

  it('requires authentication and business.settings to create a holiday', async () => {
    const csrf = newCsrfToken(env.JWT_SIGNING_KEY);
    const unauthenticated = await requestApp(createApp(env, holidayPool()), '/api/business/schedule/holidays', {
      method: 'POST', headers: { cookie: `tailoring.csrf=${csrf}`, 'x-xsrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-25', name: 'Christmas' }),
    });
    assert.equal(unauthenticated.status, 401);

    const forbidden = await requestApp(createApp(env, holidayPool({ owner: false, permissions: ['customers.view'] })), '/api/business/schedule/holidays', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-25', name: 'Christmas' }),
    });
    assert.equal(forbidden.status, 403);
  });

  it('deletes only a holiday belonging to the authenticated business', async () => {
    const pool = holidayPool();
    const deleted = await requestApp(createApp(env, pool), '/api/business/schedule/holidays/00000000-0000-4000-8000-000000000004', {
      method: 'DELETE', headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(deleted.status, 204);

    const otherBusiness = await requestApp(createApp(env, holidayPool()), '/api/business/schedule/holidays/00000000-0000-4000-8000-000000000004', {
      method: 'DELETE', headers: { authorization: `Bearer ${bearerToken('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000022')}` },
    });
    assert.equal(otherBusiness.status, 404);
  });
  it('saves document branding to the business row and audits field names only', async () => {
    const pool = brandingPool();
    const res = await putBranding(pool, { accentColor: '#1f3a5f', phone: '  +234   801 ', email: 'hello@shop.test', taxNumber: '', footerNote: 'Thanks\n for  shopping', logoMediaId: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.accentColor, '#1F3A5F');
    assert.equal(res.body.phone, '+234 801');
    assert.equal(res.body.taxNumber, null);
    assert.equal(res.body.footerNote, 'Thanks for shopping');
    const update = pool.calls.find((call) => call.sql.includes('UPDATE "Businesses"'));
    assert.ok(update, 'expected an UPDATE of Businesses');
    assert.deepEqual(update.values, ['Shop', '#1F3A5F', null, '+234 801', 'hello@shop.test', null, 'Thanks for shopping', '00000000-0000-4000-8000-000000000002']);
    const audit = pool.calls.find((call) => call.sql.includes("'business.branding_updated'"));
    assert.ok(audit, 'expected an audit row');
    const changed = JSON.parse(audit.values[3]).changed;
    assert.deepEqual(changed.sort(), ['accentColor', 'email', 'footerNote', 'phone']);
    assert.ok(!audit.values[3].includes('hello@shop.test'));
  });

  it('rejects branding that is too light, too long, malformed, or points at another business image', async () => {
    const light = await putBranding(brandingPool(), { accentColor: '#FFFF00' });
    assert.equal(light.status, 400);
    assert.equal(light.body.code, 'brand_color_too_light');

    const badColor = await putBranding(brandingPool(), { accentColor: 'red' });
    assert.equal(badColor.status, 400);
    assert.equal(badColor.body.code, 'invalid_brand_color');

    const longPhone = await putBranding(brandingPool(), { phone: '1'.repeat(41) });
    assert.equal(longPhone.status, 400);
    assert.equal(longPhone.body.code, 'branding_too_long');

    const badEmail = await putBranding(brandingPool(), { email: 'not-an-email' });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.code, 'invalid_email');

    const foreignLogo = await putBranding(brandingPool({ mediaExists: false }), { logoMediaId: '00000000-0000-4000-8000-000000000009' });
    assert.equal(foreignLogo.status, 404);
    assert.equal(foreignLogo.body.code, 'media_not_found');

    const logoPool = brandingPool();
    await putBranding(logoPool, { logoMediaId: '00000000-0000-4000-8000-000000000009' });
    const logoQuery = logoPool.calls.find((call) => call.sql.includes('FROM "MediaAssets"'));
    assert.ok(logoQuery.sql.includes(`"Purpose" <> 'TaskProgressPhoto'`));
    assert.ok(logoQuery.sql.includes('"TaskProgressPhotos"'));
  });
});
