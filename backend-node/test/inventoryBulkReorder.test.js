import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bulkAdjustStock, bulkMoveMaterials, bulkSetMaterialActive, bulkSetReorderLevel } from '../src/auth/inventoryService.js';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const LOC1 = '00000000-0000-4000-8000-000000000f01';
const LOC2 = '00000000-0000-4000-8000-000000000f02';
const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const owner = { businessId: A, userId: '00000000-0000-4000-8000-000000000001', isOwner: true, permissions: [] };

function makePool({ allowed = [] } = {}) {
  const materials = [
    { Id: id(1), BusinessId: A, LocationId: LOC1, Sku: 'A1', Name: 'Cotton', Unit: 'm', OnHand: '5', Reserved: '0', ReorderLevel: '1', Version: '1' },
    { Id: id(2), BusinessId: A, LocationId: LOC2, Sku: 'A2', Name: 'Silk', Unit: 'm', OnHand: '5', Reserved: '0', ReorderLevel: '1', Version: '1' },
    { Id: id(3), BusinessId: B, LocationId: LOC1, Sku: 'B1', Name: 'Other tenant', Unit: 'm', OnHand: '5', Reserved: '0', ReorderLevel: '1', Version: '1' },
  ];
  const log = { sql: [], audits: [], updates: 0, states: new Map(), movements: [], notifications: [] };
  const handle = async (sql, values = []) => {
    log.sql.push(sql.trim().split(/\s+/)[0]);
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: 'basic' }] };
    if (sql.includes('SELECT DISTINCT ml."LocationId"')) return { rows: allowed.map((LocationId) => ({ LocationId })) };
    if (sql.includes('FROM "Memberships" m') && sql.includes('NotificationPreferences')) return { rows: [{
      Id: '00000000-0000-4000-8000-000000000099', DisplayName: 'Inventory manager', Email: null,
      TimeZoneId: 'UTC', QuietHoursEnabled: false, InAppEnabled: true, EmailEnabled: false, PushEnabled: false,
    }] };
    if (sql.includes('INSERT INTO "NotificationOutbox"')) return { rows: [{
      Id: values[0], BusinessId: values[1], RecipientMembershipId: values[2], Category: values[3], EventType: values[4],
      Title: values[5], Body: values[6], TargetKind: values[7], TargetId: values[8], DeduplicationKey: values[9],
      InAppEnabled: values[10], EmailToAddress: values[11], EmailSubject: values[12], EmailTemplateKey: values[13],
      EmailTextBody: values[14], EmailDeduplicationKey: values[15], EmailNextAttemptUtc: values[16],
      Status: 'Pending', CreatedAtUtc: values[17],
    }], rowCount: 1 };
    if (sql.includes('INSERT INTO "Notifications"')) { log.notifications.push(values); return { rows: [], rowCount: 1 }; }
    if (sql.includes('UPDATE "NotificationOutbox"')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM "Materials"') && sql.includes('FOR UPDATE')) {
      const [biz, ids, locs] = values;
      return { rows: materials.filter((m) => m.BusinessId === biz && ids.includes(m.Id) && (locs === null || locs.includes(m.LocationId))).map((m) => ({ ...m })) };
    }
    if (sql.includes('SELECT "Id" FROM "Locations"')) return { rows: values[1] === LOC1 || values[1] === LOC2 ? [{ Id: values[1] }] : [] };
    if (sql.includes('INSERT INTO "NodeMaterialStates"')) { log.states.set(values[1], values[2]); return { rows: [] }; }
    if (sql.includes('UPDATE "Materials" SET "LocationId"')) { const [loc,biz,ids]=values; for (const m of materials) if (m.BusinessId===biz&&ids.includes(m.Id)) m.LocationId=loc; log.updates+=1; return { rows: [] }; }
    if (sql.includes('UPDATE "Materials" SET "OnHand"')) { const [onHand,biz,id]=values; const m=materials.find(x=>x.BusinessId===biz&&x.Id===id); if(m)m.OnHand=onHand; log.updates+=1; return { rows: [] }; }
    if (sql.includes('INSERT INTO "StockMovements"')) { log.movements.push({ kind: values[3], note: values[8], materialId: values[2] }); return { rows: [] }; }
    if (sql.includes('UPDATE "Materials" SET "ReorderLevel"')) {
      const [level, biz, ids] = values;
      for (const m of materials) if (m.BusinessId === biz && ids.includes(m.Id)) { m.ReorderLevel = level; log.updates += 1; }
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO "AuditLogs"')) { log.audits.push({ action: values[1], entityId: values[5], business: values[3], details: JSON.parse(values[4]) }); return { rows: [] }; }
    if (sql.includes('FROM "Materials" m')) {
      if (sql.includes('FOR UPDATE')) { const [biz, ids, locs] = values; return { rows: materials.filter(m=>m.BusinessId===biz&&ids.includes(m.Id)&&(locs===null||locs.includes(m.LocationId))) }; }
      const [biz, locs] = values;
      return { rows: materials.filter((m) => m.BusinessId === biz && (locs === null || locs.includes(m.LocationId))).map(m=>({...m,IsActive:log.states.get(m.Id)!==false})) };
    }
    return { rows: [] };
  };
  return { materials, log, query: handle, connect: async () => ({ query: handle, release() {} }) };
}

describe('bulkSetReorderLevel', () => {
  it('updates only the selected materials of the current business and audits each one', async () => {
    const pool = makePool();
    const result = await bulkSetReorderLevel(pool, owner, { ids: [id(1)], reorderLevel: 2.5 });
    assert.equal(result.updated, 1);
    assert.equal(pool.materials[0].ReorderLevel, '2.5');
    assert.equal(pool.materials[1].ReorderLevel, '1');
    assert.equal(pool.materials[2].ReorderLevel, '1');
    assert.deepEqual(pool.log.audits.map((a) => [a.action, a.entityId, a.business]), [['inventory.reorder_level_changed', id(1), A]]);
    assert.equal(pool.log.audits[0].details.bulk, true);
    assert.ok(result.items.every((item) => item.sku.startsWith('A')));
  });

  it('notifies inventory viewers only when a reorder-level change crosses into low stock', async () => {
    const pool = makePool();
    await bulkSetReorderLevel(pool, owner, { ids: [id(1)], reorderLevel: 6 });
    assert.equal(pool.log.notifications.length, 1);
    assert.equal(pool.log.notifications[0][3], 'inventory');
    assert.equal(pool.log.notifications[0][4], 'stock.low');
    assert.equal(pool.log.notifications[0][8], id(1));

    const noCrossing = makePool();
    await bulkSetReorderLevel(noCrossing, owner, { ids: [id(1)], reorderLevel: 2 });
    assert.equal(noCrossing.log.notifications.length, 0);
  });

  it('cross-tenant: a material id from another business is not found and nothing is changed', async () => {
    const pool = makePool();
    await assert.rejects(() => bulkSetReorderLevel(pool, owner, { ids: [id(1), id(3)], reorderLevel: 4 }), (e) => e.code === 'material_not_found' && e.status === 404);
    assert.equal(pool.log.updates, 0);
    assert.equal(pool.log.audits.length, 0);
    assert.ok(pool.log.sql.includes('ROLLBACK'));
    assert.ok(!pool.log.sql.includes('COMMIT'));
    assert.equal(pool.materials[2].ReorderLevel, '1');
  });

  it('a location-restricted user cannot change materials outside their locations', async () => {
    const pool = makePool({ allowed: [LOC1] });
    const limited = { businessId: A, userId: 'u2', isOwner: false, permissions: ['inventory.manage'] };
    await assert.rejects(() => bulkSetReorderLevel(pool, limited, { ids: [id(2)], reorderLevel: 3 }), (e) => e.code === 'material_not_found');
    assert.equal(pool.log.updates, 0);
    const ok = await bulkSetReorderLevel(pool, limited, { ids: [id(1)], reorderLevel: 3 });
    assert.equal(ok.updated, 1);
  });

  it('validates the id list and the reorder level', async () => {
    const pool = makePool();
    const bad = async (request, code) => assert.rejects(() => bulkSetReorderLevel(pool, owner, request), (e) => e.code === code);
    await bad({ ids: [], reorderLevel: 1 }, 'invalid_material_ids');
    await bad({ ids: [id(1), id(1)], reorderLevel: 1 }, 'invalid_material_ids');
    await bad({ ids: ['not-a-uuid'], reorderLevel: 1 }, 'invalid_material_ids');
    await bad({ ids: Array.from({ length: 101 }, (_, n) => id(n)), reorderLevel: 1 }, 'invalid_material_ids');
    await bad({ ids: [id(1)], reorderLevel: -1 }, 'invalid_quantity');
    await bad({ ids: [id(1)], reorderLevel: 1.2345 }, 'invalid_quantity');
    assert.equal(pool.log.updates, 0);
  });
});


describe('bulk inventory operations', () => {
  it('deactivates/reactivates selected materials and audits within tenant', async () => {
    const pool = makePool();
    const off = await bulkSetMaterialActive(pool, owner, { ids: [id(1)], active: false });
    assert.equal(off.updated, 1); assert.equal(off.items.find(x=>x.id===id(1)).active, false);
    await bulkSetMaterialActive(pool, owner, { ids: [id(1)], active: true });
    assert.equal(pool.log.states.get(id(1)), true);
    assert.deepEqual(pool.log.audits.map(a=>a.action), ['inventory.material_deactivated','inventory.material_activated']);
  });
  it('rejects cross-tenant deactivation without changes', async () => {
    const pool = makePool();
    await assert.rejects(()=>bulkSetMaterialActive(pool,owner,{ids:[id(3)],active:false}), e=>e.code==='material_not_found');
    assert.equal(pool.log.states.size,0); assert.equal(pool.log.audits.length,0);
  });
  it('moves only permitted tenant materials to a permitted active location', async () => {
    const pool = makePool();
    const result=await bulkMoveMaterials(pool,owner,{ids:[id(1)],locationId:LOC2});
    assert.equal(result.updated,1); assert.equal(pool.materials[0].LocationId,LOC2);
    assert.equal(pool.log.audits[0].action,'inventory.material_moved');
    await assert.rejects(()=>bulkMoveMaterials(pool,owner,{ids:[id(3)],locationId:LOC2}),e=>e.code==='material_not_found');
  });
  it('blocks moving materials with stock reserved for production', async () => {
    const pool = makePool();
    pool.materials[0].Reserved = '1.5';
    await assert.rejects(
      () => bulkMoveMaterials(pool, owner, { ids: [id(1)], locationId: LOC2 }),
      (e) => e.code === 'reserved_stock_protected' && e.status === 409,
    );
    assert.equal(pool.materials[0].LocationId, LOC1);
    assert.equal(pool.log.updates, 0);
    assert.equal(pool.log.audits.length, 0);
    assert.ok(pool.log.sql.includes('ROLLBACK'));
    assert.ok(!pool.log.sql.includes('COMMIT'));
  });
  it('rejects cross-tenant bulk stock adjustment without updating or recording movement', async () => {
    const pool = makePool();
    await assert.rejects(()=>bulkAdjustStock(pool,owner,{ids:[id(3)],quantity:2,reason:'cycle count'}),e=>e.code==='material_not_found');
    assert.equal(pool.log.movements.length,0); assert.equal(pool.log.audits.length,0);
  });
  it('requires a reason and prevents stock below reserved quantity', async () => {
    const pool = makePool();
    await assert.rejects(()=>bulkAdjustStock(pool,owner,{ids:[id(1)],quantity:4,reason:''}),e=>e.code==='adjustment_reason_required');
    pool.materials[0].Reserved='4';
    await assert.rejects(()=>bulkAdjustStock(pool,owner,{ids:[id(1)],quantity:3,reason:'cycle count'}),e=>e.code==='reserved_stock_protected');
    assert.equal(pool.log.movements.length,0);
  });
});
