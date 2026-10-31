// Step-09c: how much the tenant-scoped query wrapper costs. Not a test and not run by `node --test "test/db/**/*.test.js"` (the name has no
// ".test.js"). Run it by hand: DATABASE_URL=... node test/db/rlsLatency.bench.js
// It prints median and p95 in milliseconds for the same read done (1) on a plain pool as the restricted role with no tenant context
// (the query sees nothing, so it is only a round-trip baseline), (2) through the scoped wrapper (BEGIN, set_config, query, COMMIT), and
// (3) three HTTP endpoints. No pass or fail: shared CI runners are too noisy to gate on. Treat the numbers as indicative only.
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { runWithTenantRlsContext, setTenantRlsContext } from '../../src/db/tenantRlsContext.js';
import { createTempDatabase, MIGRATIONS_DIR, quiet } from './helpers.js';
import { signUp, startApp } from './httpHarness.js';
import { createRestrictedAppPool } from './restrictedRole.js';

const url = process.env.DATABASE_URL;
if (!url) { console.log('DATABASE_URL is not set; nothing to measure.'); process.exit(0); }
const N = Number(process.env.RLS_BENCH_ITERATIONS ?? 200);

const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: sorted.length, medianMs: Number(at(0.5).toFixed(2)), p95Ms: Number(at(0.95).toFixed(2)) };
};
async function measure(fn) {
  for (let i = 0; i < 20; i++) await fn(); // warm-up, not counted
  const samples = [];
  for (let i = 0; i < N; i++) { const start = performance.now(); await fn(); samples.push(performance.now() - start); }
  return stats(samples);
}

const db = await createTempDatabase(url, 'avzar_rls_bench');
let role; let api;
try {
  await migrate(db.pool, MIGRATIONS_DIR, quiet);
  await syncPlans(db.pool);
  role = await createRestrictedAppPool(db);
  api = await startApp(role.pool);
  const owner = await signUp(api, 'bench');
  const rows = [];
  const raw = new pg.Pool({ connectionString: role.pool.options.connectionString, max: 1 });
  rows.push(['plain pool, restricted role, no tenant (baseline)', await measure(() => raw.query('SELECT "Id" FROM "Customers" LIMIT 20'))]);
  rows.push(['scoped wrapper, same read', await measure(() => runWithTenantRlsContext(async () => {
    setTenantRlsContext(owner.businessId);
    return role.pool.query('SELECT "Id" FROM "Customers" LIMIT 20');
  }))]);
  const ok = async (path) => { const r = await api.call('GET', path, { token: owner.token }); if (r.status !== 200) throw new Error(`${path} returned ${r.status}`); };
  rows.push(['GET /api/customers', await measure(() => ok('/api/customers'))]);
  rows.push(['GET /api/designs', await measure(() => ok('/api/designs'))]);
  rows.push(['GET /api/orders', await measure(() => ok('/api/orders'))]);
  await raw.end();
  console.log(`RLS latency, ${N} iterations each (indicative only; shared runner, local PostgreSQL)`);
  for (const [label, result] of rows) console.log(`${label.padEnd(52)} median ${String(result.medianMs).padStart(7)} ms   p95 ${String(result.p95Ms).padStart(7)} ms`);
} finally {
  await api?.close();
  await role?.close();
  await db.drop();
}
