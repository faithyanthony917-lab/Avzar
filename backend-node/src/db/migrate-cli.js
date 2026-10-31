// Applies pending SQL migrations from ../../migrations, then adds missing default plans. Usage: DATABASE_URL=... npm run migrate
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from './migrate.js';
import { syncPlans } from './planSeed.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required.'); process.exit(1); }
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  const applied = await migrate(pool, dir, console);
  console.info(JSON.stringify({ event: 'migrations_done', applied }));
  // Add-only: inserts missing default plans and entitlement keys, never overwrites admin edits. Skip with SKIP_PLAN_SEED=true.
  if (process.env.SKIP_PLAN_SEED !== 'true') console.info(JSON.stringify({ event: 'plans_seeded', ...(await syncPlans(pool)) }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
