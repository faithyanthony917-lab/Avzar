import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { createApp } from '../src/http/app.js';
import { issueAccessToken } from '../src/security/jwt.js';
import { createObjectStorage } from '../src/auth/objectStorage.js';
import { createVirusScanner } from '../src/auth/documentService.js';
import { getMedia, listMedia, openMedia } from '../src/auth/mediaService.js';

const env = {
  NODE_ENV: 'test',
  PORT: 8081,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEY: 'test-signing-key-with-at-least-thirty-two-characters',
  JWT_ISSUER: 'avzar-api',
  JWT_AUDIENCE: 'avzar-mobile',
  ACCESS_TOKEN_MINUTES: 10,
};

async function requestApp(app, pathname, init = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    let body = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    return { status: response.status, body, text, bytes, headers: response.headers };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function bearerToken(userId = '00000000-0000-4000-8000-000000000001', businessId = '00000000-0000-4000-8000-000000000002', sessionId = '00000000-0000-4000-8000-000000000003') {
  return issueAccessToken({
    jwtSigningKey: env.JWT_SIGNING_KEY,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenMinutes: env.ACCESS_TOKEN_MINUTES,
  }, { userId, businessId, sessionId }).token;
}

const businessId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-000000000010';
const orderId = '00000000-0000-4000-8000-000000000020';
const locationId = '00000000-0000-4000-8000-000000000030';
const assetId = '00000000-0000-4000-8000-000000000040';
const documentId = '00000000-0000-4000-8000-000000000050';
const invoiceId = '00000000-0000-4000-8000-000000000060';
const taskId = '00000000-0000-4000-8000-000000000070';
const membershipId = '00000000-0000-4000-8000-000000000080';
const sliceEnv = { ...env, MEDIA_MAX_UPLOAD_BYTES: 12 * 1024 * 1024, MEDIA_MAX_PIXELS: 50_000_000,
  DOCUMENT_MAX_UPLOAD_BYTES: 15 * 1024 * 1024, STORAGE_QUOTA_BYTES_PER_GB: 1_073_741_824,
  ANTIVIRUS_PROVIDER: 'none', ANTIVIRUS_REQUIRED: false };

function makeSlice4Pool({ permissions = ['media.view', 'media.manage', 'documents.view', 'documents.manage', 'customers.view', 'customers.manage',
  'orders.view', 'invoices.view', 'designs.view', 'inquiries.view', 'tasks.view', 'tasks.work'], isOwner = true,
  assetBusinessId = businessId, documentBusinessId = businessId, publicMedia = true, mediaReferenced = false,
  allowedLocationIds = [locationId], storageLimit = '10', customers = [] } = {}) {
  const statements = [];
  const mediaRows = [];
  const documentRows = [];
  const customerRows = [...customers];
  const stored = new Map();
  const member = { Id: membershipId, UserId: userId, BusinessId: businessId, Email: 'staff@example.test', FullName: 'Staff', BusinessName: 'Atelier',
    TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: isOwner, Permissions: permissions };

  async function query(sql, values = []) {
    statements.push({ sql, values });
    if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('"MembershipLocations"')) return { rows: allowedLocationIds.map((LocationId) => ({ LocationId })) };
    if (sql.includes('FROM "Memberships"')) return { rows: [member] };
    if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: storageLimit }] };
    if (sql.includes('SELECT (COALESCE((SELECT sum("SizeBytes") FROM "MediaAssets"'))
      return { rows: [{ UsedBytes: String(mediaRows.reduce((sum, row) => sum + row.SizeBytes, 0) + documentRows.reduce((sum, row) => sum + row.SizeBytes, 0)) }] };
    if (sql.includes('INSERT INTO "MediaAssets"')) {
      const row = { Id: values[0], BusinessId: assetBusinessId, ContentType: 'image/webp', Height: values[2], OriginalFileName: values[3],
        Purpose: values[4], Sha256: values[5], SizeBytes: Number(values[6]), UploadedByUserId: values[7], Width: values[8], CreatedAtUtc: '2026-10-18T00:00:00.000Z' };
      mediaRows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO "Documents"')) {
      const row = { Id: values[0], BusinessId: documentBusinessId, ContentType: values[2], CustomerId: values[3], Description: values[4],
        FileName: values[5], Kind: values[6], OrderId: values[7], ScanStatus: values[8], Sha256: values[9], SizeBytes: Number(values[10]),
        UploadedByUserId: values[11], CreatedAtUtc: '2026-10-18T00:00:00.000Z' };
      documentRows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM "MediaAssets"') && sql.includes('count(*)::int')) return { rows: [{ TotalCount: mediaRows.length }] };
    if (sql.includes('FROM "MediaAssets" a') && sql.includes('ORDER BY a."CreatedAtUtc"')) return { rows: mediaRows.filter((row) => row.BusinessId === values[0]).map((row) => ({ ...row, InUse: mediaReferenced })) };
    if (sql.includes('FROM "MediaAssets" a') && sql.includes('WHERE a."BusinessId"')) {
      const row = mediaRows.find((item) => item.BusinessId === values[0] && item.Id === values[1]);
      return { rows: row ? [{ ...row, InUse: mediaReferenced }] : [] };
    }
    if (sql.includes('FROM "MediaAssets" a') && sql.includes('WHERE a."Id"')) {
      const row = mediaRows.find((item) => item.Id === values[0]);
      return { rows: row && publicMedia ? [{ Id: row.Id, BusinessId: row.BusinessId, ContentType: row.ContentType }] : [] };
    }
    if (sql.includes('FROM "MediaAssets" WHERE "BusinessId"')) {
      const row = mediaRows.find((item) => item.BusinessId === values[0] && item.Id === values[1]);
      return { rows: row ? [{ Id: row.Id, BusinessId: row.BusinessId, ContentType: row.ContentType }] : [] };
    }
    if (sql.includes('FROM "MediaAssets" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE')) {
      const row = mediaRows.find((item) => item.BusinessId === values[0] && item.Id === values[1]);
      return { rows: row ? [{ Id: row.Id, BusinessId: row.BusinessId, SizeBytes: row.SizeBytes }] : [] };
    }
    if (sql.includes('SELECT EXISTS (SELECT 1 FROM "DesignImages"')) return { rows: [{ InUse: mediaReferenced }] };
    if (sql.startsWith('DELETE FROM "MediaAssets"')) {
      const index = mediaRows.findIndex((item) => item.BusinessId === values[0] && item.Id === values[1]);
      if (index >= 0) mediaRows.splice(index, 1);
      return { rows: [], rowCount: index >= 0 ? 1 : 0 };
    }
    if (sql.includes('FROM "Documents"') && sql.includes('count(*)::int')) return { rows: [{ TotalCount: documentRows.length }] };
    if (sql.includes('FROM "Documents"') && sql.includes('ORDER BY "CreatedAtUtc"')) return { rows: documentRows.filter((row) => row.BusinessId === values[0]) };
    if (sql.includes('FROM "Documents"') && sql.includes('WHERE "BusinessId" = $1 AND "Id" = $2')) {
      const row = documentRows.find((item) => item.BusinessId === values[0] && item.Id === values[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('DELETE FROM "Documents"')) {
      const index = documentRows.findIndex((item) => item.BusinessId === values[0] && item.Id === values[1]);
      const row = index >= 0 ? documentRows.splice(index, 1)[0] : null;
      return { rows: row ? [{ BusinessId: row.BusinessId, Id: row.Id, SizeBytes: row.SizeBytes }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('SELECT "CustomerId" FROM "Orders"')) return { rows: [{ CustomerId: customerId }] };
    if (sql.includes('SELECT 1 FROM "Customers"')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('SELECT "FullName" FROM "Customers"')) return { rows: [{ FullName: 'Jane Doe' }] };
    if (sql.includes('NormalizedEmail') && sql.includes('FROM "Customers"')) return { rows: customerRows.filter((row) => values[1]?.includes(row.NormalizedEmail) || values[2]?.includes(row.NormalizedPhone)) };
    if (sql.includes('FROM "Customers"') && sql.includes('"Status" = \'Active\'')) return { rows: [{ Count: customerRows.length }] };
    if (sql.includes('INSERT INTO "Customers"')) {
      customerRows.push({ Id: values[0], BusinessId: values[1], FullName: values[2], Email: values[3], NormalizedEmail: values[4],
        Phone: values[5], NormalizedPhone: values[6], AddressLine: values[7], City: values[8], Notes: values[9],
        GarmentPreferences: values[10], Status: 'Active', CreatedAtUtc: '2026-10-18T00:00:00.000Z' });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM "Customers"') && sql.includes('"FullName"') && sql.includes('ORDER BY "FullName"')) return { rows: customerRows.filter((row) => row.BusinessId === values[0]) };
    if (sql.includes('FROM "Customers"') && sql.includes('"Id" = $2')) {
      const row = customerRows.find((item) => item.BusinessId === values[0] && item.Id === values[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('FROM "Memberships"') && sql.includes('"Id" FROM')) return { rows: [{ Id: membershipId }] };
    if (sql.includes('FROM "ProductionTasks"') && sql.includes('"AssignedMembershipId" = $3')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM "Invoices" i') && sql.includes('LEFT JOIN "Customers"')) return { rows: [{
      Id: invoiceId, BusinessId: businessId, Number: 'INV-2026-00001', Kind: 'Standard', Status: 'Issued', CustomerId: customerId,
      CustomerName: 'Jane Doe', OrderId: null, OrderNumber: null, CurrencyCode: 'USD', IssueDate: '2026-10-17', DueDate: '2026-10-31',
      Notes: null, Terms: null, Subtotal: '100.00', TaxTotal: '0.00', Total: '100.00', AmountPaid: '0.00', AmountPending: '0.00',
      AmountCredited: '0.00', Version: 1, VoidReason: null, CreatedAtUtc: '2026-10-17T12:00:00.000Z',
    }] };
    if (sql.includes('FROM "InvoiceLines"')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000091', LineNumber: 1, Description: 'Custom dress', Quantity: '1.00',
      UnitPrice: '100.00', Discount: '0.00', TaxPercent: '0.00', NetAmount: '100.00', TaxAmount: '0.00', LineTotal: '100.00' }] };
    if (sql.includes('FROM "Payments" p')) return { rows: [] };
    if (sql.includes('FROM "CreditNotes" WHERE')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000094', Number: 'CN-2026-00001',
      Amount: '10.00', Reason: 'Adjustment', CreatedAtUtc: '2026-10-17T12:00:00.000Z' }] };
    if (sql.includes('FROM "Businesses"') && sql.includes('"CurrencyCode", "TimeZoneId"')) return { rows: [{ CurrencyCode: 'USD', TimeZoneId: 'UTC' }] };
    if (sql.includes('FROM "Businesses" b')) return { rows: [{ Name: 'Atelier', BrandColor: '#1f3a5f', ContactPhone: null, ContactEmail: 'hello@example.test',
      TaxNumber: null, PdfFooterNote: null, Address: '1 Main Street', LogoMediaId: null }] };
    if (sql.includes('FROM "Orders" o JOIN "Customers" c')) {
      const scopedLocations = sql.includes('ORDER BY o."CreatedAtUtc" DESC') ? values[1] : values[2];
      if (Array.isArray(scopedLocations) && !scopedLocations.includes(locationId)) return { rows: [] };
      return { rows: [{ Id: orderId, BusinessId: businessId, LocationId: locationId, CustomerId: customerId,
      CustomerName: 'Jane Doe', OrderNumber: 'ORD-2026-00001', Status: 'Quoted', Priority: 'Normal', PromisedDate: '2026-11-01',
      DeliveryMethod: 'Collection', Subtotal: '100.00', Discount: '0.00', Total: '100.00', Notes: null, CreatedAtUtc: '2026-10-17T12:00:00.000Z', QuotedAtUtc: '2026-10-17T12:00:00.000Z' }] };
    }
    if (sql.includes('FROM "OrderGarments"') && sql.includes('"OrderId" = $2')) return { rows: [{ LineNumber: 1, Name: 'Custom dress', Quantity: 1, UnitPrice: '100.00', LineTotal: '100.00' }] };
    if (sql.includes('FROM "MeasurementSets" s')) return { rows: [{ Id: '00000000-0000-4000-8000-000000000092', Label: 'Current', CurrentRevision: 1,
      UpdatedAtUtc: '2026-10-17T12:00:00.000Z', TemplateName: 'Dress', ValuesJson: [{ label: 'Chest', value: 90, unit: 'cm' }] }] };
    if (sql.includes('FROM "ProductionTasks" t') && sql.includes('AS "UnmetDependencies"')) return { rows: [{ Id: taskId, OrderId: orderId, OrderNumber: 'ORD-2026-00001', OrderStatus: 'Confirmed',
      OrderGarmentId: '00000000-0000-4000-8000-000000000093', GarmentName: 'Custom dress', StageName: 'Cutting', StageOrder: 1, Title: 'Cut dress',
      Quantity: 1, Status: 'Pending', Priority: 'Normal', DeadlineUtc: '2026-10-25T12:00:00.000Z', AssignedMembershipId: membershipId,
      AssigneeName: 'Staff', RequiredSkill: 'cutting', EstimatedMinutes: 30, IsConditional: false, BlockedType: null, BlockedReason: null, Version: 1, UnmetDependencies: 0 }] };
    if (sql.includes('SELECT t."Instructions"')) return { rows: [{ Instructions: 'Cut to pattern', RequiredChecks: ['Measurements checked'], CompletedChecks: [], RequiredMaterialsJson: '[]',
      CompletionNotes: null, PlannedStartUtc: null, PlannedEndUtc: null, ActualStartUtc: null, CompletedAtUtc: null, GarmentName: 'Custom dress', Category: 'Dress',
      GarmentQuantity: 1, Fabric: 'Silk', Colour: 'Blue', StyleInstructions: null, AlterationNotes: null, MeasurementSnapshotJson: null, CustomerName: 'Jane Doe' }] };
    if (sql.includes('FROM "TaskDependencies"') || sql.includes('FROM "TaskEvents"')) return { rows: [] };
    if (sql.includes('FROM "Customers"') && sql.includes('"NormalizedPhone"') && sql.includes('"Status"')) return { rows: [] };
    if (sql.includes('FROM "Orders" o JOIN "Customers"') && sql.includes('Search')) return { rows: [] };
    if (sql.includes('FROM "Orders" o JOIN "Customers"') && sql.includes('ORDER BY o."CreatedAtUtc"')) return { rows: [] };
    if (sql.includes('FROM "Invoices" i JOIN "Customers"')) return { rows: [] };
    if (sql.includes('FROM "Designs"') && sql.includes('"GarmentType"')) return { rows: [] };
    if (sql.includes('FROM "Inquiries"')) return { rows: [] };
    if (sql.startsWith('INSERT INTO "AuditLogs"')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    return { rows: [], rowCount: 1 };
  }

  const storage = {
    async put(key, body) { stored.set(key, Buffer.from(body)); },
    async openRead(key) { return stored.has(key) ? Readable.from(stored.get(key)) : null; },
    async delete(key) { stored.delete(key); },
    close() {},
  };
  return {
    statements, mediaRows, documentRows, customerRows, stored, storage,
    async query(sql, values = []) { return query(sql, values); },
    async connect() { return { query, release() {} }; },
  };
}

describe('media and documents', () => {
  it('rejects media and document access without the required permissions', async () => {
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('FROM "UserSessions"')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('FROM "Memberships"')) return { rows: [{ UserId: '00000000-0000-4000-8000-000000000001', BusinessId: '00000000-0000-4000-8000-000000000002', Email: 'owner@example.test', FullName: 'Owner', BusinessName: 'Shop', TimeZoneId: 'UTC', CurrencyCode: 'USD', IsOwner: false, Permissions: ['customers.view'] }] };
        return { rows: [] };
      },
    };

    const media = await requestApp(createApp(env, pool), '/api/media', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(media.status, 403);
    assert.equal(media.body.code, 'forbidden');

    const documents = await requestApp(createApp(env, pool), '/api/documents', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(documents.status, 403);
    assert.equal(documents.body.code, 'forbidden');

    const uploadForbidden = await requestApp(createApp(sliceEnv, makeSlice4Pool({ permissions: ['customers.view'], isOwner: false })), '/api/media', {
      method: 'POST', headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(uploadForbidden.status, 403);

    const unauthenticatedPdf = await requestApp(createApp(sliceEnv, makeSlice4Pool()), `/api/orders/${orderId}/quotation-pdf`);
    assert.equal(unauthenticatedPdf.status, 401);

    const forbiddenPdf = await requestApp(createApp(sliceEnv, makeSlice4Pool({ permissions: ['customers.view'], isOwner: false })), `/api/orders/${orderId}/quotation-pdf`, {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(forbiddenPdf.status, 403);
  });

  it('uploads, scopes, serves, and deletes real media and document files', async () => {
    const pool = makeSlice4Pool();
    const app = createApp(sliceEnv, pool, { storage: pool.storage, virusScanner: { async scan() { return { outcome: 'Clean' }; } } });
    const headers = { authorization: `Bearer ${bearerToken()}` };
    const image = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#cc7755' } }).png().toBuffer();
    const imageForm = new FormData();
    imageForm.append('file', new Blob([image], { type: 'text/plain' }), '../../front.png');
    imageForm.append('purpose', 'DesignImage');
    const uploadedImage = await requestApp(app, '/api/media', { method: 'POST', headers, body: imageForm });
    assert.equal(uploadedImage.status, 201, JSON.stringify(uploadedImage.body));
    assert.equal(uploadedImage.body.fileName, 'front.png');
    assert.equal(uploadedImage.body.purpose, 'DesignImage');
    assert.ok(pool.statements.some(({ sql }) => sql.includes('INSERT INTO "MediaAssets"')));

    const mediaId = uploadedImage.body.id;
    const mediaList = await requestApp(app, '/api/media?page=1&pageSize=10', { headers });
    assert.equal(mediaList.body.totalCount, 1);
    assert.equal(mediaList.body.items[0].width, 12);
    const mediaDetail = await requestApp(app, `/api/media/${mediaId}`, { headers });
    assert.equal(mediaDetail.status, 200);
    const usage = await requestApp(app, '/api/media/usage', { headers });
    assert.ok(usage.body.usedBytes > 0);

    const privateFile = await requestApp(app, `/api/media/${mediaId}/file/md`, { headers });
    assert.equal(privateFile.status, 200);
    assert.equal(privateFile.headers.get('content-type'), 'image/webp');
    assert.equal(privateFile.headers.get('cache-control'), 'private, max-age=300');
    const publicFile = await requestApp(app, `/public/media/${mediaId}/sm`);
    assert.equal(publicFile.status, 200);
    assert.equal(publicFile.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal((await requestApp(app, `/public/media/${mediaId}/bad`)).status, 404);

    const otherBusinessPool = makeSlice4Pool({ assetBusinessId: '00000000-0000-4000-8000-000000000099' });
    const otherBusinessApp = createApp(sliceEnv, otherBusinessPool, { storage: otherBusinessPool.storage });
    const otherBusinessForm = new FormData();
    otherBusinessForm.append('file', new Blob([image]), 'other.png');
    const otherAsset = await requestApp(otherBusinessApp, '/api/media', { method: 'POST', headers, body: otherBusinessForm });
    assert.equal((await requestApp(otherBusinessApp, `/api/media/${otherAsset.body.id}`, { headers })).status, 404);

    const binaryPdf = Buffer.from('%PDF-1.7\nfixture');
    const docForm = new FormData();
    docForm.append('file', new Blob([binaryPdf], { type: 'image/png' }), 'statement.pdf');
    docForm.append('description', 'Customer attachment');
    docForm.append('customerId', customerId);
    const uploadedDoc = await requestApp(app, '/api/documents', { method: 'POST', headers, body: docForm });
    assert.equal(uploadedDoc.status, 201);
    assert.equal(uploadedDoc.body.kind, 'Pdf');
    assert.equal(uploadedDoc.body.contentType, 'application/pdf');
    assert.equal(uploadedDoc.body.scanStatus, 'Clean');
    const docList = await requestApp(app, '/api/documents?customerId=' + customerId, { headers });
    assert.equal(docList.body.totalCount, 1);
    const docDetail = await requestApp(app, `/api/documents/${uploadedDoc.body.id}`, { headers });
    assert.equal(docDetail.status, 200);
    const download = await requestApp(app, `/api/documents/${uploadedDoc.body.id}/file`, { headers });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('cache-control'), 'private, no-store');
    assert.match(download.headers.get('content-disposition'), /statement\.pdf/);

    const foreignDocumentPool = makeSlice4Pool({ documentBusinessId: '00000000-0000-4000-8000-000000000099' });
    const foreignDocumentApp = createApp(sliceEnv, foreignDocumentPool, { storage: foreignDocumentPool.storage,
      virusScanner: { async scan() { return { outcome: 'Clean' }; } } });
    const foreignDocumentForm = new FormData();
    foreignDocumentForm.append('file', new Blob([binaryPdf]), 'foreign.pdf');
    const foreignDocument = await requestApp(foreignDocumentApp, '/api/documents', { method: 'POST', headers, body: foreignDocumentForm });
    assert.equal((await requestApp(foreignDocumentApp, `/api/documents/${foreignDocument.body.id}`, { headers })).status, 404);

    const referencedPool = makeSlice4Pool({ mediaReferenced: true });
    const referencedApp = createApp(sliceEnv, referencedPool, { storage: referencedPool.storage });
    const referencedForm = new FormData();
    referencedForm.append('file', new Blob([image]), 'used.png');
    const referenced = await requestApp(referencedApp, '/api/media', { method: 'POST', headers, body: referencedForm });
    const inUse = await requestApp(referencedApp, `/api/media/${referenced.body.id}`, { method: 'DELETE', headers });
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.code, 'media_in_use');

    const deletedImage = await requestApp(app, `/api/media/${mediaId}`, { method: 'DELETE', headers });
    assert.equal(deletedImage.status, 204);
    const deletedDoc = await requestApp(app, `/api/documents/${uploadedDoc.body.id}`, { method: 'DELETE', headers });
    assert.equal(deletedDoc.status, 204);
    assert.equal(await pool.storage.openRead(`${businessId.replaceAll('-', '')}/${mediaId.replaceAll('-', '')}/md.webp`), null);
  });

  it('sniffs document content, rejects mismatches and enforces business, auth, permission, and location scope', async () => {
    const path = `/api/documents/${documentId}`;
    const unauthenticated = await requestApp(createApp(sliceEnv, makeSlice4Pool()), path);
    assert.equal(unauthenticated.status, 401);

    const forbidden = await requestApp(createApp(sliceEnv, makeSlice4Pool({ permissions: ['customers.view'], isOwner: false })), path, {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(forbidden.status, 403);

    const crossBusinessPool = makeSlice4Pool({ documentBusinessId: '00000000-0000-4000-8000-000000000099' });
    const crossBusiness = await requestApp(createApp(sliceEnv, crossBusinessPool), path, { headers: { authorization: `Bearer ${bearerToken()}` } });
    assert.equal(crossBusiness.status, 404);

    const mismatchPool = makeSlice4Pool();
    const mismatchApp = createApp(sliceEnv, mismatchPool, { storage: mismatchPool.storage });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.7')]), 'fake.png');
    const mismatch = await requestApp(mismatchApp, '/api/documents', { method: 'POST', headers: { authorization: `Bearer ${bearerToken()}` }, body: form });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.code, 'extension_mismatch');

    const restricted = makeSlice4Pool({ isOwner: false, allowedLocationIds: [] });
    const quotation = await requestApp(createApp(sliceEnv, restricted), `/api/orders/${orderId}/quotation-pdf`, {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(quotation.status, 404);
  });

  it('rejects unsafe image bytes, hides private public media, enforces quota, and refuses infected files', async () => {
    const headers = { authorization: `Bearer ${bearerToken()}` };
    const plainPool = makeSlice4Pool();
    const plainApp = createApp(sliceEnv, plainPool, { storage: plainPool.storage });
    const invalidImage = new FormData();
    invalidImage.append('file', new Blob([Buffer.from('not an image')]), 'image.png');
    const invalid = await requestApp(plainApp, '/api/media', { method: 'POST', headers, body: invalidImage });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'unsupported_image');

    const hiddenPool = makeSlice4Pool({ publicMedia: false });
    const hiddenApp = createApp(sliceEnv, hiddenPool, { storage: hiddenPool.storage });
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#334455' } }).png().toBuffer();
    const visibleForm = new FormData();
    visibleForm.append('file', new Blob([png]), 'private.png');
    const privateAsset = await requestApp(hiddenApp, '/api/media', { method: 'POST', headers, body: visibleForm });
    const hidden = await requestApp(hiddenApp, `/public/media/${privateAsset.body.id}/sm`);
    assert.equal(hidden.status, 404);

    const exhaustedPool = makeSlice4Pool({ storageLimit: '0' });
    const exhaustedApp = createApp(sliceEnv, exhaustedPool, { storage: exhaustedPool.storage });
    const quotaForm = new FormData();
    quotaForm.append('file', new Blob([png]), 'quota.png');
    const quota = await requestApp(exhaustedApp, '/api/media', { method: 'POST', headers, body: quotaForm });
    assert.equal(quota.status, 403);
    assert.equal(quota.body.code, 'plan_limit_reached');
    assert.equal(exhaustedPool.mediaRows.length, 0);
    assert.equal(exhaustedPool.stored.size, 0);

    const infectedPool = makeSlice4Pool();
    const infectedApp = createApp(sliceEnv, infectedPool, { storage: infectedPool.storage,
      virusScanner: { async scan() { return { outcome: 'Infected', detail: 'test signature' }; } } });
    const infectedForm = new FormData();
    infectedForm.append('file', new Blob([Buffer.from('%PDF-1.7')]), 'infected.pdf');
    const infected = await requestApp(infectedApp, '/api/documents', { method: 'POST', headers, body: infectedForm });
    assert.equal(infected.status, 422);
    assert.equal(infected.body.code, 'file_infected');
    assert.equal(infectedPool.documentRows.length, 0);
  });

  it('requires preview hash and explicit duplicate update confirmation, and supports S3 through a fake client', async () => {
    const existing = { Id: '00000000-0000-4000-8000-000000000099', BusinessId: businessId, FullName: 'Jane Doe',
      Email: 'jane@example.test', NormalizedEmail: 'jane@example.test', Phone: null, NormalizedPhone: null,
      AddressLine: null, City: null, Notes: null, GarmentPreferences: null, Status: 'Active', Version: 1 };
    const pool = makeSlice4Pool({ customers: [existing] });
    const app = createApp(sliceEnv, pool, { storage: pool.storage });
    const headers = { authorization: `Bearer ${bearerToken()}` };
    const csv = 'Full name,Email\r\nJane Doe,jane@example.test\r\n';
    const previewForm = new FormData();
    previewForm.append('file', new Blob([csv]), 'customers.csv');
    const preview = await requestApp(app, '/api/customers/import/preview', { method: 'POST', headers, body: previewForm });
    assert.equal(preview.body.existingCount, 1);

    const missingConfirmForm = new FormData();
    missingConfirmForm.append('file', new Blob([csv]), 'customers.csv');
    missingConfirmForm.append('expectedHash', preview.body.fileHash);
    missingConfirmForm.append('onDuplicate', 'update');
    const missingConfirm = await requestApp(app, '/api/customers/import/commit', { method: 'POST', headers, body: missingConfirmForm });
    assert.equal(missingConfirm.status, 409);
    assert.equal(missingConfirm.body.code, 'confirmation_required');

    const changedHashForm = new FormData();
    changedHashForm.append('file', new Blob([`${csv}#changed\r\n`]), 'customers.csv');
    changedHashForm.append('expectedHash', preview.body.fileHash);
    const changedHash = await requestApp(app, '/api/customers/import/commit', { method: 'POST', headers, body: changedHashForm });
    assert.equal(changedHash.status, 409);
    assert.equal(changedHash.body.code, 'file_changed');

    const calls = [];
    const fakeClient = { async send(command) {
      calls.push(command.input);
      return command.constructor.name === 'GetObjectCommand' ? { Body: Readable.from(Buffer.from('ok')) } : {};
    }, destroy() {} };
    const objectStorage = createObjectStorage({ STORAGE_PROVIDER: 's3', STORAGE_S3_REGION: 'test', STORAGE_S3_BUCKET: 'bucket',
      STORAGE_S3_ACCESS_KEY: 'fake', STORAGE_S3_SECRET_KEY: 'fake', STORAGE_S3_FORCE_PATH_STYLE: true, STORAGE_S3_KEY_PREFIX: 'avzar' }, { s3Client: fakeClient });
    await objectStorage.put('business/doc.bin', Buffer.from('ok'), 'application/octet-stream');
    const stream = await objectStorage.openRead('business/doc.bin');
    let output = '';
    for await (const chunk of stream) output += chunk;
    await objectStorage.delete('business/doc.bin');
    assert.equal(output, 'ok');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].Key, 'avzar/business/doc.bin');
  });

  it('speaks ClamAV INSTREAM to a fake scanner and returns its scan result', async () => {
    let received = Buffer.alloc(0);
    const server = createTcpServer((socket) => {
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 12 && received.subarray(-4).equals(Buffer.alloc(4))) socket.end(Buffer.from('stream: OK\0'));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const scanner = createVirusScanner({ ANTIVIRUS_PROVIDER: 'clamav', ANTIVIRUS_HOST: '127.0.0.1',
        ANTIVIRUS_PORT: server.address().port, ANTIVIRUS_TIMEOUT_SECONDS: 2 });
      const result = await scanner.scan(Buffer.from('fixture bytes'));
      assert.equal(result.outcome, 'Clean');
      assert.equal(received.subarray(0, 10).toString('binary'), 'zINSTREAM\0');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('exports UTF-8 CSV, previews hash-bound imports, commits atomically, and returns search groups', async () => {
    const pool = makeSlice4Pool();
    const app = createApp(sliceEnv, pool, { storage: pool.storage });
    const headers = { authorization: `Bearer ${bearerToken()}` };
    const exportResponse = await requestApp(app, '/api/customers/export', { headers });
    assert.equal(exportResponse.status, 200, JSON.stringify(exportResponse.body));
    assert.equal(exportResponse.body.charCodeAt(0), 0xfeff);
    assert.match(exportResponse.headers.get('content-disposition'), /customers-\d{8}\.csv/);

    const csv = 'Full name,Email,Phone\r\nJane Doe,jane@example.test,5551234567\r\nX,bad-email,\r\n';
    const previewForm = new FormData();
    previewForm.append('file', new Blob([csv]), 'customers.csv');
    const preview = await requestApp(app, '/api/customers/import/preview', { method: 'POST', headers, body: previewForm });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.totalRows, 2);
    assert.equal(preview.body.newCount, 1);
    assert.equal(preview.body.invalidCount, 1);

    const commitForm = new FormData();
    commitForm.append('file', new Blob([csv]), 'customers.csv');
    commitForm.append('expectedHash', preview.body.fileHash);
    commitForm.append('skipInvalidRows', 'true');
    const committed = await requestApp(app, '/api/customers/import/commit', { method: 'POST', headers, body: commitForm });
    assert.equal(committed.status, 200);
    assert.equal(committed.body.created, 1);
    assert.equal(committed.body.skipped, 1);
    assert.ok(pool.statements.some(({ sql }) => sql === 'BEGIN'));
    assert.ok(pool.statements.some(({ sql }) => sql === 'COMMIT'));

    const search = await requestApp(app, '/api/search?q=Jane&limit=5', { headers });
    assert.equal(search.status, 200);
    assert.deepEqual(Object.keys(search.body), ['customers', 'orders', 'invoices', 'designs', 'inquiries']);
    const shortSearch = await requestApp(app, '/api/search?q=x', { headers });
    assert.equal(shortSearch.status, 400);

    const restrictedPool = makeSlice4Pool({ isOwner: false, allowedLocationIds: [] });
    const restrictedSearch = await requestApp(createApp(sliceEnv, restrictedPool), '/api/search?q=ORD', {
      headers: { authorization: `Bearer ${bearerToken()}` },
    });
    assert.equal(restrictedSearch.status, 200);
    assert.deepEqual(restrictedSearch.body.orders, []);
    assert.deepEqual(restrictedSearch.body.invoices, []);
  });

  it('renders all six record-scoped PDFs as real PDF files', async () => {
    const pool = makeSlice4Pool();
    const app = createApp(sliceEnv, pool, { storage: pool.storage });
    const headers = { authorization: `Bearer ${bearerToken()}` };
    const paths = [
      `/api/invoices/${invoiceId}/pdf`,
      `/api/invoices/${invoiceId}/credit-notes/00000000-0000-4000-8000-000000000094/pdf`,
      `/api/orders/${orderId}/quotation-pdf`,
      `/api/customers/${customerId}/measurement-sets/00000000-0000-4000-8000-000000000092/pdf`,
      `/api/tasks/${taskId}/job-sheet-pdf`,
      `/api/my/tasks/${taskId}/job-sheet-pdf`,
    ];
    for (const pathname of paths) {
      const response = await requestApp(app, pathname, { headers });
      assert.equal(response.status, 200, `${pathname}: ${JSON.stringify(response.body)} ${pool.statements.map(({ sql }) => sql.slice(0, 72)).join(' | ')}`);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.ok(response.text.startsWith('%PDF-'));
      assert.match(response.headers.get('content-disposition'), /\.pdf/);
    }
  });
});

describe('task progress photo isolation from generic media endpoints', () => {
  const user = { businessId: '00000000-0000-4000-8000-000000000002', userId: '00000000-0000-4000-8000-000000000001' };

  it('excludes task-photo purpose and associations from generic media listing', async () => {
    const statements = [];
    const pool = { async query(sql) {
      statements.push(sql);
      return { rows: sql.includes('count(*)') ? [{ TotalCount: 0 }] : [] };
    } };
    const result = await listMedia(pool, user, {});
    assert.deepEqual(result.items, []);
    assert.match(statements[0], /Purpose.*TaskProgressPhoto/);
    assert.match(statements[0], /NOT EXISTS \(SELECT 1 FROM "TaskProgressPhotos"/);
    assert.match(statements[1], /NOT EXISTS \(SELECT 1 FROM "TaskProgressPhotos"/);
  });

  it('does not expose task-photo metadata or files through generic media endpoints', async () => {
    let statement = '';
    const pool = { async query(sql) { statement = sql; return { rows: [] }; } };
    const storage = { async openRead() { throw new Error('must not read storage'); } };
    await assert.rejects(() => getMedia(pool, user, '00000000-0000-4000-8000-000000000003'), (error) => error.code === 'media_not_found');
    assert.match(statement, /Purpose.*TaskProgressPhoto/);
    assert.match(statement, /NOT EXISTS \(SELECT 1 FROM "TaskProgressPhotos"/);
    await assert.rejects(() => openMedia(pool, storage, user, '00000000-0000-4000-8000-000000000003', 'orig'), (error) => error.code === 'media_not_found');
    assert.match(statement, /Purpose.*TaskProgressPhoto/);
    assert.match(statement, /NOT EXISTS \(SELECT 1 FROM "TaskProgressPhotos"/);
    await assert.rejects(() => openMedia(pool, storage, null, '00000000-0000-4000-8000-000000000003', 'orig', true), (error) => error.code === 'media_not_found');
    assert.match(statement, /Purpose.*TaskProgressPhoto/);
    assert.match(statement, /NOT EXISTS \(SELECT 1 FROM "TaskProgressPhotos"/);
  });
});
