// Shared helpers for real-PostgreSQL tests. Each suite that needs a pristine schema gets its own throw-away database
// created from DATABASE_URL (the CI user and a typical local postgres user may CREATE DATABASE).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
export const quiet = { info() {}, warn() {}, error() {} };

export async function createTempDatabase(baseUrl, prefix = 'avzar_t') {
  const name = `${prefix}_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  return {
    name,
    url: u.toString(),
    pool,
    async drop() {
      await pool.end().catch(() => {});
      const a = new pg.Client({ connectionString: baseUrl });
      await a.connect();
      try { await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await a.end(); }
    },
  };
}

// Columns that only the Node migrations give a DEFAULT (EF created the ten array columns NOT NULL with no default; 0046 added
// Stages.RequiresApproval NOT NULL DEFAULT false). Code that omits one of them works on a database built from the Node migrations
// but fails on a database without the default, so tests can drop the defaults. Code that inserts a Stage writes RequiresApproval.
export const NODE_ONLY_ARRAY_DEFAULTS = [
  ['Designs', 'Tags'], ['Designs', 'Fabrics'], ['Designs', 'Colours'], ['Designs', 'Sizes'],
  ['Workflows', 'GarmentCategories'], ['Stages', 'CompletionChecks'], ['Stages', 'RequiresApproval'],
  ['ProductionTasks', 'RequiredChecks'], ['ProductionTasks', 'CompletedChecks'],
  ['Invitations', 'RoleIds'], ['Invitations', 'LocationIds'],
];

export async function dropNodeOnlyDefaults(pool) {
  for (const [table, column] of NODE_ONLY_ARRAY_DEFAULTS) await pool.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT`);
}
