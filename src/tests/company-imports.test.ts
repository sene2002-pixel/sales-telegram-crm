import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../server/infra/database';
import { makeConfig } from '../server/config';
import { CrmService } from '../server/services/crm';
import { CompanyImports } from '../server/services/company-imports';
import {
  assertImportPrivacy,
  parseCompanyImport,
  fetchPublicGoogleDocument,
} from '../server/services/company-import-parser';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Actor } from '../shared/contracts';
import { DomainError } from '../server/domain/errors';
const bytes = (s: string) => Buffer.from(s);
const status = (n: number) => (e: unknown) => e instanceof DomainError && e.status === n;

// A minimal stored ZIP builder for deterministic XLSX fixtures, no filesystem or network extraction.
function zip(entries: Record<string, string>): Buffer {
  const files: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  function crc(b: Buffer) {
    let n = 0xffffffff;
    for (const c of b) {
      n ^= c;
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
  }
  for (const [name, text] of Object.entries(entries)) {
    const n = bytes(name),
      b = bytes(text),
      h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc(b), 14);
    h.writeUInt32LE(b.length, 18);
    h.writeUInt32LE(b.length, 22);
    h.writeUInt16LE(n.length, 26);
    files.push(h, n, b);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc(b), 16);
    c.writeUInt32LE(b.length, 20);
    c.writeUInt32LE(b.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += h.length + n.length + b.length;
  }
  const end = Buffer.alloc(22),
    cd = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, cd, end]);
}
function xlsx(sheet: string, extra: Record<string, string> = {}) {
  return zip({
    'xl/workbook.xml': '<workbook/>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
    ...extra,
  });
}
const cell = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;

test('company import parses only supplied facts, quoted CSV and labeled Docs without invented values', async () => {
  const rows = await parseCompanyImport(
    bytes(
      'Название компании;ИНН;Город;Потенциал (млн руб);Тип\n"ООО; Альфа";7707083893;Москва;1,5;Заказчик',
    ),
    'csv',
    assertImportPrivacy,
  );
  assert.equal(rows[0]!.data.name, 'ООО; Альфа');
  assert.equal(rows[0]!.data.inn, '7707083893');
  assert.equal(rows[0]!.data.potential, 1_500_000);
  assert.equal(rows[0]!.data.segment, 'end_client');
  assert.ok(!('industry' in rows[0]!.data));
  const doc = await parseCompanyImport(
    bytes('Название: Бета\nГород: Казань\n\nНазвание: Гамма'),
    'txt',
    assertImportPrivacy,
  );
  assert.equal(doc.length, 2);
  assert.deepEqual(doc[1]!.data, { name: 'Гамма' });
  assert.ok(doc[1]!.missing.includes('ИНН'));
  const names = await parseCompanyImport(bytes('ООО Альфа\nАО Бета'), 'txt', assertImportPrivacy);
  assert.deepEqual(
    names.map((row) => row.data),
    [{ name: 'ООО Альфа' }, { name: 'АО Бета' }],
  );
  await assert.rejects(
    parseCompanyImport(bytes('ООО Альфа\nКонтакт +79991234567'), 'txt', assertImportPrivacy),
    status(400),
  );
  await assert.rejects(
    parseCompanyImport(bytes('Город: Москва'), 'txt', assertImportPrivacy),
    status(400),
  );
});

test('company import blocks malformed headers, wrong INN, personal fields, formulas and limits before storing', async () => {
  for (const input of [
    'Название;Телефон\nАльфа;89991234567',
    'Название;Email\nАльфа;a@example.com',
    'Название;Город\nАльфа;=WEBSERVICE("http://localhost")',
    'Название;ИНН\nАльфа;123',
    'Название;Название\nАльфа;Бета',
    'Город\nМосква',
  ])
    await assert.rejects(parseCompanyImport(bytes(input), 'csv', assertImportPrivacy), status(400));
  await assert.rejects(
    parseCompanyImport(
      bytes('Название\n' + Array(101).fill('Альфа').join('\n')),
      'csv',
      assertImportPrivacy,
    ),
    status(400),
  );
  await assert.rejects(
    parseCompanyImport(Buffer.alloc(2 * 1024 * 1024 + 1), 'csv', assertImportPrivacy),
    status(413),
  );
  let called = 0;
  await assert.rejects(
    parseCompanyImport(bytes('Название\nАльфа'), 'csv', () => {
      called++;
      throw new DomainError(400, 'Запрещено');
    }),
    status(400),
  );
  assert.ok(called);
});

test('XLSX reads inline/shared strings and rejects formulas, entities, external relations, macros and zip bombs', async () => {
  const sheet = `<row r="1">${cell('A1', 'Название')}${cell('B1', 'Город')}</row><row r="2">${cell('A2', 'Альфа &amp; Бета')}<c r="B2" t="s"><v>0</v></c></row>`;
  const parsed = await parseCompanyImport(
    xlsx(sheet, { 'xl/sharedStrings.xml': '<sst><si><t>Казань</t></si></sst>' }),
    'xlsx',
    assertImportPrivacy,
  );
  assert.equal(parsed[0]!.data.name, 'Альфа & Бета');
  assert.equal(parsed[0]!.data.city, 'Казань');
  await assert.rejects(
    parseCompanyImport(
      xlsx(sheet.replace('<c r="B2" t="s"><v>0</v></c>', '<c r="B2"><f>SUM(1)</f><v>1</v></c>')),
      'xlsx',
      assertImportPrivacy,
    ),
    status(400),
  );
  await assert.rejects(
    parseCompanyImport(
      xlsx(sheet, {
        'xl/_rels/workbook.xml.rels':
          '<Relationships><Relationship TargetMode="External" Target="http://127.0.0.1"/></Relationships>',
      }),
      'xlsx',
      assertImportPrivacy,
    ),
    status(400),
  );
  await assert.rejects(
    parseCompanyImport(xlsx(sheet, { 'xl/vbaProject.bin': 'macro' }), 'xlsx', assertImportPrivacy),
    status(400),
  );
  await assert.rejects(
    parseCompanyImport(
      xlsx(sheet, { 'xl/sharedStrings.xml': '<!DOCTYPE s [<!ENTITY a "x">]><sst/>' }),
      'xlsx',
      assertImportPrivacy,
    ),
    status(400),
  );
  const forged = xlsx(sheet);
  forged.writeUInt32LE(9 * 1024 * 1024, forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
  await assert.rejects(parseCompanyImport(forged, 'xlsx', assertImportPrivacy), status(400));
  await assert.rejects(
    parseCompanyImport(bytes('not a zip'), 'xlsx', assertImportPrivacy),
    status(400),
  );
});

test('Google Docs rejects arbitrary URLs, credentials, private hosts and IDs without making requests', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('No network allowed');
  });
  for (const url of [
    'http://127.0.0.1/document/d/abcdefghij',
    'https://docs.google.com.evil.test/document/d/abcdefghij',
    'https://user:pass@docs.google.com/document/d/abcdefghij',
    'https://docs.google.com:8443/document/d/abcdefghij',
    'https://docs.google.com/spreadsheets/d/abcdefghij',
    'https://docs.google.com/document/d/abcdefghij?access_token=secret',
  ])
    await assert.rejects(fetchPublicGoogleDocument(url), status(400));
});

test('import preview/confirmation verifies current actor, skips duplicates, owns creations and is idempotent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-import-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, WORKER_ENABLED: 'false', DATABASE_URL: '' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function actor(name: string): Promise<Actor> {
    const a: Actor = {
      id: randomUUID(),
      name,
      telegramId: String(Math.floor(Math.random() * 1e9) + 1),
      role: 'manager',
      active: true,
    };
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      a.id,
      a.telegramId,
      a.name,
      a.role,
    ]);
    return a;
  }
  const a = await actor('A'),
    b = await actor('B'),
    crm = new CrmService(db),
    service = new CompanyImports(db, crm, assertImportPrivacy);
  await crm.create(b, { name: 'Дубль', inn: '7707083893' });
  const input = {
    sourceKey: 'telegram:1',
    format: 'csv' as const,
    bytes: bytes('Название;ИНН;Город\nДубль;7707083893;Москва\nНовая;;Казань\nНовая;;Самара'),
  };
  const preview = await service.prepare(a, input);
  assert.equal((await crm.list(a)).length, 0);
  assert.deepEqual(
    preview.rows.map((r) => r.disposition),
    ['skip_duplicate', 'create', 'skip_duplicate'],
  );
  assert.ok(preview.messages.join('\n').includes('Пока ничего не сохранено'));
  assert.equal((await service.prepare(a, input)).id, preview.id);
  await assert.rejects(service.confirm(b, preview.id, 1), status(403));
  await assert.rejects(service.cancel(b, preview.id, 1), status(403));
  await assert.rejects(service.confirm(a, preview.id, 99), status(409));
  const result = await service.confirm(a, preview.id, 1);
  assert.equal(result.created.length, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(await service.confirm(a, preview.id, 1), result);
  const stored = await crm.list(a);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.ownerId, a.id);
  assert.equal(stored[0]!.city, 'Казань');
  assert.equal(stored[0]!.segment, 'unknown');
  assert.equal(stored[0]!.stage, 'new');
  assert.ok(preview.messages.join('\n').includes('техническую стадию «Новый»'));
  const cancel = await service.prepare(a, { ...input, sourceKey: 'telegram:2' });
  await service.cancel(a, cancel.id, 1);
  await assert.rejects(service.confirm(a, cancel.id, 1), status(409));
  const stale = await service.prepare(a, { ...input, sourceKey: 'telegram:3' });
  await db.query('UPDATE users SET active=false WHERE id=$1', [a.id]);
  await assert.rejects(service.confirm(a, stale.id, 1), status(403));
  await assert.rejects(service.prepare(a, { ...input, sourceKey: 'telegram:4' }), status(403));
});

test('confirmation rechecks duplicates inserted since preview and rolls back on privacy rejection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-import-race-')),
    db = new Database(makeConfig({ DATA_DIR: dir, WORKER_ENABLED: 'false', DATABASE_URL: '' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const a: Actor = {
    id: randomUUID(),
    telegramId: '765432100',
    name: 'A',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    a.id,
    a.telegramId,
    a.name,
    a.role,
  ]);
  const crm = new CrmService(db);
  let block = false;
  const service = new CompanyImports(db, crm, (text) => {
    assertImportPrivacy(text);
    if (block) throw new DomainError(400, 'Недопустимо');
  });
  const p = await service.prepare(a, {
    sourceKey: 'test:1',
    bytes: bytes('Название\nПоздний дубль\nНовая'),
    format: 'csv',
  });
  await crm.create(a, { name: 'Поздний дубль' });
  block = true;
  await assert.rejects(service.confirm(a, p.id, 1), status(400));
  assert.equal((await crm.list(a)).length, 1);
  block = false;
  const result = await service.confirm(a, p.id, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.created.length, 1);
});

test('Google Docs pins a public DNS address, rejects redirects and bounds the response body', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }] as any);
  await assert.rejects(
    fetchPublicGoogleDocument('https://docs.google.com/document/d/abcdefghij'),
    status(400),
  );
  t.mock.restoreAll();
  t.mock.method(dns, 'lookup', async () => [{ address: '142.250.1.1', family: 4 }] as any);
  let statusCode = 200,
    contentType = 'text/plain; charset=utf-8',
    body = Buffer.from('Альфа\nБета');
  t.mock.method(https, 'request', ((options: any, callback: any) => {
    assert.equal(options.hostname, 'docs.google.com');
    assert.equal(options.path, '/document/d/abcdefghij/export?format=txt');
    assert.equal(options.family, 4);
    options.lookup('docs.google.com', {}, (error: any, address: any, family: any) => {
      assert.equal(error, null);
      assert.equal(address, '142.250.1.1');
      assert.equal(family, 4);
    });
    const req = new EventEmitter() as any;
    req.destroy = () => {};
    req.end = () =>
      setImmediate(() => {
        const res = new EventEmitter() as any;
        res.statusCode = statusCode;
        res.headers = { 'content-type': contentType };
        res.resume = () => {};
        callback(res);
        res.emit('data', body);
        res.emit('end');
      });
    return req;
  }) as any);
  assert.equal(
    Buffer.from(
      await fetchPublicGoogleDocument(
        'https://docs.google.com/document/d/abcdefghij/edit?usp=sharing',
      ),
    ).toString(),
    'Альфа\nБета',
  );
  statusCode = 302;
  await assert.rejects(
    fetchPublicGoogleDocument('https://docs.google.com/document/d/abcdefghij'),
    status(400),
  );
  statusCode = 200;
  contentType = 'text/html';
  await assert.rejects(
    fetchPublicGoogleDocument('https://docs.google.com/document/d/abcdefghij'),
    status(400),
  );
  contentType = 'text/plain';
  body = Buffer.alloc(2 * 1024 * 1024 + 1);
  await assert.rejects(
    fetchPublicGoogleDocument('https://docs.google.com/document/d/abcdefghij'),
    status(400),
  );
});

test('import retains all supported business facts without inventing a total or importing owners', async () => {
  const input =
    'Название;Стадия;Выручка млн руб;Заметки;lv млн руб;ПЧ и УПП 6–35 кВ;owner_id\nАльфа;Поставки;2,5;Заводское оборудование;10;600000;ignored';
  const [row] = await parseCompanyImport(bytes(input), 'csv', assertImportPrivacy);
  assert.deepEqual(row!.data, {
    name: 'Альфа',
    stage: 'supply',
    revenue: 2500000,
    notes: 'Заводское оборудование',
    divisions: { lv: 10000000, drives_mv: 600000 },
  });
  assert.equal(row!.data.potential, undefined);
  assert.ok(row!.missing.includes('Потенциал'));
  assert.ok(row!.warnings[0]!.includes('1'));
  assert.ok(!('owner_id' in row!.data));
  await assert.rejects(
    parseCompanyImport(bytes('Название;Стадия\nАльфа;Придумано'), 'csv', assertImportPrivacy),
    status(400),
  );
});

test('name-only import persists unknown category, while supplied type and manual defaults remain intact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-import-unknown-')),
    db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '987650100',
    name: 'Импорт',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    actor.id,
    actor.telegramId,
    actor.name,
    actor.role,
  ]);
  const crm = new CrmService(db),
    imports = new CompanyImports(db, crm, assertImportPrivacy);
  const preview = await imports.prepare(actor, {
    sourceKey: 'unknown:1',
    bytes: bytes('Компания только с названием'),
    format: 'txt',
  });
  assert.deepEqual(preview.rows[0]!.data, { name: 'Компания только с названием' });
  assert.ok(preview.rows[0]!.missing.includes('Тип'));
  assert.ok(preview.messages.join('\n').includes('техническую стадию «Новый»'));
  const result = await imports.confirm(actor, preview.id, preview.version),
    saved = await crm.detail(actor, result.created[0]!);
  assert.equal(saved.company.segment, 'unknown');
  assert.equal(saved.company.potential, null);
  assert.equal(saved.company.industry, '');
  assert.equal(saved.company.stage, 'new');
  const specified = await imports.prepare(actor, {
    sourceKey: 'unknown:2',
    bytes: bytes('Название;Тип;Стадия\nУказанный тип;Подрядчик;Диалог'),
    format: 'csv',
  });
  const second = await imports.confirm(actor, specified.id, 1);
  const existing = await crm.detail(actor, second.created[0]!);
  assert.equal(existing.company.segment, 'contractor');
  assert.equal(existing.company.stage, 'dialogue');
  const manual = await crm.create(actor, { name: 'Ручное создание' });
  assert.equal(manual.segment, 'end_client');
});
