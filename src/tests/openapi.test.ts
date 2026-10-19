import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import request from 'supertest';
import { openApiDocument } from '../server/http/openapi-document';
import { mountApiDocs } from '../server/http/api-docs';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { requireCondition } from '../server/domain/errors';
import { companySchema, contactSchema, taskSchema } from '../shared/contracts';
const document: any = openApiDocument;
function walk(value: any, callback: (node: any) => void) {
  if (!value || typeof value !== 'object') return;
  callback(value);
  for (const child of Object.values(value)) walk(child, callback);
}

test('OpenAPI inventories every explicit current controller operation with unique IDs, security and local resolvable references', async () => {
  const source = await readFile('src/server/http/app.ts', 'utf8');
  const declared = [...source.matchAll(/@(Get|Post|Put|Patch|Delete)\('([^']+)'\)/g)]
    .map((match) => match[1]!.toLowerCase() + ' /' + match[2]!.replace(/:([A-Za-z]+)/g, '{$1}'))
    .sort();
  const actual = Object.entries(document.paths)
    .flatMap(([path, methods]: [string, any]) =>
      Object.keys(methods).map((method) => method + ' ' + path),
    )
    .sort();
  assert.deepEqual(actual, declared);
  assert.equal(actual.length, 54);
  const ids = Object.values(document.paths).flatMap((methods: any) =>
    Object.values(methods).map((operation: any) => operation.operationId),
  );
  assert.equal(new Set(ids).size, ids.length);
  for (const [path, methods] of Object.entries(document.paths) as [string, any][]) {
    for (const [method, operation] of Object.entries(methods) as [string, any][]) {
      assert.ok(operation.summary);
      assert.ok(operation.description);
      assert.ok(operation.responses[method === 'post' ? '201' : '200']);
      assert.ok(Array.isArray(operation.security));
      assert.equal(
        operation.parameters.filter((parameter: any) => parameter.in === 'path').length,
        [...path.matchAll(/\{/g)].length,
      );
      for (const parameter of operation.parameters.filter(
        (parameter: any) => parameter.in === 'path',
      ))
        assert.equal(parameter.required, true);
    }
  }
  walk(document, (node) => {
    if (node.$ref) {
      assert.ok(node.$ref.startsWith('#/'));
      let target = document;
      for (const key of node.$ref.slice(2).split('/'))
        target = target?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
      assert.ok(target, 'unresolved ' + node.$ref);
    }
  });
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.jsonSchemaDialect, 'https://spec.openapis.org/oas/3.1/dialect/base');
  assert.deepEqual(
    document.servers.map((server: any) => server.url),
    ['/api'],
  );
  assert.equal(
    document.paths['/telegram/webhook'].post.security[0].TelegramWebhookSecret.length,
    0,
  );
  assert.equal(
    document.components.securitySchemes.TelegramWebhookSecret.name,
    'X-Telegram-Bot-Api-Secret-Token',
  );
  for (const path of ['/users', '/users/admit'])
    assert.deepEqual(document.paths[path].post['x-roles'], ['admin']);
  assert.deepEqual(document.paths['/analytics/settings'].put['x-roles'], ['admin']);
  assert.deepEqual(document.paths['/downloads/files/{token}'].get.security, []);
  assert.equal(document.components.schemas.ContactInput.additionalProperties, false);
  assert.equal(document.components.schemas.ContactInput.properties.contactSource, undefined);
  assert.equal(document.components.schemas.Record.properties.contactSource.readOnly, true);
});

test('source schemas and synthetic examples remain valid without a JSON export', async () => {
  for (const [schema, key] of [
    [companySchema, 'CompanyInput'],
    [contactSchema, 'ContactInput'],
    [taskSchema, 'TaskInput'],
  ] as const)
    for (const example of document.components.schemas[key].examples) schema.parse(example);
  assert.equal(document.components.schemas.TaskInput.properties.completedAt, undefined);
  assert.equal(document.components.schemas.FileData.properties.key, undefined);
  assert.equal(document.components.schemas.FileData.additionalProperties, false);
  assert.equal(document.components.schemas.TaskData.properties.completedAt.readOnly, true);
  assert.deepEqual(document.components.schemas.CommercialReport.properties.clients.items.required, [
    'company',
    'text',
  ]);
  const signature = document.components.schemas.SavedSignature;
  assert.ok(signature.properties.id);
  assert.ok(signature.properties.firstName);
  assert.equal(signature.additionalProperties, false);
  assert.ok(document.components.schemas.ReportDetail.properties.candidates);
  assert.ok(document.components.schemas.ReportDetail.properties.status);
  const runtime = await readFile('src/server/http/api-docs.ts', 'utf8');
  assert.ok(!/localStorage|sessionStorage/.test(runtime));
  assert.ok(!/https:\/\//.test(runtime));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.dependencies['swagger-ui-dist'], '5.33.2');
  assert.equal(pkg.scarfSettings.enabled, false);
});

test('disabled documentation and every allowlisted asset stay unavailable without executing authorization', async () => {
  const raw = express();
  let calls = 0;
  mountApiDocs(raw, {
    enabled: false,
    authorize: async () => {
      calls++;
    },
  });
  for (const path of [
    '/api/docs',
    '/api/docs/openapi.json',
    '/api/docs/swagger-ui-bundle.js',
    '/api/docs/swagger-ui.css',
    '/api/docs/docs-bootstrap.js',
    '/api/docs/docs-shell.css',
  ])
    await request(raw).get(path).expect(404);
  assert.equal(calls, 0);
});

test('documentation schema requires a real current active administrator; public shell/assets contain no inventory or credentials', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-openapi-docs-'));
  const {
    app,
    services: s,
    db,
  } = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      DATA_DIR: dir,
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
    }),
  );
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  await request(app.getHttpServer()).get('/api/docs').expect(200);
  await request(app.getHttpServer()).get('/api/docs/openapi.json').expect(401);
  const admin = await s.auth.dev('admin', '127.0.0.1'),
    manager = await s.auth.dev('manager', '127.0.0.1'),
    supervisor = await s.auth.dev('supervisor', '127.0.0.1');
  const raw = express();
  mountApiDocs(raw, {
    enabled: true,
    authorize: async (req) => {
      const actor = await s.auth.authenticate(
        (req.headers.authorization || '').replace(/^Bearer /, ''),
      );
      requireCondition(actor.active && actor.role === 'admin', 403, 'Только администратор');
    },
  });
  const shell = await request(raw).get('/api/docs').expect(200);
  assert.ok(shell.text.includes('type="password"'));
  assert.ok(!shell.text.includes('/companies'));
  assert.ok(!shell.text.includes('openapi":"'));
  const csp = shell.headers['content-security-policy'];
  assert.ok(csp);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https:/);
  const bootstrap = await request(raw).get('/api/docs/docs-bootstrap.js').expect(200);
  assert.match(bootstrap.text, /supportedSubmitMethods: \[\]/);
  assert.match(bootstrap.text, /persistAuthorization: false/);
  assert.match(bootstrap.text, /validatorUrl: null/);
  assert.match(bootstrap.text, /queryConfigEnabled: false/);
  assert.doesNotMatch(bootstrap.text, /localStorage|sessionStorage|console\./);
  for (const asset of ['swagger-ui-bundle.js', 'swagger-ui.css']) {
    const response = await request(raw)
      .get('/api/docs/' + asset)
      .expect(200);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  await request(raw).get('/api/docs/../../package.json').expect(404);
  await request(raw).get('/api/docs/swagger-ui-bundle.js.map').expect(404);
  await request(raw).get('/api/docs/openapi.json').expect(401);
  await request(raw)
    .get('/api/docs/openapi.json?token=' + admin.token)
    .expect(401);
  for (const actor of [manager, supervisor])
    await request(raw)
      .get('/api/docs/openapi.json')
      .set('Authorization', `Bearer ${actor.token}`)
      .expect(403);
  const allowed = await request(raw)
    .get('/api/docs/openapi.json')
    .set('Authorization', `Bearer ${admin.token}`)
    .expect(200);
  assert.deepEqual(allowed.body, document);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  await db.query("UPDATE users SET role='manager' WHERE id=$1", [admin.user.id]);
  await request(raw)
    .get('/api/docs/openapi.json')
    .set('Authorization', `Bearer ${admin.token}`)
    .expect(403);
  await db.query("UPDATE users SET role='admin',active=false WHERE id=$1", [admin.user.id]);
  await request(raw)
    .get('/api/docs/openapi.json')
    .set('Authorization', `Bearer ${admin.token}`)
    .expect(403);
});

// Narrow wire-shape checks, not a replacement for a full OpenAPI/JSON Schema validator.
function assertWire(schema: any, value: any, path = 'response') {
  if (schema.$ref) {
    assertWire(document.components.schemas[schema.$ref.split('/').at(-1)], value, path);
    return;
  }
  if (schema.anyOf) {
    assert.ok(
      schema.anyOf.some((part: any) => {
        try {
          assertWire(part, value, path);
          return true;
        } catch {
          return false;
        }
      }),
      'no variant matches ' + path,
    );
    return;
  }
  if (schema.const !== undefined) assert.equal(value, schema.const, path);
  if (schema.enum) assert.ok(schema.enum.includes(value), path);
  if (schema.type === 'null') {
    assert.equal(value, null, path);
    return;
  }
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), path);
    for (const key of schema.required || [])
      assert.ok(Object.hasOwn(value, key), path + '.' + key + ' required');
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) assertWire(schema.properties[key], item, path + '.' + key);
      else if (schema.additionalProperties === false)
        assert.fail(path + '.' + key + ' undocumented');
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value), path);
    for (const item of value) assertWire(schema.items, item, path + '[]');
  } else if (schema.type === 'integer') assert.ok(Number.isInteger(value), path);
  else if (schema.type) assert.equal(typeof value, schema.type, path);
}

test('real createApp docs integration guards fresh roles and documented public wire shapes match actual HTTP responses', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-openapi-integration-'));
  const {
    app,
    services: s,
    db,
  } = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      API_DOCS_ENABLED: 'true',
      DATA_DIR: dir,
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
    }),
  );
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const admin = await s.auth.dev('admin', '127.0.0.1'),
    manager = await s.auth.dev('manager', '127.0.0.1'),
    supervisor = await s.auth.dev('supervisor', '127.0.0.1');
  const server = app.getHttpServer();
  await request(server).get('/api/docs').expect(200);
  await request(server).get('/api/docs/openapi.json').expect(401);
  for (const actor of [manager, supervisor])
    await request(server)
      .get('/api/docs/openapi.json')
      .set('Authorization', `Bearer ${actor.token}`)
      .expect(403);
  const allowed = await request(server)
    .get('/api/docs/openapi.json')
    .set('Authorization', `Bearer ${admin.token}`)
    .expect(200);
  assert.deepEqual(allowed.body, document);
  const own = await request(server)
    .post('/api/companies')
    .set('Authorization', `Bearer ${manager.token}`)
    .send({ name: 'Документация QA', potential: 0 })
    .expect(201);
  assertWire(document.components.schemas.Company, own.body);
  const task = await request(server)
    .post(`/api/companies/${own.body.id}/records/task`)
    .set('Authorization', `Bearer ${manager.token}`)
    .send({ data: { text: 'Проверить описание API' } })
    .expect(201);
  assertWire(document.components.schemas.Record, task.body);
  const file = await request(server)
    .post(`/api/companies/${own.body.id}/files`)
    .set('Authorization', `Bearer ${manager.token}`)
    .field('category', 'docs')
    .attach('file', Buffer.from('%PDF-synthetic-only'), {
      filename: 'example.pdf',
      contentType: 'application/pdf',
    })
    .expect(201);
  assertWire(document.components.schemas.Record, file.body);
  assert.equal(file.body.data.key, undefined);
  const detail = await request(server)
    .get(`/api/companies/${own.body.id}`)
    .set('Authorization', `Bearer ${manager.token}`)
    .expect(200);
  assertWire(document.components.schemas.CompanyDetail, detail.body);
  const analytics = await request(server)
    .get('/api/analytics?from=2026-01-01&to=2026-12-31&mode=all')
    .set('Authorization', `Bearer ${manager.token}`)
    .expect(200);
  assertWire(document.components.schemas.AnalyticsSummary, analytics.body);
  const signatures = await request(server)
    .get('/api/me/letter-signatures')
    .set('Authorization', `Bearer ${manager.token}`)
    .expect(200);
  assertWire(
    { type: 'array', items: { $ref: '#/components/schemas/SavedSignature' } },
    signatures.body,
  );
  await db.query("UPDATE users SET role='manager' WHERE id=$1", [admin.user.id]);
  await request(server)
    .get('/api/docs/openapi.json')
    .set('Authorization', `Bearer ${admin.token}`)
    .expect(403);
  await db.query("UPDATE users SET role='admin',active=false WHERE id=$1", [admin.user.id]);
  await request(server)
    .get('/api/docs/openapi.json')
    .set('Authorization', `Bearer ${admin.token}`)
    .expect(403);
});

test('actual generator accepts JSON formatting and key-order changes but detects changed specification content', () => {
  const { assertArtifactCurrent } = require('../../scripts/generate-openapi.cjs');
  assert.doesNotThrow(() => assertArtifactCurrent(JSON.stringify(document), document));
  const reordered = Object.fromEntries(Object.entries(document).reverse());
  assert.doesNotThrow(() =>
    assertArtifactCurrent(JSON.stringify(reordered, null, 8) + '\n', document),
  );
  const changed = structuredClone(document);
  changed.info.title = 'Stale synthetic title';
  assert.throws(
    () => assertArtifactCurrent(JSON.stringify(changed), document),
    /artifact is stale/,
  );
  const removed = structuredClone(document);
  delete removed.paths['/health'];
  assert.throws(
    () => assertArtifactCurrent(JSON.stringify(removed), document),
    /artifact is stale/,
  );
  assert.throws(() => assertArtifactCurrent('{', document), /not valid JSON/);
});

test('OpenAPI export creates missing directories and matches the runtime schema', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-openapi-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'api', 'openapi.json');
  const { exportDocument } = require('../../scripts/generate-openapi.cjs');
  await exportDocument(document, target);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), document);
});

test('Swagger is enabled by default and can explicitly be disabled', () => {
  assert.equal(makeConfig({ NODE_ENV: 'test' }).apiDocsEnabled, true);
  assert.equal(makeConfig({ NODE_ENV: 'test', API_DOCS_ENABLED: 'false' }).apiDocsEnabled, false);
});
