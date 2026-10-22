import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCompanyImport,
  parseCompanyTable,
  assertImportPrivacy,
} from '../server/services/company-import-parser';
import { zip, xmlCell } from './helpers/import-fixtures';

test('project tables preserve company/customer/role identities and source-only dates', () => {
  const result = parseCompanyTable(
    [
      [
        'Компания',
        'Проект',
        'Заказчик',
        'Сумма проекта, млн руб',
        'Стадия',
        'Реализация',
        'Подрядчик',
        'Щитовик / ОЭМ',
        'Вопросы',
      ],
      [
        'Альфа',
        'Новая подстанция',
        'Заказчик',
        '12',
        'Диалог',
        'ноябрь 2026',
        'СтройСервис',
        'ЩитСервис',
        'Согласовать смету',
      ],
      ['Альфа', 'Новый цех', 'Заказчик', '18', 'ожидание', 'ноябрь', '', '', ''],
    ],
    'CSV',
    assertImportPrivacy,
    undefined,
    '2026-10-21',
  );
  assert.equal(result.length, 4);
  const owner = result.find((c) => c.data.name === 'Альфа')!;
  assert.equal(owner.projects?.length, 2);
  assert.equal(owner.projects![0]!.data.amount, 12e6);
  assert.equal(owner.projects![0]!.data.stage, 'dialogue');
  assert.equal(owner.projects![0]!.data.due, null);
  assert.match(owner.projects![0]!.data.notes, /11\.2026/);
  assert.match(owner.projects![0]!.data.notes, /Согласовать смету/);
  assert.match(owner.projects![1]!.data.notes, /ожидание/);
  assert.equal(owner.projects![0]!.customerName, 'Заказчик');
  assert.match(owner.projects![0]!.data.notes, /Заказчик из источника: Заказчик/);
  assert.equal(
    result.find((c) => c.data.name === 'СтройСервис')!.projects![0]!.participantRole,
    'Подрядчик',
  );
  assert.equal(result.find((c) => c.data.name === 'Заказчик')!.data.segment, 'end_client');
});

test('customer-only project rows work in CSV, XLSX and ODS without fabricated owner', async () => {
  const rows = [
    ['Проект', 'Заказчик', 'Реализация'],
    ['Цех', 'Тестовый завод', 'ноябрь'],
  ];
  const csv = await parseCompanyImport(
    Buffer.from(rows.map((r) => r.join(';')).join('\n')),
    'csv',
    assertImportPrivacy,
  );
  assert.equal(csv[0]!.data.name, 'Тестовый завод');
  assert.equal(csv[0]!.projects![0]!.data.due, null);
  assert.match(csv[0]!.projects![0]!.data.notes, /исходное значение.*ноябрь/);
  const xlsx = await parseCompanyImport(
    zip({
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="Проекты" sheetId="1" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => xmlCell(`${String.fromCharCode(65 + j)}${i + 1}`, v)).join('')}</row>`).join('')}</sheetData></worksheet>`,
      'docProps/core.xml':
        '<cp:coreProperties><dcterms:modified>2026-10-21T10:00:00Z</dcterms:modified></cp:coreProperties>',
    }),
    'xlsx',
    assertImportPrivacy,
  );
  assert.match(xlsx[0]!.projects![0]!.data.notes, /11\.2026/);
  const ods = await parseCompanyImport(
    zip({
      mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
      'content.xml': `<office:document-content><office:body><office:spreadsheet><table:table>${rows.map((r) => `<table:table-row>${r.map((v) => `<table:table-cell><text:p>${v}</text:p></table:table-cell>`).join('')}</table:table-row>`).join('')}</table:table></office:spreadsheet></office:body></office:document-content>`,
    }),
    'ods',
    assertImportPrivacy,
    '2026-10-21',
  );
  assert.match(ods[0]!.projects![0]!.data.notes, /11\.2026/);
  assert.throws(
    () =>
      parseCompanyTable(
        [
          ['Проект', 'Заказчик'],
          ['Цех', ''],
        ],
        'CSV',
        assertImportPrivacy,
      ),
    /нужна компания или заказчик/,
  );
});

test('project import preserves structured business contacts, equipment and sanitized raw', () => {
  const rows = parseCompanyTable(
    [
      [
        'Компания',
        'Проект',
        'ФИО',
        'Должность',
        'Телефон',
        'Email',
        'Выключатели 0,4 кВ',
        'Пароль',
        'Стадия',
      ],
      [
        'Альфа',
        'Объект',
        'Иван Петров',
        'ГИП',
        '+7 999 123-45-67',
        'ivan@example.test',
        '3',
        'very-secret',
        'новый',
      ],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(rows[0]!.contacts![0]!.name, 'Иван Петров');
  assert.equal(rows[0]!.projects![0]!.data.equipment[0]!.amount, 3e6);
  assert.ok(!JSON.stringify(rows).includes('very-secret'));
  const safe = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Комментарий'],
      ['А', 'Цех', 'password=abc'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.ok(!JSON.stringify(safe).includes('password=abc'));
  const located = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Город компании', 'Город проекта'],
      ['А', 'Цех', 'Москва', 'Казань'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(located[0]!.data.city, 'Москва');
  assert.equal(located[0]!.projects![0]!.data.city, 'Казань');
});

test('layout integration retains source coordinates, safe provenance and skips shipments', () => {
  const rows = parseCompanyTable(
    [
      ['1 - Подрядчик'],
      ['Компания', 'Тип', 'Отгружено 2025', 'Пароль'],
      ['Альфа', '1', '900', 'very-secret'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(rows[0]!.data.segment, 'contractor');
  assert.match(rows[0]!.source, /строка 3$/);
  assert.equal(rows[0]!.data.potential, undefined);
  assert.equal(rows[0]!.raw!['Исходная ячейка 3'], '900');
  assert.ok(!JSON.stringify(rows).includes('very-secret'));
});

test('project-only secret columns and mixed invoice tables retain their boundaries', () => {
  const safe = parseCompanyTable(
    [
      ['Заказчик', 'Проект', 'Пароль'],
      ['Тестовый завод', 'Объект', 'CANARY_SECRET'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.ok(!JSON.stringify(safe).includes('CANARY_SECRET'));
  const mixed = parseCompanyTable(
    [
      ['Компания', 'Город'],
      ['Альфа', 'Москва'],
      ['Документ', 'Сумма'],
      ['Договор 123 от 01.10.2026 Бета', '9000000'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.deepEqual(
    mixed.map((c) => c.data.name),
    ['Альфа', 'Бета'],
  );
  assert.equal(mixed[1]!.data.potential, undefined);
});

test('phone-only project contacts remain visible without invented identity', () => {
  const records = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Телефон', 'Email'],
      ['Альфа', 'Цех', '+7 999 123-45-67', 'office@example.test'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(records[0]!.contacts?.length || 0, 0);
  assert.ok(!records[0]!.projects![0]!.data.notes.includes('office@example.test'));
  assert.match(records[0]!.projects![0]!.data.notes, /ФИО не указано/);
  assert.match(records[0]!.warnings.join(' '), /без ФИО/);
});

test('Cyrillic project totals do not become projects or invalid owner rows', () => {
  const records = parseCompanyTable(
    [
      ['Проект', 'Заказчик'],
      ['Цех', 'Альфа'],
      ['Итого', ''],
      ['Итого по проектам', ''],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]!.projects!.length, 1);
});

test('project participant geography belongs only to explicitly named company', () => {
  const records = parseCompanyTable(
    [
      [
        'Компания',
        'Проект',
        'Город компании',
        'Страна компании',
        'Регион компании',
        'Заказчик',
        'Подрядчик',
      ],
      ['Альфа', 'Цех', 'Москва', 'Россия', 'Московский', 'Бета', 'Гамма'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(records[0]!.data.city, 'Москва');
  for (const participant of records.slice(1)) {
    assert.ok(!participant.data.city);
    assert.ok(!participant.data.country);
    assert.ok(!participant.data.region);
  }
  const same = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Город компании', 'Заказчик'],
      ['Альфа', 'Цех', 'Москва', 'Альфа'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(same.length, 1);
  assert.equal(same[0]!.data.city, 'Москва');
  const foreign = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Страна компании', 'Заказчик', 'Страна заказчика', 'ИНН заказчика'],
      ['Альфа', 'Цех', 'Россия', 'Бета', 'Беларусь', '7707083893'],
      ['Альфа', 'Цех2', 'Беларусь', 'Бета', 'Беларусь', '7707083893'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(foreign.filter((c) => c.data.name === 'Альфа').length, 2);
  assert.equal(foreign[0]!.projects![0]!.customerCountry, 'Беларусь');
  assert.equal(foreign[0]!.projects![0]!.customerInn, undefined);
});
test('contact instruction without facts stays a note rather than invented person', () => {
  const records = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Контакты'],
      ['Альфа', 'Цех', 'Уточнить у Алексея Бондаренко'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(records[0]!.contacts?.length || 0, 0);
  assert.match(records[0]!.projects![0]!.data.notes, /Уточнить у Алексея/);
});

test('same-name foreign customer does not reuse domestic owner', () => {
  const records = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Страна компании', 'Заказчик', 'Страна заказчика'],
      ['Альфа', 'Цех', 'Россия', 'Альфа', 'Беларусь'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(records.length, 2);
  assert.equal(records[1]!.data.country, 'Беларусь');
});
test('mixed contact instructions survive company tables without contact duplication', () => {
  const records = parseCompanyTable(
    [
      ['Компания', 'Контакты'],
      [
        'Альфа',
        'Иван Петров,ГИП,+7 999 123-45-67,ivan@example.test\nУточнить у Алексея Бондаренко',
      ],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(records[0]!.contacts!.length, 1);
  assert.match(records[0]!.data.notes || '', /Уточнить у Алексея/);
});

test('all project identities share conservative legal-form, INN, country and city matching', () => {
  const variants = [
    ['АО Альфа', 'ООО Альфа', '', '', '', ''],
    ['Альфа', 'Альфа', 'Россия', 'Беларусь', '', ''],
    ['Альфа', 'Альфа', 'Россия', 'Россия', 'Москва', 'Казань'],
  ];
  for (const [owner, customer, country, customerCountry, city, customerCity] of variants) {
    const records = parseCompanyTable(
      [
        [
          'Компания',
          'Проект',
          'Заказчик',
          'Страна компании',
          'Страна заказчика',
          'Город компании',
          'Город заказчика',
        ],
        [owner!, 'Цех', customer!, country!, customerCountry!, city!, customerCity!],
      ],
      'CSV',
      assertImportPrivacy,
    );
    assert.equal(records.length, 2);
  }
  const differentInn = parseCompanyTable(
    [
      ['Компания', 'ИНН', 'Проект', 'Заказчик', 'ИНН заказчика'],
      ['Альфа', '7707083893', 'Цех', 'Альфа', '7736050003'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(differentInn.length, 2);
});

test('identity enrichment fills only missing facts and refreshes the matching snapshot', () => {
  const records = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Заказчик', 'ИНН заказчика'],
      ['Альфа', 'Цех', 'Альфа', '7707083893'],
      ['Альфа', 'Цех2', 'Альфа', '7736050003'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(records.length, 2);
  assert.equal(records[0]!.data.inn, '7707083893');
  assert.equal(records[1]!.data.inn, '7736050003');
});

test('foreign identity enrichment never inserts Russian INN into an existing foreign company', () => {
  const records = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Заказчик', 'Страна компании', 'Страна заказчика', 'ИНН заказчика'],
      ['Альфа', 'Цех', 'Альфа', 'Беларусь', 'Беларусь', '7707083893'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(records.length, 1);
  assert.ok(!records[0]!.data.inn);
  assert.ok(!records[0]!.projects![0]!.customerInn);
});

test('validated candidate boundary rejects invalid INN before pool fill', () => {
  const records = parseCompanyTable(
    [
      ['Компания', 'Проект', 'Заказчик', 'ИНН заказчика'],
      ['Альфа', 'Цех', 'Альфа', '7707083894'],
      ['Альфа', 'Цех2', 'Альфа', '7707083893'],
      ['Альфа', 'Цех3', 'Альфа', '7736050003'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(records.length, 2);
  assert.equal(records[0]!.data.inn, '7707083893');
  assert.equal(records[1]!.data.inn, '7736050003');
});
