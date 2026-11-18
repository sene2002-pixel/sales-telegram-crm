import { createHash } from 'node:crypto';
import { importTemplateCaption } from '../server/services/import-onboarding';
import { parseCompanyImport, assertImportPrivacy } from '../server/services/company-import-parser';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import {
  picoTemplate,
  syntheticClient,
  syntheticProject,
  docxDocument,
  docTable,
} from './helpers/import-fixtures';
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import dns from 'node:dns/promises';
import { Actor } from '../shared/contracts';
import { makeConfig } from '../server/config';
import { createApp, Services } from '../server/http/app';
import { companyImportLimits } from '../server/services/company-import-parser';
let app: any, db: any, services: Services, dir: string, actor: Actor, foreign: Actor;
let input: Buffer = Buffer.from(''),
  downloads = 0,
  sequence = 100;
const replies: { method: string; payload: any }[] = [];
const secret = 'synthetic-import-webhook-secret';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bot-import-tests-'));
  const built = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      WORKER_ENABLED: 'false',
      DATA_DIR: dir,
      DATABASE_URL: '',
      BOT_TOKEN: 'synthetic-import-token',
      TELEGRAM_WEBHOOK_SECRET: secret,
      OPENAI_API_KEY: '',
      SESSION_SECRET: 'local-import-test-secret-at-least-32-characters',
    }),
  );
  app = built.app;
  db = built.db;
  services = built.services;
  const admin = (await services.auth.dev('admin', '127.0.0.1')).user;
  actor = await services.auth.saveUser(admin, {
    telegramId: '992001',
    name: 'Импортирующий менеджер',
    role: 'manager',
    active: true,
  });
  foreign = await services.auth.saveUser(admin, {
    telegramId: '992002',
    name: 'Другой менеджер',
    role: 'manager',
    active: true,
  });
  const telegram = (services.bot as any).telegram;
  telegram.call = async (method: string, payload: any) => {
    replies.push({ method, payload });
    return { message_id: ++sequence };
  };
  telegram.download = async (_id: string, limit: number) => {
    downloads++;
    assert.equal(limit, companyImportLimits.bytes);
    return input;
  };
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE company_imports,outbox,reports,records,companies,audit,error_logs CASCADE',
  );
  await db.query('UPDATE users SET active=true WHERE id=ANY($1::uuid[])', [[actor.id, foreign.id]]);
  replies.length = 0;
  downloads = 0;
  input = Buffer.from('Название;ИНН;Город\nНовый импортированный клиент;1234567894;Казань');
});
after(async () => {
  await app?.close();
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
function document(who = actor, extra: object = {}) {
  const id = ++sequence;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      from: { id: Number(who.telegramId), first_name: who.name },
      chat: { id: Number(who.telegramId), type: 'private' },
      document: {
        file_id: 'local-fixture',
        file_name: 'companies.csv',
        mime_type: 'text/csv',
        file_size: input.length,
        ...extra,
      },
    },
  };
}
function callback(data: string, who = actor) {
  return {
    update_id: ++sequence,
    callback_query: {
      id: 'callback-' + sequence,
      from: { id: Number(who.telegramId), first_name: who.name },
      message: { chat: { id: Number(who.telegramId), type: 'private' } },
      data,
    },
  };
}
function webhook(body: object, authorized = true) {
  const r = request(app.getHttpServer()).post('/api/telegram/webhook');
  return (authorized ? r.set('X-Telegram-Bot-Api-Secret-Token', secret) : r).send(body);
}
async function rows(table: string) {
  return db.query('SELECT * FROM ' + table);
}
function confirmData() {
  const reply = replies.findLast((r) =>
    r.payload.reply_markup?.inline_keyboard?.some((row: any[]) =>
      row.some((button) => button.callback_data?.startsWith('ic:')),
    ),
  );
  assert.ok(
    reply,
    'Explicit import confirmation is shown: ' + JSON.stringify(replies.map((r) => r.payload.text)),
  );
  return reply.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
}

test('Bot CSV webhook prepares a draft, denies foreign confirmation and saves once only after its author confirms', async () => {
  input = Buffer.from(
    'Название;ИНН;Город;Тип;Стадия\nНовый импортированный клиент;1234567894;Казань;;\nКлиент с указанным типом;;Москва;oem;proposal',
  );
  const uploaded = document();
  await webhook(uploaded).expect(201);
  assert.equal(downloads, 1);
  assert.equal((await rows('companies')).length, 0);
  assert.ok(
    replies.some((r) => /Пока ничего не сохранено/.test(r.payload.text || '')),
    JSON.stringify(replies.map((r) => r.payload.text)),
  );
  const previewText = replies.map((r) => r.payload.text || '').join('\n');
  assert.equal((previewText.match(/Стадия в источнике не указана/g) || []).length, 1);
  assert.ok(previewText.includes('Тип: OEM'));
  assert.ok(previewText.includes('Стадия: Предложение'));
  const data = confirmData();
  await webhook(callback(data, foreign)).expect(201);
  assert.equal((await rows('companies')).length, 0);
  assert.ok(
    replies.some(
      (r) =>
        r.method === 'answerCallbackQuery' &&
        r.payload.show_alert &&
        /Импорт недоступен/.test(r.payload.text),
    ),
  );
  assert.ok((await rows('error_logs')).some((r: any) => r.status === 403));
  await webhook(callback(data)).expect(201);
  await webhook(callback(data)).expect(201);
  const companies = await rows('companies');
  assert.equal(companies.length, 2);
  assert.ok(companies.every((company: any) => company.owner_id === actor.id));
  const unknown = companies.find(
    (company: any) => company.data.name === 'Новый импортированный клиент',
  );
  const known = companies.find((company: any) => company.data.name === 'Клиент с указанным типом');
  assert.equal(unknown.data.inn, '1234567894');
  assert.equal(unknown.data.city, 'Казань');
  assert.equal(unknown.data.segment, 'unknown');
  assert.equal(unknown.data.stage, 'new');
  assert.equal(known.data.segment, 'oem');
  assert.equal(known.data.stage, 'proposal');
  assert.equal((await rows('company_imports'))[0].status, 'saved');
  const manual = await services.crm.create(actor, { name: 'Добавлен вручную' });
  assert.equal(manual.segment, 'end_client');
});

test('Bot import transport requires webhook authentication and a matching sender in a private chat', async () => {
  await webhook(document(), false).expect(401);
  assert.equal(downloads, 0);
  const group = document();
  group.message.chat.type = 'group';
  await webhook(group).expect(201);
  const mismatch = document();
  mismatch.message.chat.id = Number(foreign.telegramId);
  await webhook(mismatch).expect(201);
  assert.equal(downloads, 0);
  assert.equal((await rows('company_imports')).length, 0);
  assert.equal((await rows('companies')).length, 0);
});

test('Bot imports reject oversized, unsupported and private data without persisting a draft or company', async () => {
  await webhook(document(actor, { file_size: companyImportLimits.bytes + 1 })).expect(201);
  assert.equal(downloads, 0);
  assert.ok(replies.some((r) => /2 МБ/.test(r.payload.text || '')));
  await webhook(
    document(actor, { file_name: 'unsupported.pdf', mime_type: 'application/pdf' }),
  ).expect(201);
  assert.equal(downloads, 0);
  input = Buffer.from('Название;Город\nПриватный клиент;person@example.test');
  await webhook(document()).expect(201);
  assert.equal(downloads, 1);
  assert.ok(replies.some((r) => /без личных контактов и секретов/.test(r.payload.text || '')));
  assert.equal((await rows('company_imports')).length, 0);
  assert.equal((await rows('companies')).length, 0);
  assert.equal((await rows('reports')).length, 0);
});

test('Bot pending import cannot create a company after actor access revocation', async () => {
  await webhook(document()).expect(201);
  const data = confirmData();
  await db.query('UPDATE users SET active=false WHERE id=$1', [actor.id]);
  await webhook(callback(data)).expect(201);
  assert.equal((await rows('companies')).length, 0);
  assert.equal((await rows('company_imports'))[0].status, 'pending');
  assert.ok(replies.some((r) => r.method === 'answerCallbackQuery' && r.payload.show_alert));
});

test('Bot Google document import rejects unexpected URL query before DNS or remote download', async () => {
  const lookup = dns.lookup;
  let networkAttempts = 0;
  dns.lookup = (async () => {
    networkAttempts++;
    throw new Error('Unexpected network in local test');
  }) as typeof dns.lookup;
  try {
    const id = ++sequence;
    await webhook({
      update_id: id,
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        from: { id: Number(actor.telegramId), first_name: actor.name },
        chat: { id: Number(actor.telegramId), type: 'private' },
        text: 'https://docs.google.com/document/d/1234567894abcdef/edit?redirect=http://127.0.0.1',
      },
    }).expect(201);
    assert.equal(networkAttempts, 0);
    assert.equal(downloads, 0);
    assert.equal((await rows('company_imports')).length, 0);
    assert.equal((await rows('companies')).length, 0);
    assert.ok(replies.some((r) => r.payload.text || r.payload.show_alert));
  } finally {
    dns.lookup = lookup;
  }
});

test('Bot accepts the Pico workbook and DOCX upload with linked contacts/projects only after confirmation', async () => {
  input = picoTemplate({ clients: [syntheticClient()], projects: [syntheticProject()] });
  await webhook(document(actor, { file_name: 'Pico-import.xlsx' })).expect(201);
  assert.equal((await rows('records')).length, 0);
  await webhook(callback(confirmData())).expect(201);
  assert.equal((await rows('companies')).length, 1);
  assert.deepEqual((await rows('records')).map((r: any) => r.kind).sort(), ['contact', 'project']);
  replies.length = 0;
  input = docxDocument(
    docTable([
      ['Название компании', 'Контакты'],
      ['Другая компания', 'Тестовый Контакт, инженер, +79990000001, business@example.test'],
    ]),
  );
  await webhook(
    document(actor, {
      file_name: 'document.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  ).expect(201);
  await webhook(callback(confirmData())).expect(201);
  assert.equal((await rows('companies')).length, 2);
});

test('Bot Google Docs link parses real table structure; webhook retry reuses draft without another download', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '142.250.1.1', family: 4 }] as any);
  let requested = 0;
  const body = docxDocument(
    docTable([
      ['Название компании', 'Город', 'Контакты'],
      ['Google тест', 'Казань', 'Тестовый Контакт, инженер, +79990000001, business@example.test'],
    ]),
  );
  t.mock.method(https, 'request', ((options: any, callback: any) => {
    requested++;
    assert.equal(options.path, '/document/d/abcdefghij/export?format=docx');
    const req = new EventEmitter() as any;
    req.destroy = () => {};
    req.end = () =>
      setImmediate(() => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {
          'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
        callback(res);
        res.emit('data', body);
        res.emit('end');
      });
    return req;
  }) as any);
  const id = ++sequence;
  const msg = {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      from: { id: Number(actor.telegramId), first_name: actor.name },
      chat: { id: Number(actor.telegramId), type: 'private' },
      text: 'https://docs.google.com/document/d/abcdefghij/edit',
    },
  };
  await webhook(msg).expect(201);
  assert.equal(requested, 1);
  assert.equal((await rows('companies')).length, 0);
  // Service retry itself is also independent of network/provider availability.
  await (services.bot as any).imports.prepareGoogle(actor, {
    sourceKey: `telegram:${id}`,
    url: msg.message.text,
  });
  assert.equal(requested, 1);
  await webhook(callback(confirmData())).expect(201);
  assert.equal((await rows('companies')).length, 1);
  assert.equal((await rows('records')).filter((r: any) => r.kind === 'contact').length, 1);
});

test('Start offers import; its button sends the packaged workbook and creates no CRM data', async (t) => {
  const sent: { chatId: string; bytes: Uint8Array; caption: string }[] = [];
  t.mock.method(
    (services.bot as any).telegram,
    'sendImportTemplate',
    async (chatId: string, bytes: Uint8Array, caption: string) => {
      sent.push({ chatId, bytes, caption });
      return 123;
    },
  );
  const id = ++sequence;
  await webhook({
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      from: { id: Number(actor.telegramId), first_name: actor.name },
      chat: { id: Number(actor.telegramId), type: 'private' },
      text: '/start',
    },
  }).expect(201);
  const greeting = replies.find((r) =>
    r.payload.reply_markup?.inline_keyboard?.some((row: any[]) =>
      row.some((b: any) => b.callback_data === 'import:template'),
    ),
  );
  assert.ok(greeting, 'Import button must survive dynamic CRM-menu fallback');
  const action = greeting.payload.reply_markup.inline_keyboard
    .flat()
    .find((b: any) => b.callback_data === 'import:template');
  assert.equal(action.text, 'Импортировать компании');
  await webhook(callback('import:template')).expect(201);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, actor.telegramId);
  assert.equal(
    createHash('sha256').update(sent[0]!.bytes).digest('hex'),
    'a3be274a67d0cc8fbd445d65787b8b81ce1c799c77f4fbd7d931ce8cd11a8136',
  );
  assert.equal(sent[0]!.caption, importTemplateCaption);
  assert.ok(sent[0]!.caption.length <= 1024);
  for (const phrase of [
    'Предзаполненные строки — пример',
    'в одной ячейке «Контакты»',
    'с новой строки внутри этой ячейки',
    'не импортируются',
    'млн ₽',
    'Подтвердить импорт',
  ])
    assert.ok(sent[0]!.caption.includes(phrase), phrase);
  await assert.rejects(
    parseCompanyImport(sent[0]!.bytes, 'xlsx', assertImportPrivacy),
    /Шаблон не заполнен/,
  );
  for (const table of ['companies', 'records', 'reports', 'company_imports'])
    assert.equal((await rows(table)).length, 0, table);
  assert.ok(replies.some((r) => r.method === 'answerCallbackQuery'));
});

test('Template callback refuses blocked users, unauthenticated webhooks, groups and mismatched recipients', async (t) => {
  let sends = 0;
  t.mock.method((services.bot as any).telegram, 'sendImportTemplate', async () => {
    sends++;
  });
  await webhook(callback('import:template'), false).expect(401);
  const group = callback('import:template');
  group.callback_query.message.chat.type = 'group';
  await webhook(group).expect(201);
  const mismatch = callback('import:template');
  mismatch.callback_query.message.chat.id = Number(foreign.telegramId);
  await webhook(mismatch).expect(201);
  await db.query('UPDATE users SET active=false WHERE id=$1', [actor.id]);
  await webhook(callback('import:template')).expect(201);
  assert.equal(sends, 0);
  assert.ok(replies.some((r) => /Доступ не выдан/.test(r.payload.text || '')));
});

test('Template delivery failure is explained safely and a later button press can retry', async (t) => {
  let fail = true,
    sends = 0;
  t.mock.method((services.bot as any).telegram, 'sendImportTemplate', async () => {
    sends++;
    if (fail) throw new Error('internal /private/path synthetic-secret');
  });
  await webhook(callback('import:template')).expect(201);
  const error = replies.find((r) => /Не удалось отправить шаблон/.test(r.payload.text || ''));
  assert.ok(error);
  assert.doesNotMatch(error.payload.text, /private|synthetic-secret/);
  fail = false;
  await webhook(callback('import:template')).expect(201);
  assert.equal(sends, 2);
  assert.equal((await rows('companies')).length, 0);
});

test('photo import requires an explicit caption, replays its preview, confirms once and supports undo', async (t) => {
  input = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ2kAAAAASUVORK5CYII=',
    'base64',
  );
  const enabled = services.config.aiBudget.enabled;
  services.config.aiBudget.enabled = true;
  t.after(() => {
    services.config.aiBudget.enabled = enabled;
  });
  assert.equal(services.diagnostics.enabled, false);
  const sample = document(actor);
  const message = { ...sample.message, document: undefined };
  const image = {
    ...sample,
    message: {
      ...message,
      photo: [{ file_id: 'table-photo', width: 100, height: 100, file_size: input.length }],
      caption: '/import',
    },
  };
  const originalKey = services.config.apiKey;
  services.config.apiKey = 'test-double';
  t.after(() => {
    services.config.apiKey = originalKey;
  });
  let signal!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      signal = resolve;
    }),
    ongoing = new Promise<void>((resolve) => {
      release = resolve;
    });
  const provider = t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.equal(body.text.format.name, 'company_table');
      signal();
      await ongoing;
      return Response.json({
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  status: 'table',
                  rows: [
                    ['Название', 'Город'],
                    ['Учебная компания', 'Самара'],
                  ],
                }),
              },
            ],
          },
        ],
      });
    },
  );
  await webhook({
    ...image,
    update_id: ++sequence,
    message: { ...image.message, caption: '' },
  }).expect(201);
  assert.equal((await rows('reports')).length, 1);
  assert.equal(provider.mock.callCount(), 0);
  const sending = webhook(image)
    .expect(201)
    .then(() => undefined);
  try {
    await Promise.race([
      started,
      sending.then(() => {
        throw new Error('OCR did not start');
      }),
    ]);
    await webhook(image).expect(201);
    assert.equal(provider.mock.callCount(), 1);
  } finally {
    release();
    await sending;
  }
  assert.equal((await rows('companies')).length, 0);
  const confirm = confirmData();
  await webhook(image).expect(201);
  assert.equal(confirmData(), confirm);
  assert.equal(downloads, 1);
  assert.equal(provider.mock.callCount(), 1);
  const [usage] = await db.query(
    'SELECT count(*)::int AS calls,count(lease_until)::int AS leases FROM ai_budget_requests WHERE actor_id=$1',
    [actor.id],
  );
  assert.deepEqual(usage, { calls: 1, leases: 0 });
  await webhook(callback(confirm, foreign)).expect(201);
  assert.equal((await rows('companies')).length, 0);
  await webhook(callback(confirm)).expect(201);
  await webhook(callback(confirm)).expect(201);
  const companies = await rows('companies');
  assert.equal(companies.length, 1);
  assert.equal(companies[0].data.city, 'Самара');
  const undo = replies
    .flatMap((r) => r.payload.reply_markup?.inline_keyboard?.flat() || [])
    .find((b) => b.callback_data?.startsWith('iz:'));
  assert.ok(undo);
  await webhook(callback(undo.callback_data)).expect(201);
  assert.equal((await rows('companies'))[0].data.archived, true);
});

test('photo import safely rejects unreadable, oversized and unauthorized results', async (t) => {
  input = Buffer.from([255, 216, 255, 0]);
  const sample = document();
  const image = (extras: object = {}) => ({
    ...sample,
    update_id: ++sequence,
    message: {
      ...sample.message,
      caption: '/import',
      document: {
        ...sample.message.document,
        mime_type: 'image/jpeg',
        file_name: 'company.jpg',
        ...extras,
      },
    },
  });
  const originalKey = services.config.apiKey;
  services.config.apiKey = 'test-double';
  t.after(() => {
    services.config.apiKey = originalKey;
  });
  let result: unknown = { status: 'table', rows: [['Название', 'Город'], ['Сдвинутая строка']] };
  const provider = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
    }),
  );
  const oversized = image({ file_size: companyImportLimits.bytes + 1 });
  await webhook(oversized).expect(201);
  assert.equal(downloads, 0);
  assert.equal(provider.mock.callCount(), 0);
  await webhook(image({ mime_type: 'image/gif' })).expect(201);
  assert.equal(downloads, 0);
  await webhook(image({ mime_type: 'image/png' })).expect(201);
  assert.equal(downloads, 1);
  assert.equal(provider.mock.callCount(), 0);
  input = Buffer.alloc(companyImportLimits.bytes + 1);
  await webhook(image({ file_size: 30 })).expect(201);
  assert.equal(provider.mock.callCount(), 0);
  input = Buffer.from([255, 216, 255, 0]);
  const wrong = image();
  await webhook(wrong).expect(201);
  await webhook(wrong).expect(201);
  assert.equal(provider.mock.callCount(), 1);
  assert.equal(downloads, 3);
  assert.equal((await rows('company_imports')).length, 0);
  assert.ok(replies.some((r) => r.payload.text?.includes('Не удалось прочитать таблицу целиком')));
  result = { status: 'too_large', rows: [] };
  await webhook(image()).expect(201);
  assert.ok(replies.some((r) => r.payload.text?.includes('Разделите таблицу')));
  result = { status: 'table', command: 'save', rows: [['Название'], ['Тест']] };
  await webhook(image()).expect(201);
  assert.equal((await rows('company_imports')).length, 0);
  result = { status: 'table', rows: [['Название'], ['а'.repeat(companyImportLimits.cell + 1)]] };
  await webhook(image()).expect(201);
  assert.equal((await rows('company_imports')).length, 0);
  const blocked = image();
  await db.query('UPDATE users SET active=false WHERE id=$1', [actor.id]);
  await webhook(blocked).expect(201);
  assert.equal(provider.mock.callCount(), 4);
  assert.equal((await rows('companies')).length, 0);
});

test('regional refusal shows the file alternative immediately and does not retry the paid request', async (t) => {
  input = Buffer.from([255, 216, 255, 0]);
  const key = services.config.apiKey;
  services.config.apiKey = 'test-double';
  t.after(() => {
    services.config.apiKey = key;
  });
  const provider = t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: { code: 'unsupported_country_region_territory', message: 'provider details' } },
      { status: 403 },
    ),
  );
  const original = document(actor, { mime_type: 'image/jpeg', file_name: 'scan.jpg' });
  const photo = { ...original, message: { ...original.message, caption: '/import' } };
  await webhook(photo).expect(201);
  assert.ok(
    replies.some(
      (r) =>
        r.payload.text?.includes('в регионе сервиса') && r.payload.text?.includes('CSV или XLSX'),
    ),
  );
  await webhook(photo).expect(201);
  assert.equal(provider.mock.callCount(), 1);
  assert.equal((await rows('company_imports')).length, 0);
  input = Buffer.from('Название;Город\nУчебная компания;Самара');
  const file = document(actor);
  await webhook({ ...file, message: { ...file.message, caption: '/import' } }).expect(201);
  assert.ok(confirmData());
  assert.equal(provider.mock.callCount(), 1);
});
