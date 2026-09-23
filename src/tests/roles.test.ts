import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import request from 'supertest';
import { makeConfig } from '../server/config';
import { Database } from '../server/infra/database';
import { createApp, Services } from '../server/http/app';
import { Actor, Company, Extraction, Role, companySchema, roles } from '../shared/contracts';
import { BotService } from '../server/services/bot';
import { TelegramAdapter } from '../server/infra/telegram';
import { ReportWorker } from '../server/services/worker';
import { DomainError } from '../server/domain/errors';
import { ExportService } from '../server/services/exports';
import { readFile } from 'node:fs/promises';

test(
  'Letters: renders PDF, persists company file and reserves unique numbers',
  { skip: !process.env.LETTER_PYTHON },
  async () => {
    const contact = await s.crm.createRecord(actors.manager, own.id, 'contact', {
      name: 'Иванов Иван Иванович',
      role: 'Директор',
    });
    await s.letters.saveSignature(actors.manager, {
      lastName: 'Петров',
      firstName: 'Пётр',
      patronymic: '',
      workPhone: '',
      mobilePhone: '',
      email: '',
    });
    const fixture = JSON.parse(await readFile('assets/esq/data_example.json', 'utf8'));
    const original = s.letters.ai.request;
    s.letters.ai.request = async () => ({
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                recipient_lines: fixture.recipient_lines,
                references_paragraph: fixture.references_paragraph,
                sources: ['https://example.com'],
              }),
            },
          ],
        },
      ],
    });
    try {
      const result = await api(actors.manager, 'post', `/companies/${own.id}/letters`, {
        contactId: contact.id,
      }).expect(201);
      const file = await api(actors.manager, 'get', `/files/${result.body.record.id}`).expect(200);
      assert.equal(file.body.subarray(0, 5).toString(), '%PDF-');
      await api(other, 'get', `/files/${result.body.record.id}`).expect(404);
      const second = await api(actors.manager, 'post', `/companies/${own.id}/letters`, {
        contactId: contact.id,
      }).expect(201);
      assert.notEqual(second.body.record.data.name, result.body.record.data.name);
    } finally {
      s.letters.ai.request = original;
    }
  },
);

test('Letters: no contacts, foreign contacts and private confirmed signatures', async () => {
  await request(server).post('/api/me/letter-signature').send({}).expect(401);
  const absent = await api(actors.manager, 'post', `/companies/${own.id}/letters`, {
    contactId: randomUUID(),
  }).expect(400);
  assert.match(absent.body.message, /хотя бы один контакт/);
  await api(other, 'post', `/companies/${own.id}/letters`, { contactId: randomUUID() }).expect(404);
  const contact = await s.crm.createRecord(actors.manager, own.id, 'contact', {
    name: 'Иванов Иван Иванович',
    role: 'Директор',
  });
  await api(actors.manager, 'post', `/companies/${own.id}/letters`, {
    contactId: randomUUID(),
  }).expect(400);
  const missing = await api(actors.manager, 'post', `/companies/${own.id}/letters`, {
    contactId: contact.id,
  }).expect(400);
  assert.match(missing.body.message, /подпись/);
  const signature = {
    lastName: 'Петров',
    firstName: 'Пётр',
    patronymic: '',
    workPhone: '123',
    mobilePhone: '',
    email: 'test@example.com',
  };
  await api(actors.manager, 'post', '/me/letter-signature', signature).expect(201);
  const saved = await api(actors.manager, 'get', '/me/letter-signature').expect(200);
  assert.deepEqual(saved.body.signature, signature);
  const isolated = await api(other, 'get', '/me/letter-signature').expect(200);
  assert.equal(isolated.body.signature, null);
  await api(actors.manager, 'post', '/me/letter-signature', {
    ...signature,
    userId: other.id,
  }).expect(400);
  await api(actors.manager, 'post', '/me/letter-signature/recognize')
    .attach('file', Buffer.from('not an image'), 'card.jpg')
    .expect(400);
});

test('Letters: recognition stays a draft until explicitly saved', async () => {
  const signature = {
    lastName: 'Иванов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  };
  const original = s.letters.ai.request;
  s.letters.ai.request = async () => ({
    status: 'completed',
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(signature) }] }],
  });
  try {
    const result = await api(actors.manager, 'post', '/me/letter-signature/recognize')
      .attach('file', Buffer.from([255, 216, 255, 0]), 'card.jpg')
      .expect(201);
    assert.deepEqual(result.body, signature);
    assert.equal(await s.letters.signature(actors.manager), null);
  } finally {
    s.letters.ai.request = original;
  }
});

test('Contacts: deletion is authorized, soft, audited and blocks letters without contacts', async () => {
  const contact = await s.crm.createRecord(actors.manager, own.id, 'contact', {
    name: 'Удаляемый контакт',
  });
  await request(server).delete(`/api/contacts/${contact.id}`).expect(401);
  await api(other, 'delete', `/contacts/${contact.id}`).expect(404);
  const task = await s.crm.createRecord(actors.manager, own.id, 'task', { text: 'Не контакт' });
  await api(actors.manager, 'delete', `/contacts/${task.id}`).expect(404);
  await api(actors.manager, 'delete', `/contacts/${contact.id}`).expect(200);
  const detail = await s.crm.detail(actors.manager, own.id);
  assert.equal(
    detail.records.some((r) => r.id === contact.id),
    false,
  );
  assert.ok(detail.audit.some((a) => a.action === 'contact.deleted'));
  const [stored] = await db.query('SELECT deleted FROM records WHERE id=$1', [contact.id]);
  assert.equal(stored.deleted, true);
  await api(actors.manager, 'delete', `/contacts/${contact.id}`).expect(404);
  const letter = await api(actors.manager, 'post', `/companies/${own.id}/letters`, {
    contactId: contact.id,
  }).expect(400);
  assert.match(letter.body.message, /хотя бы один контакт/);
});

test('Signatures: limit, isolation, editing, deletion and concurrent creation', async () => {
  const data = {
    lastName: 'Иванов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  };
  await request(server).get('/api/me/letter-signatures').expect(401);
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => s.letters.writeSignature(actors.manager, data)),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.reason.status, 409);
  const saved = results.find((r) => r.status === 'fulfilled')!.value;
  const list = await api(actors.manager, 'get', '/me/letter-signatures').expect(200);
  assert.equal(list.body.length, 3);
  assert.deepEqual((await api(other, 'get', '/me/letter-signatures')).body, []);
  await api(other, 'patch', `/me/letter-signatures/${saved.id}`, data).expect(404);
  await api(other, 'delete', `/me/letter-signatures/${saved.id}`).expect(404);
  await api(actors.manager, 'patch', `/me/letter-signatures/${saved.id}`, {
    ...data,
    firstName: 'Пётр',
  }).expect(200);
  await api(actors.manager, 'post', '/me/letter-signature', data).expect(409);
  const contact = await s.crm.createRecord(actors.manager, own.id, 'contact', {
    name: 'Иванов',
    role: 'Директор',
  });
  await api(actors.manager, 'post', `/companies/${own.id}/letters`, {
    contactId: contact.id,
    signatureId: randomUUID(),
  }).expect(400);
  await api(actors.manager, 'post', `/companies/${own.id}/letters`, {
    contactId: contact.id,
  }).expect(400);
  await api(actors.manager, 'delete', `/me/letter-signatures/${saved.id}`).expect(200);
  await api(actors.manager, 'delete', `/me/letter-signatures/${saved.id}`).expect(404);
  await api(actors.manager, 'post', `/companies/${own.id}/letters`, {
    contactId: contact.id,
    signatureId: saved.id,
  }).expect(400);
  await api(actors.manager, 'post', '/me/letter-signatures', data).expect(201);
});

test('Signatures: upgrades legacy signature without loss and migration is repeatable', async () => {
  const data = {
    lastName: 'Старый',
    firstName: 'Контакт',
    patronymic: '',
    workPhone: '123',
    mobilePhone: '',
    email: '',
  };
  await db.transaction(async (tx) => {
    await tx.query('DROP TABLE letter_signatures');
    await tx.query(
      'CREATE TABLE letter_signatures(user_id uuid PRIMARY KEY REFERENCES users(id),data jsonb NOT NULL)',
    );
    await tx.query('INSERT INTO letter_signatures(user_id,data) VALUES($1,$2)', [
      actors.manager.id,
      JSON.stringify(data),
    ]);
    await tx.query('DELETE FROM schema_migrations WHERE version=2');
  });
  await db.migrate();
  await db.migrate();
  assert.deepEqual(await s.letters.signatures(actors.manager), [
    { ...data, id: actors.manager.id, isDefault: false },
  ]);
  await s.letters.writeSignature(actors.manager, { ...data, firstName: 'Второй' });
  assert.equal((await s.letters.signatures(actors.manager)).length, 2);
});

test('CSV download: leaders only, authenticated creation, strict parameters', async () => {
  const body = { from: '2026-09-01', to: '2026-09-15' };
  await request(server).post('/api/dashboard/export-link').send(body).expect(401);
  for (const endpoint of ['export-link', 'export-bot']) {
    await api(actors.manager, 'post', `/dashboard/${endpoint}`, body).expect(403);
    await api(actors.admin, 'post', `/dashboard/${endpoint}`, { ...body, chatId: '999' }).expect(
      400,
    );
    await api(actors.admin, 'post', `/dashboard/${endpoint}`, { ...body, from: 'invalid' }).expect(
      400,
    );
  }
  for (const role of ['admin', 'supervisor'] as const) {
    const issued = await api(actors[role], 'post', '/dashboard/export-link', body).expect(201);
    assert.match(
      issued.body.url,
      /^https:\/\/crm.example.test\/api\/downloads\/csv\/[a-f0-9]{64}$/,
    );
    assert.equal(issued.body.filename, 'team-report-2026-09-01-2026-09-15.csv');
    const file = await request(server).get(new URL(issued.body.url).pathname).expect(200);
    assert.match(file.headers['content-disposition'] || '', /attachment/);
    assert.match(file.headers['content-type'] || '', /text\/csv; charset=utf-8/);
    assert.equal(file.headers['cache-control'], 'no-store');
    assert.equal(file.headers['access-control-allow-origin'], 'https://web.telegram.org');
    const expected = await s.dashboard.csv(actors[role], body.from, body.to);
    assert.equal(file.text, expected);
    assert.equal(
      (await s.exports.read(new URL(issued.body.url).pathname.split('/').at(-1)!)).content,
      expected,
    );
  }
});

test('CSV download: stable snapshot, expiry, random tickets and revoked permissions', async () => {
  const file = await s.exports.issue(actors.supervisor, '2026-09-01', '2026-09-15');
  const path = new URL(file.url).pathname;
  const original = await request(server).get(path).expect(200);
  await db.query('UPDATE users SET name=$1 WHERE id=$2', ['Changed', actors.manager.id]);
  assert.equal((await request(server).get(path).expect(200)).text, original.text);
  await request(server).get('/api/downloads/csv/invalid').expect(404);
  await request(server)
    .get('/api/downloads/csv/' + '0'.repeat(64))
    .expect(404);
  await db.query('UPDATE users SET active=false WHERE id=$1', [actors.supervisor.id]);
  await request(server).get(path).expect(404);
  await db.query("UPDATE users SET active=true,role='manager' WHERE id=$1", [actors.supervisor.id]);
  await request(server).get(path).expect(404);
  await db.query("UPDATE users SET role='supervisor' WHERE id=$1", [actors.supervisor.id]);
  await db.query("UPDATE csv_downloads SET expires_at=now()-interval '1 second'");
  await request(server).get(path).expect(404);
});

test('CSV download: bounded outstanding tickets and cleanup', async () => {
  for (let i = 0; i < 5; i++) await s.exports.issue(actors.admin, '2026-09-01', '2026-09-15');
  await assert.rejects(s.exports.issue(actors.admin, '2026-09-01', '2026-09-15'), { status: 429 });
  await db.query("UPDATE csv_downloads SET expires_at=now()-interval '1 second'");
  await s.exports.issue(actors.admin, '2026-09-01', '2026-09-15');
  assert.equal((await db.query('SELECT * FROM csv_downloads')).length, 1);
});

test('CSV bot delivery: sends only to requester; manager denied; adapter error propagated', async () => {
  const sent: any[] = [];
  const telegram = {
    sendDocument: async (...args: any[]) => {
      sent.push(args);
    },
  } as unknown as TelegramAdapter;
  const service = new ExportService(db, s.dashboard, telegram, config);
  for (const role of ['admin', 'supervisor'] as const) {
    await service.sendToBot(actors[role], '2026-09-01', '2026-09-15');
    assert.equal(sent.at(-1)[0], actors[role].telegramId);
    assert.equal(sent.at(-1)[1], await s.dashboard.csv(actors[role], '2026-09-01', '2026-09-15'));
  }
  await assert.rejects(service.sendToBot(actors.manager, '2026-09-01', '2026-09-15'), {
    status: 403,
  });
  await assert.rejects(
    service.sendToBot({ ...actors.admin, telegramId: 'dev-admin' }, '2026-09-01', '2026-09-15'),
    { status: 400 },
  );
  assert.equal(sent.length, 2);
  telegram.sendDocument = async () => {
    throw new DomainError(502, 'Telegram unavailable');
  };
  await assert.rejects(service.sendToBot(actors.admin, '2026-09-01', '2026-09-15'), {
    status: 502,
  });
});

let dir: string,
  db: Database,
  s: Services,
  app: any,
  server: any,
  postgres: Pool | undefined,
  schema: string;
let actors: Record<Role, Actor>, other: Actor, own: Company, foreign: Company;
const config = makeConfig({
  NODE_ENV: 'test',
  DEV_AUTH: 'true',
  WORKER_ENABLED: 'false',
  SESSION_SECRET: 'role-tests-only-32-character-secret',
  BOT_TOKEN: 'test',
  TELEGRAM_WEBHOOK_SECRET: 'test-secret',
  BOOTSTRAP_ADMIN_TELEGRAM_ID: '11111',
  PUBLIC_URL: 'https://crm.example.test',
});
const input = {
  name: 'Клиент',
  inn: '',
  city: 'Казань',
  industry: 'Энергетика',
  segment: 'end_client',
  stage: 'dialogue',
  potential: 3000000,
  revenue: 10000000,
  divisions: { lv: 1000000 },
  notes: 'Заметка',
  archived: false,
};
const draft = (): Extraction => ({
  warnings: ['Проверьте срок'],
  blocks: [
    {
      companyName: 'Новый клиент из отчёта',
      inn: null,
      city: 'Москва',
      segment: 'oem',
      stage: 'proposal',
      potential: 5000000,
      divisions: [{ key: 'mv', amount: 2000000 }],
      summary: 'Итог встречи',
      occurredOn: '2026-09-15',
      contacts: [{ name: 'Иван', role: null, phone: '123', email: null }],
      tasks: [{ text: 'Предложение', due: null }],
    },
  ],
});
const api = (
  actor: Actor,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: unknown,
) => {
  const call = request(server)
    [method]('/api' + path)
    .set('Authorization', 'Bearer ' + s.auth.issue(actor));
  return body === undefined ? call : call.send(body as object);
};
async function review(author: Actor = actors.manager) {
  const r = await s.reports.enqueue(author, {
    sourceKey: randomUUID(),
    text: 'Транскрипция встречи',
  });
  await db.query(`UPDATE reports SET status='review',draft=$1 WHERE id=$2`, [
    JSON.stringify(draft()),
    r.id,
  ]);
  return r;
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crm-roles-'));
  config.dataDir = dir;
  if (process.env.TEST_DATABASE_URL) {
    postgres = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = 'roles_' + randomUUID().replaceAll('-', '');
    await postgres.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    config.databaseUrl = url.toString();
  }
  db = new Database(config);
  await db.init();
  const context = await createApp(config, db);
  app = context.app;
  s = context.services;
  server = app.getHttpServer();
});
beforeEach(async () => {
  await db.query('TRUNCATE outbox,audit,reports,records,companies,users CASCADE');
  const admin = await s.auth.byTelegram('11111', 'Администратор');
  for (const [telegramId, name, role] of [
    ['22222', 'Менеджер', 'manager'],
    ['33333', 'Руководитель', 'supervisor'],
    ['44444', 'Другой менеджер', 'manager'],
  ])
    await s.auth.saveUser(admin, { telegramId, name, role, active: true });
  actors = {
    admin,
    manager: await s.auth.byTelegram('22222'),
    supervisor: await s.auth.byTelegram('33333'),
  };
  other = await s.auth.byTelegram('44444');
  own = await s.crm.create(actors.manager, { ...input, name: 'Своя компания' });
  foreign = await s.crm.create(other, { ...input, name: 'Чужая компания' });
});
after(async () => {
  await app?.close();
  await db?.close();
  if (postgres) {
    await postgres.query(`DROP SCHEMA ${schema} CASCADE`);
    await postgres.end();
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

for (const role of roles) {
  test(`[ACCESS-01] ${role}: profile, employee directory and session use current role`, async () => {
    const actor = actors[role];
    const me = await api(actor, 'get', '/me').expect(200);
    assert.equal(me.body.role, role);
    const users = await api(actor, 'get', '/users').expect(200);
    assert.equal(users.body.length, role === 'manager' ? 1 : 4);
    assert.ok(users.body.every((u: any) => !('token' in u)));
  });
  test(`[CRM-01] ${role}: create and edit every company field with server validation`, async () => {
    const actor = actors[role];
    const created = await api(actor, 'post', '/companies', input).expect(201);
    assert.equal(created.body.ownerId, actor.id);
    const data = {
      ...input,
      name: 'Обновлён',
      inn: '7707083893',
      city: 'Пермь',
      segment: 'oem',
      industry: 'Промышленность',
      stage: 'supply',
      potential: 900,
      revenue: 800,
      divisions: { heat: 700 },
      notes: 'Новые заметки',
    };
    const updated = await api(actor, 'patch', `/companies/${created.body.id}`, {
      version: 1,
      data,
    }).expect(200);
    for (const [key, value] of Object.entries(data)) assert.deepEqual(updated.body[key], value);
    await api(actor, 'post', '/companies', { ...input, ownerId: other.id }).expect(400);
    await api(actor, 'post', '/companies', { ...input, inn: '123' }).expect(400);
    await api(actor, 'post', '/companies', { ...input, potential: -1 }).expect(400);
    await api(actor, 'patch', `/companies/${created.body.id}`, { version: 1, data }).expect(409);
  });
  test(`[CRM-02] ${role}: foreign company read/write/audit scope`, async () => {
    const actor = actors[role],
      allowed = role !== 'manager';
    const list = await api(actor, 'get', '/companies').expect(200);
    assert.equal(
      list.body.some((c: any) => c.id === foreign.id),
      allowed,
    );
    const detail = await api(actor, 'get', `/companies/${foreign.id}`).expect(allowed ? 200 : 404);
    if (allowed) {
      assert.equal(detail.body.company.ownerName, other.name);
      assert.ok(detail.body.audit.length > 0);
    }
    await api(actor, 'patch', `/companies/${foreign.id}`, {
      version: 1,
      data: { ...input, name: 'Правка чужой' },
    }).expect(allowed ? 200 : 404);
  });
  for (const [kind, data, changed] of [
    [
      'contact',
      { name: 'Иван', role: 'Директор', phone: '+7999', email: 'a@example.com' },
      { name: 'Пётр', role: 'Инженер', phone: '+7888', email: 'b@example.com' },
    ],
    [
      'project',
      { name: 'Проект', amount: 1200, due: '2026-10-01', stage: 'new', notes: 'Описание' },
      {
        name: 'Новый проект',
        amount: 2500,
        due: '2026-11-01',
        stage: 'proposal',
        notes: 'Другое описание',
      },
    ],
    [
      'task',
      { text: 'Задача', due: '2026-10-01', done: false },
      { text: 'Правка задачи', due: '2026-11-01', done: false },
    ],
  ] as const) {
    test(`[RECORD-01] ${role}/${kind}: create, list, edit and reject foreign access`, async () => {
      const actor = actors[role],
        allowed = role !== 'manager';
      const local = await api(actor, 'post', `/companies/${own.id}/records/${kind}`, {
        data,
      }).expect(201);
      const updated = await api(actor, 'patch', `/records/${local.body.id}`, {
        version: 1,
        data: changed,
      }).expect(200);
      for (const [key, value] of Object.entries(changed))
        assert.deepEqual(updated.body.data[key], value);
      await api(actor, 'patch', `/records/${local.body.id}`, { version: 1, data: changed }).expect(
        409,
      );
      const theirs = await s.crm.createRecord(other, foreign.id, kind, data);
      const list = await api(actor, 'get', `/records/${kind}`).expect(200);
      assert.equal(
        list.body.some((r: any) => r.id === theirs.id),
        allowed,
      );
      await api(actor, 'patch', `/records/${theirs.id}`, { version: 1, data: changed }).expect(
        allowed ? 200 : 404,
      );
      await api(actor, 'post', `/companies/${foreign.id}/records/${kind}`, { data }).expect(
        allowed ? 201 : 404,
      );
    });
  }
  test(`[HISTORY-01] ${role}: append history, retain author/date and prohibit rewriting`, async () => {
    const actor = actors[role];
    for (const text of ['Первая встреча', 'Уточнение'])
      await api(actor, 'post', `/companies/${own.id}/records/activity`, {
        data: { text, occurredOn: '2026-09-15' },
      }).expect(201);
    const detail = await api(actor, 'get', `/companies/${own.id}`).expect(200);
    const history = detail.body.records.filter((r: any) => r.kind === 'activity');
    assert.equal(history.length, 2);
    assert.ok(
      history.every((r: any) => r.authorId === actor.id && r.data.occurredOn === '2026-09-15'),
    );
    await api(actor, 'patch', `/records/${history[0].id}`, {
      version: 1,
      data: { text: 'Подмена', occurredOn: '2026-09-16' },
    }).expect(400);
    await api(actor, 'post', `/companies/${foreign.id}/records/activity`, {
      data: { text: 'Чужая встреча', occurredOn: '2026-09-15' },
    }).expect(role === 'manager' ? 404 : 201);
  });
  test(`[ARCHIVE-01] ${role}: archive, retain data, refuse new records and restore`, async () => {
    const actor = actors[role];
    await api(actor, 'patch', `/companies/${own.id}`, {
      version: 1,
      data: { ...input, archived: true },
    }).expect(200);
    for (const [kind, data] of [
      ['contact', { name: 'A' }],
      ['project', { name: 'P' }],
      ['task', { text: 'T' }],
      ['activity', { text: 'A', occurredOn: '2026-09-15' }],
    ])
      await api(actor, 'post', `/companies/${own.id}/records/${kind}`, { data }).expect(409);
    const archived = await api(actor, 'get', `/companies/${own.id}`).expect(200);
    assert.equal(archived.body.company.archived, true);
    await api(actor, 'patch', `/companies/${own.id}`, { version: 2, data: input }).expect(200);
    await api(actor, 'post', `/companies/${own.id}/records/contact`, {
      data: { name: 'Теперь можно' },
    }).expect(201);
  });
  test(`[TASK-01] ${role}: project binding, complete/reopen and execution time`, async () => {
    const actor = actors[role],
      project = await s.crm.createRecord(actor, own.id, 'project', { name: 'Проект' });
    const t = await api(actor, 'post', `/companies/${own.id}/records/task`, {
      data: { text: 'Шаг' },
      projectId: project.id,
    }).expect(201);
    assert.equal(t.body.projectId, project.id);
    assert.equal(t.body.assigneeId, actors.manager.id);
    assert.equal(t.body.data.due, null);
    const done = await api(actor, 'patch', `/records/${t.body.id}`, {
      version: 1,
      data: { text: 'Шаг', done: true },
    }).expect(200);
    assert.ok(done.body.data.completedAt);
    const again = await api(actor, 'patch', `/records/${t.body.id}`, {
      version: 2,
      data: { text: 'Шаг', done: true },
    }).expect(200);
    assert.equal(again.body.data.completedAt, done.body.data.completedAt);
    const reopened = await api(actor, 'patch', `/records/${t.body.id}`, {
      version: 3,
      data: { text: 'Шаг', done: false },
    }).expect(200);
    assert.equal(reopened.body.data.completedAt, null);
    const wrong = await s.crm.createRecord(other, foreign.id, 'project', { name: 'Чужой проект' });
    await api(actor, 'post', `/companies/${own.id}/records/task`, {
      data: { text: 'Ошибка' },
      projectId: wrong.id,
    }).expect(400);
  });
  test(`[FILES-01] ${role}: protected upload/download/project/category/archive and foreign denial`, async () => {
    const actor = actors[role],
      project = await s.crm.createRecord(actor, own.id, 'project', { name: 'Документы проекта' });
    const f = await api(actor, 'post', `/companies/${own.id}/files`)
      .field('category', 'catalog')
      .field('projectId', project.id)
      .attach('file', Buffer.from('Содержимое'), 'catalog.txt')
      .expect(201);
    assert.equal(f.body.data.category, 'catalog');
    assert.equal(f.body.projectId, project.id);
    const bytes = await api(actor, 'get', `/files/${f.body.id}`).expect(200);
    assert.equal(bytes.body.toString(), 'Содержимое');
    assert.match(bytes.headers['content-disposition'] || '', /attachment/);
    const theirs = await api(other, 'post', `/companies/${foreign.id}/files`)
      .attach('file', Buffer.from('Secret'), 'secret.txt')
      .expect(201);
    const list = await api(actor, 'get', '/records/file').expect(200);
    assert.equal(
      list.body.some((r: any) => r.id === theirs.body.id),
      role !== 'manager',
    );
    await api(actor, 'get', `/files/${theirs.body.id}`).expect(role === 'manager' ? 404 : 200);
    await api(actor, 'delete', `/files/${theirs.body.id}`).expect(role === 'manager' ? 404 : 200);
    await api(actor, 'post', `/companies/${foreign.id}/files`)
      .attach('file', Buffer.from('x'), 'x.txt')
      .expect(role === 'manager' ? 404 : 201);
    await api(actor, 'delete', `/files/${f.body.id}`).expect(200);
    await api(actor, 'get', `/files/${f.body.id}`).expect(404);
    assert.ok((await readdir(join(dir, 'files'))).includes(f.body.data.key));
  });
  test(`[ASSIGN-01] ${role}: transfer permission, open tasks, past authors and new ACL`, async () => {
    const actor = actors[role];
    const task = await s.crm.createRecord(actors.manager, own.id, 'task', { text: 'Открыта' });
    const completed = await s.crm.createRecord(actors.manager, own.id, 'task', {
      text: 'Выполнена',
      done: true,
    });
    const activity = await s.crm.createRecord(actors.manager, own.id, 'activity', {
      text: 'История',
      occurredOn: '2026-09-15',
    });
    await api(actor, 'post', `/companies/${own.id}/assign`, {
      ownerId: other.id,
      version: 1,
    }).expect(role === 'manager' ? 403 : 201);
    if (role === 'manager') return;
    const detail = await api(other, 'get', `/companies/${own.id}`).expect(200);
    assert.equal(detail.body.records.find((r: any) => r.id === task.id).assigneeId, other.id);
    assert.equal(
      detail.body.records.find((r: any) => r.id === completed.id).assigneeId,
      actors.manager.id,
    );
    assert.equal(
      detail.body.records.find((r: any) => r.id === activity.id).authorId,
      actors.manager.id,
    );
    assert.ok(
      detail.body.audit.some(
        (a: any) =>
          a.action === 'company.assigned' &&
          a.details.from === actors.manager.id &&
          a.details.to === other.id,
      ),
    );
    await api(actors.manager, 'get', `/companies/${own.id}`).expect(404);
    await api(actor, 'post', `/companies/${own.id}/assign`, {
      ownerId: actors.manager.id,
      version: 1,
    }).expect(409);
  });
  test(`[REPORT-01] ${role}: submit text, preserve identity and reject empty input`, async () => {
    const actor = actors[role],
      requestId = randomUUID();
    const a = await api(actor, 'post', '/reports', { text: 'Встреча', requestId }).expect(201);
    const b = await api(actor, 'post', '/reports', { text: 'Встреча', requestId }).expect(201);
    assert.equal(a.body.id, b.body.id);
    assert.equal(a.body.authorId, actor.id);
    await api(actor, 'post', '/reports', { text: ' ', requestId: randomUUID() }).expect(400);
    await api(actor, 'post', '/reports', {
      text: 'Встреча',
      requestId: randomUUID(),
      authorId: other.id,
    }).expect(400);
  });
  test(`[REPORT-02] ${role}: own draft edit, confirm, exact destinations and repeat safety`, async () => {
    const actor = actors[role],
      r = await review(actor),
      body = draft();
    body.blocks[0]!.summary = 'Исправленный итог';
    const edited = await api(actor, 'patch', `/reports/${r.id}`, {
      version: 1,
      draft: body,
    }).expect(200);
    assert.equal(edited.body.version, 2);
    const payload = { version: 2, draft: body, companyIds: [null] };
    const saved = await api(actor, 'post', `/reports/${r.id}/confirm`, payload).expect(201);
    await api(actor, 'post', `/reports/${r.id}/confirm`, payload).expect(201);
    const detail = await api(actor, 'get', `/companies/${saved.body.result[0].companyId}`).expect(
      200,
    );
    assert.equal(detail.body.company.ownerId, actor.id);
    assert.equal(detail.body.company.potential, 5000000);
    assert.equal(detail.body.company.divisions.mv, 2000000);
    assert.equal(detail.body.company.stage, 'proposal');
    assert.equal(
      detail.body.records.filter(
        (r: any) =>
          r.kind === 'activity' && r.data.text === 'Исправленный итог' && r.authorId === actor.id,
      ).length,
      1,
    );
    assert.equal(
      detail.body.records.filter((r: any) => r.kind === 'contact' && r.data.name === 'Иван').length,
      1,
    );
    assert.equal(
      detail.body.records.filter((r: any) => r.kind === 'task' && r.data.due === null).length,
      1,
    );
    const report = await api(actor, 'get', `/reports/${r.id}`).expect(200);
    assert.equal(report.body.transcript, 'Транскрипция встречи');
    assert.deepEqual(report.body.draft.warnings, body.warnings);
    await api(actor, 'patch', `/reports/${r.id}`, { version: 3, draft: body }).expect(409);
    await api(actor, 'post', `/reports/${r.id}/cancel`).expect(409);
  });
  test(`[REPORT-03] ${role}: foreign report list/read/edit/confirm scope`, async () => {
    const actor = actors[role],
      r = await review(other),
      allowed = role !== 'manager',
      body = draft();
    const list = await api(actor, 'get', '/reports').expect(200);
    assert.equal(
      list.body.some((x: any) => x.id === r.id),
      allowed,
    );
    await api(actor, 'get', `/reports/${r.id}`).expect(allowed ? 200 : 404);
    await api(actor, 'patch', `/reports/${r.id}`, { version: 1, draft: body }).expect(
      allowed ? 200 : 404,
    );
    const saved = await api(actor, 'post', `/reports/${r.id}/confirm`, {
      version: allowed ? 2 : 1,
      draft: body,
      companyIds: [foreign.id],
    }).expect(allowed ? 201 : 404);
    if (allowed) {
      const detail = await api(actor, 'get', `/companies/${foreign.id}`).expect(200);
      assert.equal(
        detail.body.records.find((x: any) => x.id === saved.body.result[0].activityId).authorId,
        other.id,
      );
      assert.ok(
        detail.body.audit.some(
          (a: any) => a.action === 'report.applied' && a.actor_id === actor.id,
        ),
      );
    }
  });
  for (const action of ['cancel', 'retry'] as const) {
    test(`[REPORT-04] ${role}/${action}: transition permissions and allowed states`, async () => {
      const actor = actors[role],
        ownReport = await review(actor),
        otherReport = await review(other);
      if (action === 'retry')
        await db.query(`UPDATE reports SET status='failed',attempts=3 WHERE id IN ($1,$2)`, [
          ownReport.id,
          otherReport.id,
        ]);
      await api(actor, 'post', `/reports/${ownReport.id}/${action}`).expect(201);
      assert.equal(
        (await s.reports.get(actor, ownReport.id)).status,
        action === 'retry' ? 'queued' : 'cancelled',
      );
      await api(actor, 'post', `/reports/${otherReport.id}/${action}`).expect(
        role === 'manager' ? 404 : 201,
      );
      await api(actor, 'post', `/reports/${ownReport.id}/${action}`).expect(
        action === 'retry' ? 409 : 201,
      );
    });
  }
  test(`[TEAM-01] ${role}: dashboard/export permissions`, async () => {
    const actor = actors[role];
    await api(actor, 'get', '/dashboard?from=2026-09-01&to=2026-09-30').expect(
      role === 'manager' ? 403 : 200,
    );
    const csv = await api(actor, 'get', '/dashboard/export?from=2026-09-01&to=2026-09-30').expect(
      role === 'manager' ? 403 : 200,
    );
    if (role !== 'manager') {
      assert.match(csv.text, /Сотрудник/);
      assert.match(csv.headers['content-disposition'] || '', /team-report.csv/);
    }
  });
  test(`[USERS-01] ${role}: only admin can create, change role and block a user`, async () => {
    const actor = actors[role],
      body = { telegramId: '55555', name: 'Новый сотрудник', role: 'manager', active: true };
    await api(actor, 'post', '/users', body).expect(role === 'admin' ? 201 : 403);
    const modified = {
      telegramId: other.telegramId,
      name: 'Новое имя',
      role: 'supervisor',
      active: false,
    };
    await api(actor, 'post', '/users', modified).expect(role === 'admin' ? 201 : 403);
    const [row] = await db.query('SELECT name,role,active FROM users WHERE id=$1', [other.id]);
    assert.equal(row.active, role !== 'admin');
    assert.equal(row.role, role === 'admin' ? 'supervisor' : 'manager');
  });
}

test('[USERS-02] admin lifecycle: upsert, change roles, block/unblock, audit and session revocation', async () => {
  const body = { telegramId: '55555', name: 'Новый', role: 'manager', active: true };
  const first = await api(actors.admin, 'post', '/users', body).expect(201);
  const created = await s.auth.byTelegram(body.telegramId);
  const token = s.auth.issue(created);
  const changed = await api(actors.admin, 'post', '/users', {
    ...body,
    name: 'Повышен',
    role: 'supervisor',
  }).expect(201);
  assert.equal(changed.body.id, first.body.id);
  const who = () =>
    request(server)
      .get('/api/me')
      .set('Authorization', 'Bearer ' + token);
  assert.equal((await who().expect(200)).body.role, 'supervisor');
  await api(actors.admin, 'post', '/users', { ...body, active: false }).expect(201);
  await who().expect(403);
  await api(actors.admin, 'post', '/users', body).expect(201);
  await who().expect(200);
  const audit = await db.query(`SELECT * FROM audit WHERE action='user.updated' AND entity_id=$1`, [
    first.body.id,
  ]);
  assert.equal(audit.length, 4);
  await api(actors.admin, 'post', '/users', { ...body, telegramId: '@username' }).expect(400);
  await api(actors.admin, 'post', '/users', { ...body, role: 'owner' }).expect(400);
});
test('[USERS-03] last active admin cannot be blocked/demoted, second admin permits handover', async () => {
  const admin = actors.admin;
  for (const change of [
    { role: 'admin', active: false },
    { role: 'manager', active: true },
  ])
    await api(admin, 'post', '/users', {
      telegramId: admin.telegramId,
      name: admin.name,
      ...change,
    }).expect(409);
  await api(admin, 'post', '/users', {
    telegramId: '55555',
    name: 'Второй админ',
    role: 'admin',
    active: true,
  }).expect(201);
  await api(admin, 'post', '/users', {
    telegramId: admin.telegramId,
    name: admin.name,
    role: 'manager',
    active: true,
  }).expect(201);
  await api(admin, 'post', '/users', {
    telegramId: '55555',
    name: 'Подмена',
    role: 'manager',
    active: true,
  }).expect(403);
});
test('[ACCESS-02] first admin bootstrap, unknown/blocked users, and login does not restore privileges', async () => {
  await assert.rejects(() => s.auth.byTelegram('99999'), /Доступ не выдан/);
  assert.equal((await s.auth.byTelegram(config.adminTelegramId)).role, 'admin');
  await db.query(`UPDATE users SET active=false,role='manager' WHERE id=$1`, [actors.admin.id]);
  await assert.rejects(() => s.auth.byTelegram(config.adminTelegramId), /Доступ не выдан/);
  const [row] = await db.query('SELECT role FROM users WHERE id=$1', [actors.admin.id]);
  assert.equal(row.role, 'manager');
});
test('[ACCESS-03] expired session, local-only demo and production validation', async () => {
  const p = Buffer.from(JSON.stringify({ sub: actors.manager.id, exp: 1 })).toString('base64url');
  const token = p + '.' + createHmac('sha256', config.sessionSecret).update(p).digest('base64url');
  await request(server)
    .get('/api/me')
    .set('Authorization', 'Bearer ' + token)
    .expect(401);
  await assert.rejects(() => s.auth.dev('admin', '203.0.113.10'));
  const old = config.devAuth;
  config.devAuth = false;
  await request(server).post('/api/auth/dev').send({ role: 'admin' }).expect(403);
  config.devAuth = old;
  assert.throws(() => makeConfig({ NODE_ENV: 'production', DEV_AUTH: 'true' }));
});
test('[FILES-02] file size/category/missing input/cross-project/archived company validation', async () => {
  const actor = actors.manager;
  await api(actor, 'post', `/companies/${own.id}/files`)
    .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), 'large.bin')
    .expect(413);
  await api(actor, 'post', `/companies/${own.id}/files`)
    .field('category', 'invalid')
    .attach('file', Buffer.from('x'), 'x.txt')
    .expect(400);
  await api(actor, 'post', `/companies/${own.id}/files`, {}).expect(400);
  const project = await s.crm.createRecord(other, foreign.id, 'project', { name: 'Чужой' });
  await api(actor, 'post', `/companies/${own.id}/files`)
    .field('projectId', project.id)
    .attach('file', Buffer.from('x'), 'x.txt')
    .expect(400);
  await api(actor, 'patch', `/companies/${own.id}`, {
    version: 1,
    data: { ...input, archived: true },
  }).expect(200);
  await api(actor, 'post', `/companies/${own.id}/files`)
    .attach('file', Buffer.from('x'), 'x.txt')
    .expect(409);
});
test('[ASSIGN-02] disabled target and missing target cannot receive companies', async () => {
  await db.query('UPDATE users SET active=false WHERE id=$1', [other.id]);
  await api(actors.supervisor, 'post', `/companies/${own.id}/assign`, {
    ownerId: other.id,
    version: 1,
  }).expect(400);
  await api(actors.admin, 'post', `/companies/${own.id}/assign`, {
    ownerId: randomUUID(),
    version: 1,
  }).expect(400);
});
test('[REPORT-05] matching by INN/exact name, ambiguity, archive, null fields and atomic multi-company save', async () => {
  const actor = actors.manager,
    body = draft();
  body.blocks[0]!.companyName = own.name;
  body.blocks[0]!.stage = null;
  body.blocks[0]!.potential = null;
  body.blocks[0]!.divisions = [];
  const r = await review();
  await db.query('UPDATE reports SET draft=$1 WHERE id=$2', [JSON.stringify(body), r.id]);
  assert.deepEqual((await api(actor, 'get', `/reports/${r.id}`).expect(200)).body.candidates, [
    [own.id],
  ]);
  const saved = await api(actor, 'post', `/reports/${r.id}/confirm`, {
    version: 1,
    draft: body,
    companyIds: [own.id],
  }).expect(201);
  assert.equal(saved.body.result[0].companyId, own.id);
  const detail = await s.crm.company(actor, own.id);
  assert.equal(detail.potential, input.potential);
  assert.equal(detail.stage, input.stage);
  const valid = await s.crm.create(actor, { name: 'По ИНН', inn: '7707083893' });
  const byInn = draft();
  byInn.blocks[0]!.companyName = 'Другое написание';
  byInn.blocks[0]!.inn = '7707083893';
  assert.deepEqual(await s.reports.candidates(actor, byInn), [[valid.id]]);
  const multi = draft();
  multi.blocks.push({ ...multi.blocks[0]!, companyName: 'Вторая компания' });
  const report = await review();
  const applied = await api(actor, 'post', `/reports/${report.id}/confirm`, {
    version: 1,
    draft: multi,
    companyIds: [null, null],
  }).expect(201);
  assert.equal(applied.body.result.length, 2);
  const blocked = await review();
  await api(actor, 'patch', `/companies/${own.id}`, {
    version: detail.version,
    data: { ...input, archived: true },
  }).expect(200);
  await api(actor, 'post', `/reports/${blocked.id}/confirm`, {
    version: 1,
    draft: body,
    companyIds: [own.id],
  }).expect(409);
});
test('[REPORT-06] disabled author cannot be confirmed by a supervisor', async () => {
  const r = await review();
  await db.query('UPDATE users SET active=false WHERE id=$1', [actors.manager.id]);
  await api(actors.supervisor, 'post', `/reports/${r.id}/confirm`, {
    version: 1,
    draft: draft(),
    companyIds: [own.id],
  }).expect(409);
});
test('[TEAM-02] exact metrics, date boundaries, attribution and CSV contents', async () => {
  const now = new Date(),
    today = now.toISOString().slice(0, 10),
    old = '2000-01-01';
  const open = await s.crm.createRecord(actors.manager, own.id, 'task', {
    text: 'Просрочена',
    due: old,
  });
  await s.crm.createRecord(actors.manager, own.id, 'task', { text: 'Без срока' });
  const done = await s.crm.createRecord(actors.manager, own.id, 'task', {
    text: 'Готово',
    done: true,
  });
  await db.query(
    `UPDATE records SET data=data || '{"completedAt":"2026-09-15T12:00:00Z"}'::jsonb WHERE id=$1`,
    [done.id],
  );
  await s.crm.createRecord(actors.manager, own.id, 'activity', {
    text: 'Свежая встреча',
    occurredOn: today,
  });
  await s.crm.createRecord(actors.manager, own.id, 'activity', {
    text: 'Встреча периода',
    occurredOn: '2026-09-15',
  });
  const rows = await s.dashboard.summary(actors.supervisor, '2026-09-15', '2026-09-15');
  const row = rows.find((r) => r.id === actors.manager.id)!;
  assert.equal(row.companies, 1);
  assert.equal(row.openTasks, 2);
  assert.equal(row.overdue, 1);
  assert.equal(row.completed, 1);
  assert.equal(row.interactions, today === '2026-09-15' ? 2 : 1);
  assert.equal(row.inactiveCompanies.length, 0);
  assert.equal(rows.find((r) => r.id === other.id)?.inactiveCompanies.length, 1);
  await s.crm.assign(actors.admin, own.id, other.id, 1);
  const after = await s.dashboard.summary(actors.admin, '2026-09-15', '2026-09-15');
  assert.equal(after.find((r) => r.id === actors.manager.id)?.completed, 1);
  assert.equal(after.find((r) => r.id === other.id)?.openTasks, 2);
  const invalidPeriod = await api(
    actors.supervisor,
    'get',
    '/dashboard?from=2026-09-30&to=2026-09-01',
  );
  assert.equal(invalidPeriod.status, 400, JSON.stringify(invalidPeriod.body));
});

function fakeBot() {
  const messages: any[] = [],
    callbacks: any[] = [];
  const telegram = {
    send: async (chatId: string, payload: any) => {
      messages.push({ chatId, ...payload });
    },
    call: async (method: string, payload: any) => {
      callbacks.push({ method, ...payload });
    },
    appButton: () => ({
      inline_keyboard: [[{ text: 'Открыть CRM', web_app: { url: config.publicUrl } }]],
    }),
  } as unknown as TelegramAdapter;
  return { bot: new BotService(config, s.auth, s.reports, s.crm, telegram), messages, callbacks };
}
function message(text: string, from = 22222) {
  return {
    update_id: Math.floor(Math.random() * 1e8),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      from: { id: from },
      chat: { id: from, type: 'private' },
      text,
    },
  };
}
for (const from of [22222, 99999])
  test(`[BOT-04] /myid returns only sender ID without provisioning (${from})`, async () => {
    const before = await db.query('SELECT * FROM users ORDER BY id');
    const { bot, messages } = fakeBot();
    await bot.handle(message('/myid', from));
    await bot.handle(message('/myid@crm_test_bot 44444', from));
    assert.equal(messages.length, 2);
    for (const reply of messages) {
      assert.equal(reply.chatId, String(from));
      assert.ok(reply.text.includes(`Telegram ID: ${from}\n`));
      assert.doesNotMatch(reply.text, /44444/);
      assert.equal(reply.reply_markup, undefined);
    }
    assert.deepEqual(await db.query('SELECT * FROM users ORDER BY id'), before);
    assert.equal((await s.reports.list(actors.admin)).length, 0);
    if (from === 99999) {
      await bot.handle(message('/crm', from));
      assert.match(messages[2].text, /Доступ не выдан/);
    }
  });
test('[BOT-04] /myid works for blocked users without reactivating access', async () => {
  await db.query('UPDATE users SET active=false WHERE id=$1', [actors.manager.id]);
  const { bot, messages } = fakeBot();
  await bot.handle(message('/myid'));
  assert.match(messages[0].text, /Telegram ID: 22222/);
  await assert.rejects(s.auth.byTelegram('22222'));
  assert.equal((await s.reports.list(actors.admin)).length, 0);
});
test('[BOT-04] /myid never replies in groups or mismatched private chats', async () => {
  const { bot, messages } = fakeBot();
  for (const type of ['group', 'supergroup', 'channel']) {
    const update = message('/myid');
    update.message.chat.type = type;
    await bot.handle(update);
  }
  const mismatch = message('/myid');
  mismatch.message.chat.id = 44444;
  await bot.handle(mismatch);
  assert.equal(messages.length, 0);
});
for (const command of ['/start', '/help', '/crm', '/tasks', '/voice', '/voice@crm_bot'])
  test(`[BOT-01] ${command}: meaningful response, app button and scoped tasks`, async () => {
    await s.crm.createRecord(actors.manager, own.id, 'task', { text: 'Своя задача' });
    await s.crm.createRecord(other, foreign.id, 'task', { text: 'Чужая задача' });
    const { bot, messages } = fakeBot();
    await bot.handle(message(command));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].reply_markup.inline_keyboard[0][0].web_app.url, config.publicUrl);
    assert.ok(messages[0].text.length > 10);
    if (command.startsWith('/voice')) {
      assert.match(messages[0].text, /Отчёт о работе/);
      assert.match(messages[0].text, /Добавь подпись/);
      assert.match(messages[0].text, /Сохранить изменения/);
      assert.ok(messages[0].text.length <= 4096);
      assert.equal((await s.reports.list(actors.manager)).length, 0);
    }
    if (command === '/tasks') {
      assert.match(messages[0].text, /Своя задача/);
      assert.doesNotMatch(messages[0].text, /Чужая задача/);
    }
  });
test('[BOT-02] private/authorized messages only; voice duration/size and duplicate updates', async () => {
  const { bot, messages } = fakeBot();
  const group = message('Встреча');
  group.message.chat.type = 'group';
  await bot.handle(group);
  assert.equal((await s.reports.list(actors.admin)).length, 0);
  await bot.handle(message('Встреча', 99999));
  assert.match(messages[0].text, /Доступ не выдан/);
  const update: any = message('');
  delete update.message.text;
  update.message.voice = { file_id: 'file', duration: 601, file_size: 100 };
  await bot.handle(update);
  assert.equal((await s.reports.list(actors.admin)).length, 0);
  update.message.voice = { file_id: 'file', duration: 10, file_size: config.maxVoiceBytes + 1 };
  await bot.handle(update);
  assert.equal((await s.reports.list(actors.admin)).length, 0);
  update.message.voice.file_size = 100;
  await bot.handle(update);
  await bot.handle(update);
  assert.equal((await s.reports.list(actors.admin)).length, 1);
});
test('[BOT-03] callbacks save, reject stale versions and cancel review', async () => {
  const { bot, callbacks } = fakeBot(),
    r = await review();
  const callback = (data: string) => ({
    update_id: 1,
    callback_query: {
      id: 'callback',
      from: { id: 22222 },
      data,
      message: { chat: { id: 22222, type: 'private' } },
    },
  });
  await bot.handle(callback(`save:${r.id}:0`));
  assert.equal(callbacks[0].show_alert, true);
  assert.equal((await s.reports.get(actors.manager, r.id)).status, 'review');
  await bot.handle(callback(`save:${r.id}:1`));
  assert.equal((await s.reports.get(actors.manager, r.id)).status, 'saved');
  const cancelled = await review();
  await bot.handle(callback(`cancel:${cancelled.id}`));
  assert.equal((await s.reports.get(actors.manager, cancelled.id)).status, 'cancelled');
  await bot.handle(callback(`cancel:${cancelled.id}`));
  assert.equal(callbacks.at(-1).text, 'Отчёт отменён');
  assert.notEqual(callbacks.at(-1).show_alert, true);
  await bot.handle(callback(`cancel:${r.id}`));
  assert.match(callbacks.at(-1).text, /уже сохранён/);
  assert.equal((await s.reports.get(actors.manager, r.id)).status, 'saved');
});
test('cancel during extraction invalidates lease and late worker cannot restore review', async () => {
  const r = await s.reports.enqueue(actors.manager, { text: 'Текст', sourceKey: randomUUID() });
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => '' },
    {
      extract: async () => {
        assert.equal((await s.reports.get(actors.manager, r.id)).status, 'processing');
        await s.reports.transition(actors.manager, r.id, 'cancel');
        // Deliberately fail after cancellation: the worker catch must also respect the lease.
        throw new DomainError(502, 'Запоздавшая ошибка');
      },
    },
    { download: async () => new Uint8Array(), send: async () => {} },
    config,
  );
  await worker.processOne();
  const cancelled = await s.reports.get(actors.manager, r.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.lease_token, null);
  assert.equal(cancelled.error, null);
  await s.reports.transition(actors.manager, r.id, 'cancel');
  assert.equal((await s.reports.get(actors.manager, r.id)).version, cancelled.version);
});
test('unknown commands do not create reports, including after voice transcription', async () => {
  const { bot, messages } = fakeBot();
  await bot.handle(message('/unknown'));
  await bot.handle(message('Покажи погоду'));
  assert.ok(messages.every((m) => m.text.includes('Не знаю такой команды')));
  assert.equal((await s.reports.list(actors.manager)).length, 0);
  const r = await s.reports.enqueue(actors.manager, {
    audioFileId: 'voice',
    chatId: actors.manager.telegramId,
    sourceKey: randomUUID(),
  });
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => 'Удали подпись Иванова' },
    {
      extract: async () => {
        throw new Error('Unknown command must not become report');
      },
    },
    { download: async () => new Uint8Array([1]), send: async () => {} },
    config,
  );
  await worker.processOne();
  assert.equal((await s.reports.list(actors.manager)).length, 0);
  const [row] = await db.query('SELECT * FROM reports WHERE id=$1', [r.id]);
  assert.equal(row.purpose, 'command');
  assert.equal(row.status, 'cancelled');
  assert.equal(row.transcript, null);
  const notifications = await db.query('SELECT payload FROM outbox');
  assert.ok(notifications.some((n) => n.payload.text.includes('Не знаю такой команды')));
  assert.ok(notifications.some((n) => n.payload.text.includes('Голосовое принято')));
});
test('[QUEUE-01] transient failure retries with delay; success preserves transcript and review warning', async () => {
  const r = await s.reports.enqueue(actors.manager, { text: 'Текст', sourceKey: randomUUID() });
  let attempts = 0;
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => '' },
    {
      extract: async () => {
        if (++attempts === 1) throw new DomainError(502, 'Временная ошибка');
        return draft();
      },
    },
    { send: async () => {}, download: async () => new Uint8Array() },
    config,
  );
  await worker.processOne();
  assert.equal((await s.reports.get(actors.manager, r.id)).status, 'queued');
  await worker.processOne();
  assert.equal(attempts, 1);
  await db.query('UPDATE reports SET available_at=now() WHERE id=$1', [r.id]);
  await worker.processOne();
  const result = await s.reports.get(actors.manager, r.id);
  assert.equal(result.status, 'review');
  assert.equal(result.transcript, 'Текст');
  assert.deepEqual(result.draft.warnings, draft().warnings);
});
test('[QUEUE-02] outbox retries delivery and stops after five failures', async () => {
  await s.reports.notify(db, '22222', { text: 'Уведомление' });
  let calls = 0;
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => '' },
    { extract: async () => draft() },
    {
      send: async () => {
        calls++;
        throw new Error('Offline');
      },
      download: async () => new Uint8Array(),
    },
    config,
  );
  for (let i = 0; i < 6; i++) {
    await db.query('UPDATE outbox SET available_at=now()');
    await worker.deliverOne();
  }
  assert.equal(calls, 5);
  const [row] = await db.query('SELECT * FROM outbox');
  assert.equal(row.sent, false);
  assert.equal(row.attempts, 5);
  await db.query('UPDATE outbox SET attempts=0,available_at=now()');
  const success = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => '' },
    { extract: async () => draft() },
    {
      send: async () => {
        calls++;
      },
      download: async () => new Uint8Array(),
    },
    config,
  );
  await success.deliverOne();
  await success.deliverOne();
  assert.equal(calls, 6);
  assert.equal((await db.query('SELECT sent FROM outbox'))[0].sent, true);
});
