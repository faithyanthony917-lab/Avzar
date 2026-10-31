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
  return issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES }, { userId, businessId, sessionId }).token;
}

describe('billing and AI', () => {
  it('serves the plan catalog publicly and rejects AI access without its permission', async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
        return { rows: [] };
      },
    };

    const plans = await requestApp(createApp(env, pool), '/api/plans');
    assert.equal(plans.status, 200);
    assert.equal(Array.isArray(plans.body.entitlements), true);
    assert.equal(Array.isArray(plans.body.plans), true);

    const ai = await requestApp(createApp(env, pool), '/api/ai/assistant-builder', { method: 'POST', headers: { authorization: `Bearer ${bearerToken()}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(ai.status, 403);
    assert.equal(ai.body.code, 'forbidden');
  });

  it('serves plans and effective entitlements', async () => {
    const pool = {
      query: async (sql, values = []) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('count(*)::bigint AS "Count" FROM "Memberships"')) return { rows: [{ Count: '1' }] };
        if (sql.includes('count(*)::bigint AS "Count" FROM "Invitations"')) return { rows: [{ Count: '0' }] };
        if (sql.includes('count(*)::bigint AS "Count" FROM "Customers"')) return { rows: [{ Count: '0' }] };
        if (sql.includes('FROM "UsageCounters"')) return { rows: [] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: ['plans.view', 'plans.manage', 'billing.view', 'billing.manage', 'ai.view', 'ai.use'] }] };
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Code: 'free', Name: 'Free', Status: 'Active', Value: values[2] ?? 'false' }] };
        if (sql.includes('FROM "Subscriptions" s')) return { rows: [{ Status: 'Active', PlanId: '00000000-0000-4000-8000-000000000008', Code: 'free', Name: 'Free' }] };
        if (sql.includes('FROM "Plans" WHERE "Code"')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000008', Code: 'free', Name: 'Free' }] };
        if (sql.includes('FROM "Memberships" WHERE "BusinessId"')) return { rows: [{ Count: '1' }] };
        if (sql.includes('FROM "Invitations" WHERE "BusinessId"')) return { rows: [{ Count: '0' }] };
        return { rows: [] };
      },
    };

    const plans = await requestApp(createApp(env, pool), '/api/plans');
    assert.equal(plans.status, 200);
    assert.equal(Array.isArray(plans.body.plans), true);

    const entitlements = await requestApp(createApp(env, pool), '/api/billing/entitlements', { headers: { authorization: `Bearer ${bearerToken()}` } });
    assert.equal(entitlements.status, 200);
    assert.equal(entitlements.body.planCode, 'free');
  });

  it('restricts global plan controls to explicitly configured platform emails', async () => {
    const adminEnv = { ...env, PLATFORM_ADMIN_EMAILS: 'admin@example.test' };
    const pool = { query: async (sql) => {
      if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM "Memberships" m')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', Email: 'owner@example.test', FullName: 'Owner', BusinessId: '00000000-0000-4000-8000-000000000002', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: true, Permissions: [] }] };
      return { rows: [] };
    } };
    const denied = await requestApp(createApp(adminEnv, pool), '/api/platform-admin/plans', { headers: { authorization: `Bearer ${bearerToken()}` } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'platform_admin_required');
  });
});

import { askTextAssistant } from '../src/auth/aiService.js';

describe('Avzar text assistant', () => {
  it('uses only supplied context, includes bounded history, and accounts for AI usage', async () => {
    const statements = [];
    const pool = { query: async (sql, values = []) => {
      statements.push({ sql, values });
      if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: values[1] === 'ai.credits.daily' ? '50' : 'true' }] };
      if (sql.includes('INSERT INTO "UsageCounters"')) return { rows: [{ PeriodStartUtc: '2026-10-19T00:00:00.000Z' }] };
      return { rows: [] };
    } };
    let prompt = '';
    const provider = { isConfigured: () => true, textModel: 'test-text-model', completeText: async (value) => { prompt = value; return 'Start by confirming the delivery date and assigning a responsible worker.'; } };
    const result = await askTextAssistant(pool, { AI_DAILY_LIMIT_PER_BUSINESS: 50 }, provider,
      { businessId: 'business-a' },
      { question: 'How do I reduce delays?', businessType: 'Tailoring workshop', context: 'We have five active custom orders.', history: [{ role: 'user', content: 'I have late orders.' }, { role: 'assistant', content: 'Review each order deadline.' }] });
    assert.equal(result.answer, 'Start by confirming the delivery date and assigning a responsible worker.');
    assert.equal(result.model, 'test-text-model');
    assert.match(prompt, /We have five active custom orders/);
    assert.match(prompt, /User: I have late orders/);
    assert.match(prompt, /How do I reduce delays/);
    assert.equal(statements.some((s) => s.sql.includes('INSERT INTO "UsageCounters"')), true);
  });

  it('rejects an empty question before calling the provider', async () => {
    const pool = { query: async (sql) => sql.includes('FROM "Plans" p') ? { rows: [{ Value: 'true' }] } : { rows: [] } };
    let called = false;
    const provider = { isConfigured: () => true, completeText: async () => { called = true; return 'answer'; } };
    await assert.rejects(() => askTextAssistant(pool, {}, provider, { businessId: 'business-a' }, { question: '  ' }), (error) => error.code === 'invalid_ai_request');
    assert.equal(called, false);
  });
});
