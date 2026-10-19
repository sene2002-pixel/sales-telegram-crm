import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompanyImport, assertImportPrivacy } from '../server/services/company-import-parser';
const parse = (s: string) => parseCompanyImport(Buffer.from(s), 'csv', assertImportPrivacy);

test('import expands exact scientific INN and validates checksum without rounding', async () => {
  const rows = await parse('Название;ИНН\nООО «Тестовый Завод»;7.707083893E+9');
  assert.equal(rows[0]!.data.inn, '7707083893');
  assert.equal(rows[0]!.data.name, 'Тестовый Завод');
  for (const inn of ['7.70708E9', '7.7070838931E9', '7.707083892E9', '7.707083893E99']) {
    await assert.rejects(parse(`Название;ИНН\nЗавод;${inn}`));
  }
});

test('import uses explicit cell units before header units and rejects ambiguous amounts', async () => {
  const rows = await parse(
    'Название;Потенциал млн руб;Выручка тыс руб;lv тыс руб\nЗавод;250 тыс. руб.;200 руб;1,5 млн ₽',
  );
  assert.equal(rows[0]!.data.potential, 250_000);
  assert.equal(rows[0]!.data.revenue, 200);
  assert.equal(rows[0]!.data.divisions!.lv, 1_500_000);
  const header = await parse('Название;Потенциал тыс руб\nЗавод;1,5');
  assert.equal(header[0]!.data.potential, 1_500);
  for (const value of ['1 млн тыс', '-1', 'Infinity', '1000000000001 руб']) {
    await assert.rejects(parse(`Название;Потенциал\nЗавод;${value}`));
  }
  await assert.rejects(
    parse('Название;Заметки\nЗавод;api_key: forbidden'),
    /без личных контактов и секретов/,
  );
});

test('same normalized name and city skips legacy company without exposing or merging foreign facts', async (t) => {
  const { randomUUID } = await import('node:crypto');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Database } = await import('../server/infra/database');
  const { makeConfig } = await import('../server/config');
  const { CrmService } = await import('../server/services/crm');
  const { CompanyImports } = await import('../server/services/company-imports');
  const dir = await mkdtemp(join(tmpdir(), 'normalization-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor = (name: string) => ({
    id: randomUUID(),
    name,
    telegramId: randomUUID(),
    role: 'manager' as const,
    active: true,
  });
  const owner = actor('Владелец'),
    uploader = actor('Импортёр');
  for (const a of [owner, uploader])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      a.id,
      a.telegramId,
      a.name,
      a.role,
    ]);
  const crm = new CrmService(db);
  const original = await crm.create(owner, {
    name: 'ООО «Северный Завод»',
    city: ' Нижний   Новгород ',
    potential: 987654321,
    notes: 'Закрытая заметка',
  });
  const service = new CompanyImports(db, crm, assertImportPrivacy);
  const preview = await service.prepare(uploader, {
    sourceKey: 'normalization:1',
    format: 'csv',
    bytes: Buffer.from(
      'Название;Город;Потенциал\nАО «Северный Завод»;нижний новгород;100\nСеверный Завод;Самара;200\nСеверный Завод;;300\nСеверный Завод;;400',
    ),
  });
  assert.deepEqual(
    preview.rows.map((r) => r.disposition),
    ['skip_duplicate', 'create', 'create', 'create'],
  );
  assert.ok(!JSON.stringify(preview).includes('Закрытая заметка'));
  assert.ok(!JSON.stringify(preview).includes('987654321'));
  const result = await service.confirm(uploader, preview.id, preview.version);
  assert.equal(result.created.length, 3);
  assert.deepEqual(await service.confirm(uploader, preview.id, preview.version), result);
  assert.equal((await crm.company(owner, original.id)).potential, 987654321);
  assert.ok((await crm.list(uploader)).every((c) => c.ownerId === uploader.id));
  const repeated = await service.prepare(uploader, {
    sourceKey: 'normalization:2',
    format: 'csv',
    bytes: Buffer.from('Название;Город\nСеверный Завод;Самара'),
  });
  assert.equal(repeated.rows[0]!.disposition, 'skip_duplicate');
});

test('numeric XLSX INN uses exact text; structured template accepts multiple holdings without fake INNs', async () => {
  const { zip, picoTemplate, syntheticClient } = await import('./helpers/import-fixtures');
  const workbook = zip({
    'xl/workbook.xml': '<workbook/>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Название</t></is></c><c r="B1" t="inlineStr"><is><t>ИНН</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>Завод</t></is></c><c r="B2"><v>7.707083893E9</v></c></row></sheetData></worksheet>',
  });
  const rows = await parseCompanyImport(workbook, 'xlsx', assertImportPrivacy);
  assert.equal(rows[0]!.data.inn, '7707083893');
  const holding = syntheticClient();
  holding[0] = '';
  holding[1] = 'Холдинг Первый';
  holding[3] = 'Холдинг';
  for (let i = 4; i < 12; i++) holding[i] = '';
  const second = [...holding];
  second[1] = 'Холдинг Второй';
  const holdings = await parseCompanyImport(
    picoTemplate({ clients: [holding, second] }),
    'xlsx',
    assertImportPrivacy,
  );
  assert.equal(holdings.length, 2);
  assert.ok(holdings.every((row) => row.data.segment === 'holding' && !row.data.inn));
});

test('scientific money remains supported with explicit units and finite range bounds', async () => {
  const rows = await parse('Название;Потенциал млн руб;Выручка;lv\nЗавод;2.5e-1;1e6;5e2 тыс');
  assert.equal(rows[0]!.data.potential, 250_000);
  assert.equal(rows[0]!.data.revenue, 1_000_000);
  assert.equal(rows[0]!.data.divisions!.lv, 500_000);
  for (const value of ['1e309', '1e13', '-1e3'])
    await assert.rejects(parse(`Название;Потенциал\nЗавод;${value}`));
});
