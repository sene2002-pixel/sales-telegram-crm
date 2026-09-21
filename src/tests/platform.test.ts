import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { makeConfig } from '../server/config';
import { Database } from '../server/infra/database';
import { createApp, Services } from '../server/http/app';
import { Actor, Extraction, companySchema, dateSchema, validInn } from '../shared/contracts';
import { verifyTelegram } from '../server/services/auth';
import { ReportWorker } from '../server/services/worker';
import { DomainError } from '../server/domain/errors';
import { OpenAiAdapter } from '../server/infra/ai';
import { Pool } from 'pg';

let dir: string, db: Database, s: Services, app: any, server: any;
let postgresAdmin: Pool | undefined, testSchema: string;
let admin: Actor,
  manager: Actor,
  other: Actor,
  adminToken: string,
  managerToken: string,
  otherToken: string;
const config = makeConfig({
  NODE_ENV: 'test',
  DEV_AUTH: 'true',
  WORKER_ENABLED: 'false',
  SESSION_SECRET: 'test-only-session-secret-at-least-32-chars',
  BOT_TOKEN: 'test-bot-token',
  TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-32-characters-long',
});
function signed(id = 12345, at = Math.floor(Date.now() / 1000)) {
  const fields = {
    auth_date: String(at),
    query_id: 'test-query',
    user: JSON.stringify({ id, first_name: 'Test' }),
  };
  const secret = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const hash = createHmac('sha256', secret)
    .update(
      Object.entries(fields)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    )
    .digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
function draft(name: string): Extraction {
  return {
    warnings: [],
    blocks: [
      {
        companyName: name,
        inn: null,
        city: 'Казань',
        segment: 'end_client',
        stage: 'dialogue',
        potential: 3000000,
        divisions: [{ key: 'lv', amount: 3000000 }],
        summary: 'Обсудили предложение',
        occurredOn: '2026-09-14',
        contacts: [{ name: 'Иван', role: 'Директор', phone: null, email: null }],
        tasks: [{ text: 'Отправить предложение', due: '2026-09-15' }],
      },
    ],
  };
}
async function readyReport(actor: Actor, body: Extraction) {
  const report = await s.reports.enqueue(actor, { sourceKey: randomUUID(), text: 'Текст отчёта' });
  await db.query(`UPDATE reports SET status='review',draft=$1 WHERE id=$2`, [
    JSON.stringify(body),
    report.id,
  ]);
  return report;
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'telegram-crm-tests-'));
  config.dataDir = dir;
  if (process.env.TEST_DATABASE_URL) {
    postgresAdmin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    testSchema = 'test_' + randomUUID().replaceAll('-', '');
    await postgresAdmin.query(`CREATE SCHEMA ${testSchema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${testSchema}`);
    config.databaseUrl = url.toString();
  }
  db = new Database(config);
  await db.init();
  const built = await createApp(config, db);
  app = built.app;
  s = built.services;
  server = app.getHttpServer();
  const a = await s.auth.dev('admin', '127.0.0.1'),
    m = await s.auth.dev('manager', '127.0.0.1');
  admin = a.user;
  adminToken = a.token;
  manager = m.user;
  managerToken = m.token;
  await s.auth.saveUser(admin, {
    telegramId: '22222',
    name: 'Второй менеджер',
    role: 'manager',
    active: true,
  });
  other = await s.auth.byTelegram('22222');
  otherToken = s.auth.issue(other);
});
after(async () => {
  await app?.close();
  await db?.close();
  if (postgresAdmin) {
    await postgresAdmin.query(`DROP SCHEMA ${testSchema} CASCADE`);
    await postgresAdmin.end();
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});
test('Telegram signature: valid, tampered, old, future, duplicate keys', () => {
  assert.equal(verifyTelegram(signed(), config.botToken).id, '12345');
  assert.throws(() => verifyTelegram(signed().replace('Test', 'Fake'), config.botToken));
  assert.throws(() => verifyTelegram(signed(12345, 1), config.botToken));
  assert.throws(() =>
    verifyTelegram(signed(12345, Math.floor(Date.now() / 1000) + 120), config.botToken),
  );
  assert.throws(() => verifyTelegram(signed() + '&auth_date=1', config.botToken));
});
test('validates INN, impossible calendar dates and negative money', () => {
  assert.equal(validInn('7707083893'), true);
  assert.equal(validInn('7707083894'), false);
  assert.equal(dateSchema.safeParse('2026-02-30').success, false);
  assert.equal(companySchema.safeParse({ name: 'A', potential: -1 }).success, false);
});
test('production refuses demo auth and missing secrets', () => {
  assert.throws(() => makeConfig({ NODE_ENV: 'production', DEV_AUTH: 'true' }));
});
test('HTTP requires a session and denies tampering', async () => {
  await request(server).get('/api/companies').expect(401);
  await request(server)
    .get('/api/companies')
    .set('Authorization', 'Bearer ' + managerToken + 'x')
    .expect(401);
  await request(server).post('/api/telegram/webhook').send({ update_id: 1 }).expect(401);
});
test('company CRUD persists, rejects stale writes and isolates managers', async () => {
  const response = await request(server)
    .post('/api/companies')
    .set('Authorization', 'Bearer ' + managerToken)
    .send({ name: 'Изоляция', inn: '7707083893' })
    .expect(201);
  const id = response.body.id;
  await request(server)
    .get(`/api/companies/${id}`)
    .set('Authorization', 'Bearer ' + otherToken)
    .expect(404);
  const others = await request(server)
    .get('/api/companies')
    .set('Authorization', 'Bearer ' + otherToken)
    .expect(200);
  assert.equal(others.body.length, 0);
  await request(server)
    .patch(`/api/companies/${id}`)
    .set('Authorization', 'Bearer ' + managerToken)
    .send({ version: 1, data: { name: 'Обновлено', inn: '7707083893' } })
    .expect(200);
  await request(server)
    .patch(`/api/companies/${id}`)
    .set('Authorization', 'Bearer ' + managerToken)
    .send({ version: 1, data: { name: 'Устаревшая версия' } })
    .expect(409);
  await request(server)
    .post('/api/companies')
    .set('Authorization', 'Bearer ' + adminToken)
    .send({ name: 'Дубликат ИНН', inn: '7707083893' })
    .expect(409);
  assert.equal((await s.crm.company(manager, id)).name, 'Обновлено');
});
test('same company names do not overwrite each other', async () => {
  const a = await s.crm.create(manager, { name: 'Одинаковое имя' }),
    b = await s.crm.create(manager, { name: 'Одинаковое имя' });
  assert.notEqual(a.id, b.id);
});
test('record ACL and cross-company project references are enforced', async () => {
  const a = await s.crm.create(manager, { name: 'Связи A' }),
    b = await s.crm.create(other, { name: 'Связи B' });
  const project = await s.crm.createRecord(other, b.id, 'project', { name: 'Чужой проект' });
  await assert.rejects(() =>
    s.crm.createRecord(manager, a.id, 'task', { text: 'Неверная связь' }, project.id),
  );
  const contact = await s.crm.createRecord(manager, a.id, 'contact', { name: 'Контакт' });
  await request(server)
    .patch(`/api/records/${contact.id}`)
    .set('Authorization', 'Bearer ' + otherToken)
    .send({ version: 1, data: { name: 'Подмена' } })
    .expect(404);
  await request(server)
    .post(`/api/companies/${a.id}/records/file`)
    .set('Authorization', 'Bearer ' + managerToken)
    .send({ data: { name: 'fake' } })
    .expect(400);
});
test('assignment transfers open tasks but preserves completed tasks and authors', async () => {
  const company = await s.crm.create(manager, { name: 'Передача' });
  const open = await s.crm.createRecord(manager, company.id, 'task', { text: 'Открытая' });
  const done = await s.crm.createRecord(manager, company.id, 'task', {
    text: 'Закрытая',
    done: true,
  });
  await assert.rejects(() => s.crm.assign(manager, company.id, other.id, 1));
  await s.crm.assign(admin, company.id, other.id, 1);
  await assert.rejects(() => s.crm.company(manager, company.id));
  const detail = await s.crm.detail(other, company.id);
  assert.equal(detail.records.find((r) => r.id === open.id)?.assigneeId, other.id);
  assert.equal(detail.records.find((r) => r.id === done.id)?.assigneeId, manager.id);
  assert.equal(detail.records.find((r) => r.id === open.id)?.authorId, manager.id);
  assert.ok(detail.audit.some((a) => a.action === 'company.assigned'));
});
test('duplicate inbound messages enqueue a single report', async () => {
  const key = randomUUID();
  const a = await s.reports.enqueue(manager, { text: 'Текст', sourceKey: key });
  const b = await s.reports.enqueue(manager, { text: 'Текст', sourceKey: key });
  assert.equal(a.id, b.id);
});
test('report confirmation atomically creates records; repeat confirmation is idempotent', async () => {
  const body = draft('Голосовая компания'),
    r = await readyReport(manager, body);
  const result = await s.reports.confirm(manager, r.id, {
    version: 1,
    draft: body,
    companyIds: [null],
  });
  await s.reports.confirm(manager, r.id, { version: 1, draft: body, companyIds: [null] });
  const detail = await s.crm.detail(manager, result.result[0].companyId);
  assert.equal(detail.records.filter((x) => x.kind === 'task').length, 1);
  assert.equal(detail.records.filter((x) => x.kind === 'contact').length, 1);
  assert.equal(detail.records.filter((x) => x.kind === 'activity').length, 1);
  assert.equal(detail.company.potential, 3000000);
  assert.equal(detail.records.find((x) => x.kind === 'activity')?.data.reportId, r.id);
});
test('confirmation with a forbidden company rolls back earlier blocks', async () => {
  const чужая = await s.crm.create(other, { name: 'Недоступна' });
  const body = draft('Должна откатиться');
  body.blocks.push({ ...body.blocks[0]!, companyName: 'Недоступна' });
  const r = await readyReport(manager, body);
  await assert.rejects(() =>
    s.reports.confirm(manager, r.id, { version: 1, draft: body, companyIds: [null, чужая.id] }),
  );
  assert.equal(
    (await s.crm.list(manager)).some((c) => c.name === 'Должна откатиться'),
    false,
  );
  assert.equal((await s.reports.get(manager, r.id)).status, 'review');
});
test('ambiguous names require explicit company selection', async () => {
  const body = draft('Одинаковое имя'),
    r = await readyReport(manager, body);
  await assert.rejects(() => s.reports.confirmCurrent(manager, r.id), /Несколько компаний/);
});
test('edited draft rejects stale confirmation; cancelled draft cannot be saved', async () => {
  const body = draft('Редактирование'),
    r = await readyReport(manager, body);
  await s.reports.edit(manager, r.id, 1, body);
  await assert.rejects(() =>
    s.reports.confirm(manager, r.id, { version: 1, draft: body, companyIds: [null] }),
  );
  await s.reports.transition(manager, r.id, 'cancel');
  await assert.rejects(() =>
    s.reports.confirm(manager, r.id, { version: 3, draft: body, companyIds: [null] }),
  );
});
test('report ACL denies another manager', async () => {
  const r = await readyReport(manager, draft('ACL отчёта'));
  await request(server)
    .get(`/api/reports/${r.id}`)
    .set('Authorization', 'Bearer ' + otherToken)
    .expect(404);
});
test('worker handles text with a fake extractor and recovers an expired lease', async () => {
  // Isolate queued fixtures from earlier tests.
  await db.query(`UPDATE reports SET status='cancelled' WHERE status='queued'`);
  const r = await s.reports.enqueue(manager, { text: 'Компания Тест', sourceKey: randomUUID() });
  await db.query(
    `UPDATE reports SET status='processing',lease_until=now()-interval '1 minute' WHERE id=$1`,
    [r.id],
  );
  let called = 0;
  const worker = new ReportWorker(
    db,
    s.reports,
    {
      transcribe: async () => {
        throw new Error('Not audio');
      },
    },
    {
      extract: async (text) => {
        called++;
        assert.equal(text, 'Компания Тест');
        return draft('Из очереди');
      },
    },
    { send: async () => {}, download: async () => new Uint8Array() },
    config,
  );
  assert.equal(await worker.processOne(), true);
  assert.equal(called, 1);
  const saved = await s.reports.get(manager, r.id);
  assert.equal(saved.status, 'review');
  assert.equal(saved.lease_token, null);
});
test('missing AI configuration becomes a visible terminal error', async () => {
  const r = await s.reports.enqueue(manager, { text: 'Ошибка', sourceKey: randomUUID() });
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => '' },
    {
      extract: async () => {
        throw new DomainError(503, 'Ключ ИИ не настроен');
      },
    },
    { send: async () => {}, download: async () => new Uint8Array() },
    config,
  );
  await worker.processOne();
  const failed = await s.reports.get(manager, r.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /не настроен/);
  await s.reports.transition(manager, r.id, 'retry');
  assert.equal((await s.reports.get(manager, r.id)).status, 'queued');
  await s.reports.transition(manager, r.id, 'cancel');
});
test('file uploads and downloads are persistent and protected', async () => {
  const c = await s.crm.create(manager, { name: 'Файлы' });
  const uploaded = await request(server)
    .post(`/api/companies/${c.id}/files`)
    .set('Authorization', 'Bearer ' + managerToken)
    .field('category', 'docs')
    .attach('file', Buffer.from('CRM test file'), 'example.txt')
    .expect(201);
  await request(server)
    .get(`/api/files/${uploaded.body.id}`)
    .set('Authorization', 'Bearer ' + otherToken)
    .expect(404);
  const downloaded = await request(server)
    .get(`/api/files/${uploaded.body.id}`)
    .set('Authorization', 'Bearer ' + managerToken)
    .expect(200);
  assert.equal(downloaded.body.toString(), 'CRM test file');
  await request(server)
    .delete(`/api/files/${uploaded.body.id}`)
    .set('Authorization', 'Bearer ' + managerToken)
    .expect(200);
  await request(server)
    .get(`/api/files/${uploaded.body.id}`)
    .set('Authorization', 'Bearer ' + managerToken)
    .expect(404);
});
test('dashboard is supervisor-only and CSV neutralizes formula names', async () => {
  await request(server)
    .get('/api/dashboard?from=2026-09-01&to=2026-09-30')
    .set('Authorization', 'Bearer ' + managerToken)
    .expect(403);
  await s.auth.saveUser(admin, {
    telegramId: '33333',
    name: '=SUM(1)',
    role: 'manager',
    active: true,
  });
  const csv = await s.dashboard.csv(admin, '2026-09-01', '2026-09-30');
  assert.ok(csv.includes("'=SUM(1)"));
});
test('deactivation revokes existing sessions', async () => {
  await s.auth.saveUser(admin, {
    telegramId: '22222',
    name: 'Второй менеджер',
    role: 'manager',
    active: false,
  });
  await request(server)
    .get('/api/me')
    .set('Authorization', 'Bearer ' + otherToken)
    .expect(403);
});
test('voice webhook stores one durable report despite duplicate delivery', async () => {
  const update = {
    update_id: 98765,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      from: { id: 33333, first_name: 'Test' },
      chat: { id: 33333, type: 'private' },
      voice: { file_id: 'voice-test', duration: 10, file_size: 1000 },
    },
  };
  await request(server)
    .post('/api/telegram/webhook')
    .set('X-Telegram-Bot-Api-Secret-Token', config.webhookSecret)
    .send(update)
    .expect(201);
  await request(server)
    .post('/api/telegram/webhook')
    .set('X-Telegram-Bot-Api-Secret-Token', config.webhookSecret)
    .send(update)
    .expect(201);
  const rows = await db.query(`SELECT id FROM reports WHERE source_key='telegram:98765'`);
  assert.equal(rows.length, 1);
  await db.query(`UPDATE reports SET status='cancelled' WHERE id=$1`, [rows[0].id]);
});
test('audio pipeline calls download, transcription and extraction before review', async () => {
  const r = await s.reports.enqueue(manager, { audioFileId: 'audio-id', sourceKey: randomUUID() });
  const calls: string[] = [];
  const worker = new ReportWorker(
    db,
    s.reports,
    {
      transcribe: async (audio) => {
        calls.push('transcribe');
        assert.equal(audio.length, 3);
        return 'Распознанная речь';
      },
    },
    {
      extract: async (text) => {
        calls.push('extract');
        assert.equal(text, 'Распознанная речь');
        return draft('Аудио');
      },
    },
    {
      send: async () => {},
      download: async (id) => {
        calls.push('download');
        assert.equal(id, 'audio-id');
        return new Uint8Array([1, 2, 3]);
      },
    },
    config,
  );
  await worker.processOne();
  assert.deepEqual(calls, ['download', 'transcribe', 'extract']);
  assert.equal((await s.reports.get(manager, r.id)).status, 'review');
});
test('expired third attempt is terminal instead of looping forever', async () => {
  const r = await s.reports.enqueue(manager, {
    text: 'Исчерпание попыток',
    sourceKey: randomUUID(),
  });
  await db.query(
    `UPDATE reports SET status='processing',attempts=3,lease_until=now()-interval '1 minute' WHERE id=$1`,
    [r.id],
  );
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => '' },
    {
      extract: async () => {
        throw new Error('Must not be called');
      },
    },
    { send: async () => {}, download: async () => new Uint8Array() },
    config,
  );
  await worker.processOne();
  assert.equal((await s.reports.get(manager, r.id)).status, 'failed');
});
test('stale bot button cannot apply a newly edited draft', async () => {
  const body = draft('Старая кнопка'),
    r = await readyReport(manager, body);
  await s.reports.edit(manager, r.id, 1, body);
  await assert.rejects(() => s.reports.confirmCurrent(manager, r.id, 1), /изменён/);
});
test('OpenAI adapter uses multipart transcription and strict output schema, handles refusal', async () => {
  const original = globalThis.fetch;
  const seen: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url, init });
    return new Response(
      JSON.stringify(
        String(url).endsWith('transcriptions')
          ? { text: 'Текст из аудио' }
          : {
              status: 'completed',
              output: [
                {
                  content: [
                    { type: 'output_text', text: JSON.stringify(draft('Контракт провайдера')) },
                  ],
                },
              ],
            },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const adapter = new OpenAiAdapter({ ...config, apiKey: 'fake-test-key' });
    assert.equal(await adapter.transcribe(new Uint8Array([1, 2])), 'Текст из аудио');
    const body = seen[0].init.body as FormData;
    assert.ok(body.get('file') instanceof Blob);
    assert.equal(body.get('language'), 'ru');
    const result = await adapter.extract('Отчёт', '2026-09-14T12:00:00Z');
    assert.equal(result.blocks[0]?.companyName, 'Контракт провайдера');
    const requestBody = JSON.parse(seen[1].init.body);
    assert.equal(requestBody.text.format.strict, true);
    assert.equal(requestBody.store, false);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ content: [{ type: 'refusal', refusal: 'No company' }] }],
        }),
      )) as typeof fetch;
    await assert.rejects(
      () => adapter.extract('Без компании', '2026-09-14T12:00:00Z'),
      /название компании/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('database survives reopening and migrations are repeatable', async () => {
  await db.close();
  await db.init();
  const companies = await s.crm.list(manager);
  assert.ok(companies.some((c) => c.name === 'Голосовая компания'));
  const versions = await db.query('SELECT version FROM schema_migrations');
  assert.deepEqual(versions.map((v) => v.version).sort(), [1, 2]);
});
