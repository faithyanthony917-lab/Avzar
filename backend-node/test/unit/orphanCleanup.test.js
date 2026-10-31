import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createObjectStorage } from '../../src/auth/objectStorage.js';
import { cleanOrphanObjects, startOrphanCleanupWorker } from '../../src/storage/orphanCleanup.js';

const businessA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const businessB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const assetLive = '11111111111111111111111111111111';
const assetOrphan = '22222222222222222222222222222222';
const assetRecent = '33333333333333333333333333333333';
const assetCrossBusiness = '44444444444444444444444444444444';
const documentLive = '55555555555555555555555555555555';
const documentOrphan = '66666666666666666666666666666666';
const now = new Date('2026-10-18T12:00:00.000Z');
const oldTime = new Date(now.getTime() - 30 * 60 * 60 * 1000);
const recentTime = new Date(now.getTime() - 60 * 60 * 1000);

describe('orphan storage cleanup', () => {
  it('deletes only stale exact-key objects without a same-business database row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'avzar-orphans-'));
    const storage = createObjectStorage({ STORAGE_PROVIDER: 'local', STORAGE_LOCAL_ROOT: root });
    const keys = {
      liveMedia: `${businessA}/${assetLive}/orig.webp`,
      orphanMedia: `${businessA}/${assetOrphan}/md.webp`,
      recentMedia: `${businessA}/${assetRecent}/sm.webp`,
      crossBusinessMedia: `${businessA}/${assetCrossBusiness}/orig.webp`,
      unknown: 'unrecognized/keep.txt',
      liveDocument: `${businessA}/d/${documentLive}.bin`,
      orphanDocument: `${businessA}/d/${documentOrphan}.bin`,
    };

    try {
      for (const [name, key] of Object.entries(keys)) {
        await storage.put(key, Buffer.from(name));
        const modified = name === 'recentMedia' ? recentTime : oldTime;
        const file = path.join(root, ...key.split('/'));
        await utimes(file, modified, modified);
      }

      const pool = {
        async query(sql) {
          if (sql.includes('FROM "MediaAssets"')) return { rows: [
            { Id: assetLive, BusinessId: businessA },
            { Id: assetCrossBusiness, BusinessId: businessB },
          ] };
          if (sql.includes('FROM "Documents"')) return { rows: [{ Id: documentLive, BusinessId: businessA }] };
          throw new Error(`Unexpected cleanup query: ${sql}`);
        },
      };

      const result = await cleanOrphanObjects({ pool, storage, graceHours: 24, maxDeletes: 10, now, log: {} });

      assert.deepEqual(result, { scanned: 7, deleted: 3, skipped: 2 });
      for (const name of ['liveMedia', 'recentMedia', 'unknown', 'liveDocument']) {
        assert.ok(await storage.openRead(keys[name]), `${name} must be preserved`);
      }
      for (const name of ['orphanMedia', 'crossBusinessMedia', 'orphanDocument']) {
        assert.equal(await storage.openRead(keys[name]), null, `${name} must be deleted`);
      }
    } finally {
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores uppercase-hex keys (C# matches lowercase only)', async () => {
    const upper = `${businessA.toUpperCase()}/${assetOrphan.toUpperCase()}/orig.webp`;
    const storage = { async *list() { yield { key: upper, lastModifiedUtc: oldTime.toISOString() }; }, async delete() { throw new Error('must not delete'); } };
    const result = await cleanOrphanObjects({ pool: { async query() { throw new Error('no query expected'); } }, storage, now, log: {} });
    assert.deepEqual(result, { scanned: 1, deleted: 0, skipped: 1 });
  });

  it('waits for the startup delay (default 2 minutes) before the first sweep, then repeats on the interval', async () => {
    const scheduled = [];
    let lists = 0;
    const storage = { async *list() { lists++; }, async delete() {} };
    const stop = startOrphanCleanupWorker({
      pool: {}, storage, intervalMinutes: 360, log: {},
      schedule: (fn, ms) => { const t = { fn, ms }; scheduled.push(t); return t; }, cancel: () => {},
    });
    assert.equal(lists, 0, 'no sweep may run at boot');
    assert.equal(scheduled[0].ms, 120_000);
    scheduled[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lists, 1);
    assert.equal(scheduled[1].ms, 360 * 60_000);
    await stop();
  });
});
