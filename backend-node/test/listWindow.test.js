import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_CAP, optionalPaging, respondList, windowedRows } from '../src/auth/listWindow.js';

function fakeRes() {
  const res = { statusCode: null, headers: {}, body: null };
  res.set = (headers) => { Object.assign(res.headers, headers); return res; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

describe('optionalPaging', () => {
  it('is null without paging parameters', () => {
    assert.equal(optionalPaging({}), null);
    assert.equal(optionalPaging({ status: 'x' }), null);
  });
  it('reads page and pageSize, filling in the missing one', () => {
    assert.deepEqual(optionalPaging({ page: '3', pageSize: '10' }), { page: 3, pageSize: 10 });
    assert.deepEqual(optionalPaging({ page: '2' }), { page: 2, pageSize: 25 });
    assert.deepEqual(optionalPaging({ pageSize: '50' }), { page: 1, pageSize: 50 });
  });
  it('refuses a bad page or a page size over 100', () => {
    for (const query of [{ page: '0' }, { page: 'x' }, { pageSize: '0' }, { pageSize: '101' }, { page: '1.5e3', pageSize: 'abc' }]) {
      assert.throws(() => optionalPaging(query), (error) => error.status === 400 && error.code === 'invalid_paging', JSON.stringify(query));
    }
  });
});

describe('windowedRows', () => {
  it('appends the window to the SELECT and counts the same SELECT', async () => {
    const calls = [];
    const query = async (sql, params) => {
      calls.push({ sql, params });
      return sql.startsWith('SELECT count') ? { rows: [{ TotalCount: 7 }] } : { rows: [{ Id: 1 }, { Id: 2 }] };
    };
    const result = await windowedRows(query, 'SELECT "Id" FROM "T" WHERE "BusinessId"=$1 ORDER BY "Id"', ['b'], { limit: 2, offset: 4 });
    assert.deepEqual(result, { rows: [{ Id: 1 }, { Id: 2 }], totalCount: 7 });
    assert.equal(calls[0].sql, 'SELECT "Id" FROM "T" WHERE "BusinessId"=$1 ORDER BY "Id" LIMIT $2 OFFSET $3');
    assert.deepEqual(calls[0].params, ['b', 2, 4]);
    assert.equal(calls[1].sql, 'SELECT count(*)::int AS "TotalCount" FROM (SELECT "Id" FROM "T" WHERE "BusinessId"=$1 ORDER BY "Id") counted');
    assert.deepEqual(calls[1].params, ['b']);
  });
  it('treats a missing count row as zero', async () => {
    const result = await windowedRows(async () => ({ rows: [] }), 'SELECT 1 ORDER BY 1', [], { limit: 1, offset: 0 });
    assert.equal(result.totalCount, 0);
  });
});

describe('respondList', () => {
  const source = (total, seen = []) => async (window) => {
    seen.push(window);
    return { rows: Array.from({ length: Math.min(window.limit, Math.max(0, total - window.offset)) }, (_, index) => ({ n: window.offset + index })), totalCount: total };
  };

  it('sends a plain array with total headers and no truncation when everything fits', async () => {
    const res = fakeRes();
    const seen = [];
    await respondList(res, {}, source(3, seen));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 3);
    assert.deepEqual(seen, [{ limit: LIST_CAP, offset: 0 }]);
    assert.deepEqual(res.headers, { 'X-Total-Count': '3', 'X-Result-Limit': String(LIST_CAP), 'X-Truncated': 'false' });
  });

  it('flags a list longer than the cap as truncated', async () => {
    const res = fakeRes();
    await respondList(res, {}, source(LIST_CAP + 350));
    assert.equal(res.body.length, LIST_CAP);
    assert.equal(res.headers['X-Total-Count'], String(LIST_CAP + 350));
    assert.equal(res.headers['X-Truncated'], 'true');
  });

  it('uses the cap a route asks for', async () => {
    const res = fakeRes();
    await respondList(res, {}, source(250), { cap: 100 });
    assert.equal(res.body.length, 100);
    assert.equal(res.headers['X-Result-Limit'], '100');
    assert.equal(res.headers['X-Truncated'], 'true');
  });

  it('sends the standard envelope for a page, with no total headers', async () => {
    const res = fakeRes();
    const seen = [];
    await respondList(res, { page: '3', pageSize: '10' }, source(45, seen));
    assert.deepEqual(seen, [{ limit: 10, offset: 20 }]);
    assert.equal(res.body.page, 3);
    assert.equal(res.body.pageSize, 10);
    assert.equal(res.body.totalCount, 45);
    assert.equal(res.body.items.length, 10);
    assert.deepEqual(res.headers, {});
  });

  it('refuses bad paging before reading anything', async () => {
    const seen = [];
    await assert.rejects(() => respondList(fakeRes(), { pageSize: '500' }, source(5, seen)), (error) => error.code === 'invalid_paging');
    assert.equal(seen.length, 0);
  });
});
