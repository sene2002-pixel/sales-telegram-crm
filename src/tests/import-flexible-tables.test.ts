import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCompanyImport,
  parseCompanyTable,
  assertImportPrivacy,
  parseBusinessContacts,
} from '../server/services/company-import-parser';
import { zip, xmlCell } from './helpers/import-fixtures';
const parse = (entries: Record<string, string>, format: 'xlsx' | 'ods') =>
  parseCompanyImport(zip(entries), format, assertImportPrivacy);
const sheet = (rows: string[][], extra = '') =>
  `<worksheet><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((v, col) => xmlCell(String.fromCharCode(65 + col) + (i + 1), v)).join('')}</row>`).join('')}</sheetData>${extra}</worksheet>`;

test('generic tables skip totals, inherit explicit section types and split independent blocks', () => {
  const rows = parseCompanyTable(
    [
      ['Отчёт'],
      ['Компания', 'Город'],
      ['Альфа', 'Мск'],
      ['Итого', ''],
      ['Щитовик', ''],
      ['Бета', 'Казань'],
      ['Компания', 'Город'],
      ['Гамма', 'СПб'],
    ],
    'Файл',
    assertImportPrivacy,
  );
  assert.deepEqual(
    rows.map((r) => r.data.name),
    ['Альфа', 'Бета', 'Гамма'],
  );
  assert.equal(rows[1]!.data.segment, 'integrator');
  assert.equal(rows[0]!.data.city, 'Москва');
  assert.equal(rows[2]!.data.city, 'Санкт-Петербург');
});
test('side-by-side tables and two-level equipment headers preserve column semantics', () => {
  const rows = parseCompanyTable(
    [
      ['Компания', 'Город', '', 'Компания', 'Город'],
      ['А', 'Мск', '', 'Б', 'Казань'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(rows.length, 2);
  const layered = parseCompanyTable(
    [
      ['Компания', 'Выключатели', 'Выключатели'],
      ['', '0,4 кВ', '6-35 кВ'],
      ['А', '3', '5'],
    ],
    'XLSX',
    assertImportPrivacy,
  );
  assert.equal(layered[0]!.data.divisions?.lv, 3e6);
  assert.equal(layered[0]!.data.divisions?.mv, 5e6);
});
test('business contacts accept columns and local free order; secrets are removed before raw retention', () => {
  const rows = parseCompanyTable(
    [
      ['Компания', 'Город', 'ФИО', 'Должность', 'Телефон', 'Email', 'Комментарий', 'Пароль'],
      [
        'А',
        'Казань',
        'Петров Иван',
        'Инженер',
        '8(902)600-04-39',
        'A@EXAMPLE.TEST',
        'Договорились\nпароль: forbidden-value',
        'password-value',
      ],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(rows[0]!.contacts?.[0]?.phone, '+79026000439');
  assert.equal(rows[0]!.contacts?.[0]?.email, 'a@example.test');
  assert.equal(rows[0]!.data.notes, 'Договорились');
  assert.ok(!JSON.stringify(rows).includes('forbidden-value'));
  assert.ok(!JSON.stringify(rows).includes('password-value'));
  assert.equal(
    parseBusinessContacts(
      'Иван Петров, инженер, +7 902 600-04-39, a@example.test',
      assertImportPrivacy,
    )[0]!.name,
    'Иван Петров',
  );
  assert.equal(
    parseBusinessContacts(
      'a@example.test | Иван Петров | инженер | 89026000439',
      assertImportPrivacy,
    )[0]!.phone,
    '+79026000439',
  );
});
test('generic XLSX reads visible sheets, skips hidden records and expands merged values', async () => {
  const parts = {
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets><sheet name="Первый" r:id="rId1"/><sheet name="Второй" r:id="rId2"/><sheet name="Скрытый" state="hidden" r:id="rId3"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet(
      [
        ['Компания', 'Город'],
        ['А', 'Москва'],
        ['Б', ''],
      ],
      '<mergeCells><mergeCell ref="B2:B3"/></mergeCells>',
    ),
    'xl/worksheets/sheet2.xml': sheet([
      ['Компания', 'Город'],
      ['В', 'Казань'],
      ['Не импортировать', 'Мск'],
    ]).replace('<row r="3">', '<row r="3" hidden="1">'),
    'xl/worksheets/sheet3.xml': sheet([
      ['Компания', 'Город'],
      ['Секретный лист', 'Мск'],
    ]),
  };
  const rows = await parse(parts, 'xlsx');
  assert.deepEqual(
    rows.map((r) => r.data.name),
    ['А', 'Б', 'В'],
  );
  assert.equal(rows[1]!.data.city, 'Москва');
});
test('ODS bounds repeated cells, skips collapsed rows and never executes formulas', async () => {
  const contents =
    '<document-content><body><spreadsheet><table><table-row><table-cell><p>Компания</p></table-cell><table-cell><p>Город</p></table-cell></table-row><table-row><table-cell><p>А</p></table-cell><table-cell><p>Мск</p></table-cell><table-cell number-columns-repeated="16382"/></table-row><table-row visibility="collapse"><table-cell><p>Скрытая</p></table-cell></table-row></table></spreadsheet></body></document-content>';
  const rows = await parse({ 'content.xml': contents }, 'ods');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.data.city, 'Москва');
  await assert.rejects(
    parse(
      {
        'content.xml': contents
          .replace('<p>Мск</p>', '<p>Мск</p>')
          .replace('<table-cell><p>А', '<table-cell formula="of:=EXTERNAL()"><p>А'),
      },
      'ods',
    ),
    /Формулы/,
  );
});

test('secret-labelled columns are removed together with values before raw retention', () => {
  for (const label of ['API key', 'secret', 'токен', 'API key production', 'Токен доступа']) {
    const rows = parseCompanyTable(
      [
        ['Компания', label],
        ['Safe company', 'SYNTHETIC_CANARY_123'],
      ],
      'synthetic',
      assertImportPrivacy,
    );
    assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_CANARY_123'), label);
    assert.equal(rows[0]!.data.name, 'Safe company');
  }
});
test('XLSX aggregate merged expansion is rejected before allocating unbounded rows or cells', async () => {
  const base = sheet([
    ['Компания', 'Город'],
    ['Safe company', 'Мск'],
  ]);
  const merges =
    '<mergeCells><mergeCell ref="A3:A2002"/><mergeCell ref="A2003:A4002"/></mergeCells>';
  await assert.rejects(
    parse(
      {
        'xl/workbook.xml': '<workbook/>',
        'xl/worksheets/sheet1.xml': base.replace('</worksheet>', merges + '</worksheet>'),
      },
      'xlsx',
    ),
    /Слишком много строк после раскрытия/,
  );
  const ranges =
    '<mergeCells>' +
    Array.from({ length: 501 }, () => '<mergeCell ref="A2:A2"/>').join('') +
    '</mergeCells>';
  await assert.rejects(
    parse(
      {
        'xl/workbook.xml': '<workbook/>',
        'xl/worksheets/sheet1.xml': base.replace('</worksheet>', ranges + '</worksheet>'),
      },
      'xlsx',
    ),
    /Слишком много объединённых диапазонов/,
  );
});
test('ODS rejects executable macro paths even when their bytes are not XML', async () => {
  const content =
    '<document-content><body><spreadsheet><table><table-row><table-cell><p>Компания</p></table-cell></table-row><table-row><table-cell><p>Safe company</p></table-cell></table-row></table></spreadsheet></body></document-content>';
  for (const path of ['Basic/Standard/Module1.xba', 'Scripts/python/module.py']) {
    await assert.rejects(
      parse({ 'content.xml': content, [path]: 'synthetic non-XML macro bytes' }, 'ods'),
      /Макросы ODS запрещены/,
    );
  }
});

test('ODS preserves covered columns, hidden style sheets and multiline contact identity', async () => {
  const content = `<document-content><automatic-styles><style name="hiddenSheet" family="table"><table-properties display="false"/></style></automatic-styles><body><spreadsheet>
<table><table-row><table-cell><p>Компания</p></table-cell><table-cell><p>Город</p></table-cell><table-cell><p>Контакты</p></table-cell></table-row><table-row><table-cell><p>ООО<s/>Альфа</p></table-cell><table-cell><p>Мск</p></table-cell><table-cell><p>Иван, инженер, +79990000001, ivan@example.test</p><p>Пётр, директор, +79990000002, petr@example.test</p></table-cell></table-row></table>
<table style-name="hiddenSheet"><table-row><table-cell><p>Компания</p></table-cell></table-row><table-row><table-cell><p>Скрытая компания</p></table-cell></table-row></table>
</spreadsheet></body></document-content>`;
  const rows = await parse({ 'content.xml': content }, 'ods');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.data.name, 'Альфа');
  assert.deepEqual(
    rows[0]!.contacts!.map((c) => [c.name, c.email]),
    [
      ['Иван', 'ivan@example.test'],
      ['Пётр', 'petr@example.test'],
    ],
  );
  const merged = `<document-content><body><spreadsheet><table><table-row><table-cell number-columns-spanned="2"><p>Компания</p></table-cell><covered-table-cell/><table-cell><p>Потенциал</p></table-cell></table-row><table-row><table-cell number-columns-spanned="2"><p>Альфа</p></table-cell><covered-table-cell/><table-cell><p>5</p></table-cell></table-row></table></spreadsheet></body></document-content>`;
  // Duplicate merged company columns are ambiguous and must fail instead of shifting money into city.
  await assert.rejects(parse({ 'content.xml': merged }, 'ods'), /Колонки с одним значением/);
});

test('generic import preserves explicit legal identities and contractor categories', () => {
  const rows = parseCompanyTable(
    [
      ['Компания', 'ИНН', 'Тип'],
      ['НЛМК', '7707083893', 'Подрядчик'],
      ['Карабашмедь', '', 'Подрядчик'],
      ['ООО Сервис Карабашмеди', '', 'Заказчик'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(rows[0]!.data.inn, '7707083893');
  assert.equal(rows[0]!.data.segment, 'contractor');
  assert.equal(rows[1]!.data.segment, 'contractor');
  assert.equal(rows[1]!.holdingName, undefined);
  assert.equal(rows[2]!.data.name, 'Сервис Карабашмеди');
  assert.equal(rows[2]!.holdingName, undefined);
});

test('XLSX source row retains original spreadsheet coordinates', async () => {
  const xml = sheet([
    ['Компания', 'Город'],
    ['Альфа', 'Мск'],
  ])
    .replaceAll('r="2"', 'r="100"')
    .replaceAll('A2', 'A100')
    .replaceAll('B2', 'B100');
  const rows = await parse(
    { 'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': xml },
    'xlsx',
  );
  assert.match(rows[0]!.source, /строка 100$/);
});

test('contact-only continuation rows attach locally and safe credential mentions remain without secrets', () => {
  const rows = parseCompanyTable(
    [
      ['Компания', 'ФИО', 'Должность', 'Телефон', 'Email', 'Комментарий'],
      ['Альфа', 'Иван', 'инженер', '+79990000001', 'ivan@example.test', 'логин и пароль скинут'],
      ['', 'Пётр', 'директор', '+79990000002', 'petr@example.test', ''],
      ['', '', '', '', '', 'Unidentified unrelated note'],
      ['Бета', 'Максим', '', '', 'max@example.test', 'пароль: SYNTHETIC_SECRET'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows[0]!.contacts!.map((c) => c.name),
    ['Иван', 'Пётр'],
  );
  assert.equal(rows[0]!.data.notes, 'логин и пароль скинут');
  assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_SECRET'));
  assert.ok(!JSON.stringify(rows[0]).includes('Unidentified unrelated note'));
  assert.deepEqual(
    rows[1]!.contacts!.map((c) => c.name),
    ['Максим'],
  );
});

test('contact continuation maps reordered columns by meaning rather than position', () => {
  const rows = parseCompanyTable(
    [
      ['Компания', 'Телефон', 'ФИО', 'Email', 'Должность'],
      ['Альфа', '+79990000001', 'Иван', 'ivan@example.test', 'инженер'],
      ['', '+79990000002', 'Пётр', 'petr@example.test', 'директор'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.deepEqual(
    rows[0]!.contacts!.map((c) => [c.name, c.role, c.phone, c.email]),
    [
      ['Иван', 'инженер', '+79990000001', 'ivan@example.test'],
      ['Пётр', 'директор', '+79990000002', 'petr@example.test'],
    ],
  );
});
