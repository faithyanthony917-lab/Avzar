import { runWithTenantRlsContext, setTenantRlsContext } from '../db/tenantRlsContext.js';
import { isRlsPool } from '../db/userScope.js';
import { describeError } from '../http/errors.js';

const MEDIA_KEY = /^([0-9a-f]{32})\/([0-9a-f]{32})\/(orig|md|sm)\.webp$/;
const DOCUMENT_KEY = /^([0-9a-f]{32})\/d\/([0-9a-f]{32})\.bin$/;
const BATCH_SIZE = 200;

function pairKey(businessId, ownerId) {
  return `${String(businessId).replaceAll('-', '').toLowerCase()}:${String(ownerId).replaceAll('-', '').toLowerCase()}`;
}

function candidateFor(key) {
  const media = MEDIA_KEY.exec(key);
  if (media) return { key, businessId: media[1], ownerId: media[2], document: false };
  const document = DOCUMENT_KEY.exec(key);
  if (document) return { key, businessId: document[1], ownerId: document[2], document: true };
  return null;
}

// A storage key begins with its business ID as 32 hex digits. Tenant tables are isolated by business (row-level security), so a
// row can only be seen from that business's own context: with no context every object would look orphaned and be deleted.
// Each business's candidates are therefore checked under that business's context. A key whose prefix cannot be read as a
// business ID is treated as live (kept): this sweep must never delete on a guess.
const businessUuid = (hex) => (/^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null);

async function existingObjects(pool, candidates, table) {
  if (!candidates.length) return new Set();
  const live = new Set();
  const byBusiness = new Map();
  for (const candidate of candidates) {
    if (!byBusiness.has(candidate.businessId)) byBusiness.set(candidate.businessId, []);
    byBusiness.get(candidate.businessId).push(candidate);
  }
  for (const [businessHex, group] of byBusiness) {
    const businessId = businessUuid(businessHex);
    if (!businessId) { for (const candidate of group) live.add(pairKey(candidate.businessId, candidate.ownerId)); continue; }
    const ids = [...new Set(group.map((candidate) => candidate.ownerId))];
    const select = () => pool.query(`
      SELECT "Id", "BusinessId" FROM "${table}"
      WHERE "Id" = ANY($1::uuid[]) AND "BusinessId" = $2::uuid`, [ids, businessId]);
    let rows;
    try {
      // Without the tenant wrapper there is no row-level security and one unscoped query is enough.
      rows = isRlsPool(pool) ? await runWithTenantRlsContext(async () => { setTenantRlsContext(businessId); return (await select()).rows; }) : (await select()).rows;
    } catch (error) {
      // A business ID the tenant context refuses cannot be checked, so its objects are kept rather than guessed at.
      if (!(error instanceof TypeError)) throw error;
      for (const candidate of group) live.add(pairKey(candidate.businessId, candidate.ownerId));
      continue;
    }
    for (const row of rows) live.add(pairKey(row.BusinessId, row.Id));
  }
  return live;
}

export async function cleanOrphanObjects({ pool, storage, graceHours = 24, maxDeletes = 500, now = new Date(), log = console }) {
  if (!pool || !storage || typeof storage.list !== 'function') throw new TypeError('pool and list-capable storage are required.');
  const cutoff = now.getTime() - Math.max(1, graceHours) * 3_600_000;
  const deleteLimit = Math.max(1, Math.min(5000, Math.trunc(maxDeletes)));
  let scanned = 0;
  let deleted = 0;
  let skipped = 0;
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const media = batch.filter((candidate) => !candidate.document);
    const documents = batch.filter((candidate) => candidate.document);
    const [liveMedia, liveDocuments] = await Promise.all([
      existingObjects(pool, media, 'MediaAssets'), existingObjects(pool, documents, 'Documents'),
    ]);
    for (const candidate of batch) {
      const live = candidate.document ? liveDocuments : liveMedia;
      if (live.has(pairKey(candidate.businessId, candidate.ownerId))) continue;
      if (deleted >= deleteLimit) { skipped++; continue; }
      await storage.delete(candidate.key);
      deleted++;
      log.info?.('Deleted orphaned storage object.', { key: candidate.key });
    }
    batch = [];
  };

  for await (const object of storage.list()) {
    scanned++;
    const modified = new Date(object.lastModifiedUtc).getTime();
    if (!Number.isFinite(modified) || modified > cutoff) { skipped++; continue; }
    const candidate = candidateFor(object.key);
    if (!candidate) { skipped++; continue; }
    batch.push(candidate);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return { scanned, deleted, skipped };
}

export function startOrphanCleanupWorker({ pool, storage, enabled = true, graceHours = 24, intervalMinutes = 360,
  maxDeletes = 500, startupDelayMs = 120_000, log = console, schedule = setTimeout, cancel = clearTimeout }) {
  if (!pool || !storage || !enabled) return async () => {};
  let stopped = false;
  let timer = null;
  let running = null;

  const cycle = async () => {
    if (stopped) return;
    running = cleanOrphanObjects({ pool, storage, graceHours, maxDeletes, log });
    try {
      const result = await running;
      log.info?.('Orphan cleanup completed.', result);
    } catch (error) {
      log.error?.('Orphan cleanup failed; it will retry.', { errorType: error?.constructor?.name ?? 'Error', error: describeError(error) });
    } finally {
      running = null;
    }
    if (!stopped) timer = schedule(() => { timer = null; void cycle(); }, Math.max(5, intervalMinutes) * 60_000);
  };

  // Wait (2 minutes by default) after boot before the first sweep so startup traffic is not competing with a bucket listing.
  timer = schedule(() => { timer = null; void cycle(); }, Math.max(0, startupDelayMs));
  return async () => {
    stopped = true;
    if (timer !== null) cancel(timer);
    await running?.catch(() => {});
  };
}