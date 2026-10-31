import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARRAY_COLUMNS, REQUIRED_FKS, compareSchema, formatReport } from '../../scripts/check-schema.js';

const baseline = { Designs: { columns: { Id: { nullable: false }, Name: { nullable: false } } }, Plans: { columns: { Id: { nullable: false } } } };
const col = (t, c, udt = 'text', nullable = 'NO') => ({ table_name: t, column_name: c, udt_name: udt, is_nullable: nullable });

describe('check-schema compareSchema', () => {
  it('reports missing tables, columns, array problems and foreign keys, and passes a complete schema', () => {
    const bad = compareSchema({ columnRows: [col('Designs', 'Id', 'uuid'), col('Designs', 'Tags', 'text', 'NO')], fkRows: [], baseline });
    assert.deepEqual(bad.missingTables.filter((t) => t === 'Plans'), ['Plans']);
    assert.ok(bad.missingColumns.includes('Designs.Name'));
    assert.ok(bad.arrayProblems.some((p) => p.startsWith('Designs.Tags')));
    assert.ok(bad.problems > 0);
    assert.match(formatReport(bad), /^MISSING TABLES/m);

    const tables = new Set([...Object.keys(baseline), ...ARRAY_COLUMNS.map((a) => a[0]), ...REQUIRED_FKS.flatMap((f) => [f[0], f[2]])]);
    const columnRows = [...Object.entries(baseline).flatMap(([t, d]) => Object.keys(d.columns).map((c) => col(t, c))),
      ...ARRAY_COLUMNS.map(([t, c, udt]) => col(t, c, udt))];
    for (const t of tables) if (!columnRows.some((r) => r.table_name === t)) columnRows.push(col(t, 'Id', 'uuid'));
    const fkRows = REQUIRED_FKS.map(([tbl, cols, ref_tbl]) => ({ tbl, cols, ref_tbl, name: 'x' }));
    const ok = compareSchema({ columnRows, fkRows, baseline });
    assert.equal(ok.problems, 0);
    assert.match(formatReport(ok), /^OK:/m);
  });

  it('flags a foreign key whose column order differs', () => {
    const r = compareSchema({
      columnRows: [col('Materials', 'Id', 'uuid'), col('Locations', 'Id', 'uuid')],
      fkRows: [{ tbl: 'Materials', cols: ['BusinessId', 'LocationId'], ref_tbl: 'Locations', name: 'x' }], baseline: {},
    });
    assert.ok(r.missingFks.includes('Materials(LocationId, BusinessId) -> Locations'));
  });
});
