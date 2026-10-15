import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCompanyImport, assertImportPrivacy } from '../server/services/company-import-parser';
import { CompanyImports } from '../server/services/company-imports';
import { Database } from '../server/infra/database';
import { makeConfig } from '../server/config';
import { CrmService } from '../server/services/crm';
import { Actor } from '../shared/contracts';
import {
  zip,
  picoTemplate,
  syntheticClient,
  syntheticProject,
  docxDocument,
  docParagraph,
  docTable,
} from './helpers/import-fixtures';
const parse = (b: Buffer, format: 'xlsx' | 'docx' | 'csv' = 'xlsx') =>
  parseCompanyImport(b, format, assertImportPrivacy);

test('Pico template skips demonstration and empty formatted rows; recalculates totals without cached formula values', async () => {
  await assert.rejects(parse(picoTemplate()), /Шаблон не заполнен/);
  const rows = await parse(
    picoTemplate({ clients: [syntheticClient()], projects: [syntheticProject()] }),
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.source, 'Клиенты · строка 5');
  assert.equal(row.data.potential, 6_000_000);
  assert.equal(row.data.divisions!.cells, 0);
  assert.ok(row.data.notes!.includes('АСУ ТП: 3000000'));
  assert.equal(row.contacts!.length, 1);
  assert.equal(row.projects![0]!.data.amount, 7_000_000);
  assert.equal(row.projects![0]!.data.due, null);
  assert.ok(row.projects![0]!.data.notes.includes('Решение до (месяц): 11.2026'));
  assert.ok(row.projects![0]!.data.notes.includes('Стадия из источника: Тендер'));
  assert.equal(row.projects![0]!.data.stage, 'new');
});

test('Pico template rejects modified formulas/merges, ambiguous contacts, unresolved parents and invalid amounts', async () => {
  await assert.rejects(
    parse(
      picoTemplate({ clients: [syntheticClient()], formula: 'WEBSERVICE("http://localhost")' }),
    ),
    /Неизвестная формула/,
  );
  await assert.rejects(
    parse(picoTemplate({ clients: [syntheticClient()], merge: 'A5:B5' })),
    /Объединения/,
  );
  const c = syntheticClient();
  c[14] = 'Тестовый Контакт, инженер, отдел, +79990000001, a@example.test';
  await assert.rejects(parse(picoTemplate({ clients: [c] })), /Контакты:/);
  const project = syntheticProject();
  project[1] = '1234567894';
  await assert.rejects(
    parse(picoTemplate({ clients: [syntheticClient()], projects: [project] })),
    /тем же ИНН/,
  );
  const negative = syntheticClient();
  negative[4] = '-1';
  await assert.rejects(parse(picoTemplate({ clients: [negative] })), /сумма должна/);
  const secret = syntheticClient();
  secret[15] = 'password: forbidden';
  await assert.rejects(
    parse(picoTemplate({ clients: [secret] })),
    /без личных контактов и секретов/,
  );
});

test('Google Docs structured tables and labeled paragraphs preserve company and business contact fields locally', async () => {
  const rows = await parse(
    docxDocument(
      docTable([
        ['Название компании', 'Город', 'Контакты'],
        [
          'Тестовая компания',
          'Казань',
          'Тестовый Контакт, инженер, +79990000001, business@example.test',
        ],
      ]),
    ),
    'docx',
  );
  assert.equal(rows[0]!.contacts![0]!.email, 'business@example.test');
  assert.equal(rows[0]!.data.city, 'Казань');
  const blocks = await parse(
    docxDocument(
      docParagraph('Название: Компания А') +
        docParagraph('Город: Москва') +
        docParagraph('') +
        docParagraph('Название: Компания Б'),
    ),
    'docx',
  );
  assert.deepEqual(
    blocks.map((r) => r.data.name),
    ['Компания А', 'Компания Б'],
  );
  const csv = await parse(
    Buffer.from(
      'Название компании;Контакты\nТестовая компания;Тестовый Контакт, инженер, +79990000001, business@example.test',
    ),
    'csv',
  );
  assert.equal(csv[0]!.contacts!.length, 1);
  await assert.rejects(parse(docxDocument('<w:altChunk/>'), 'docx'), /вложенные объекты/);
});

test('Template confirmation creates a complete graph once, skips foreign duplicates and checks author/access', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-template-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '997001',
    name: 'A',
    role: 'manager',
    active: true,
  };
  const other: Actor = { ...actor, id: randomUUID(), telegramId: '997002', name: 'B' };
  for (const a of [actor, other])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      a.id,
      a.telegramId,
      a.name,
      a.role,
    ]);
  const crm = new CrmService(db),
    service = new CompanyImports(db, crm, assertImportPrivacy);
  const input = {
    bytes: picoTemplate({ clients: [syntheticClient()], projects: [syntheticProject()] }),
    format: 'xlsx' as const,
    sourceKey: 'template:1',
  };
  const preview = await service.prepare(actor, input);
  assert.equal((await db.query('SELECT * FROM records')).length, 0);
  assert.ok(preview.messages.every((m) => m.length <= 3500));
  assert.ok(preview.messages.join('\n').includes('Контакт:'));
  assert.ok(preview.messages.join('\n').includes('Проект:'));
  await assert.rejects(service.confirm(other, preview.id, 1), /Импорт недоступен/);
  const result = await service.confirm(actor, preview.id, 1);
  assert.equal(result.created.length, 1);
  assert.equal(result.contacts, 1);
  assert.equal(result.projects, 1);
  assert.deepEqual(await service.confirm(actor, preview.id, 1), result);
  const records = await db.query('SELECT * FROM records');
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.company_id === result.created[0] && r.author_id === actor.id));
  assert.equal(records.find((r) => r.kind === 'contact').contact_source, 'user');
  const dupe = await service.prepare(other, { ...input, sourceKey: 'template:2' });
  assert.equal(dupe.rows[0]!.disposition, 'skip_duplicate');
  const skipped = await service.confirm(other, dupe.id, 1);
  assert.equal(skipped.created.length, 0);
  assert.equal((await db.query('SELECT * FROM records')).length, 2);
  const next = syntheticClient();
  next[0] = '1234567894';
  next[1] = 'Другая тестовая компания';
  const revoked = await service.prepare(actor, {
    ...input,
    bytes: picoTemplate({ clients: [next] }),
    sourceKey: 'template:3',
  });
  await db.query('UPDATE users SET active=false WHERE id=$1', [actor.id]);
  await assert.rejects(service.confirm(actor, revoked.id, 1), /Импорт недоступен/);
  await db.query('UPDATE users SET active=true WHERE id=$1', [actor.id]);
  const createRecord = crm.createRecord.bind(crm);
  t.mock.method(crm, 'createRecord', async (...args: Parameters<CrmService['createRecord']>) => {
    await createRecord(...args);
    throw new Error('synthetic downstream failure');
  });
  await assert.rejects(service.confirm(actor, revoked.id, 1), /synthetic downstream failure/);
  assert.equal((await db.query('SELECT * FROM companies')).length, 1);
  assert.equal((await db.query('SELECT * FROM records')).length, 2);
  assert.equal(
    (await db.query('SELECT status FROM company_imports WHERE id=$1', [revoked.id]))[0].status,
    'pending',
  );
});

test('DOCX rejects hidden/merged/nested data instead of silently skipping companies; hyperlinks remain inert', async () => {
  const table = docTable([['Название компании'], ['Компания А']]);
  for (const unsupported of [
    '<w:sdt><w:sdtContent>' + table + '</w:sdtContent></w:sdt>',
    table.replace('<w:tc>', '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>'),
    table.replace('<w:tc>', '<w:tc><w:tcPr><w:vMerge/></w:tcPr>'),
    '<w:tbl><w:tr><w:tc>' + table + '</w:tc></w:tr></w:tbl>',
  ])
    await assert.rejects(parse(docxDocument(table + unsupported), 'docx'), /не поддерживаются/);
  const xml = `<w:document xmlns:w="urn:word"><w:body>${table}</w:body></w:document>`;
  const rels = (type: string) =>
    `<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="https://example.test/" TargetMode="External"/></Relationships>`;
  const accepted = await parse(
    zip({ 'word/document.xml': xml, 'word/_rels/document.xml.rels': rels('hyperlink') }),
    'docx',
  );
  assert.equal(accepted[0]!.data.name, 'Компания А');
  await assert.rejects(
    parse(zip({ 'word/document.xml': xml, 'word/_rels/document.xml.rels': rels('image') }), 'docx'),
    /Внешние связи/,
  );
});

test('Customer name/INN conflict and omitted DOCX grid columns cannot create wrong CRM links', async () => {
  const customer = syntheticClient();
  customer[0] = '1234567894';
  customer[1] = 'Заказчик А';
  const project = syntheticProject();
  project[3] = 'Заказчик Б';
  project[4] = '1234567894';
  await assert.rejects(
    parse(picoTemplate({ clients: [syntheticClient(), customer], projects: [project] })),
    /название заказчика не совпадает/,
  );
  const table = docTable([['Название компании', 'Город'], ['Казань']]);
  for (const tag of ['gridBefore', 'gridAfter'])
    await assert.rejects(
      parse(
        docxDocument(table.replace('<w:tr>', '<w:tr><w:trPr><w:' + tag + ' w:val="1"/></w:trPr>')),
        'docx',
      ),
      /не поддерживаются/,
    );
  await assert.rejects(
    parse(
      Buffer.from(
        'Название;Контакты\n;Тестовый Контакт, инженер, +79990000001, business@example.test',
      ),
      'csv',
    ),
    /нет названия/,
  );
});
