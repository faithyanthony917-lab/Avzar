import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { createPostgresAnalyticsProvider } from '../src/auth/storefrontAnalyticsProvider.js';
import {
  CONSENT_TTL_DAYS, STOREFRONT_CONSENT_VERSION, consentTokenHash, issueConsentToken, normalizeAnalyticsPath, recordPageView, verifyConsentToken,
} from '../src/auth/storefrontAnalyticsService.js';
import { createFakeAnalyticsProvider } from './helpers/fakeAnalyticsProvider.js';

const USER = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-000000000003';
const BIZ_A = '00000000-0000-4000-8000-0000000000a1';
const BIZ_B = '00000000-0000-4000-8000-0000000000b1';
const SITE_A = '00000000-0000-4000-8000-0000000000a2';
const SITE_B = '00000000-0000-4000-8000-0000000000b2';
const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};
const bearer = (businessId) => ({
  authorization: `Bearer ${issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: 10 }, { userId: USER, businessId, sessionId: SESSION }).token}`,
});

async function call(app, method, pathname, { body, headers = {} } = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = text; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: json };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

/** Fake Postgres: two tenants, each with one published storefront. Only what these routes touch. */
function makePool({ permissions = ['business.settings'], enabledA = true, enabledB = true } = {}) {
  const state = {
    businesses: new Map([[BIZ_A, { enabled: enabledA }], [BIZ_B, { enabled: enabledB }]]),
    storefronts: [
      { Id: SITE_A, BusinessId: BIZ_A, Slug: 'atelier-a', Name: 'Atelier A', Status: 'Published' },
      { Id: SITE_B, BusinessId: BIZ_B, Slug: 'atelier-b', Name: 'Atelier B', Status: 'Published' },
    ],
    updates: [], audits: [],
  };
  async function query(rawSql, values = []) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: USER, BusinessId: values[1], Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false, Permissions: permissions }] };
    if (sql.includes('FROM "Storefronts" s LEFT JOIN "StorefrontAnalyticsSettings" a')) {
      const site = state.storefronts.find((row) => row.Slug === values[0] && row.Status === 'Published');
      return { rows: site ? [{ Id: site.Id, BusinessId: site.BusinessId, StorefrontAnalyticsEnabled: state.businesses.get(site.BusinessId).enabled }] : [] };
    }
    if (sql.startsWith('SELECT "Enabled" FROM "StorefrontAnalyticsSettings"')) {
      const business = state.businesses.get(values[0]);
      return { rows: business ? [{ Enabled: business.enabled }] : [] };
    }
    if (sql.startsWith('SELECT "Id", "Name", "Slug" FROM "Storefronts" WHERE "BusinessId" = $1')) {
      return { rows: state.storefronts.filter((row) => row.BusinessId === values[0]).map(({ Id, Name, Slug }) => ({ Id, Name, Slug })) };
    }
    if (sql.startsWith('INSERT INTO "StorefrontAnalyticsSettings"')) {
      state.updates.push({ businessId: values[0], enabled: values[1] });
      const business = state.businesses.get(values[0]);
      if (business) business.enabled = values[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO "AuditLogs"')) { state.audits.push({ action: values[1], actor: values[2], businessId: values[3], details: JSON.parse(values[4]) }); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
  return { query, async connect() { return { query, release() {} }; }, state };
}

const publicUrl = (slug, tail) => `/api/storefront-analytics/${slug}/${tail}`;
const accept = (app, slug = 'atelier-a') => call(app, 'POST', publicUrl(slug, 'consent'), { body: { version: STOREFRONT_CONSENT_VERSION, decision: 'accepted' } });

describe('consent decisions', () => {
  it('records an accepted choice anonymously and hands back a consent token, with no CSRF token needed', async () => {
    const provider = createFakeAnalyticsProvider();
    const res = await accept(createApp(env, makePool(), { analyticsProvider: provider }));
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.recorded, true);
    assert.match(res.body.consentToken, /^2\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(provider.consents, [{ businessId: BIZ_A, storefrontId: SITE_A, version: 2, decision: 'accepted' }]);
  });
  it('revokes a previously accepted grant server-side when the visitor withdraws consent', async () => {
    const provider = createFakeAnalyticsProvider();
    const app = createApp(env, makePool(), { analyticsProvider: provider });
    const { body: { consentToken } } = await accept(app);
    const before = await call(app, 'POST', publicUrl('atelier-a', 'event'), { body: { type: 'page_view', path: '/before', consentToken } });
    assert.equal(before.status, 202);
    const withdrawn = await call(app, 'POST', publicUrl('atelier-a', 'consent'), { body: { version: STOREFRONT_CONSENT_VERSION, decision: 'rejected', consentToken } });
    assert.equal(withdrawn.status, 202);
    const after = await call(app, 'POST', publicUrl('atelier-a', 'event'), { body: { type: 'page_view', path: '/after', consentToken } });
    assert.equal(after.status, 403);
    assert.equal(provider.views.length, 1);
  });
  it('records a rejection without issuing a token', async () => {
    const provider = createFakeAnalyticsProvider();
    const res = await call(createApp(env, makePool(), { analyticsProvider: provider }), 'POST', publicUrl('atelier-a', 'consent'), { body: { version: STOREFRONT_CONSENT_VERSION, decision: 'rejected' } });
    assert.equal(res.status, 202);
    assert.equal(res.body.consentToken, undefined);
    assert.equal(provider.consents[0].decision, 'rejected');
  });
  it('refuses an outdated version, unknown fields and an unknown storefront', async () => {
    const app = createApp(env, makePool(), { analyticsProvider: createFakeAnalyticsProvider() });
    assert.equal((await call(app, 'POST', publicUrl('atelier-a', 'consent'), { body: { version: 0, decision: 'accepted' } })).body.code, 'consent_version_mismatch');
    assert.equal((await call(app, 'POST', publicUrl('atelier-a', 'consent'), { body: { version: STOREFRONT_CONSENT_VERSION, decision: 'accepted', ip: '1.2.3.4' } })).status, 400);
    assert.equal((await call(app, 'POST', publicUrl('nope-nope', 'consent'), { body: { version: STOREFRONT_CONSENT_VERSION, decision: 'accepted' } })).status, 404);
  });
  it('stores nothing and issues no token while the business has analytics switched off', async () => {
    const provider = createFakeAnalyticsProvider();
    const res = await accept(createApp(env, makePool({ enabledA: false }), { analyticsProvider: provider }));
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { recorded: false, analyticsEnabled: false });
    assert.equal(provider.consents.length, 0);
  });
});

describe('page view events', () => {
  const event = (consentToken, path = '/about?utm=x#top') => ({ type: 'page_view', path, consentToken });
  it('accepts an event with a valid consent token and stores only tenant, storefront, UTC day and normalized path', async () => {
    const provider = createFakeAnalyticsProvider();
    const app = createApp(env, makePool(), { analyticsProvider: provider });
    const { body: { consentToken } } = await accept(app);
    const res = await call(app, 'POST', publicUrl('atelier-a', 'event'), { body: event(consentToken) });
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { collected: true });
    assert.equal(provider.views.length, 1);
    assert.deepEqual(Object.keys(provider.views[0]).sort(), ['businessId', 'day', 'path', 'storefrontId'], 'no IP, user agent, referrer or visitor id');
    assert.equal(provider.views[0].path, '/about');
    assert.equal(provider.views[0].businessId, BIZ_A);
    assert.equal(provider.views[0].storefrontId, SITE_A);
    assert.match(provider.views[0].day, /^\d{4}-\d{2}-\d{2}$/);
  });
  it('accepts no event without consent: missing, malformed or tampered token', async () => {
    const provider = createFakeAnalyticsProvider();
    const app = createApp(env, makePool(), { analyticsProvider: provider });
    const { body: { consentToken } } = await accept(app);
    for (const token of ['', 'not-a-token', consentToken.slice(0, -1) + (consentToken.endsWith('A') ? 'B' : 'A'), consentToken.replace(/^2\./, '3.')]) {
      const res = await call(app, 'POST', publicUrl('atelier-a', 'event'), { body: event(token) });
      assert.ok([400, 403].includes(res.status), `token ${token} gave ${res.status}`);
    }
    const missing = await call(app, 'POST', publicUrl('atelier-a', 'event'), { body: { type: 'page_view', path: '/' } });
    assert.equal(missing.status, 400);
    assert.equal(provider.views.length, 0);
  });
  it('rejects an expired token and a token minted for another storefront', async () => {
    const provider = createFakeAnalyticsProvider();
    const pool = makePool();
    const secret = 'unit-test-secret';
    const context = { pool, provider, secret, now: new Date('2026-10-20T10:00:00Z') };
    const expired = issueConsentToken(secret, SITE_A, STOREFRONT_CONSENT_VERSION, new Date(context.now.getTime() - (CONSENT_TTL_DAYS + 1) * 86_400_000));
    await assert.rejects(recordPageView(context, 'atelier-a', event(expired)), { code: 'consent_required' });
    const forOther = issueConsentToken(secret, SITE_B, STOREFRONT_CONSENT_VERSION, context.now);
    await assert.rejects(recordPageView(context, 'atelier-a', event(forOther)), { code: 'consent_required' });
    const valid = issueConsentToken(secret, SITE_A, STOREFRONT_CONSENT_VERSION, context.now);
    await provider.registerConsentToken({ businessId: BIZ_A, storefrontId: SITE_A, version: STOREFRONT_CONSENT_VERSION, tokenHash: consentTokenHash(valid), expiresAt: new Date(context.now.getTime() + CONSENT_TTL_DAYS * 86_400_000) });
    await recordPageView(context, 'atelier-a', event(valid));
    assert.equal(provider.views.length, 1);
    assert.equal(provider.views[0].day, '2026-10-20');
  });
  it('collects nothing while the setting is off, even with a token that was valid earlier', async () => {
    const provider = createFakeAnalyticsProvider();
    const pool = makePool();
    const app = createApp(env, pool, { analyticsProvider: provider });
    const { body: { consentToken } } = await accept(app);
    pool.state.businesses.get(BIZ_A).enabled = false;
    const res = await call(app, 'POST', publicUrl('atelier-a', 'event'), { body: event(consentToken) });
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { collected: false, reason: 'analytics_disabled' });
    assert.equal(provider.views.length, 0);
  });
  it('rejects bad paths and extra fields', async () => {
    const provider = createFakeAnalyticsProvider();
    const app = createApp(env, makePool(), { analyticsProvider: provider });
    const { body: { consentToken } } = await accept(app);
    for (const path of ['about', '//evil.example', '/a/b/c/d/e', '/%00', '/ünï', `/${'a'.repeat(300)}`]) {
      assert.equal((await call(app, 'POST', publicUrl('atelier-a', 'event'), { body: event(consentToken, path) })).status, 400, path);
    }
    assert.equal((await call(app, 'POST', publicUrl('atelier-a', 'event'), { body: { ...event(consentToken), referrer: 'x' } })).status, 400);
    assert.equal(provider.views.length, 0);
  });
});

describe('cross-tenant isolation', () => {
  it('files an event under the storefront owner only and never mixes tenants in a summary', async () => {
    const provider = createFakeAnalyticsProvider();
    const pool = makePool();
    const app = createApp(env, pool, { analyticsProvider: provider });
    for (const slug of ['atelier-a', 'atelier-b']) {
      const { body: { consentToken } } = await accept(app, slug);
      await call(app, 'POST', publicUrl(slug, 'event'), { body: { type: 'page_view', path: slug === 'atelier-a' ? '/' : '/secret-b', consentToken } });
    }
    const summaryA = await call(app, 'GET', '/api/business/storefront-analytics/summary?days=7', { headers: bearer(BIZ_A) });
    assert.equal(summaryA.status, 200);
    assert.equal(summaryA.body.totalViews, 1);
    assert.deepEqual(summaryA.body.topPaths.map((entry) => entry.path), ['/']);
    assert.deepEqual(summaryA.body.storefronts.map((entry) => entry.id), [SITE_A]);
    assert.equal(summaryA.body.consent.accepted, 1);
    const summaryB = await call(app, 'GET', '/api/business/storefront-analytics/summary?days=7', { headers: bearer(BIZ_B) });
    assert.deepEqual(summaryB.body.topPaths.map((entry) => entry.path), ['/secret-b']);
  });
  it('does not accept a consent token from one tenant\'s storefront on another tenant\'s', async () => {
    const provider = createFakeAnalyticsProvider();
    const app = createApp(env, makePool(), { analyticsProvider: provider });
    const { body: { consentToken } } = await accept(app, 'atelier-a');
    const res = await call(app, 'POST', publicUrl('atelier-b', 'event'), { body: { type: 'page_view', path: '/', consentToken } });
    assert.equal(res.status, 403);
    assert.equal(provider.views.length, 0);
  });
  it('refuses a summary filtered to another business\'s storefront', async () => {
    const app = createApp(env, makePool(), { analyticsProvider: createFakeAnalyticsProvider() });
    const res = await call(app, 'GET', `/api/business/storefront-analytics/summary?storefrontId=${SITE_B}`, { headers: bearer(BIZ_A) });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'storefront_not_found');
  });
  it('changes only the caller\'s own business setting', async () => {
    const pool = makePool({ enabledA: false, enabledB: false });
    const app = createApp(env, pool, { analyticsProvider: createFakeAnalyticsProvider() });
    const res = await call(app, 'PUT', '/api/business/storefront-analytics/settings', { body: { enabled: true }, headers: bearer(BIZ_A) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(pool.state.updates, [{ businessId: BIZ_A, enabled: true }]);
    assert.equal(pool.state.businesses.get(BIZ_B).enabled, false);
  });
  it('scopes every query of the first-party provider to the tenant', async () => {
    const calls = [];
    const pool = { async query(sql, values = []) { calls.push({ sql: sql.replace(/\s+/g, ' '), values }); return { rows: [{ Count: 0, Known: false }] }; } };
    const provider = createPostgresAnalyticsProvider(pool);
    await provider.recordPageView({ businessId: BIZ_A, storefrontId: SITE_A, day: '2026-10-20', path: '/' });
    await provider.recordConsent({ businessId: BIZ_A, storefrontId: SITE_A, version: STOREFRONT_CONSENT_VERSION, decision: 'accepted' });
    await provider.summary({ businessId: BIZ_A, storefrontId: null, fromDay: '2026-10-14', toDay: '2026-10-20' });
    assert.ok(calls.length >= 6);
    for (const entry of calls) {
      assert.match(entry.sql, /"BusinessId"/, entry.sql);
      assert.ok(entry.values.includes(BIZ_A), entry.sql);
      assert.ok(!entry.values.includes(BIZ_B));
    }
  });
});

describe('owner settings and summary', () => {
  it('defaults to off and requires business.settings', async () => {
    const pool = makePool({ enabledA: false });
    const app = createApp(env, pool, { analyticsProvider: createFakeAnalyticsProvider() });
    const read = await call(app, 'GET', '/api/business/storefront-analytics/settings', { headers: bearer(BIZ_A) });
    assert.deepEqual(read.body, { enabled: false, consentVersion: STOREFRONT_CONSENT_VERSION });
    const denied = createApp(env, makePool({ permissions: [] }), { analyticsProvider: createFakeAnalyticsProvider() });
    for (const [method, path, body] of [['GET', '/settings'], ['PUT', '/settings', { enabled: true }], ['GET', '/summary']]) {
      assert.equal((await call(denied, method, `/api/business/storefront-analytics${path}`, { body, headers: bearer(BIZ_A) })).status, 403, path);
      assert.equal((await call(denied, method, `/api/business/storefront-analytics${path}`, { body, headers: { authorization: 'Bearer not-a-valid-token' } })).status, 401, path);
    }
  });
  it('writes an audit record when the switch changes and validates the body', async () => {
    const pool = makePool({ enabledA: false });
    const app = createApp(env, pool, { analyticsProvider: createFakeAnalyticsProvider() });
    assert.equal((await call(app, 'PUT', '/api/business/storefront-analytics/settings', { body: { enabled: 'yes' }, headers: bearer(BIZ_A) })).status, 400);
    assert.equal(pool.state.updates.length, 0);
    await call(app, 'PUT', '/api/business/storefront-analytics/settings', { body: { enabled: true }, headers: bearer(BIZ_A) });
    await call(app, 'PUT', '/api/business/storefront-analytics/settings', { body: { enabled: false }, headers: bearer(BIZ_A) });
    assert.deepEqual(pool.state.audits.map((entry) => [entry.action, entry.businessId, entry.actor]), [
      ['storefront_analytics.enabled', BIZ_A, USER], ['storefront_analytics.disabled', BIZ_A, USER]]);
  });
  it('returns a zero-filled daily series for the requested window and rejects other windows', async () => {
    const app = createApp(env, makePool(), { analyticsProvider: createFakeAnalyticsProvider() });
    const res = await call(app, 'GET', '/api/business/storefront-analytics/summary?days=7', { headers: bearer(BIZ_A) });
    assert.equal(res.status, 200);
    assert.equal(res.body.daily.length, 7);
    assert.ok(res.body.daily.every((entry) => entry.views === 0));
    assert.equal(res.body.totalViews, 0);
    assert.equal((await call(app, 'GET', '/api/business/storefront-analytics/summary?days=11', { headers: bearer(BIZ_A) })).body.code, 'invalid_days');
  });
});

describe('helpers', () => {
  it('normalizes storefront paths', () => {
    assert.equal(normalizeAnalyticsPath('/'), '/');
    assert.equal(normalizeAnalyticsPath('/About/?a=1#x'), '/about');
    assert.equal(normalizeAnalyticsPath('/design/Silk-Gown/'), '/design/silk-gown');
    for (const bad of ['', 'x', '//x', '/a/b/c/d/e', '/%00', 5, null]) assert.equal(normalizeAnalyticsPath(bad), null, String(bad));
  });
  it('binds a token to its storefront, version and expiry', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const token = issueConsentToken('k', SITE_A, STOREFRONT_CONSENT_VERSION, now);
    assert.equal(verifyConsentToken('k', token, SITE_A, now), true);
    assert.equal(verifyConsentToken('k', token, SITE_B, now), false);
    assert.equal(verifyConsentToken('other', token, SITE_A, now), false);
    assert.equal(verifyConsentToken('k', token, SITE_A, new Date(now.getTime() + (CONSENT_TTL_DAYS + 1) * 86_400_000)), false);
  });
});
