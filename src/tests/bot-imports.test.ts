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

test('Start offers import; its button sends the exact supplied workbook and creates no CRM data', async (t) => {
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
    '0b1dd5e0c9f9b6e7a41fce78076957406a90012686b5ac94075a0044c92efa5d',
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
