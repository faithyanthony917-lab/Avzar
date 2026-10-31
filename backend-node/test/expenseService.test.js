import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExpense,
  exportExpenses,
  listExpenseCategories,
  listExpenses,
  saveExpenseCategory,
  summarizeExpenses,
  updateExpense,
  voidExpense,
} from '../src/auth/expenseService.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const categoryId = '00000000-0000-4000-8000-000000000050';
const expenseId = '00000000-0000-4000-8000-000000000070';
const locationId = '00000000-0000-4000-8000-000000000060';
const user = { businessId, userId, isOwner: true, permissions: [] };
const allowed = [locationId];
const empty = { rows: [] };
const tx = (db) => async (_pool, callback) => callback(db);
const category = { Id: categoryId, Name: 'Materials', IsActive: true, SortOrder: 1 };

function expense(overrides = {}) {
  return {
    Id: expenseId,
    CategoryId: categoryId,
    CategoryName: category.Name,
    ExpenseDate: '2026-10-10',
    Amount: '125.50',
    CurrencyCode: 'NGN',
    Description: 'Thread stock',
    Vendor: 'Supply, Inc.',
    Reference: 'INV-123',
    VoidedAtUtc: null,
    VoidReason: null,
    LocationId: locationId,
    CreatedAtUtc: '2026-10-10T12:00:00.000Z',
    Version: '4',
    ...overrides,
  };
}

function entitlement(sql) {
  return sql.includes('FROM "Plans" p') ? { rows: [{ Value: 'true' }] } : null;
}

describe('expense ledger persistence', () => {
  it('seeds the default category list once and returns database categories', async () => {
    const defaults = [];
    const client = {
      query: async (sql, values) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return empty;
        if (sql.includes('FROM "ExpenseCategories"')) return defaults.length
          ? { rows: [{ '?column?': 1 }] } : empty;
        if (sql.includes('INSERT INTO "ExpenseCategories"')) {
          defaults.push({ Id: values[0], Name: values[2], IsActive: true, SortOrder: values[3] });
          return empty;
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      },
      release() {},
    };
    const pool = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('FROM "ExpenseCategories"') && sql.includes('LIMIT 1')) {
          return defaults.length ? { rows: [{ '?column?': 1 }] } : empty;
        }
        if (sql.includes('FROM "ExpenseCategories"')) return { rows: defaults };
        throw new Error(`Unexpected query: ${sql}`);
      },
      connect: async () => client,
    };
    const result = await listExpenseCategories(pool, user);
    assert.equal(result.length, 7);
    assert.equal(result[0].name, 'Fabric & materials');
    assert.equal(defaults[6].Name, 'Other');
  });

  it('denies ledger access when the active plan has no expense entitlement', async () => {
    await assert.rejects(
      listExpenses({ query: async () => ({ rows: [{ Value: 'false' }] }) }, user,
        { page: 1, pageSize: 20, includeVoid: false }, null),
      (error) => error.code === 'feature_not_in_plan',
    );
  });

  it('filters paged ledger results to allowed locations and requested criteria', async () => {
    const calls = [];
    const row = expense();
    const pool = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('count(*)')) return { rows: [{ TotalCount: 1 }] };
        return { rows: [row] };
      },
    };
    const result = await listExpenses(pool, user, {
      page: 1, pageSize: 10, includeVoid: false, categoryId, from: '2026-10-01', search: 'thread_',
    }, allowed);
    assert.equal(result.totalCount, 1);
    assert.equal(result.items[0].amount, 125.5);
    assert.equal(result.items[0].version, 4);
    const ledgerQuery = calls.find(({ sql }) => sql.includes('count(*)'));
    assert.match(ledgerQuery.sql, /e\."LocationId" = ANY\(\$2::uuid\[\]\)/);
    assert.match(ledgerQuery.sql, /e\."VoidedAtUtc" IS NULL/);
    assert.match(ledgerQuery.sql, /e\."CategoryId" = \$3/);
    assert.deepEqual(ledgerQuery.values.slice(0, 3), [businessId, allowed, categoryId]);
  });

  it('creates an expense with business currency, permitted location, and audit in one transaction', async () => {
    const called = [];
    const db = {
      query: async (sql, values) => {
        called.push(sql);
        if (sql.includes('INSERT INTO "Expenses"')) return { rows: [expense({ Amount: String(values[5]), LocationId: values[3] })] };
        if (sql.includes('FROM "ExpenseCategories"')) return { rows: [{ CategoryName: category.Name }] };
        if (sql.includes('INSERT INTO "AuditLogs"')) return empty;
        throw new Error(`Unexpected transaction query: ${sql}`);
      },
    };
    const pool = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN', TimeZoneId: 'UTC' }] };
        if (sql.includes('FROM "ExpenseCategories"')) return { rows: [{ Name: category.Name, IsActive: true }] };
        if (sql.includes('FROM "Locations"')) return { rows: [{ '?column?': 1 }] };
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    };
    const result = await createExpense(pool, tx(db), user, {
      categoryId, amount: 125.5, expenseDate: '2026-10-10',
      description: 'Thread stock', vendor: 'Supply, Inc.', reference: 'INV-123', locationId,
    }, allowed);
    assert.equal(result.currencyCode, 'NGN');
    assert.equal(result.locationId, locationId);
    assert.equal(result.categoryName, 'Materials');
    assert.equal(called.some((sql) => sql.includes('INSERT INTO "AuditLogs"')), true);
  });

  it('rejects inactive categories and future-dated expenses', async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN', TimeZoneId: 'UTC' }] };
        if (sql.includes('FROM "ExpenseCategories"')) return { rows: [{ Name: category.Name, IsActive: false }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    await assert.rejects(
      createExpense(pool, tx({ query: async () => empty }), user, {
        categoryId, amount: 15, expenseDate: '2026-10-10', description: 'Test purchase', locationId,
      }, allowed),
      (error) => error.code === 'category_inactive',
    );

    const futurePool = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN', TimeZoneId: 'UTC' }] };
        if (sql.includes('FROM "ExpenseCategories"')) return { rows: [{ Name: category.Name, IsActive: true }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await assert.rejects(
      createExpense(futurePool, tx({ query: async () => empty }), user, {
        categoryId, amount: 15, expenseDate: tomorrow, description: 'Test purchase', locationId,
      }, allowed),
      (error) => error.code === 'expense_in_future',
    );
  });

  it('rejects duplicate category names without changing existing categories', async () => {
    const db = {
      query: async (sql) => sql.includes('lower("Name")')
        ? { rows: [{ '?column?': 1 }] }
        : empty,
    };
    await assert.rejects(
      saveExpenseCategory({ query: async (sql) => sql.includes('FROM "Plans" p')
        ? { rows: [{ Value: 'true' }] } : empty }, tx(db), user, null,
      { name: 'materials', isActive: true, sortOrder: 1 }),
      (error) => error.code === 'category_exists',
    );
  });

  it('enforces optimistic versions when updating and prevents changes after void', async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('JOIN "ExpenseCategories"')) return { rows: [expense()] };
        if (sql.includes('FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN', TimeZoneId: 'UTC' }] };
        if (sql.includes('FROM "ExpenseCategories"')) return { rows: [{ Name: category.Name, IsActive: true }] };
        return empty;
      },
    };
    const staleDb = {
      query: async (sql) => sql.includes('UPDATE "Expenses"') ? empty : empty,
    };
    await assert.rejects(
      updateExpense(pool, tx(staleDb), user, expenseId, {
        categoryId, amount: 125.5, expenseDate: '2026-10-10', description: 'Thread stock',
        locationId, version: 3,
      }, allowed),
      (error) => error.code === 'stale_version',
    );

    const voidedPool = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('JOIN "ExpenseCategories"')) return { rows: [expense({ VoidedAtUtc: '2026-10-11T00:00:00Z' })] };
        return empty;
      },
    };
    await assert.rejects(
      updateExpense(voidedPool, tx(staleDb), user, expenseId, {
        categoryId, amount: 125.5, expenseDate: '2026-10-10', description: 'Thread stock', version: 4,
      }, allowed),
      (error) => error.code === 'expense_void',
    );
  });

  it('summarizes only non-voided expenses and exports CSV with formula-injection protection', async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('GROUP BY e."CategoryId"')) return { rows: [{
          CategoryId: categoryId, CategoryName: category.Name, Total: '125.50', Count: 1,
        }] };
        if (sql.includes('FROM "Businesses"')) return { rows: [{ CurrencyCode: 'NGN', TimeZoneId: 'UTC' }] };
        if (sql.includes('count(*)')) return { rows: [{ TotalCount: 1 }] };
        return { rows: [expense({ Description: '=HYPERLINK("x")', Vendor: 'Supply,\0 Inc.' })] };
      },
    };
    const summary = await summarizeExpenses(pool, user, { from: '2026-10-01', to: '2026-10-31' }, allowed);
    assert.equal(summary.total, 125.5);
    assert.equal(summary.byCategory[0].categoryName, 'Materials');
    const csv = await exportExpenses(pool, user, {
      page: 1, pageSize: 100, includeVoid: true,
    }, allowed);
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
    assert.ok(csv.includes('"Supply, Inc."'));
    assert.match(csv, /Expense ID,Date,Category,Amount,Currency/);
  });

  it('rejects oversized CSV exports instead of silently truncating them', async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'true' }] };
        if (sql.includes('count(*)')) return { rows: [{ TotalCount: 100_001 }] };
        return { rows: [] };
      },
    };
    await assert.rejects(
      exportExpenses(pool, user, { page: 1, pageSize: 100, includeVoid: true }, allowed),
      (error) => error.status === 413 && error.code === 'export_too_large',
    );
  });

  it('voids an expense with a reason, audit record, and stable financial history', async () => {
    const calls = [];
    const db = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes('FROM "Expenses" e')) return { rows: [{ Id: expenseId, Amount: '125.50', Version: '4', VoidedAtUtc: null }] };
        if (sql.includes('UPDATE "Expenses"')) return { rows: [{ Id: expenseId }] };
        return empty;
      },
    };
    await voidExpense({ query: async () => ({ rows: [{ Value: 'true' }] }) }, tx(db), user, expenseId, 'Duplicate entry', allowed);
    assert.equal(calls.some(({ sql }) => sql.includes('UPDATE "Expenses"')), true);
    assert.equal(calls.some(({ sql, values }) => sql.includes('INSERT INTO "AuditLogs"') && values[1] === 'expense.voided'), true);
  });
});
