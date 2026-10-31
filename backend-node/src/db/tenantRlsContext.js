import { AsyncLocalStorage } from 'node:async_hooks';

const tenantContext = new AsyncLocalStorage();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Lookup keys (see migration 0033). 'uuid' keys are validated before they are sent to PostgreSQL, which casts them.
export const LOOKUP_KINDS = Object.freeze({
  storefront_slug: 'text',
  storefront_id: 'uuid',
  storefront_redirect_slug: 'text',
  storefront_hostname: 'text',
  portal_token_hash: 'text',
  calendar_token_hash: 'text',
  rtw_payment_reference: 'text',
  invoice_payment_reference: 'text',
  subscription_payment_reference: 'text',
  email_provider_message_id: 'text',
  user_id: 'uuid',
  invitation_token_hash: 'text',
  session_token_hash: 'text',
  media_asset_id: 'uuid',
});
const MAX_LOOKUP_LENGTH = 512;

function newStore() {
  return { businessId: null, lookups: new Map(), platformScope: false };
}

export function runWithTenantRlsContext(callback) {
  return tenantContext.run(newStore(), callback);
}

function ensureStore() {
  let current = tenantContext.getStore();
  if (!current) {
    current = newStore();
    tenantContext.enterWith(current);
  }
  return current;
}

export function setTenantRlsContext(businessId) {
  if (typeof businessId !== 'string' || !UUID.test(businessId)) {
    throw new TypeError('A valid authenticated business ID is required for tenant-scoped database access.');
  }
  ensureStore().businessId = businessId;
}

export function clearTenantRlsContext() {
  const current = tenantContext.getStore();
  if (current) {
    current.businessId = null;
    current.lookups.clear();
    current.platformScope = false;
  }
}

/**
 * Tell PostgreSQL which public key this request holds (a slug, a token hash, a payment reference, a verified user id).
 * Only the row with that key becomes readable, and only for SELECT. The caller then reads the row's BusinessId and calls adoptTenant.
 * A key that is not on the list throws; a malformed uuid is ignored, so the lookup simply finds nothing.
 * Pass a checked-out client that is inside a transaction to apply it to that transaction immediately.
 */
export function setTenantLookup(name, value, db) {
  if (!Object.hasOwn(LOOKUP_KINDS, name)) throw new TypeError(`Unknown tenant lookup key: ${String(name)}`);
  const text = typeof value === 'string' ? value : '';
  const valid = text.length > 0 && text.length <= MAX_LOOKUP_LENGTH && (LOOKUP_KINDS[name] !== 'uuid' || UUID.test(text));
  const store = ensureStore();
  if (!valid) { store.lookups.delete(name); return undefined; }
  store.lookups.set(name, text);
  return db ? db.query('SELECT set_config($1, $2, true)', [`app.lookup_${name}`, text]) : undefined;
}

export function clearTenantLookups() {
  tenantContext.getStore()?.lookups.clear();
}

/** The row found through a lookup named its business: use that business from now on and drop the lookup keys. */
export function adoptTenant(businessId, db) {
  setTenantRlsContext(businessId);
  const lookups = [...tenantContext.getStore().lookups.keys()];
  tenantContext.getStore().lookups.clear();
  if (!db) return undefined;
  return (async () => {
    await db.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    for (const name of lookups) await db.query('SELECT set_config($1, $2, true)', [`app.lookup_${name}`, '']);
  })();
}

/** Allow this request to read and write EmailOutbox rows that belong to no business (account mails, dispatcher). Nothing else. */
export function setTenantPlatformScope(on = true) {
  ensureStore().platformScope = Boolean(on);
}

export function runWithTenantPlatformScope(callback) {
  return tenantContext.run({ ...newStore(), platformScope: true }, callback);
}

// Settings other than app.business_id that the current request needs on every query: lookup keys and platform scope.
function extraSettings() {
  const store = tenantContext.getStore();
  if (!store) return [];
  const extras = [...store.lookups].map(([name, value]) => [`app.lookup_${name}`, value]);
  if (store.platformScope) extras.push(['app.platform_scope', 'on']);
  return extras;
}

async function applySettings(runQuery) {
  const businessId = currentTenantRlsBusinessId();
  if (businessId) await runQuery("SELECT set_config('app.business_id', $1, true)", [businessId]);
  const extras = extraSettings();
  if (extras.length) {
    await runQuery('SELECT set_config(k, v, true) FROM unnest($1::text[], $2::text[]) AS t(k, v)', [extras.map((e) => e[0]), extras.map((e) => e[1])]);
  }
}

function hasSettings() {
  return Boolean(currentTenantRlsBusinessId()) || extraSettings().length > 0;
}

export function currentTenantRlsBusinessId() {
  const id = tenantContext.getStore()?.businessId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

// Accepts a SQL string or a node-postgres query config object ({ text, values }).
function sqlText(sql) {
  return typeof sql === 'string' ? sql : String(sql?.text ?? '');
}

function isTransactionControl(sql) {
  return /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sqlText(sql));
}

/**
 * Install transaction-local tenant context on all pool.query and checked-out-client queries.
 * GUC state is set with set_config(..., true), so it cannot leak through pooled connections.
 * Queries without authenticated tenant context remain unscoped and are denied by tenant RLS policies.
 */
export function installTenantRlsContext(pool) {
  if (!pool || pool.__tenantRlsContextInstalled) return pool;
  Object.defineProperty(pool, '__tenantRlsContextInstalled', { value: true });

  const rawPoolQuery = pool.query.bind(pool);
  const rawConnect = pool.connect.bind(pool);
  pool.query = function tenantScopedPoolQuery(sql, values, callback) {
    // Preserve node-postgres callback signatures; callbacks are uncommon in this codebase but supported.
    if (typeof values === 'function' || typeof callback === 'function') {
      const cb = typeof values === 'function' ? values : callback;
      const params = typeof values === 'function' ? undefined : values;
      return rawPoolQuery(sql, params, cb);
    }
    if (!hasSettings() || isTransactionControl(sql)) return rawPoolQuery(sql, values);
    return (async () => {
      // Use the undecorated client: this wrapper already sets the context itself, and the decorated client would set it a second time.
      const client = await rawConnect();
      try {
        await client.query('BEGIN');
        await applySettings((text, params) => client.query(text, params));
        const result = await client.query(sql, values);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    })();
  };

  pool.connect = function tenantScopedConnect(callback) {
    if (typeof callback === 'function') {
      return rawConnect((error, client, release) => {
        if (error) return callback(error, client, release);
        callback(null, decorateClient(client), release);
      });
    }
    return rawConnect().then(decorateClient);
  };

  function decorateClient(client) {
    if (client.__tenantRlsContextDecorated) return client;
    Object.defineProperty(client, '__tenantRlsContextDecorated', { value: true });
    const rawQuery = client.query.bind(client);
    let inTransaction = false;
    let settingTenant = false;

    async function scopedQuery(sql, values) {
      const scoped = hasSettings();
      const command = sqlText(sql).trim();
      if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(command)) {
        const result = await rawQuery(sql, values);
        inTransaction = true;
        if (scoped) {
          settingTenant = true;
          try { await applySettings(rawQuery); }
          finally { settingTenant = false; }
        }
        return result;
      }
      if (/^(COMMIT|END|ROLLBACK)\b/i.test(command)) {
        try { return await rawQuery(sql, values); }
        finally { inTransaction = false; }
      }
      if (settingTenant || !scoped || inTransaction || isTransactionControl(command)) {
        return rawQuery(sql, values);
      }
      await rawQuery('BEGIN');
      try {
        await applySettings(rawQuery);
        const result = await rawQuery(sql, values);
        await rawQuery('COMMIT');
        return result;
      } catch (error) {
        await rawQuery('ROLLBACK').catch(() => {});
        throw error;
      }
    }

    // pg-pool's own pool.query() calls client.query(text, values, callback) and releases the
    // client only inside that callback, so callback-style calls must be honoured. Dropping the
    // callback leaks the connection and hangs every later pool.query.
    client.query = function tenantScopedClientQuery(...args) {
      if (typeof args[args.length - 1] === 'function') {
        const cb = args.pop();
        scopedQuery(...args).then((result) => cb(null, result), (error) => cb(error));
        return undefined;
      }
      return scopedQuery(...args);
    };
    return client;
  }
  return pool;
}
