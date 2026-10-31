
// Step 5: a database built ONLY from the Node migrations must have the same schema the EF Core model describes:
// columns (type, nullability, identity), primary keys, unique keys, indexes (columns, uniqueness, filter), check constraints and
// foreign keys (columns, referenced table and columns, delete action). The expected schema is test/fixtures/ef-model.json, which
// was generated once from the EF model snapshot and is now the committed reference schema.
// Expressions (check constraints and index filters) are compared the way PostgreSQL stores them: each EF expression is applied to a
// scratch copy of the table and the stored text of both is compared, so no expression parsing is done here.
// Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
import { syncPlans } from '../../src/db/planSeed.js';
import { registerBusiness } from '../../src/auth/coreAuthService.js';
import {
  createTempDatabase,
  dropNodeOnlyDefaults,
  MIGRATIONS_DIR,
  NODE_ONLY_ARRAY_DEFAULTS,
  quiet,
} from './helpers.js';

const url = process.env.DATABASE_URL;
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/ef-model.json'
);

const NODE_ONLY_TABLES = new Set([
  'avzar_schema_migrations',
  'CustomerPrivacyRequests',
  'TaskWorkerRequests',
  'StorefrontAnalyticsSettings',
  'StorefrontConsentRecords',
  'StorefrontPageViewDaily',
  'StorefrontConsentTokenGrants',
  'NodeMaterialStates',
  'Notifications',
  'NotificationPreferences',
  'NotificationSettings',
  'WorkerSummaryJobs',
  'WorkerSummaryEvents',
  'NotificationOutbox',
  'PushTokens',
  'PushDeliveries',
  'TaskProgressPhotos',
  'ShopScheduleVersions',
  'StorefrontSlugRedirects',
  'Appointments',
  'AppointmentReminders',
  'PlatformAuditLogs',
  'PlatformFeatureFlags',
  'ReadyToWearOrderItems',
  'ReadyToWearOrders',
  'ReadyToWearReservations',
  'ReadyToWearVariants',
  'Suppliers',
  'PurchaseOrders',
  'PurchaseOrderItems',
  'CustomerMessagingPreferences',
  'CalendarFeedTokens',
  'CustomerMessageOutbox',
  'MessagingSuppressions',
  'InvoicePaymentAttempts', // 0037
  'InvoiceInstallmentPlans', // 0038
  'InvoiceInstallments', // 0038
  'CustomerEventOutbox', // 0040
  'NotificationTemplates', // 0041
]);

// Unique keys the Node migrations add to tables that EF created, so other tables can reference them as (Id, BusinessId).
const NODE_ONLY_UNIQUE_KEYS = {
  TaskEvents: ['Id,BusinessId'],
}; // 0014: WorkerSummaryEvents references TaskEvents

// Indexes that Node migrations add to tables that EF created.
const NODE_ONLY_INDEXES = {
  Designs: [
    {
      name: 'UX_Designs_Id_BusinessId',
      columns: ['Id', 'BusinessId'],
      unique: true,
    },
  ],
  Storefronts: [
    {
      name: 'UX_Storefronts_Id_BusinessId',
      columns: ['Id', 'BusinessId'],
      unique: true,
    },
  ],
  Inquiries: [
    { name: 'UX_Inquiries_AppointmentId', columns: ['AppointmentId'], unique: true, predicate: '"AppointmentId" IS NOT NULL' },
  ], // 0036
  StockMovements: [
    { name: 'UX_StockMovements_BusinessId_IdempotencyKey', columns: ['BusinessId', 'IdempotencyKey'], unique: true, predicate: '"IdempotencyKey" IS NOT NULL' },
    { name: 'IX_StockMovements_BusinessId_LocationId_CreatedAtUtc', columns: ['BusinessId', 'LocationId', 'CreatedAtUtc'], unique: false },
  ],
};

// Explicit, reviewed Node-only extensions to the EF-owned StockMovements table.
const NODE_ONLY_COLUMNS = {
  Businesses: new Set(['PaymentSubaccountCode', 'SuspendedAtUtc', 'SuspendedReason']), // 0037, 0044
  Inquiries: new Set(['AppointmentId']), // 0036
  StockMovements: new Set([
    'LocationId', 'MovementType', 'QuantityDelta', 'UnitCost', 'ReferenceType',
    'ReferenceId', 'IdempotencyKey', 'Reason', 'CreatedByUserId',
  ]),
};
// Foreign keys the Node migrations add to tables that EF created, written as the test prints them.
const NODE_ONLY_FOREIGN_KEYS = {
  Inquiries: ['(AppointmentId,BusinessId) -> Appointments(Id,BusinessId) ON DELETE RESTRICT'], // 0036
};
const NODE_ONLY_CHECKS = {
  StockMovements: new Set([
    'CK_StockMovements_Quantity', 'CK_StockMovements_OnHand',
    'CK_StockMovements_MovementType', 'CK_StockMovements_QuantityDelta',
    'CK_StockMovements_UnitCost', 'CK_StockMovements_Idempotency',
  ]),
};

const PROBE = '__ef_probe';
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const list = (names) => names.map(quote).join(', ');
const ACTIONS = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

const COLUMNS_SQL = `
  SELECT c.relname AS tbl, a.attname::text AS col, format_type(a.atttypid, a.atttypmod) AS type,
         NOT a.attnotnull AS nullable, a.attidentity::text AS identity
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY c.relname, a.attnum`;

// contype p = primary key, u = unique constraint, c = check, f = foreign key.
const CONSTRAINTS_SQL = `
  SELECT t.relname AS tbl, k.conname::text AS name, k.contype::text AS kind,
         (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS cols,
         r.relname AS ref_tbl,
         (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(k.confkey) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum) AS ref_cols,
         k.confdeltype::text AS on_delete,
         CASE WHEN k.contype = 'c' THEN pg_get_constraintdef(k.oid) END AS definition
  FROM pg_constraint k
  JOIN pg_class t ON t.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  LEFT JOIN pg_class r ON r.oid = k.confrelid
  WHERE n.nspname = 'public' AND k.contype IN ('p', 'u', 'c', 'f')`;

// Indexes that are not the backing index of a primary key or unique constraint.
const INDEXES_SQL = `
  SELECT t.relname AS tbl, ic.relname::text AS name, i.indisunique AS "unique",
         (SELECT array_agg(a.attname::text ORDER BY u.ord)
            FROM unnest(string_to_array(i.indkey::text, ' ')::int2[]) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) AS cols,
         pg_get_expr(i.indpred, i.indrelid) AS predicate
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p', 'u'))`;

// PostgreSQL silently cuts identifiers to 63 bytes, so an EF index name longer than that exists in the database in cut form
// (an EF-adopted database has the same cut names).
const pgName = (name) => Buffer.from(name).subarray(0, 63).toString();
const sameList = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b);
const bySorted = (rows, key) =>
  [...rows].sort((x, y) => key(x).localeCompare(key(y)));

describe(
  'Node migrations produce the schema the EF model describes',
  { skip: !url },
  () => {
    let db;
    let expected;
    let tables; // table name -> { columns, primaryKey, uniqueKeys, checks, foreignKeys, indexes } as found in PostgreSQL
    let probeCache;

    before(async () => {
      expected = JSON.parse(await readFile(FIXTURE, 'utf8')).tables;
      db = await createTempDatabase(url, 'avzar_efschema');
      await migrate(db.pool, MIGRATIONS_DIR, quiet);

      tables = {};

      const table = (name) =>
        (tables[name] ??= {
          columns: {},
          primaryKey: null,
          uniqueKeys: [],
          checks: {},
          foreignKeys: [],
          indexes: [],
        });

      for (const r of (await db.pool.query(COLUMNS_SQL)).rows) {
        table(r.tbl).columns[r.col] = {
          type: r.type,
          nullable: r.nullable,
          identity: r.identity === 'd',
        };
      }

      for (const r of (await db.pool.query(CONSTRAINTS_SQL)).rows) {
        const t = table(r.tbl);

        if (r.kind === 'p') {
          t.primaryKey = r.cols;
        } else if (r.kind === 'u') {
          t.uniqueKeys.push(r.cols);
        } else if (r.kind === 'c') {
          t.checks[r.name] = r.definition;
        } else {
          t.foreignKeys.push({
            columns: r.cols,
            referencedTable: r.ref_tbl,
            referencedColumns: r.ref_cols,
            onDelete: ACTIONS[r.on_delete],
          });
        }
      }

      for (const r of (await db.pool.query(INDEXES_SQL)).rows) {
        table(r.tbl).indexes.push({
          name: r.name,
          columns: r.cols,
          unique: r.unique,
          predicate: r.predicate,
        });
      }

      probeCache = new Map();
    });

    after(async () => {
      await db?.drop();
    });

    // Stored form of an expression, obtained by applying it to a scratch copy of the table (same column names and types).
    async function storedExpression(tableName, kind, expression, columns) {
      const key = `${kind}|${tableName}|${expression}`;

      if (probeCache.has(key)) {
        return probeCache.get(key);
      }

      const client = await db.pool.connect();

      try {
        await client.query(`DROP TABLE IF EXISTS ${quote(PROBE)}`);
        await client.query(
          `CREATE TABLE ${quote(PROBE)} (LIKE ${quote(tableName)})`
        );

        let stored;

        if (kind === 'check') {
          await client.query(
            `ALTER TABLE ${quote(PROBE)} ADD CONSTRAINT "probe_check" CHECK (${expression})`
          );

          stored = (
            await client.query(
              `SELECT pg_get_constraintdef(oid) AS d
               FROM pg_constraint
               WHERE conrelid = $1::regclass AND conname = 'probe_check'`,
              [quote(PROBE)]
            )
          ).rows[0].d;
        } else {
          await client.query(
            `CREATE INDEX "probe_index" ON ${quote(PROBE)} (${list(columns)}) WHERE ${expression}`
          );

          stored = (
            await client.query(
              `SELECT pg_get_expr(i.indpred, i.indrelid) AS d
               FROM pg_index i
               JOIN pg_class c ON c.oid = i.indexrelid
               WHERE c.relname = 'probe_index'`
            )
          ).rows[0].d;
        }

        probeCache.set(key, stored);
        return stored;
      } finally {
        await client
          .query(`DROP TABLE IF EXISTS ${quote(PROBE)}`)
          .catch(() => {});
        client.release();
      }
    }

    it('has exactly the tables of the EF model (plus the migration tracking table)', () => {
      const have = Object.keys(tables)
        .filter((t) => !NODE_ONLY_TABLES.has(t))
        .sort();

      assert.deepEqual(have, Object.keys(expected).sort());
    });

    it('has every column with the same type, nullability and identity, and no extra columns', () => {
      const problems = [];

      for (const [t, def] of Object.entries(expected)) {
        const have = tables[t]?.columns ?? {};

        for (const [c, col] of Object.entries(def.columns)) {
          const h = have[c];

          if (!h) {
            problems.push(`${t}.${c} is missing`);
            continue;
          }

          if (h.type !== col.type) {
            problems.push(`${t}.${c} has type ${h.type}, EF has ${col.type}`);
          }

          // A primary key column is NOT NULL in PostgreSQL whatever the EF snapshot says about the property.
          const wantNullable = col.nullable && !def.primaryKey?.includes(c);

          if (h.nullable !== wantNullable) {
            problems.push(`${t}.${c} nullable=${h.nullable}, EF has ${wantNullable}`);
          }

          if (h.identity !== col.identity) {
            problems.push(`${t}.${c} identity=${h.identity}, EF has ${col.identity}`);
          }
        }

        for (const c of Object.keys(have)) {
          if (!def.columns[c] && !NODE_ONLY_COLUMNS[t]?.has(c)) {
            problems.push(`${t}.${c} is not in the EF model or approved Node-only extensions`);
          }
        }
      }

      assert.deepEqual(problems, []);
    });

    it('has the same primary keys and unique (alternate) keys', () => {
      const problems = [];

      for (const [t, def] of Object.entries(expected)) {
        const have = tables[t];

        if (!sameList(have.primaryKey, def.primaryKey)) {
          problems.push(
            `${t} primary key is (${have.primaryKey}), EF has (${def.primaryKey})`
          );
        }

        const want = def.uniqueKeys.map((k) => k.join(',')).sort();
        const nodeOnly = NODE_ONLY_UNIQUE_KEYS[t] ?? [];
        const gotAll = have.uniqueKeys.map((k) => k.join(','));

        for (const key of nodeOnly) {
          if (!gotAll.includes(key)) {
            problems.push(`${t} is missing the Node-only unique key [${key}]`);
          }
        }

        const got = gotAll.filter((k) => !nodeOnly.includes(k)).sort();

        if (!sameList(got, want)) {
          problems.push(`${t} unique keys are [${got}], EF has [${want}]`);
        }
      }

      assert.deepEqual(problems, []);
    });

    it('has the same indexes: name, columns, uniqueness and filter', async () => {
      const problems = [];

      for (const [t, def] of Object.entries(expected)) {
        const have = tables[t].indexes;

        for (const ix of def.indexes) {
          const h = have.find((x) => x.name === pgName(ix.name));

          if (!h) {
            problems.push(`${t}: index ${ix.name} is missing`);
            continue;
          }

          if (!sameList(h.columns, ix.columns)) {
            problems.push(
              `${t}.${ix.name} columns are (${h.columns}), EF has (${ix.columns})`
            );
          }

          if (h.unique !== ix.unique) {
            problems.push(
              `${t}.${ix.name} unique=${h.unique}, EF has ${ix.unique}`
            );
          }

          const wantFilter = ix.filter
            ? await storedExpression(t, 'index', ix.filter, ix.columns)
            : null;

          if ((h.predicate ?? null) !== wantFilter) {
            problems.push(
              `${t}.${ix.name} filter is ${h.predicate ?? 'none'}, EF has ${wantFilter ?? 'none'}`
            );
          }
        }

        // Check indexes not declared in the EF model.
        for (const h of have) {
          if (def.indexes.some((ix) => pgName(ix.name) === h.name)) {
            continue;
          }

          // Match using PostgreSQL's stored/truncated index name.
          const nodeOnly = (NODE_ONLY_INDEXES[t] ?? []).find(
            (ix) => pgName(ix.name) === h.name
          );

          if (!nodeOnly) {
            problems.push(`${t}: index ${h.name} is not in the EF model`);
            continue;
          }

          if (!sameList(h.columns, nodeOnly.columns)) {
            problems.push(
              `${t}.${h.name} has unexpected columns (${h.columns})`
            );
          }

          if (h.unique !== nodeOnly.unique) {
            problems.push(
              `${t}.${h.name} unique=${h.unique}, expected ${nodeOnly.unique}`
            );
          }

          const wantNodeFilter = nodeOnly.predicate
            ? await storedExpression(t, 'index', nodeOnly.predicate, nodeOnly.columns)
            : null;
          if ((h.predicate ?? null) !== wantNodeFilter) {
            problems.push(`${t}.${h.name} filter is ${h.predicate ?? 'none'}, expected ${wantNodeFilter ?? 'none'}`);
          }
        }
      }

      assert.deepEqual(problems, []);
    });

    it('has the same check constraints, by name and by stored expression', async () => {
      const problems = [];

      for (const [t, def] of Object.entries(expected)) {
        const have = tables[t].checks;

        for (const [name, expression] of Object.entries(def.checks)) {
          if (!(name in have)) {
            problems.push(`${t}: check ${name} is missing`);
            continue;
          }

          const want = await storedExpression(t, 'check', expression);

          if (have[name] !== want) {
            problems.push(`${t}.${name} is ${have[name]}, EF has ${want}`);
          }
        }

        for (const name of Object.keys(have)) {
          if (!(name in def.checks) && !NODE_ONLY_CHECKS[t]?.has(name)) {
            problems.push(`${t}: check ${name} is not in the EF model or approved Node-only extensions`);
          }
        }
      }

      assert.deepEqual(problems, []);
    });

    it('has no column defaults except the ten array defaults the Node migrations add (the EF model defines none)', async () => {
      const { rows } = await db.pool.query(`
        SELECT c.relname AS tbl, a.attname::text AS col
        FROM pg_attrdef d
        JOIN pg_class c ON c.oid = d.adrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE n.nspname = 'public'`);

      const have = rows
        .filter((r) => !NODE_ONLY_TABLES.has(r.tbl))
        .map((r) => `${r.tbl}.${r.col}`)
        .sort();

      assert.deepEqual(
        have,
        NODE_ONLY_ARRAY_DEFAULTS.map(([t, c]) => `${t}.${c}`).sort()
      );
    });

    it('has the same foreign keys: columns, referenced table and columns, delete action', () => {
      const problems = [];

      const describeFk = (f) =>
        `(${f.columns}) -> ${f.referencedTable}(${f.referencedColumns}) ON DELETE ${f.onDelete}`;

      for (const [t, def] of Object.entries(expected)) {
        const want = bySorted(def.foreignKeys, describeFk).map(describeFk);
        const got = bySorted(tables[t].foreignKeys, describeFk).map(describeFk);

        for (const w of want) {
          if (!got.includes(w)) {
            problems.push(`${t}: foreign key ${w} is missing or different`);
          }
        }

        for (const g of got) {
          if (!want.includes(g) && !(NODE_ONLY_FOREIGN_KEYS[t] ?? []).includes(g)) {
            problems.push(`${t}: foreign key ${g} is not in the EF model`);
          }
        }
      }

      assert.deepEqual(problems, []);
    });
  }
);

// EF created the ten array columns as NOT NULL with no default, so a production database adopted from EF has none. Any INSERT that
// leaves one of them out works on a database built from the Node migrations (which add a default) and fails in production.
// Register-business creates the default workflow and its stages; it used to leave "GarmentCategories" out.
describe(
  'Node code on a database without the Node-only array defaults',
  { skip: !url },
  () => {
    let db;

    before(async () => {
      db = await createTempDatabase(url, 'avzar_nodefaults');
      await migrate(db.pool, MIGRATIONS_DIR, quiet);
      await syncPlans(db.pool);
      await dropNodeOnlyDefaults(db.pool);
    });

    after(async () => {
      await db?.drop();
    });

    it('the array columns really have no default now', async () => {
      const { rows } = await db.pool.query(
        `SELECT count(*)::int AS n
         FROM pg_attrdef d
         JOIN pg_class c ON c.oid = d.adrelid
         WHERE c.relname = ANY($1)`,
        [[...new Set(NODE_ONLY_ARRAY_DEFAULTS.map(([t]) => t))]]
      );

      // Other columns of these tables have no default either, so nothing is left.
      assert.equal(rows[0].n, 0);
    });

    it('registers a business, creating the default workflow and its stages', async () => {
      const env = {
        JWT_SIGNING_KEY: 'integration-signing-key-with-at-least-32-chars',
        WEB_BASE_URL: 'https://app.example.test',
      };

      const { businessId } = await registerBusiness(
        db.pool,
        {
          businessName: 'No Defaults Tailors',
          ownerName: 'Owner',
          email: `nodefaults-${Date.now()}@example.test`,
          password: 'correct horse battery staple',
          timeZoneId: 'UTC',
          currencyCode: 'NGN',
        },
        env
      );

      const workflow = (
        await db.pool.query(
          'SELECT "GarmentCategories" FROM "Workflows" WHERE "BusinessId" = $1 AND "IsDefault"',
          [businessId]
        )
      ).rows;

      assert.deepEqual(workflow, [{ GarmentCategories: [] }]);

      const stages = (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM "Stages" WHERE "BusinessId" = $1',
          [businessId]
        )
      ).rows[0].n;

      assert.equal(stages, 10);
    });
  }
);
