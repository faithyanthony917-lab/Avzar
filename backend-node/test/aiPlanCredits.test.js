import test from 'node:test';
import assert from 'node:assert/strict';
import { generateStructuredTextDraft } from '../src/auth/aiService.js';

const draftJson = JSON.stringify({ title: 'Tailored outfit', shortDescription: 'A tailored outfit.', longDescription: 'A tailored outfit made for your occasion.', highlights: ['Custom fit', 'Classic style'], seoTitle: 'Tailored outfit', seoDescription: 'A tailored outfit for your occasion.' });
function fixture(limit) {
  let used = 0;
  const pool = { query: async (sql, values = []) => {
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: values[1] === 'ai.credits.daily' ? String(limit) : 'true' }] };
    if (sql.includes('INSERT INTO "UsageCounters"')) {
      if (used >= values[2]) return { rows: [] };
      used += 1; return { rows: [{ PeriodStartUtc: '2026-10-20T00:00:00Z' }] };
    }
    if (sql.includes('UPDATE "UsageCounters"')) { used = Math.max(0, used - 1); return { rows: [] }; }
    return { rows: [] };
  } };
  const provider = { isConfigured: () => true, textModel: 'test-fake', completeText: async () => draftJson };
  return { pool, provider, used: () => used };
}
const user = { businessId: 'business-1' };
const env = {};
const request = { type: 'product_description', context: 'Cotton kaftan', businessType: 'Tailor' };

test('AI draft daily credits enforce all plan limits (0, 5, 100, 300)', async () => {
  for (const limit of [0, 5, 100, 300]) {
    const f = fixture(limit);
    for (let index = 0; index < limit; index += 1) {
      const result = await generateStructuredTextDraft(f.pool, env, f.provider, user, request);
      assert.equal(result.applied, false);
    }
    assert.equal(f.used(), limit, `consumed ${limit} credits`);
    await assert.rejects(() => generateStructuredTextDraft(f.pool, env, f.provider, user, request), (error) => error.code === 'plan_limit_reached');
    assert.equal(f.used(), limit, `did not exceed ${limit} credits`);
  }
});

test('a failed provider call gives the daily credit back; an unusable provider answer keeps it', async () => {
  const failing = fixture(5);
  failing.provider.completeText = async () => { throw new Error('provider down'); };
  await assert.rejects(() => generateStructuredTextDraft(failing.pool, env, failing.provider, user, request), /provider down/);
  assert.equal(failing.used(), 0, 'credit returned after the provider failed');

  // The provider did the work but returned text that is not a valid draft: the request was served, so the credit stays used.
  const invalid = fixture(5);
  invalid.provider.completeText = async () => '{"unexpected":true}';
  await assert.rejects(() => generateStructuredTextDraft(invalid.pool, env, invalid.provider, user, request), (error) => error.code === 'ai_provider_response_invalid');
  assert.equal(invalid.used(), 1, 'credit kept when the provider answered but the draft was unusable');
});
