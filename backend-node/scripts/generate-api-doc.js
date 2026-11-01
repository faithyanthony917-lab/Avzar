#!/usr/bin/env node
// Builds docs/API.md from the route files, so the route table cannot drift from the code. It is a static reader (regular expressions
// over the source), not a replacement for OpenAPI: it lists method, full path, who may call it and the rate limiters named on the route.
// It also writes docs/openapi.json: an OpenAPI 3.1 route skeleton (paths, methods, path parameters, security, permissions, generic
// error responses) built from the same rows. It has no request or response schemas.
// Usage:  node scripts/generate-api-doc.js          (writes ../docs/API.md and ../docs/openapi.json)
//         node scripts/generate-api-doc.js --check  (exit 1 when either file is out of date)
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DOC = path.resolve(ROOT, '../docs/API.md');
const OPENAPI = path.resolve(ROOT, '../docs/openapi.json');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

async function listJs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/** Router factory name -> mount prefix, read from the app.use(...) lines in app.js. */
export function mountPrefixes(appSource) {
  const map = new Map();
  for (const m of appSource.matchAll(/app\.use\(\s*'(\/api|\/)'\s*,\s*(create\w+)\(/g)) map.set(m[2], m[1] === '/' ? '' : m[1]);
  return map;
}

/** `export const NAME = '/path'` constants, so a route registered with NAME shows its real path. */
export function pathConstants(sources) {
  const map = new Map();
  for (const source of sources) for (const m of source.matchAll(/export const (\w+) = '([^']*)'/g)) map.set(m[1], m[2]);
  return map;
}

/** Routes whose list is a plain array that takes optional `page` and `pageSize` (step 17d-2). */
export const OPTIONAL_PAGING = new Set([
  'GET /api/inventory', 'GET /api/suppliers', 'GET /api/purchase-orders', 'GET /api/tasks/worker-requests',
  'GET /api/customers/:id/measurements', 'GET /api/storefronts/:id/versions', 'GET /api/ready-to-wear/variants',
]);

const LISTS_AND_LIMITS = [
  '## Lists and limits',
  '',
  '- **Paged lists** (orders, invoices, payments, appointments, inquiries, customers, designs, tasks, media, documents, audit and others) take `page` and `pageSize` (1 to 100) and return `{ items, page, pageSize, totalCount }`.',
  '- **Whole-list screens and pickers** (inventory, suppliers, purchase orders, worker requests, a customer\'s measurement sets, a storefront\'s versions, the ready-to-wear variants) return a plain array. With no parameters they return at most 1000 rows (storefront versions: the newest 100) and send `X-Total-Count`, `X-Result-Limit` and `X-Truncated` headers, so a screen can say it shows part of the list. With `page` and/or `pageSize` (1 to 100) they return the paged envelope instead. The ready-to-wear variants list returns `{ items, totalCount, truncated }` instead of headers.',
  '- **Public storefront product list:** at most 500 variants.',
  '- **Intentional "recent N" lists:** a customer\'s communications (200), a task\'s events (100), shop schedule versions (25), calendar links (20) and the workload member list (200) show only the latest rows by design.',
  '- **Short by nature:** staff, roles, locations, storefronts, domains, sessions, workflows, categories and platform plans are bounded by plan limits or are small by definition and are not limited.',
  '- **CSV exports** (`.../export`) read every matching row up to 50,000 and refuse a larger result with 413 `export_too_large`.',
];

function describeAccess(argsText, aliases) {
  const expanded = argsText.replace(/\.\.\.(\w+)/g, (whole, name) => aliases.get(name) ?? whole);
  const permissions = [...expanded.matchAll(/requirePermission\('([a-z.]+)'\)/g)].map((m) => m[1]);
  const limits = [...new Set([...argsText.matchAll(/\b(\w*[lL]imit\w*)\b/g)].map((m) => m[1]).filter((name) => name !== 'limit'))];
  const signedIn = /requireBearerAuth|\bsignedIn\b|\bauth\b|requireAuth/.test(expanded) || permissions.length > 0 || /\bbearer\w*\b/i.test(expanded);
  let access;
  if (permissions.length) access = `permission ${permissions.join(' + ')}`;
  else if (signedIn) access = 'signed in';
  else access = 'public';
  return { access, limits };
}

/** Platform-admin routes only need a signed-in user at the route; the e-mail allow-list is checked in the service. */
function withPlatformNote(row) {
  return row.path.startsWith('/api/platform-admin/') ? { ...row, access: `${row.access} + platform admin (checked in service)` } : row;
}

/** Pure parser: one source file in, route rows out. `prefixes` comes from mountPrefixes(). */
export function parseRouteFile(source, file, prefixes, constants) {
  const aliases = new Map();
  for (const m of source.matchAll(/const (\w+) = (\[[^\]]*\]|requireBearerAuth\([^)]*\)|rateLimit\(\{[^}]*\}\));/g)) aliases.set(m[1], m[2]);
  const factories = [...source.matchAll(/export function (create\w+Router)\b/g)].map((m) => ({ name: m[1], index: m.index }));
  const rows = [];
  const callPattern = new RegExp(`router\\.(${METHODS.join('|')})\\(\\s*([^,]+?)\\s*,`, 'g');
  for (const m of source.matchAll(callPattern)) {
    const factory = [...factories].reverse().find((f) => f.index < m.index);
    if (!factory) continue;
    const prefix = prefixes.get(factory.name);
    if (prefix === undefined) continue;
    const rawPath = m[2].trim();
    const literal = /^['"`]([^'"`]*)['"`]$/.exec(rawPath);
    const routePath = literal ? literal[1] : constants.get(rawPath) ?? `\${${rawPath}}`;
    const rest = source.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const end = rest.search(/=>/);
    const argsText = end === -1 ? rest : rest.slice(0, end);
    rows.push(withPlatformNote({ method: m[1].toUpperCase(), path: `${prefix}${routePath}`.replace(/\/{2,}/g, '/'), file, ...describeAccess(argsText, aliases) }));
  }
  return rows;
}

/** Every route row, sorted. */
export async function collectRows() {
  const files = await listJs(SRC);
  const sources = new Map(await Promise.all(files.map(async (f) => [f, await readFile(f, 'utf8')])));
  const prefixes = mountPrefixes(sources.get(path.join(SRC, 'http/app.js')));
  const constants = pathConstants([...sources.values()]);
  const rows = [];
  for (const [file, source] of sources) {
    if (!/router\.(get|post|put|patch|delete)\(/.test(source)) continue;
    rows.push(...parseRouteFile(source, path.relative(SRC, file).replaceAll('\\', '/'), prefixes, constants));
  }
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return rows;
}

export async function buildApiDoc() {
  const rows = await collectRows();
  const byFile = new Map();
  for (const row of rows) byFile.set(row.file, [...(byFile.get(row.file) ?? []), row]);
  const lines = [
    '# Avzar API route table',
    '',
    '<!-- Generated by backend-node/scripts/generate-api-doc.js. Do not edit by hand: run `npm run docs:api` and commit the result. A test fails when this file is out of date. -->',
    '',
    `${rows.length} routes in ${byFile.size} route files. This is a route list read from the source, **not an OpenAPI description**: it has no request or response schemas. A route skeleton in OpenAPI 3.1 form is generated beside it in docs/openapi.json.`,
    '',
    '## What the table does and does not say',
    '',
    '- **Access** is read from the middleware named on the route: `public` (no bearer token; this includes routes that check a token in the body, such as the customer portal, and webhooks that check a signature instead), `signed in` (any signed-in member of the business) or `permission X` (owners always pass; other members need X). Permission names are in `src/security/permissions.js` and the role tables.',
    '- **Not shown:** plan limits and entitlements (checked inside services, for example `entitlementService.js`), platform-admin checks (`PLATFORM_ADMIN_EMAILS`, checked inside `adminService.js` and `platformOperationsService.js`), and per-route business rules. Read the service for those.',
    '- **Limiters** are the rate-limit variables named on the route; their windows are set at the top of each route file.',
    '- **Mount prefix:** most routers are mounted at `/api`. `createPublicSiteRouter` and `createPublicMediaRouter` are mounted at `/`, so their paths have no `/api`. Browser code reaches `/api/...` only through the web app proxy `/backend/...`.',
    '- **CSRF:** unsafe requests without a bearer token need the double-submit CSRF cookie and header, except the paths listed in `src/http/app.js` (token and refresh routes, portal, privacy, webhooks, analytics).',
    '- Health checks, outside the table: `GET /health/live`, `GET /health/ready`, `GET /health` (database check), `GET /api/v1`.',
    '',
  ];
  lines.push(...LISTS_AND_LIMITS, '');
  for (const [file, list] of byFile) {
    lines.push(`## ${file}`, '', '| Method | Path | Access | Limiters |', '|---|---|---|---|');
    for (const r of list) lines.push(`| ${r.method} | \`${r.path}\` | ${r.access} | ${r.limits.length ? r.limits.join(', ') : ''} |`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** `/api/orders/:id/amend` -> `/api/orders/{id}/amend`. */
export const openApiPath = (routePath) => routePath.replace(/:(\w+)/g, '{$1}');

const camel = (method, routePath) => `${method.toLowerCase()}${openApiPath(routePath).replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))}`;

/**
 * An OpenAPI 3.1 skeleton from the route rows. Honest about what it is: paths, methods, path parameters, who may call, and
 * generic error responses. No request or response bodies are described.
 */
export function buildOpenApi(rows, version = '0.0.0') {
  const paths = {};
  const operationIds = new Set();
  for (const row of rows) {
    const template = openApiPath(row.path);
    const method = row.method.toLowerCase();
    paths[template] ??= {};
    if (paths[template][method]) continue; // the same method and path registered twice: the first one is described
    const secured = row.access !== 'public';
    const permissions = [...row.access.matchAll(/permission ([a-z.+ ]+)/g)].flatMap((m) => m[1].split('+').map((p) => p.trim()).filter(Boolean));
    let operationId = camel(row.method, row.path);
    for (let n = 2; operationIds.has(operationId); n += 1) operationId = `${camel(row.method, row.path)}${n}`;
    operationIds.add(operationId);
    const responses = { 200: { description: 'Success.' }, 400: { $ref: '#/components/responses/BadRequest' } };
    if (secured) responses[401] = { $ref: '#/components/responses/Unauthorized' };
    if (permissions.length) responses[403] = { $ref: '#/components/responses/Forbidden' };
    if (/\{\w+\}/.test(template)) responses[404] = { $ref: '#/components/responses/NotFound' };
    if (row.limits.length) responses[429] = { $ref: '#/components/responses/RateLimited' };
    if (row.path.endsWith('/export')) responses[413] = { $ref: '#/components/responses/TooLarge' };
    const operation = {
      operationId,
      summary: `${row.method} ${row.path}`,
      tags: [row.file.replace(/\.js$/, '').split('/').pop()],
      security: secured ? [{ bearerAuth: [] }] : [],
      'x-access': row.access,
      responses,
    };
    if (permissions.length) operation['x-permissions'] = permissions;
    if (row.limits.length) operation['x-rate-limits'] = row.limits;
    if (OPTIONAL_PAGING.has(`${row.method} ${row.path}`)) {
      operation['x-paging'] = 'optional';
      operation.parameters = [{ $ref: '#/components/parameters/Page' }, { $ref: '#/components/parameters/PageSize' }];
    }
    paths[template][method] = operation;
  }
  const params = new Map();
  for (const template of Object.keys(paths)) for (const m of template.matchAll(/\{(\w+)\}/g)) params.set(`${template}|${m[1]}`, m[1]);
  for (const template of Object.keys(paths)) {
    const names = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (names.length) paths[template].parameters = names.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
  }
  const problem = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } } });
  return `${JSON.stringify({
    openapi: '3.1.0',
    info: {
      title: 'Avzar API',
      version,
      description: 'A route skeleton generated from the source by backend-node/scripts/generate-api-doc.js. It lists every route, its method, path parameters, who may call it (x-access, x-permissions) and the generic error responses. It has no request or response schemas: for those, read the route file. Do not edit by hand; run `npm run docs:api`.',
    },
    servers: [{ url: '/' }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      parameters: {
        Page: { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: 'With page or pageSize the list comes back as { items, page, pageSize, totalCount }.' },
        PageSize: { name: 'pageSize', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
      },
      responses: {
        BadRequest: problem('The request is invalid.'),
        Unauthorized: problem('Not signed in, or the session has ended.'),
        Forbidden: problem('The signed-in person lacks the permission or the plan feature.'),
        NotFound: problem('No such record in this business.'),
        TooLarge: problem('An export is limited to 50,000 rows; narrow the filters.'),
        RateLimited: problem('Too many requests.'),
      },
      schemas: { Problem: { type: 'object', properties: { status: { type: 'integer' }, title: { type: 'string' }, code: { type: 'string' } } } },
    },
  }, null, 2)}\n`;
}

export async function buildOpenApiFile() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  return buildOpenApi(await collectRows(), pkg.version);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await buildApiDoc();
  const openApi = await buildOpenApiFile();
  if (process.argv.includes('--check')) {
    const current = await readFile(DOC, 'utf8').catch(() => '');
    const currentOpenApi = await readFile(OPENAPI, 'utf8').catch(() => '');
    if (current !== text || currentOpenApi !== openApi) { console.error('docs/API.md or docs/openapi.json is out of date. Run: npm run docs:api'); process.exit(1); }
    console.info('docs/API.md and docs/openapi.json are up to date.');
  } else {
    await writeFile(DOC, text);
    await writeFile(OPENAPI, openApi);
    console.info(`Wrote ${DOC} and ${OPENAPI}`);
  }
}
