import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { defaultDocument } from '../src/auth/storefrontService.js';

const userId = '00000000-0000-4000-8000-000000000001';
const businessId = '00000000-0000-4000-8000-000000000002';
const otherBusinessId = '00000000-0000-4000-8000-000000000020';
const storefrontId = '00000000-0000-4000-8000-000000000003';
const domainId = '00000000-0000-4000-8000-000000000030';
const mediaId = '00000000-0000-4000-8000-000000000031';
const env = {
  NODE_ENV: 'test', PORT: 8081, HOST: '127.0.0.1', LOG_LEVEL: 'silent', STOREFRONT_BASE_DOMAIN: 'sites.example.test',
  STOREFRONT_DNS_LOOKUP: async () => [['verification-proof']],
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api', JWT_AUDIENCE: 'avzar-mobile', ACCESS_TOKEN_MINUTES: 10,
};

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    return { status: response.status, body, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function bearer(permissions = ['storefront.view', 'storefront.edit']) {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY, jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE, accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId, sessionId: '00000000-0000-4000-8000-000000000004' }).token;
}

function makePool({ seed = true, seedBusinessId = businessId, permissions = ['storefront.view', 'storefront.edit', 'storefront.publish'], customDomain = true, builder = true, domainCount = 0, existingDomain = false, lastCheckedAtUtc = null } = {}) {
  const statements = [];
  const versions = [];
  const versionMedia = [];
  let domain = { Id: domainId, Hostname: 'shop.example.test', Status: 'Pending', VerificationToken: 'verification-proof',
    VerifiedAtUtc: null, LastCheckedAtUtc: lastCheckedAtUtc, LastError: null };
  const entitlement = (key) => key === 'storefront.template_tier' ? 'premium'
    : key === 'storefront.custom_domain' ? String(customDomain)
      : key === 'storefront.builder' || key === 'storefront.custom_pages' ? String(builder)
        : key === 'storefront.pages.max' ? 'unlimited'
          : key === 'storefront.count.max' ? '10'
          : key?.includes('_level') ? 'full' : '0';
  let row = seed ? {
    Id: storefrontId, BusinessId: seedBusinessId, Name: 'Atelier', Slug: 'atelier', Status: 'Draft', TemplateKey: 'standard',
    PublishedVersionId: null,
    DraftRevision: 1, CreatedAtUtc: '2026-10-01T00:00:00.000Z', UpdatedAtUtc: null, PublishedVersion: null,
    HasUnpublishedChanges: true, ContactEmail: null, ContactPhone: null, Address: null, OpeningHours: null,
    WorkflowInquiry: true, WorkflowBooking: false, WorkflowCustomOrder: false, WorkflowContact: true,
    AllowSearchIndexing: true, Version: 1,
    DraftJson: JSON.stringify(defaultDocument('Atelier')),
  } : null;

  function queryResult(sql, values = []) {
    statements.push({ sql, values });
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: userId, BusinessId: businessId, Email: 'staff@example.test', FullName: 'Staff',
      BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: permissions }] };
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: entitlement(values[1]) }] };
    if (sql.includes('FROM "MediaAssets"')) return { rows: (values[1] ?? []).includes(mediaId) ? [{ Id: mediaId }] : [] };
    if (sql.includes('count(*)::bigint AS "Count"')) return { rows: [{ Count: row?.BusinessId === values[0] ? 1 : 0 }] };
    if (sql.includes('FROM "StorefrontDomains"') && sql.includes('count(*)::int')) return { rows: [{ Count: domainCount }] };
    if (sql.includes('FROM "StorefrontDomains"') && sql.includes('"Hostname" = $1')) return { rows: existingDomain ? [{ '?column?': 1 }] : [] };
    if (sql.includes('FROM "StorefrontDomains"') && sql.includes('"Id" = $1')) return { rows: row?.BusinessId === values[2] && values[0] === domainId && values[1] === storefrontId ? [domain] : [] };
    if (sql.includes('FROM "StorefrontDomains"') && sql.includes('"StorefrontId" = $1')) return { rows: domainCount ? [domain] : [] };
    if (sql.includes('FROM "SectionPresets"') && sql.includes('count(*)::int')) return { rows: [{ Count: 0 }] };
    if (sql.includes('FROM "SectionPresets"') && sql.includes('lower("Name")')) return { rows: [] };
    if (sql.includes('FROM "SectionPresets"')) return { rows: [] };
    if (sql.includes('FROM "Storefronts" s JOIN "Businesses"')) return { rows: row?.Id === values[0] ? [{
      Id: row.Id, BusinessId: row.BusinessId, Name: row.Name, Slug: row.Slug, DraftJson: row.DraftJson,
      ContactEmail: null, ContactPhone: null, Address: null, OpeningHours: null,
      WorkflowInquiry: true, WorkflowBooking: false, WorkflowCustomOrder: false, WorkflowContact: true,
      BusinessName: 'Shop', CurrencyCode: 'USD',
    }] : [] };
    if (sql.includes('FROM "Storefronts"') && sql.includes('WHERE "Id" = $1 AND "BusinessId" = $2')) return { rows: row?.Id === values[0] && row.BusinessId === values[1] ? [row] : [] };
    if (sql.includes('FROM "StorefrontVersions"') && sql.includes('COALESCE(max("VersionNumber")')) return { rows: [{ MaxVersion: versions.length }] };
    if (sql.includes('FROM "StorefrontVersions"') && sql.includes('"DocumentJson"')) {
      const version = versions.find((item) => item.VersionNumber === values[2] || item.Id === values[0]);
      return { rows: version ? [{ DocumentJson: version.DocumentJson }] : [] };
    }
    if (sql.includes('FROM "StorefrontVersions"') && sql.includes('ORDER BY "VersionNumber" DESC')) return { rows: versions.slice().reverse() };
    if (sql.includes('FROM "Storefronts"') && sql.includes('WHERE "Id" = $1 AND "BusinessId" = $2')) return { rows: row?.Id === values[0] && row.BusinessId === values[1] ? [{ Id: row.Id }] : [] };
    if (sql.includes('FROM "Storefronts"') && sql.includes('WHERE "Slug" = $1')) return { rows: [] };
    if (sql.includes('FROM "Storefronts" s')) {
      if (sql.includes('WHERE s."BusinessId" = $1')) return { rows: row?.BusinessId === values[0] ? [row] : [] };
      return { rows: row?.Id === values[0] && row.BusinessId === values[1] ? [row] : [] };
    }
    return { rows: [], rowCount: 1 };
  }

  return {
    statements, versionMedia,
    query: async (sql, values = []) => queryResult(sql, values),
    async connect() {
      return {
        async query(sql, values = []) {
          statements.push({ sql, values });
          if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: entitlement(values[1]) }] };
          if (sql.includes('FROM "MediaAssets"')) return { rows: (values[1] ?? []).includes(mediaId) ? [{ Id: mediaId }] : [] };
          if (sql.includes('count(*)::bigint AS "Count"')) return { rows: [{ Count: row?.BusinessId === values[0] ? 1 : 0 }] };
          if (sql.includes('FROM "Storefronts"') && sql.includes('WHERE "Slug" = $1')) return { rows: [] };
          if (sql.includes('FROM "Storefronts" s')) return { rows: row?.Id === values[0] && row.BusinessId === values[1] ? [row] : [] };
          if (sql.includes('FROM "Storefronts"') && sql.includes('WHERE "Id" = $1 AND "BusinessId" = $2')) return { rows: row?.Id === values[0] && row.BusinessId === values[1] ? [row] : [] };
          if (sql.includes('FROM "StorefrontVersions"') && sql.includes('COALESCE(max("VersionNumber")')) return { rows: [{ MaxVersion: versions.length }] };
          if (sql.includes('FROM "StorefrontVersions"') && sql.includes('"DocumentJson"')) {
            const version = versions.find((item) => item.VersionNumber === values[2] || item.Id === values[0]);
            return { rows: version ? [{ DocumentJson: version.DocumentJson }] : [] };
          }
          if (sql.includes('FROM "StorefrontVersions"') && sql.includes('ORDER BY "VersionNumber" DESC')) return { rows: versions.slice().reverse() };
          if (sql.startsWith('DELETE FROM "SectionPresets"')) return { rows: [{ Name: 'Hero sample' }], rowCount: 1 };
          if (sql.includes('FROM "SectionPresets"') && sql.includes('count(*)::int')) return { rows: [{ Count: 0 }] };
          if (sql.includes('FROM "SectionPresets"') && sql.includes('lower("Name")')) return { rows: [] };
          if (sql.includes('FROM "SectionPresets"')) return { rows: [] };
          if (sql.startsWith('INSERT INTO "Storefronts"')) {
            row = { Id: values[0], BusinessId: values[1], Name: values[2], Slug: values[3], TemplateKey: values[4], Status: 'Draft',
              DraftRevision: 1, CreatedAtUtc: '2026-10-18T00:00:00.000Z', UpdatedAtUtc: null, PublishedVersion: null,
              HasUnpublishedChanges: true, ContactEmail: null, ContactPhone: null, Address: null, OpeningHours: null,
              WorkflowInquiry: true, WorkflowBooking: false, WorkflowCustomOrder: false, WorkflowContact: true,
              AllowSearchIndexing: true, Version: 1 };
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO "StorefrontVersions"')) {
            versions.push({ Id: values[0], BusinessId: values[1], StorefrontId: values[2], VersionNumber: values[3],
              SchemaVersion: values[4], TemplateKey: values[5], DocumentJson: JSON.parse(values[6]), Note: values[7],
              PublishedByUserId: values[8], RolledBackFromVersion: values[9], CreatedAtUtc: '2026-10-18T00:00:00.000Z' });
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO "StorefrontVersionMedia"')) {
            versionMedia.push({ businessId: values[0], versionId: values[1], mediaId: values[2] });
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('UPDATE "Storefronts"') && sql.includes('SET "DraftJson"')) {
            row = { ...row, DraftJson: values[2], TemplateKey: values[3], DraftRevision: row.DraftRevision + 1 };
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('UPDATE "Storefronts"') && sql.includes('"PublishedVersionId" = $3')) {
            row = { ...row, PublishedVersionId: values[2], Status: 'Published', ...(sql.includes('"DraftJson"') ? { DraftJson: values[3], TemplateKey: values[4], DraftRevision: row.DraftRevision + 1 } : {}) };
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('UPDATE "Storefronts"') && sql.includes("'Unpublished'")) {
            row = { ...row, Status: 'Unpublished' };
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('UPDATE "Storefronts"')) {
            row = { ...row, Name: values[2], ContactEmail: values[3], ContactPhone: values[4], Address: values[5], OpeningHours: values[6],
              WorkflowInquiry: values[7], WorkflowBooking: values[8], WorkflowCustomOrder: values[9], WorkflowContact: values[10],
              AllowSearchIndexing: values[11], Version: row.Version + 1 };
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO "StorefrontDomains"')) {
            domain = { Id: values[0], Hostname: values[3], VerificationToken: values[4], Status: 'Pending', VerifiedAtUtc: null, LastCheckedAtUtc: null, LastError: null };
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO "SectionPresets"')) return { rows: [], rowCount: 1 };
          if (sql.startsWith('SELECT "Id" FROM "MediaAssets"') || sql.startsWith('SELECT "Id" FROM "DesignCollections"') || sql.startsWith('SELECT "Id" FROM "DesignCategories"')) return { rows: [] };
          if (sql.startsWith('UPDATE "StorefrontDomains"')) {
            domain = { ...domain, Status: values[3], LastCheckedAtUtc: '2026-10-18T00:00:00.000Z',
              VerifiedAtUtc: values[3] === 'Verified' ? '2026-10-18T00:00:00.000Z' : domain.VerifiedAtUtc, LastError: values[4] };
            return { rows: [domain], rowCount: 1 };
          }
          if (sql.startsWith('DELETE FROM "StorefrontDomains"')) return { rows: [{ Hostname: domain.Hostname }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
  };
}

describe('storefront owner routes', () => {
  it('lists and reads only storefronts belonging to the active business', async () => {
    const pool = makePool();
    const headers = { authorization: `Bearer ${bearer()}` };
    const list = await requestApp(createApp(env, pool), '/api/storefronts', { headers });
    assert.equal(list.status, 200);
    assert.equal(list.body[0].slug, 'atelier');

    const detail = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}`, { headers });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.publicUrlPath, 'https://atelier.sites.example.test');

    const crossBusiness = await requestApp(createApp(env, makePool({ seedBusinessId: otherBusinessId })), `/api/storefronts/${storefrontId}`, { headers });
    assert.equal(crossBusiness.status, 404);
  });

  it('creates a persistent source-shaped storefront with plan checks and audit', async () => {
    const pool = makePool({ seed: false });
    const result = await requestApp(createApp(env, pool), '/api/storefronts', {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Atelier', templateKey: 'standard' }),
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.name, 'New Atelier');
    assert.equal(result.body.slug, 'new-atelier');
    assert.equal(result.body.status, 'Draft');
    assert.equal(result.body.draftRevision, 1);
    assert.equal(pool.statements.some(({ sql }) => sql.startsWith('INSERT INTO "AuditLogs"')), true);
    const inserted = pool.statements.find(({ sql }) => sql.startsWith('INSERT INTO "Storefronts"'));
    const draft = JSON.parse(inserted.values[5]);
    assert.equal(draft.schemaVersion, 1);
    assert.equal(draft.templateKey, 'standard');
  });

  it('starts a new site from the template that was chosen, in the column and in the document', async () => {
    for (const [templateKey, preset] of [['bespoke', 'elegant'], ['luxury', 'modern-luxury']]) {
      const pool = makePool({ seed: false });
      const result = await requestApp(createApp(env, pool), '/api/storefronts', {
        method: 'POST', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New Atelier', templateKey }),
      });
      assert.equal(result.status, 201, templateKey);
      const inserted = pool.statements.find(({ sql }) => sql.startsWith('INSERT INTO "Storefronts"'));
      assert.equal(inserted.values[4], templateKey);
      const draft = JSON.parse(inserted.values[5]);
      assert.equal(draft.templateKey, templateKey);
      assert.equal(draft.theme.preset, preset);
      const home = draft.pages.find((page) => page.kind === 'home');
      assert.notDeepEqual(home.sections.map((item) => item.type), ['hero', 'designList', 'inquiryForm']);
    }
  });

  it('enforces validation, authentication, edit permission, and optimistic settings versions', async () => {
    const invalid = await requestApp(createApp(env, makePool()), '/api/storefronts', {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', templateKey: 'standard' }),
    });
    assert.equal(invalid.status, 400);

    const unauthenticated = await requestApp(createApp(env, makePool()), '/api/storefronts', {
      method: 'POST', headers: { authorization: 'Bearer invalid-token', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Site' }),
    });
    assert.equal(unauthenticated.status, 401);

    const noEdit = await requestApp(createApp(env, makePool({ permissions: ['storefront.view'] })), '/api/storefronts', {
      method: 'POST', headers: { authorization: `Bearer ${bearer(['storefront.view'])}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Site' }),
    });
    assert.equal(noEdit.status, 403);

    const pool = makePool();
    const updated = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/settings`, {
      method: 'PUT', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, name: 'Atelier One', workflowInquiry: true, workflowBooking: false, workflowCustomOrder: false, workflowContact: true, allowSearchIndexing: true }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Atelier One');

    const stale = await requestApp(createApp(env, makePool()), `/api/storefronts/${storefrontId}/settings`, {
      method: 'PUT', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 0, name: 'Atelier One' }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale_version');
  });

  it('requires storefront.publish to change a storefront address', async () => {
    const pool = makePool({ permissions: ['storefront.view', 'storefront.edit'] });
    const result = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/slug`, {
      method: 'PUT', headers: { authorization: `Bearer ${bearer(['storefront.view', 'storefront.edit'])}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, slug: 'new-address' }),
    });
    assert.equal(result.status, 403);
    assert.equal(pool.statements.some(({ sql }) => sql.includes('StorefrontSlugRedirects')), false);
  });
});

describe('storefront previews and custom domains', () => {
  it('creates a short-lived signed preview and returns only the current draft without cache', async () => {
    const pool = makePool();
    const link = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/preview-link`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(link.status, 200);
    assert.ok(Date.parse(link.body.expiresAtUtc) > Date.now());
    const preview = await requestApp(createApp(env, pool), `/public/preview/${encodeURIComponent(link.body.token)}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    assert.equal(preview.body.isPreview, true);
    assert.equal(preview.body.isSample, false);
    assert.equal(preview.body.allowSearchIndexing, false);

    const invalid = await requestApp(createApp(env, pool), '/public/preview/invalid-token');
    assert.equal(invalid.status, 404);
  });

  it('previews a sample of a template with its own look, using the shop name and no plan tier check', async () => {
    const pool = makePool();
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    for (const templateKey of ['bespoke', 'ready-to-wear', 'luxury', 'african-heritage', 'bridal', 'streetwear', 'atelier-studio']) {
      const link = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/preview-link`, {
        method: 'POST', headers, body: JSON.stringify({ templateKey }),
      });
      assert.equal(link.status, 200);
      const preview = await requestApp(createApp(env, pool), `/public/preview/${encodeURIComponent(link.body.token)}`);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('cache-control'), 'no-store');
      assert.equal(preview.body.isPreview, true);
      assert.equal(preview.body.isSample, true);
      assert.equal(preview.body.allowSearchIndexing, false);
      assert.equal(preview.body.templateKey, templateKey);
      assert.equal(preview.body.document.templateKey, templateKey);
      assert.equal(preview.body.name, 'Atelier');
      assert.ok(JSON.stringify(preview.body.document).includes('Atelier'));
    }
    assert.equal(pool.statements.some(({ values }) => values.includes('storefront.template_tier')), false, 'a sample must not need the plan tier');
    assert.equal(pool.statements.some(({ sql }) => /UPDATE "Storefronts"|INSERT INTO "Storefront/.test(sql)), false, 'a sample must save nothing');
  });

  it('refuses a sample of standard, of an unknown template, or for a malformed template key', async () => {
    const pool = makePool();
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    for (const templateKey of ['standard', 'no-such-template', 7, {}]) {
      const link = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/preview-link`, {
        method: 'POST', headers, body: JSON.stringify({ templateKey }),
      });
      assert.equal(link.status, 400, String(JSON.stringify(templateKey)));
      assert.equal(link.body.code, 'template_not_previewable');
    }
  });

  it('keeps a sample preview inside the business and the signature, and a plain link still shows the draft', async () => {
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const crossBusiness = await requestApp(createApp(env, makePool({ seedBusinessId: otherBusinessId })), `/api/storefronts/${storefrontId}/preview-link`, {
      method: 'POST', headers, body: JSON.stringify({ templateKey: 'luxury' }),
    });
    assert.equal(crossBusiness.status, 404);

    const pool = makePool();
    const link = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/preview-link`, {
      method: 'POST', headers, body: JSON.stringify({ templateKey: 'luxury' }),
    });
    const [payload, signature] = link.body.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), t: 'bespoke' })).toString('base64url');
    const tampered = await requestApp(createApp(env, pool), `/public/preview/${encodeURIComponent(`${forged}.${signature}`)}`);
    assert.equal(tampered.status, 404);

    const plain = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/preview-link`, { method: 'POST', headers });
    const draft = await requestApp(createApp(env, pool), `/public/preview/${encodeURIComponent(plain.body.token)}`);
    assert.equal(draft.status, 200);
    assert.equal(draft.body.templateKey, 'standard');
  });

  it('validates and persists custom domains only with entitlement and owner scope', async () => {
    const pool = makePool();
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const denied = await requestApp(createApp(env, makePool({ customDomain: false })), `/api/storefronts/${storefrontId}/domains`, {
      method: 'POST', headers, body: JSON.stringify({ hostname: 'shop.example.test' }),
    });
    assert.equal(denied.status, 403);

    const invalid = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/domains`, {
      method: 'POST', headers, body: JSON.stringify({ hostname: 'https://shop.example.test/path' }),
    });
    assert.equal(invalid.status, 400);

    const reserved = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/domains`, {
      method: 'POST', headers, body: JSON.stringify({ hostname: 'evil.sites.example.test' }),
    });
    assert.equal(reserved.status, 400);
    assert.equal(reserved.body.code, 'reserved_hostname');

    const added = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/domains`, {
      method: 'POST', headers, body: JSON.stringify({ hostname: 'Shop.Example.Test.' }),
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.hostname, 'shop.example.test');
    assert.equal(added.body.verificationRecordName, '_avzar-verify.shop.example.test');
    assert.ok(pool.statements.some(({ sql }) => sql.startsWith('INSERT INTO "StorefrontDomains"')));
  });

  it('verifies DNS TXT, rejects rapid rechecks, hides cross-business domains, and deletes with an audit', async () => {
    const headers = { authorization: `Bearer ${bearer()}` };
    const pool = makePool();
    const verified = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/domains/${domainId}/verify`, {
      method: 'POST', headers,
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.status, 'Verified');
    assert.ok(pool.statements.some(({ sql, values }) => sql.startsWith('INSERT INTO "AuditLogs"') && values[1] === 'storefront.domain_verified'));

    const tooSoon = await requestApp(createApp(env, makePool({ lastCheckedAtUtc: new Date().toISOString() })), `/api/storefronts/${storefrontId}/domains/${domainId}/verify`, {
      method: 'POST', headers,
    });
    assert.equal(tooSoon.status, 409);
    assert.equal(tooSoon.body.code, 'too_soon');

    const crossBusiness = await requestApp(createApp(env, makePool({ seedBusinessId: otherBusinessId })), `/api/storefronts/${storefrontId}/domains/${domainId}/verify`, {
      method: 'POST', headers,
    });
    assert.equal(crossBusiness.status, 404);

    const removedPool = makePool();
    const removed = await requestApp(createApp(env, removedPool), `/api/storefronts/${storefrontId}/domains/${domainId}`, {
      method: 'DELETE', headers,
    });
    assert.equal(removed.status, 204);
    assert.ok(removedPool.statements.some(({ sql, values }) => sql.startsWith('INSERT INTO "AuditLogs"') && values[1] === 'storefront.domain_removed'));
  });
});

describe('storefront draft and publish lifecycle', () => {
  it('validates publish requests and enforces publish permission, authentication, and business scope', async () => {
    const path = `/api/storefronts/${storefrontId}/publish`;
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const invalid = await requestApp(createApp(env, makePool()), path, {
      method: 'POST', headers, body: JSON.stringify({ note: 'x'.repeat(201) }),
    });
    assert.equal(invalid.status, 400);

    const unauthenticated = await requestApp(createApp(env, makePool()), path, {
      method: 'POST', headers: { authorization: 'Bearer invalid-token', 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(unauthenticated.status, 401);

    const forbidden = await requestApp(createApp(env, makePool({ permissions: ['storefront.view', 'storefront.edit'] })), path, {
      method: 'POST', headers: { ...headers, authorization: `Bearer ${bearer(['storefront.view', 'storefront.edit'])}` }, body: JSON.stringify({}),
    });
    assert.equal(forbidden.status, 403);

    const crossBusiness = await requestApp(createApp(env, makePool({ seedBusinessId: otherBusinessId })), path, {
      method: 'POST', headers, body: JSON.stringify({}),
    });
    assert.equal(crossBusiness.status, 404);
  });

  it('saves validated drafts, publishes immutable versions, unpublishes, and appends a rollback version', async () => {
    const pool = makePool();
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const initial = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/draft`, { headers });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.revision, 1);

    const document = structuredClone(initial.body.document);
    document.pages[0].title = 'Atelier home';
    document.pages[0].sections[0].props.imageMediaId = mediaId;
    document.theme.colors.text = '#FFFFFF';
    const saved = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/draft`, {
      method: 'PUT', headers, body: JSON.stringify({ document, expectedRevision: initial.body.revision }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 2);
    assert.equal(saved.body.document.pages[0].title, 'Atelier home');
    assert.equal(saved.body.contrastWarnings[0].foreground, 'text');
    assert.equal(saved.body.contrastWarnings[0].ratio, 1);

    const invalidDocument = structuredClone(saved.body.document);
    invalidDocument.pages[0].sections[0].props.headline = '<script>unsafe</script>';
    const invalid = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/draft`, {
      method: 'PUT', headers, body: JSON.stringify({ document: invalidDocument, expectedRevision: saved.body.revision }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_document');

    const published = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/publish`, {
      method: 'POST', headers, body: JSON.stringify({ note: 'Launch' }),
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.version.versionNumber, 1);
    assert.equal(published.body.version.note, 'Launch');
    assert.equal(published.body.contrastWarnings[0].foreground, 'text');

    const versions = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/versions`, { headers });
    assert.deepEqual(versions.body.map((version) => version.versionNumber), [1]);
    assert.equal(versions.body[0].isLive, true);
    const versionDocument = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/versions/1`, { headers });
    assert.equal(versionDocument.body.pages[0].title, 'Atelier home');

    const unpublished = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/unpublish`, { method: 'POST', headers });
    assert.equal(unpublished.status, 204);

    const nextDocument = structuredClone(saved.body.document);
    nextDocument.pages[0].title = 'Updated title';
    const savedAgain = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/draft`, {
      method: 'PUT', headers, body: JSON.stringify({ document: nextDocument, expectedRevision: 2 }),
    });
    assert.equal(savedAgain.status, 200);
    const publishedAgain = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/publish`, {
      method: 'POST', headers, body: JSON.stringify({}),
    });
    assert.equal(publishedAgain.body.version.versionNumber, 2);

    const rollback = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/versions/1/rollback`, {
      method: 'POST', headers, body: JSON.stringify({}),
    });
    assert.equal(rollback.status, 200);
    assert.equal(rollback.body.version.versionNumber, 3);
    assert.equal(rollback.body.version.rolledBackFromVersion, 1);
    assert.equal(pool.statements.filter(({ sql }) => sql.startsWith('INSERT INTO "StorefrontVersions"')).length, 3);
    assert.equal(pool.versionMedia.length, 3);
    assert.ok(pool.versionMedia.every((entry) => entry.mediaId === mediaId));
  });

  it('requires authentication, permissions, builder entitlement, and same-business ownership', async () => {
    const unauthenticated = await requestApp(createApp(env, makePool()), `/api/storefronts/${storefrontId}/draft`);
    assert.equal(unauthenticated.status, 401);

    const forbidden = await requestApp(createApp(env, makePool({ permissions: ['storefront.view'] })), `/api/storefronts/${storefrontId}/draft`, {
      method: 'PUT', headers: { authorization: `Bearer ${bearer(['storefront.view'])}`, 'content-type': 'application/json' },
      body: JSON.stringify({ document: {}, expectedRevision: 1 }),
    });
    assert.equal(forbidden.status, 403);

    const noBuilder = await requestApp(createApp(env, makePool({ builder: false })), `/api/storefronts/${storefrontId}/draft`, {
      method: 'PUT', headers: { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ document: {}, expectedRevision: 1 }),
    });
    assert.equal(noBuilder.status, 403);
    assert.equal(noBuilder.body.code, 'feature_not_in_plan');

    const crossBusiness = await requestApp(createApp(env, makePool({ seedBusinessId: otherBusinessId })), `/api/storefronts/${storefrontId}/draft`, {
      headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(crossBusiness.status, 404);
  });
});

describe('storefront builder catalog and presets', () => {
  it('returns the supported catalog, plan capabilities, and built-in presets', async () => {
    const response = await requestApp(createApp(env, makePool()), '/api/storefront-builder/catalog', {
      headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.templates.length, 8);
    assert.deepEqual(response.body.templates.map((template) => template.key), ['standard', 'bespoke', 'african-heritage', 'luxury', 'ready-to-wear', 'bridal', 'streetwear', 'atelier-studio']);
    assert.equal(response.body.templates.find((template) => template.key === 'standard').allowed, true);
    assert.deepEqual(response.body.templates.filter((template) => template.sample).map((template) => template.key).sort(), ['african-heritage', 'atelier-studio', 'bespoke', 'bridal', 'luxury', 'ready-to-wear', 'streetwear']);
    assert.equal(response.body.templates.find((template) => template.key === 'standard').sample, false);
    assert.equal(response.body.capabilities.builder, true);
    assert.equal(response.body.capabilities.maxPages, null);
    assert.equal(response.body.presets.length, 8);
    assert.ok(response.body.sectionTypes.some((type) => type.type === 'faq' && type.props.some((prop) => prop.name === 'items')));
  });

  it('creates and deletes tenant-scoped presets and rejects invalid input or missing permission', async () => {
    const pool = makePool();
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const created = await requestApp(createApp(env, pool), '/api/storefront-presets', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Hero sample', sectionType: 'hero', variant: 'minimal', props: { headline: 'Made for you' } }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Hero sample');
    assert.equal(created.body.isBuiltIn, false);
    assert.ok(pool.statements.some(({ sql }) => sql.startsWith('INSERT INTO "SectionPresets"')));

    const invalid = await requestApp(createApp(env, pool), '/api/storefront-presets', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Bad preset', sectionType: 'hero', variant: 'minimal', props: { headline: '<script>x</script>' } }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_document');

    const forbidden = await requestApp(createApp(env, makePool({ permissions: ['storefront.view'] })), '/api/storefront-presets', {
      method: 'POST', headers: { authorization: `Bearer ${bearer(['storefront.view'])}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hero sample', sectionType: 'hero', variant: 'minimal', props: { headline: 'Made for you' } }),
    });
    assert.equal(forbidden.status, 403);

    const deleted = await requestApp(createApp(env, pool), '/api/storefront-presets/00000000-0000-4000-8000-000000000099', {
      method: 'DELETE', headers: { authorization: `Bearer ${bearer()}` },
    });
    assert.equal(deleted.status, 204);
    assert.ok(pool.statements.some(({ sql }) => sql.startsWith('DELETE FROM "SectionPresets"') && sql.includes('"BusinessId" = $2')));
  });
});

describe('storefront template switching', () => {
  it('previews a deterministic switch plan and applies it only with the matching token and revision', async () => {
    const pool = makePool();
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const preview = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/template-switch?target=luxury`, { headers });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.fromTemplate, 'standard');
    assert.equal(preview.body.toTemplate, 'luxury');
    assert.ok(preview.body.needsConfirmation);
    assert.ok(preview.body.converted.length > 0);

    const applied = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/template-switch`, {
      method: 'POST', headers, body: JSON.stringify({ targetTemplate: 'luxury', token: preview.body.token, expectedRevision: 1 }),
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.document.templateKey, 'luxury');
    assert.ok(applied.body.revision > 1);
    assert.equal(applied.body.document.pages.find((page) => page.kind === 'about').sections[0].variant, 'split');
    assert.ok(applied.body.document.pages.every((page) => page.sections.every((section) => section.style.background == null && section.style.textColor == null && section.style.buttonShape == null)));
    assert.ok(pool.statements.some(({ sql, values }) => sql.startsWith('INSERT INTO "AuditLogs"') && values[1] === 'storefront.template_switched'));

    const stale = await requestApp(createApp(env, makePool()), `/api/storefronts/${storefrontId}/template-switch`, {
      method: 'POST', headers, body: JSON.stringify({ targetTemplate: 'luxury', token: preview.body.token, expectedRevision: 1 }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'plan_changed');
  });
});
describe('template switch and leftover section colours', () => {
  it('clears section colours kept from an older template but keeps alignment and spacing', async () => {
    const pool = makePool();
    const headers = { authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' };
    const draft = (await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/draft`, { headers })).body;
    const document = structuredClone(draft.document);
    Object.assign(document.pages[0].sections[0].style, { background: '#1F2937', textColor: '#111111', buttonShape: 'pill', align: 'right', spacing: 'spacious' });
    const saved = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/draft`, { method: 'PUT', headers, body: JSON.stringify({ document, expectedRevision: draft.revision }) });
    assert.equal(saved.status, 200);
    const plan = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/template-switch?target=luxury`, { headers });
    const applied = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/template-switch`, {
      method: 'POST', headers, body: JSON.stringify({ targetTemplate: 'luxury', token: plan.body.token, useTemplateTheme: true, expectedRevision: saved.body.revision }),
    });
    assert.equal(applied.status, 200);
    const style = applied.body.document.pages[0].sections[0].style;
    assert.equal(style.background, null);
    assert.equal(style.textColor, null);
    assert.equal(style.buttonShape, null);
    assert.equal(style.align, 'right');
    assert.equal(style.spacing, 'spacious');
  });
});
describe('storefront content-only editing on plans without the builder', () => {
  const headers = () => ({ authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' });
  const draftPath = `/api/storefronts/${storefrontId}/draft`;
  const save = (pool, document, expectedRevision = 1) => requestApp(createApp(env, pool), draftPath, {
    method: 'PUT', headers: headers(), body: JSON.stringify({ document, expectedRevision }),
  });
  const load = async (pool) => (await requestApp(createApp(env, pool), draftPath, { headers: headers() })).body;

  it('saves text, image and contact changes inside existing sections', async () => {
    const pool = makePool({ builder: false });
    const initial = await load(pool);
    const document = structuredClone(initial.document);
    document.pages[0].sections[0].props.headline = 'Tailored for you';
    document.pages[0].sections[0].props.imageMediaId = mediaId;
    document.pages[0].seo.title = 'Atelier in town';
    const saved = await save(pool, document, initial.revision);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, initial.revision + 1);
    assert.equal(saved.body.document.pages[0].sections[0].props.headline, 'Tailored for you');
    assert.ok(pool.statements.some(({ sql, values }) => sql.startsWith('INSERT INTO "AuditLogs"') && values[1] === 'storefront.draft_saved'));
  });

  it('lets a plan without the builder hide and show a section that is not an entry point', async () => {
    const pool = makePool({ builder: false });
    const initial = await load(pool);
    const document = structuredClone(initial.document);
    const target = document.pages[0].sections.find((s) => s.type !== 'inquiryForm' && s.type !== 'contactInfo');
    target.visible = false;
    const saved = await save(pool, document, initial.revision);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.document.pages[0].sections.find((s) => s.id === target.id).visible, false);
    const again = structuredClone(saved.body.document);
    again.pages[0].sections.find((s) => s.id === target.id).visible = true;
    assert.equal((await save(pool, again, saved.body.revision)).status, 200);
  });

  it('rejects structural changes on the backend and saves nothing', async () => {
    const changes = {
      'removing a section': (d) => { d.pages[0].sections.pop(); },
      'adding a section': (d) => { d.pages[0].sections.push({ ...structuredClone(d.pages[0].sections[0]), id: 'extra-section-1' }); },
      'reordering sections': (d) => { d.pages[0].sections.reverse(); },
      'changing a layout': (d) => { d.pages[0].sections[0].variant = d.pages[0].sections[0].variant === 'minimal' ? 'centered' : 'minimal'; },
      'hiding the enquiry form': (d) => { d.pages[0].sections.find((s) => s.type === 'inquiryForm').visible = false; },
      'hiding every section of a page': (d) => { d.pages[1].sections.forEach((s) => { s.visible = false; }); },
      'section styling': (d) => { d.pages[0].sections[0].style.spacing = 'spacious'; },
      'adding a custom page': (d) => { d.pages.push({ id: 'custom-page-1', kind: 'custom', slug: 'extra', title: 'Extra', visible: true, seo: { title: null, description: null, shareImageMediaId: null }, sections: [] }); },
      'removing a page': (d) => { d.pages.pop(); },
      'changing the menu': (d) => { d.navigation = d.navigation.slice(1); },
      'changing the template': (d) => { d.templateKey = 'luxury'; },
    };
    for (const [name, change] of Object.entries(changes)) {
      const pool = makePool({ builder: false });
      const initial = await load(pool);
      const document = structuredClone(initial.document);
      change(document);
      const response = await save(pool, document, initial.revision);
      assert.equal(response.status, 403, name);
      assert.equal(response.body.code, 'feature_not_in_plan', name);
      assert.equal(response.body.contentOnly, true, name);
      assert.equal(response.body.entitlement, 'storefront.builder', name);
      assert.equal(pool.statements.some(({ sql }) => sql.startsWith('UPDATE "Storefronts"') && sql.includes('SET "DraftJson"')), false, name);
      assert.equal((await load(pool)).revision, initial.revision, name);
    }
  });

  it('keeps the same structural changes available on plans with the builder', async () => {
    const pool = makePool({ builder: true });
    const initial = await load(pool);
    const document = structuredClone(initial.document);
    document.pages[0].sections.reverse();
    document.pages[0].sections[0].visible = false;
    const saved = await save(pool, document, initial.revision);
    assert.equal(saved.status, 200);
  });

  it('still applies the stale-revision and invalid-content checks without the builder', async () => {
    const pool = makePool({ builder: false });
    const initial = await load(pool);
    const stale = await save(pool, structuredClone(initial.document), initial.revision + 5);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale_revision');
    const invalid = structuredClone(initial.document);
    invalid.pages[0].sections[0].props.headline = '<script>unsafe</script>';
    const rejected = await save(pool, invalid, initial.revision);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'invalid_document');
  });

  it('does not let another business read or save a draft, builder or not', async () => {
    const pool = makePool({ builder: false, seedBusinessId: otherBusinessId });
    const read = await requestApp(createApp(env, pool), draftPath, { headers: headers() });
    assert.equal(read.status, 404);
    const document = structuredClone(defaultDocument('Atelier'));
    document.pages[0].sections[0].props.headline = 'Hijacked';
    const response = await save(pool, document, 1);
    assert.equal(response.status, 404);
  });
});

describe('storefront draft reset', () => {
  const headers = () => ({ authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' });
  const post = (pool, path, body) => requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const draftOf = async (pool) => (await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/draft`, { headers: headers() })).body;

  it('starts a never-published site over from its template starter and records an audit entry', async () => {
    const pool = makePool();
    const initial = await draftOf(pool);
    const edited = structuredClone(initial.document);
    edited.pages[0].sections[0].props.headline = 'Something I want to throw away';
    const saved = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/draft`, { method: 'PUT', headers: headers(), body: JSON.stringify({ document: edited, expectedRevision: initial.revision }) });
    assert.equal(saved.status, 200);

    const reset = await post(pool, 'draft/reset', { expectedRevision: saved.body.revision });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.source, 'starter');
    assert.equal(reset.body.revision, saved.body.revision + 1);
    assert.notEqual(reset.body.document.pages[0].sections[0].props.headline, 'Something I want to throw away');
    assert.ok(pool.statements.some(({ sql, values }) => sql.startsWith('INSERT INTO "AuditLogs"') && values[1] === 'storefront.draft_reset'));
  });

  it('returns a published site to exactly what is live', async () => {
    const pool = makePool();
    const published = await post(pool, 'publish', {});
    assert.equal(published.status, 200);
    const live = (await draftOf(pool));
    const edited = structuredClone(live.document);
    edited.pages[0].sections[0].props.headline = 'Unpublished experiment';
    const saved = await requestApp(createApp(env, pool), `/api/storefronts/${storefrontId}/draft`, { method: 'PUT', headers: headers(), body: JSON.stringify({ document: edited, expectedRevision: live.revision }) });
    assert.equal(saved.status, 200);

    const reset = await post(pool, 'draft/reset', { expectedRevision: saved.body.revision });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.source, 'published');
    assert.deepEqual(reset.body.document, live.document);
  });

  it('refuses a stale revision and a user without edit permission', async () => {
    const pool = makePool();
    const stale = await post(pool, 'draft/reset', { expectedRevision: 99 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale_revision');
    const denied = await requestApp(createApp(env, makePool({ permissions: ['storefront.view'] })), `/api/storefronts/${storefrontId}/draft/reset`, { method: 'POST', headers: headers(), body: JSON.stringify({ expectedRevision: 1 }) });
    assert.equal(denied.status, 403);
  });
});
describe('template switch can add the new template\u2019s sections', () => {
  const headers = () => ({ authorization: `Bearer ${bearer()}`, 'content-type': 'application/json' });
  const base = `/api/storefronts/${storefrontId}`;
  const sectionCount = (document) => document.pages.reduce((total, page) => total + page.sections.length, 0);
  const preview = (pool, target = 'luxury') => requestApp(createApp(env, pool), `${base}/template-switch?target=${target}`, { headers: headers() });
  const apply = (pool, body) => requestApp(createApp(env, pool), `${base}/template-switch`, { method: 'POST', headers: headers(), body: JSON.stringify({ expectedRevision: 1, ...body }) });

  it('lists the sections the draft lacks and says whether the plan may add them', async () => {
    const plan = await preview(makePool());
    assert.equal(plan.status, 200);
    assert.ok(plan.body.additions.length > 0);
    assert.ok(plan.body.additions.every((item) => item.type && item.variant && item.page));
    assert.equal(plan.body.canAddSections, true);
    const noBuilder = await preview(makePool({ builder: false }));
    assert.equal(noBuilder.body.canAddSections, false);
  });

  it('keeps only the owner\u2019s sections unless asked to add the template\u2019s', async () => {
    const pool = makePool();
    const plan = await preview(pool);
    const before = sectionCount((await requestApp(createApp(env, pool), `${base}/draft`, { headers: headers() })).body.document);
    const keepOnly = await apply(pool, { targetTemplate: 'luxury', token: plan.body.token });
    assert.equal(keepOnly.status, 200);
    assert.equal(keepOnly.body.added, 0);
    assert.equal(sectionCount(keepOnly.body.document), before);
  });

  it('appends the missing sections after the owner\u2019s own when asked, and records how many', async () => {
    const pool = makePool();
    const plan = await preview(pool);
    const added = await apply(pool, { targetTemplate: 'luxury', token: plan.body.token, addTemplateSections: true });
    assert.equal(added.status, 200);
    assert.equal(added.body.added, plan.body.additions.length);
    const home = added.body.document.pages.find((page) => page.kind === 'home');
    assert.deepEqual(home.sections.slice(-plan.body.additions.length).map((section) => section.type), plan.body.additions.filter((item) => item.page === home.title).map((item) => item.type));
    const ids = added.body.document.pages.flatMap((page) => page.sections.map((section) => section.id));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(pool.statements.some(({ sql, values }) => sql.startsWith('INSERT INTO "AuditLogs"') && values[1] === 'storefront.template_switched'));
    const again = await preview(pool);
    assert.equal(again.body.additions.length, 0);
  });

  it('refuses to add sections on a plan without the visual builder, but still allows the plain switch', async () => {
    const pool = makePool({ builder: false });
    const plan = await preview(pool);
    const denied = await apply(pool, { targetTemplate: 'luxury', token: plan.body.token, addTemplateSections: true });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'feature_not_in_plan');
    const plain = await apply(pool, { targetTemplate: 'luxury', token: plan.body.token });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.added, 0);
  });

  it('points an added button at the draft\u2019s own page, not the starter\u2019s page id', async () => {
    const pool = makePool();
    const draft = (await requestApp(createApp(env, pool), `${base}/draft`, { headers: headers() })).body;
    const document = structuredClone(draft.document);
    document.pages[0].sections = document.pages[0].sections.filter((section) => section.type !== 'hero');
    const saved = await requestApp(createApp(env, pool), `${base}/draft`, { method: 'PUT', headers: headers(), body: JSON.stringify({ document, expectedRevision: draft.revision }) });
    assert.equal(saved.status, 200);
    const plan = await preview(pool, 'ready-to-wear');
    const applied = await apply(pool, { targetTemplate: 'ready-to-wear', token: plan.body.token, addTemplateSections: true, expectedRevision: saved.body.revision });
    assert.equal(applied.status, 200);
    const hero = applied.body.document.pages[0].sections.find((section) => section.type === 'hero');
    const catalog = applied.body.document.pages.find((page) => page.kind === 'catalog');
    assert.equal(hero.props.buttonTarget, catalog.id);
  });
});
