import { describe, it } from 'node:test';
import { AppError } from '../src/http/errors.js';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { createBillingProvider } from '../src/auth/billingProvider.js';
import { toMinorUnits } from '../src/auth/subscriptionBillingService.js';

const USER = '00000000-0000-4000-8000-000000000001';
const BIZ_A = '00000000-0000-4000-8000-0000000000a1';
const BIZ_B = '00000000-0000-4000-8000-0000000000b2';
const SESSION = '00000000-0000-4000-8000-000000000003';
const PLAN_ID = '00000000-0000-4000-8000-000000000008';
const SECRET = 'sk_test_secret';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters', JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
  BILLING_PAYSTACK_SECRET_KEY: SECRET, AI_DAILY_LIMIT_PER_BUSINESS: 2,
};

const token = (businessId = BIZ_A) => issueAccessToken({ jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER, jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: 10 }, { userId: USER, businessId, sessionId: SESSION }).token;
const auth = (businessId) => ({ authorization: `Bearer ${token(businessId)}`, 'content-type': 'application/json' });
const ANON = { authorization: 'Bearer invalid', 'content-type': 'application/json' };
const sign = (raw, secret = SECRET) => createHmac('sha512', secret).update(raw).digest('hex');

async function call(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, init);
    const text = await response.text();
    let body = text; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

/** Stateful fake Postgres covering only what slice 5 touches. */
function makePool({ permissions = [], flags = {}, plan = {}, email = 'owner@example.test', existingPayment } = {}) {
  const state = { payments: new Map(), subscription: null, usage: new Map(), subscriptionUpdates: 0, usageReleases: 0, mediaInserts: 0 };
  if (existingPayment) state.payments.set(existingPayment.ProviderReference, { Id: 'pay-1', BusinessId: BIZ_A, PlanId: PLAN_ID, BillingPeriod: 'monthly', Amount: '5000.00', CurrencyCode: 'NGN', Status: 'Pending', ...existingPayment });
  const planRow = { Id: PLAN_ID, Code: 'starter', CurrencyCode: 'NGN', MonthlyPrice: '5000.00', AnnualPrice: '50000.00', ...plan };
  const byId = (id) => [...state.payments.values()].find((p) => p.Id === id);
  async function query(sql, values = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: USER, BusinessId: values[1], Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'NGN', IsOwner: false, Permissions: permissions }] };
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: flags[values[1]] ?? values[2] }] };
    if (sql.includes('FROM "Plans" WHERE "Code"')) return { rows: values[0] === planRow.Code || values[0] === 'free' ? [values[0] === 'free' ? { ...planRow, Code: 'free' } : planRow] : [] };
    if (sql.includes('FROM "Businesses"')) return { rows: [{ ContactEmail: email }] };
    if (sql.includes('INSERT INTO "SubscriptionPayments"')) {
      state.payments.set(values[5], { Id: values[0], BusinessId: values[1], PlanId: values[2], BillingPeriod: values[3], Amount: values[4], CurrencyCode: 'NGN', ProviderReference: values[5], Status: 'Pending' });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM "SubscriptionPayments" WHERE "ProviderReference"')) { const p = state.payments.get(values[0]); return { rows: p ? [{ ...p }] : [] }; }
    if (sql.includes('FROM "SubscriptionPayments" WHERE "Id"') && sql.includes('FOR UPDATE')) { const p = byId(values[0]); return { rows: p ? [{ ...p }] : [] }; }
    if (sql.includes(`UPDATE "SubscriptionPayments" SET "Status" = 'Failed'`)) { const p = byId(values[0]); if (p?.Status === 'Pending') p.Status = 'Failed'; return { rows: [], rowCount: 1 }; }
    if (sql.includes(`UPDATE "SubscriptionPayments" SET "Status" = 'Paid'`)) { byId(values[0]).Status = 'Paid'; return { rows: [], rowCount: 1 }; }
    if (sql.includes('UPDATE "Subscriptions"')) { state.subscriptionUpdates += 1; state.subscription = { BusinessId: values[0], PlanId: values[1], interval: values[2] }; return { rows: [], rowCount: 1 }; }
    if (sql.includes('INSERT INTO "UsageCounters"')) {
      const key = `${values[0]}:${values[1]}`; const used = state.usage.get(key) ?? 0;
      if (used >= values[2]) return { rows: [] };
      state.usage.set(key, used + 1); return { rows: [{ PeriodStartUtc: '2026-10-18T00:00:00Z' }] };
    }
    if (sql.includes('UPDATE "UsageCounters"')) { const key = `${values[0]}:${values[1]}`; state.usage.set(key, Math.max((state.usage.get(key) ?? 0) - 1, 0)); state.usageReleases += 1; return { rows: [] }; }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('"UsedBytes"')) return { rows: [{ UsedBytes: '0' }] };
    if (sql.includes('INSERT INTO "MediaAssets"')) { state.mediaInserts += 1; return { rows: [{ Id: values[0], Purpose: values[4], OriginalFileName: values[3], Width: values[8], Height: values[2], SizeBytes: values[6], CreatedAtUtc: new Date().toISOString() }] }; }
    return { rows: [] };
  }
  return { query, async connect() { return { query, release() {} }; }, state };
}

const fakeBilling = ({ verify, initialize, configured = true } = {}) => {
  const real = createBillingProvider(configured ? env : { ...env, BILLING_PAYSTACK_SECRET_KEY: undefined });
  const calls = { initialize: [], verify: [] };
  return { ...real, calls,
    initialize: initialize ?? (async (args) => { calls.initialize.push(args); return { authorizationUrl: 'https://pay.example.test/' + args.reference }; }),
    verify: async (reference) => { calls.verify.push(reference); return verify ? verify(reference) : { status: 'success', reference, currency: 'NGN', amountMinor: 500000 }; } };
};
const fakeAi = ({ text = '{}', fail = false, configured = true } = {}) => {
  const calls = { image: 0, text: 0 };
  return { calls, imageModel: 'fake-image', isConfigured: () => configured,
    async generateImage() { calls.image += 1; if (fail) throw new AppError(502, 'ai_provider_error', 'x'); return { base64Png: PNG_1X1 }; },
    async completeText() { calls.text += 1; return text; } };
};
const design = { garmentType: 'Agbada', occasion: 'Wedding', style: 'Modern', fabric: 'Aso oke', colours: 'Gold', details: 'Embroidery' };
const assistant = { businessType: 'Tailor', audience: 'Brides', brandStyle: 'Elegant', goals: 'Bookings', existingContent: 'About us' };
const post = (app, path, body, headers) => call(app, path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('toMinorUnits', () => {
  it('converts numeric strings without floating point', () => {
    assert.equal(toMinorUnits('5000.00'), 500000);
    assert.equal(toMinorUnits('0.1'), 10);
    assert.equal(toMinorUnits('19.995'), 2000);
    assert.equal(toMinorUnits('-1'), null);
    assert.equal(toMinorUnits('abc'), null);
  });
});

describe('POST /api/billing/subscription/checkout', () => {
  const url = '/api/billing/subscription/checkout';
  const body = { planCode: 'starter', billingPeriod: 'monthly' };
  it('creates a pending payment from the DB price and returns the C# response shape', async () => {
    const pool = makePool({ permissions: ['business.settings'] }); const billing = fakeBilling();
    const res = await post(createApp(env, pool, { billingProvider: billing }), url, { ...body, amount: 1, businessId: BIZ_B }, auth());
    assert.equal(res.status, 200);
    assert.equal(res.body.amount, 5000); assert.equal(res.body.currencyCode, 'NGN');
    assert.match(res.body.reference, /^avz_[0-9a-f]{32}$/); assert.ok(res.body.authorizationUrl.startsWith('https://pay.example.test/'));
    assert.equal(billing.calls.initialize[0].amountMinor, 500000);
    const payment = pool.state.payments.get(res.body.reference);
    assert.equal(payment.BusinessId, BIZ_A); // token business, never the client-supplied one
  });
  it('rejects validation failures, free plan, unknown plan and missing email', async () => {
    const app = (opts) => createApp(env, makePool({ permissions: ['business.settings'], ...opts }), { billingProvider: fakeBilling() });
    assert.equal((await post(app(), url, { planCode: 'starter', billingPeriod: 'weekly' }, auth())).body.code, 'invalid_billing_period');
    assert.equal((await post(app(), url, {}, auth())).body.code, 'invalid_billing_period');
    assert.equal((await post(app(), url, { planCode: 'free', billingPeriod: 'monthly' }, auth())).body.code, 'free_plan_checkout');
    assert.equal((await post(app(), url, { planCode: 'nope', billingPeriod: 'monthly' }, auth())).status, 404);
    assert.equal((await post(app({ plan: { CurrencyCode: 'USD' } }), url, body, auth())).body.code, 'unsupported_billing_currency');
    assert.equal((await post(app({ plan: { MonthlyPrice: '0.00' } }), url, body, auth())).body.code, 'invalid_plan_price');
    assert.equal((await post(app({ email: '' }), url, body, auth())).body.code, 'billing_email_required');
  });
  it('is 401 unauthenticated, 403 without business.settings, 503 when the provider is not configured', async () => {
    const pool = makePool({ permissions: [] });
    assert.equal((await post(createApp(env, pool, { billingProvider: fakeBilling() }), url, body, ANON)).status, 401);
    assert.equal((await post(createApp(env, pool, { billingProvider: fakeBilling() }), url, body, auth())).status, 403);
    const ok = makePool({ permissions: ['business.settings'] });
    assert.equal((await post(createApp(env, ok, { billingProvider: fakeBilling({ configured: false }) }), url, body, auth())).body.code, 'billing_provider_not_configured');
  });
  it('marks the payment Failed and returns 502 when the provider fails', async () => {
    const pool = makePool({ permissions: ['business.settings'] });
    const res = await post(createApp(env, pool, { billingProvider: fakeBilling({ initialize: async () => { throw new Error('down'); } }) }), url, body, auth());
    assert.equal(res.status, 502); assert.equal(res.body.code, 'billing_provider_error');
    assert.equal([...pool.state.payments.values()][0].Status, 'Failed');
  });
});

describe('POST /api/billing/subscription/webhook', () => {
  const url = '/api/billing/subscription/webhook';
  const reference = 'avz_ref1';
  const event = JSON.stringify({ event: 'charge.success', data: { reference } });
  const send = (app, raw, signature) => call(app, url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': signature }, body: raw });
  it('activates the plan once for a valid, verified event and ignores replays', async () => {
    const pool = makePool({ existingPayment: { ProviderReference: reference } }); const billing = fakeBilling();
    const app = createApp(env, pool, { billingProvider: billing });
    assert.equal((await send(app, event, sign(event))).status, 200);
    assert.equal(pool.state.payments.get(reference).Status, 'Paid');
    assert.equal(pool.state.subscription.PlanId, PLAN_ID); assert.equal(pool.state.subscription.interval, '1 month');
    assert.equal((await send(app, event, sign(event))).status, 200);
    assert.equal(pool.state.subscriptionUpdates, 1); assert.equal(billing.calls.verify.length, 1);
  });
  it('uses a one-year interval for annual payments', async () => {
    const pool = makePool({ existingPayment: { ProviderReference: reference, BillingPeriod: 'annual' } });
    await send(createApp(env, pool, { billingProvider: fakeBilling() }), event, sign(event));
    assert.equal(pool.state.subscription.interval, '1 year');
  });
  it('rejects bad, wrong-secret and missing signatures without touching the database', async () => {
    const pool = makePool({ existingPayment: { ProviderReference: reference } }); const app = createApp(env, pool, { billingProvider: fakeBilling() });
    assert.equal((await send(app, event, 'deadbeef')).status, 401);
    assert.equal((await send(app, event, sign(event, 'other-secret'))).status, 401);
    assert.equal((await send(app, event, '')).status, 401);
    assert.equal((await send(app, event + ' ', sign(event))).status, 401); // signature is over the exact raw bytes
    assert.equal(pool.state.payments.get(reference).Status, 'Pending'); assert.equal(pool.state.subscriptionUpdates, 0);
  });
  it('returns the C# status codes for other events, unknown references and provider problems', async () => {
    const other = JSON.stringify({ event: 'charge.failed', data: { reference } });
    const missing = JSON.stringify({ event: 'charge.success', data: {} });
    const unknown = JSON.stringify({ event: 'charge.success', data: { reference: 'avz_unknown' } });
    const pool = makePool({ existingPayment: { ProviderReference: reference } });
    const app = createApp(env, pool, { billingProvider: fakeBilling() });
    assert.equal((await send(app, other, sign(other))).status, 200);
    assert.equal((await send(app, missing, sign(missing))).status, 400);
    assert.equal((await send(app, unknown, sign(unknown))).status, 404);
    const down = createApp(env, makePool({ existingPayment: { ProviderReference: reference } }), { billingProvider: fakeBilling({ verify: async () => { throw new Error('down'); } }) });
    assert.equal((await send(down, event, sign(event))).status, 502);
    assert.equal((await send(createApp(env, makePool(), { billingProvider: fakeBilling({ configured: false }) }), event, sign(event))).status, 503);
  });
  it('never grants a plan when the provider-verified amount or currency differs', async () => {
    for (const verified of [{ status: 'success', reference, currency: 'NGN', amountMinor: 100 }, { status: 'success', reference, currency: 'USD', amountMinor: 500000 }, { status: 'failed', reference, currency: 'NGN', amountMinor: 500000 }]) {
      const pool = makePool({ existingPayment: { ProviderReference: reference } });
      assert.equal((await send(createApp(env, pool, { billingProvider: fakeBilling({ verify: async () => verified }) }), event, sign(event))).status, 400);
      assert.equal(pool.state.payments.get(reference).Status, 'Failed'); assert.equal(pool.state.subscriptionUpdates, 0);
    }
  });
});

describe('AI routes', () => {
  const routes = [['/api/ai/fashion-design', 'designs.manage', 'ai.fashion_design', design], ['/api/ai/assistant-builder', 'storefront.edit', 'ai.assistant_builder', assistant]];
  for (const [path, permission, flag, valid] of routes) {
    it(`${path}: 401 unauthenticated, 403 without ${permission}, 403 feature_not_in_plan`, async () => {
      const ai = fakeAi({ text: JSON.stringify({ suggestedAssistantName: 'A', systemInstructions: 'B', greeting: 'C', suggestedPrompts: 'D' }) });
      assert.equal((await post(createApp(env, makePool({ permissions: [permission], flags: { [flag]: 'true' } }), { aiProvider: ai }), path, valid, ANON)).status, 401);
      assert.equal((await post(createApp(env, makePool({ permissions: [], flags: { [flag]: 'true' } }), { aiProvider: ai }), path, valid, auth())).status, 403);
      const denied = await post(createApp(env, makePool({ permissions: [permission] }), { aiProvider: ai }), path, valid, auth());
      assert.equal(denied.status, 403); assert.equal(denied.body.code, 'feature_not_in_plan'); assert.equal(ai.calls.image + ai.calls.text, 0);
    });
    it(`${path}: validates every field and reports 503 when AI is not configured`, async () => {
      const mk = (aiOpts) => createApp(env, makePool({ permissions: [permission], flags: { [flag]: 'true' } }), { aiProvider: fakeAi(aiOpts) });
      const first = Object.keys(valid)[0];
      for (const bad of [{ ...valid, [first]: '' }, { ...valid, [first]: '   ' }, { ...valid, [first]: 'x'.repeat(2001) }, { ...valid, [first]: 5 }, {}]) {
        const res = await post(mk(), path, bad, auth()); assert.equal(res.status, 400); assert.equal(res.body.code, 'invalid_ai_request');
      }
      assert.equal((await post(mk({ configured: false }), path, valid, auth())).body.code, 'ai_not_configured');
    });
  }
  it('fashion-design returns prompt, model and a PNG data URL', async () => {
    const res = await post(createApp(env, makePool({ permissions: ['designs.manage'], flags: { 'ai.fashion_design': 'true' } }), { aiProvider: fakeAi() }), '/api/ai/fashion-design', design, auth());
    assert.equal(res.status, 200); assert.equal(res.body.model, 'fake-image'); assert.ok(res.body.prompt.includes('Agbada')); assert.equal(res.body.imageDataUrl, 'data:image/png;base64,' + PNG_1X1);
  });
  it('enforces the per-business daily limit, isolates businesses and refunds failed provider calls', async () => {
    const pool = makePool({ permissions: ['designs.manage'], flags: { 'ai.fashion_design': 'true' } }); const ai = fakeAi();
    const app = createApp(env, pool, { aiProvider: ai });
    assert.equal((await post(app, '/api/ai/fashion-design', design, auth(BIZ_A))).status, 200);
    assert.equal((await post(app, '/api/ai/fashion-design', design, auth(BIZ_A))).status, 200);
    const limited = await post(app, '/api/ai/fashion-design', design, auth(BIZ_A));
    assert.equal(limited.status, 403); assert.equal(limited.body.code, 'plan_limit_reached'); assert.equal(ai.calls.image, 2);
    assert.equal((await post(app, '/api/ai/fashion-design', design, auth(BIZ_B))).status, 200); // other business has its own counter
    const failing = makePool({ permissions: ['designs.manage'], flags: { 'ai.fashion_design': 'true' } });
    const bad = await post(createApp(env, failing, { aiProvider: fakeAi({ fail: true }) }), '/api/ai/fashion-design', design, auth());
    assert.equal(bad.status, 502); assert.equal(failing.state.usage.get(`${BIZ_A}:ai.requests`), 0); assert.equal(failing.state.usageReleases, 1);
  });
  it('does not let concurrent requests exceed the limit', async () => {
    const pool = makePool({ permissions: ['designs.manage'], flags: { 'ai.fashion_design': 'true' } }); const ai = fakeAi();
    const app = createApp(env, pool, { aiProvider: ai });
    const results = await Promise.all(Array.from({ length: 6 }, () => post(app, '/api/ai/fashion-design', design, auth())));
    assert.equal(results.filter((r) => r.status === 200).length, 2); assert.equal(ai.calls.image, 2);
  });
  it('assistant-builder returns the parsed configuration and rejects malformed provider output', async () => {
    const reply = { suggestedAssistantName: 'Ada', systemInstructions: 'Be helpful', greeting: 'Hi', suggestedPrompts: 'Prices?' };
    const mk = (text) => createApp(env, makePool({ permissions: ['storefront.edit'], flags: { 'ai.assistant_builder': 'true' } }), { aiProvider: fakeAi({ text }) });
    const ok = await post(mk(JSON.stringify(reply)), '/api/ai/assistant-builder', assistant, auth());
    assert.equal(ok.status, 200); assert.deepEqual(ok.body, reply);
    for (const text of ['not json', JSON.stringify({ ...reply, suggestedPrompts: ['a'] }), JSON.stringify({ greeting: 'Hi' })]) {
      const bad = await post(mk(text), '/api/ai/assistant-builder', assistant, auth()); assert.equal(bad.status, 502); assert.equal(bad.body.code, 'ai_provider_response_invalid');
    }
  });
  it('structured text drafts validate all five output types and never apply changes automatically', async () => {
    const cases = [
      ['product_description', { title: 'Linen Day Shirt', shortDescription: 'A relaxed linen shirt.', longDescription: 'A relaxed-fit shirt for everyday wear.', highlights: ['Relaxed fit', 'Button front'], seoTitle: 'Linen Day Shirt', seoDescription: 'A relaxed linen shirt for everyday wear.' }],
      ['collection_names', { suggestions: [{ name: 'Everyday Linen', rationale: 'Highlights the fabric and daily wear.' }, { name: 'Soft Structure', rationale: 'Suggests a relaxed, polished silhouette.' }, { name: 'Warm Weather Edit', rationale: 'Frames the collection for warm days.' }] }],
      ['customer_reply', { subject: 'Re: Your order', message: 'Thanks for checking in. I will confirm the latest status and update you shortly.', tone: 'professional', factsToConfirm: ['Current order status', 'Expected completion date'] }],
      ['report_explanation', { summary: 'The supplied figures show more late orders this week.', keyFindings: ['Late orders increased from 2 to 5.'], caveats: ['Only two weeks of data were supplied.'], recommendedChecks: ['Review the deadlines and task completion dates.'] }],
      ['scheduling_risk', { riskLevel: 'high', summary: 'Three jobs depend on one worker who is already fully booked.', risks: ['No spare capacity is listed.'], suggestedActions: ['Review priorities and confirm capacity before changing assignments.'] }],
    ];
    for (const [type, draft] of cases) {
      const app = createApp(env, makePool({ permissions: ['storefront.edit'], flags: { 'ai.assistant_builder': 'true' } }), { aiProvider: fakeAi({ text: JSON.stringify(draft) }) });
      const ok = await post(app, '/api/ai/text-assistant/drafts', { type, context: 'Use only this supplied summary; no live record access.' }, auth(BIZ_A));
      assert.equal(ok.status, 200, `${type}: ${JSON.stringify(ok.body)}`);
      assert.equal(ok.body.type, type); assert.deepEqual(ok.body.result, draft); assert.equal(ok.body.applied, false);
    }
    const malformed = await post(createApp(env, makePool({ permissions: ['storefront.edit'], flags: { 'ai.assistant_builder': 'true' } }), { aiProvider: fakeAi({ text: JSON.stringify({ title: 'Linen', highlights: 'not-an-array' }) }) }), '/api/ai/text-assistant/drafts', { type: 'product_description', context: 'Linen shirt' }, auth(BIZ_A));
    assert.equal(malformed.status, 502); assert.equal(malformed.body.code, 'ai_provider_response_invalid');
    const invalidInput = await post(createApp(env, makePool({ permissions: ['storefront.edit'], flags: { 'ai.assistant_builder': 'true' } }), { aiProvider: fakeAi({ text: '{}' }) }), '/api/ai/text-assistant/drafts', { type: 'unknown', context: 'Linen shirt' }, auth(BIZ_A));
    assert.equal(invalidInput.status, 400); assert.equal(invalidInput.body.code, 'invalid_ai_request');
    const noEntitlement = await post(createApp(env, makePool({ permissions: ['storefront.edit'], flags: {} }), { aiProvider: fakeAi({ text: '{}' }) }), '/api/ai/text-assistant/drafts', { type: 'product_description', context: 'Linen shirt' }, auth(BIZ_A));
    assert.equal(noEntitlement.status, 403); assert.equal(noEntitlement.body.code, 'feature_not_in_plan');
    const isolatedPool = makePool({ permissions: ['storefront.edit'], flags: { 'ai.assistant_builder': 'true' } });
    const isolatedApp = createApp(env, isolatedPool, { aiProvider: fakeAi({ text: JSON.stringify(cases[0][1]) }) });
    const requestDraft = (businessId) => post(isolatedApp, '/api/ai/text-assistant/drafts', { type: 'product_description', context: 'Linen shirt' }, auth(businessId));
    assert.equal((await requestDraft(BIZ_A)).status, 200);
    assert.equal((await requestDraft(BIZ_A)).status, 200);
    assert.equal((await requestDraft(BIZ_A)).status, 403); // business A exhausted its plan credits
    assert.equal((await requestDraft(BIZ_B)).status, 200); // business B has an independent credit counter
  });
  it('fashion-design/save validates input, enforces permission and plan, and stores a verified image for the caller business', async () => {
    const path = '/api/ai/fashion-design/save'; const valid = { imageDataUrl: 'data:image/png;base64,' + PNG_1X1, fileName: 'look.png' };
    const stored = []; const storage = { async put(key) { stored.push(key); }, async delete() {} };
    const mk = (opts) => { const pool = makePool({ permissions: ['media.manage'], flags: { 'ai.fashion_design': 'true', 'storage.gb.max': '1' }, ...opts }); return [createApp(env, pool, { storage }), pool]; };
    assert.equal((await post(mk()[0], path, valid, ANON)).status, 401);
    assert.equal((await post(mk({ permissions: [] })[0], path, valid, auth())).status, 403);
    assert.equal((await post(mk({ flags: {} })[0], path, valid, auth())).body.code, 'feature_not_in_plan');
    for (const bad of [{ ...valid, fileName: '' }, { ...valid, fileName: 'x'.repeat(121) }, { ...valid, imageDataUrl: 'data:image/jpeg;base64,AAAA' }, { ...valid, imageDataUrl: 'data:image/png;base64,@@@@' }, { ...valid, imageDataUrl: 'data:image/png;base64,' }, {}]) {
      const res = await post(mk()[0], path, bad, auth()); assert.equal(res.status, 400); assert.equal(res.body.code, 'invalid_generated_image');
    }
    const notAnImage = await post(mk()[0], path, { ...valid, imageDataUrl: 'data:image/png;base64,' + Buffer.from('this is not a png').toString('base64') }, auth());
    assert.equal(notAnImage.status, 400);
    const [app, pool] = mk(); const res = await post(app, path, valid, auth(BIZ_A));
    assert.equal(res.status, 200, JSON.stringify(res.body)); assert.equal(pool.state.mediaInserts, 1);
    assert.ok(stored.every((key) => key.startsWith(BIZ_A.replaceAll('-', '') + '/')));
  });
});

describe('billing provider signature check', () => {
  it('accepts only the HMAC-SHA512 of the exact raw body', () => {
    const provider = createBillingProvider(env); const raw = Buffer.from('{"a":1}');
    assert.equal(provider.verifySignature(raw, sign(raw)), true);
    assert.equal(provider.verifySignature(raw, sign(raw).toUpperCase()), true);
    assert.equal(provider.verifySignature(Buffer.from('{"a":2}'), sign(raw)), false);
    assert.equal(provider.verifySignature(raw, ''), false);
    assert.equal(provider.verifySignature(undefined, sign(raw)), false);
  });
});
