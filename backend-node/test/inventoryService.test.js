import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeStock, commitInventoryCsv, createMaterial, inventoryHistory, listInventory, previewInventoryCsv,
} from '../src/auth/inventoryService.js';

const businessId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const locationId = '00000000-0000-4000-8000-000000000060';
const materialId = '00000000-0000-4000-8000-000000000061';
const taskId = '00000000-0000-4000-8000-000000000062';
const user = { businessId, userId, isOwner: true, permissions: ['inventory.view', 'inventory.manage'] };

function makePool({ material = null, tier = 'basic', allowedLocations = null } = {}) {
  const state = { material: material ?? {
    Id: materialId, BusinessId: businessId, LocationId: locationId, Sku: 'FAB-1', Name: 'Cotton', Unit: 'metre',
    OnHand: '1.250', Reserved: '0.250', ReorderLevel: '0.500', Notes: null, Version: '1',
  }, tier, allowedLocations, movements: [], tasks: [], locations: [{ Id: locationId }] };
  const calls = [];
  async function query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: state.tier }] };
    if (sql.includes('SELECT DISTINCT ml."LocationId"')) return { rows: (state.allowedLocations ?? []).map((LocationId) => ({ LocationId })) };
    if (sql.includes('FROM "Materials" m')) {
      const row = state.material;
      if (!row || row.BusinessId !== values[0]) return { rows: [] };
      if (sql.includes('"Id" = $2') && row.Id !== values[1]) return { rows: [] };
      const allowed = Array.isArray(values[1]) ? values[1] : Array.isArray(values[2]) ? values[2] : null;
      if (allowed !== null && !allowed.includes(row.LocationId)) return { rows: [] };
      return { rows: [{ ...row }] };
    }
    if (sql.includes('FROM "Materials" WHERE "BusinessId" = $1 AND "Id" = $2')) return { rows: state.material?.Id === values[1] ? [{ ...state.material }] : [] };
    if (sql.includes('FROM "Materials" WHERE "BusinessId" = $1 AND upper')) return { rows: [] };
    if (sql.includes('FROM "Materials" WHERE "BusinessId" = $1')) return { rows: [] };
    if (sql.includes('FROM "Locations"')) return { rows: state.locations };
    if (sql.includes('FROM "StockMovements"')) return { rows: state.movements.slice().reverse() };
    return { rows: [], rowCount: 1 };
  }
  return {
    state, calls, query,
    connect: async () => ({
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: state.tier }] };
        if (sql.includes('FROM "Materials" m')) {
          const row = state.material;
          if (!row || row.BusinessId !== values[0] || row.Id !== values[1]) return { rows: [] };
          if (Array.isArray(values[2]) && !values[2].includes(row.LocationId)) return { rows: [] };
          return { rows: [{ ...row }] };
        }
        if (sql.includes('FROM "ProductionTasks" t')) return { rows: [{ Id: taskId, OrderId: '00000000-0000-4000-8000-000000000070', Status: 'Pending', LocationId: locationId }] };
        if (sql.includes('FROM "Orders"')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000070', LocationId: locationId }] };
        if (sql.includes('sum(CASE WHEN "Kind"')) return { rows: [{ Reserved: '0.000' }] };
        if (sql.includes('UPDATE "Materials"')) {
          state.material.OnHand = values[0]; state.material.Reserved = values[1];
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO "Materials"')) {
          state.material = { Id: values[0], BusinessId: values[1], LocationId: values[2], Sku: values[3], Name: values[4],
            Unit: values[5], OnHand: values[6], Reserved: '0.000', ReorderLevel: values[7], Version: '1' };
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO "StockMovements"')) {
          state.movements.push({ Id: values[0], MaterialId: values[2], Kind: values[3], Quantity: values[4],
            OnHandAfter: values[5], ReservedAfter: values[6], OrderId: values[7], TaskId: values[8], Note: values[10], CreatedAtUtc: new Date().toISOString() });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  };
}

const csv = `SKU,Name,Unit,Opening stock,Reorder level\nNEW-1,Thread,spool,2.125,0.500`;

describe('inventory service', () => {
  it('lists tenant inventory and filters restricted users by allowed locations', async () => {
    const pool = makePool({ allowedLocations: [locationId] });
    const restricted = { ...user, isOwner: false, permissions: ['inventory.view'] };
    const result = await listInventory(pool, restricted);
    assert.equal(result.length, 1);
    assert.equal(result[0].available, 1);
    const listQuery = pool.calls.find((call) => call.sql.includes('FROM "Materials" m'));
    assert.deepEqual(listQuery.values, [businessId, [locationId]]);
  });

  it('creates opening stock and records a receive movement transactionally', async () => {
    const pool = makePool();
    const created = await createMaterial(pool, user, { sku: 'NEW-1', name: 'Thread', unit: 'spool', locationId, openingStock: 2.125, reorderLevel: 0.5 });
    assert.equal(created.sku, 'NEW-1');
    assert.equal(created.onHand, 2.125);
    assert.equal(pool.calls.some((call) => call.sql.includes("'Receive'")), true);
  });

  it('updates fractional stock exactly and denies materials outside a restricted location scope', async () => {
    const pool = makePool();
    const updated = await changeStock(pool, user, materialId, 'receive', { quantity: 0.125, expectedVersion: 1 });
    assert.equal(updated.onHand, 1.375);
    assert.equal(updated.available, 1.125);
    assert.equal(pool.state.movements[0].Kind, 'Receive');

    const restrictedPool = makePool({ allowedLocations: [] });
    const restricted = { ...user, isOwner: false, permissions: ['inventory.manage'] };
    await assert.rejects(changeStock(restrictedPool, restricted, materialId, 'receive', { quantity: 1 }),
      (error) => error.status === 404 && error.code === 'material_not_found');
  });

  it('records explicit wastage without consuming stock reserved for production', async () => {
    const pool = makePool();
    const updated = await changeStock(pool, user, materialId, 'wastage', { quantity: 0.25, note: 'Fabric damaged during cutting', expectedVersion: 1 });
    assert.equal(updated.onHand, 1);
    assert.equal(updated.reserved, 0.25);
    assert.equal(pool.state.movements[0].Kind, 'Wastage');
    assert.equal(pool.state.movements[0].Note, 'Fabric damaged during cutting');

    const noNote = makePool();
    await assert.rejects(changeStock(noNote, user, materialId, 'wastage', { quantity: 0.25 }),
      (error) => error.status === 400 && error.code === 'wastage_note_required');
    const reserved = makePool();
    await assert.rejects(changeStock(reserved, user, materialId, 'wastage', { quantity: 1.1, note: 'Damaged' }),
      (error) => error.status === 409 && error.code === 'reserved_stock_protected');
  });

  it('previews CSV, binds commit to its hash, and writes imported opening stock', async () => {
    const pool = makePool();
    const preview = await previewInventoryCsv(pool, user, csv);
    assert.equal(preview.totalRows, 1);
    assert.equal(preview.validRows, 1);
    const result = await commitInventoryCsv(pool, user, csv, { expectedHash: preview.fileHash, skipInvalidRows: false });
    assert.equal(result.created, 1);
    assert.equal(result.rows[0].sku, 'NEW-1');
    assert.equal(result.rows[0].field, null);
    await assert.rejects(commitInventoryCsv(pool, user, `${csv}\n`, { expectedHash: preview.fileHash, skipInvalidRows: false }),
      (error) => error.status === 409 && error.code === 'file_changed');
  });

  it('returns row, field, and message details when inventory commit is blocked by invalid rows', async () => {
    const invalidCsv = `${csv}\nNEW-2,Thread,spool,not-a-number,0.500`;
    const pool = makePool();
    const preview = await previewInventoryCsv(pool, user, invalidCsv);
    await assert.rejects(
      commitInventoryCsv(pool, user, invalidCsv, { expectedHash: preview.fileHash, skipInvalidRows: false }),
      (error) => error.code === 'invalid_rows' && error.extensions.rowErrors[0].row === 3 && error.extensions.rowErrors[0].field === 'openingStock' && Boolean(error.extensions.rowErrors[0].message),
    );
  });

  it('reports a repeated SKU as Skipped with its field and row number on commit', async () => {
    const repeated = `${csv}\nnew-1,Thread again,spool,1.000,0.500`;
    const pool = makePool();
    const preview = await previewInventoryCsv(pool, user, repeated);
    assert.equal(preview.duplicateRows, 1);
    const result = await commitInventoryCsv(pool, user, repeated, { expectedHash: preview.fileHash, skipInvalidRows: false });
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 1);
    const skipped = result.rows.find((row) => row.outcome === 'Skipped');
    assert.equal(skipped.row, 3);
    assert.equal(skipped.field, 'sku');
  });

  it('returns movement history and requires inventory plan access', async () => {
    const pool = makePool();
    pool.state.movements.push({ Id: '00000000-0000-4000-8000-000000000063', MaterialId: materialId, Kind: 'Receive', Quantity: '1.000', OnHandAfter: '2.250', ReservedAfter: '0.250', CreatedAtUtc: new Date().toISOString() });
    assert.equal((await inventoryHistory(pool, user, materialId, 100))[0].materialId, materialId);
    const noInventory = makePool({ tier: 'none' });
    await assert.rejects(listInventory(noInventory, user), (error) => error.status === 403 && error.code === 'feature_not_in_plan');
  });
});
it('inventory CSV preview preserves every row error instead of truncating the report', async () => {
  const rows = Array.from({ length: 301 }, () => ',, ,bad,bad');
  const input = ['SKU,Name,Unit,Opening stock,Reorder level', ...rows].join('\n');
  const result = await previewInventoryCsv(makePool(), user, input);
  assert.equal(result.totalRows, 301);
  assert.equal(result.problems.length, 301);
});
