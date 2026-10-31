import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDatabaseReadiness } from '../src/http/readiness.js';

test('readiness remains false when the database pool is missing', async () => {
  assert.deepEqual(await checkDatabaseReadiness(null), {
    ready: false,
    reason: 'database_not_configured',
  });
});

test('readiness requires a successful PostgreSQL query', async () => {
  const result = await checkDatabaseReadiness({ query: async (sql) => {
    assert.equal(sql, 'SELECT 1');
    return { rows: [{ '?column?': 1 }] };
  } });
  assert.deepEqual(result, { ready: true, reason: null });
});

test('database failures return a safe status without leaking connection details', async () => {
  const result = await checkDatabaseReadiness({ query: async () => { throw new Error('private connection detail'); } });
  assert.deepEqual(result, { ready: false, reason: 'database_unavailable' });
  assert.doesNotMatch(JSON.stringify(result), /private connection detail/);
});
