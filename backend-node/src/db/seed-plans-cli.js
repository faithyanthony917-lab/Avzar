// Adds missing default plans and entitlement keys. Never overwrites admin edits. Usage: DATABASE_URL=... npm run seed-plans
// Run AFTER the migrations have been applied.
import pg from 'pg';
import { syncPlans } from './planSeed.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required.'); process.exit(1); }
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  console.info(JSON.stringify({ event: 'plans_seeded', ...(await syncPlans(pool)) }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
