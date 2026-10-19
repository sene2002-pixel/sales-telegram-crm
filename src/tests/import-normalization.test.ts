import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizedMoneyColumn,
  normalizedInn,
  normalizedCity,
  normalizedSegment,
  parsedMoney,
  normalizedCompanyName,
  importedLegalForm,
} from '../server/services/import-normalization';
import { parseCompanyTable, assertImportPrivacy } from '../server/services/company-import-parser';

test('money priority, median, separators, upper ranges and outliers are deterministic', () => {
  assert.deepEqual(
    normalizedMoneyColumn(['1', '3', '0'], 'Потенциал').map((v) => v.amount),
    [1e6, 3e6, 0],
  );
  assert.equal(normalizedMoneyColumn(['5000'], 'Потенциал')[0]!.amount, undefined);
  assert.equal(normalizedMoneyColumn(['20000'], 'Потенциал')[0]!.amount, 20000);
  assert.equal(normalizedMoneyColumn(['2 тыс'], 'Потенциал млн руб')[0]!.amount, 2000);
  assert.equal(normalizedMoneyColumn(['1’234.567,89 руб'], 'Потенциал')[0]!.amount, 1234567.89);
  assert.equal(normalizedMoneyColumn(['1,234,567.89 руб'], 'Потенциал')[0]!.amount, 1234567.89);
  for (const unit of ['млн', 'мл', 'лям', 'кк', 'м'])
    assert.equal(normalizedMoneyColumn([`2 ${unit}`], '')[0]!.amount, 2e6, unit);
  for (const unit of ['тыс', 'тр', 'т.р', 'к'])
    assert.equal(normalizedMoneyColumn([`2 ${unit}`], '')[0]!.amount, 2000, unit);
  assert.equal(normalizedMoneyColumn(['2 млрд'], '')[0]!.amount, 2e9);
  assert.equal(normalizedMoneyColumn(['10-20 млн'], '')[0]!.amount, 20000000);
  assert.match(normalizedMoneyColumn(['10-20 млн'], '')[0]!.note!, /10-20 млн/);
  assert.equal(normalizedMoneyColumn(['1 руб', '2 руб', '3000 руб'], '')[2]!.amount, undefined);
});

test('INN uses exact exponent expansion and checksum; cities and types avoid guesses', () => {
  assert.equal(normalizedInn('7.707083893e9'), '7707083893');
  assert.equal(normalizedInn('770 708 3893'), '7707083893');
  assert.equal(normalizedInn('7707083894'), undefined);
  assert.equal(normalizedInn('7.707e9'), undefined);
  assert.equal(normalizedCity('г. СПб'), 'Санкт-Петербург');
  assert.equal(normalizedCity('Ебург'), 'Екатеринбург');
  assert.equal(normalizedCity('Крас'), '');
  assert.equal(normalizedCity('Гатчина'), 'Гатчина');
  assert.equal(normalizedSegment('щитовик'), 'integrator');
  assert.equal(normalizedSegment('генподрядчик'), 'contractor');
});

test('generic table finds header, omits bad business values, preserves provenance, rejects malicious source', () => {
  const rows = parseCompanyTable(
    [
      ['Список клиентов'],
      ['Компания', 'ИНН', 'Город', 'Потенциал', 'Тип'],
      ['ООО «Альфа»', 'bad', 'Мск', '5000', 'не знаю'],
    ],
    'CSV',
    assertImportPrivacy,
  );
  assert.equal(rows[0]!.data.name, 'Альфа');
  assert.equal(rows[0]!.legalForm, 'ООО');
  assert.equal(rows[0]!.data.city, 'Москва');
  assert.equal(rows[0]!.data.inn, undefined);
  assert.equal(rows[0]!.data.potential, undefined);
  assert.equal(rows[0]!.data.segment, 'unknown');
  assert.ok(rows[0]!.warnings.length >= 2);
  assert.throws(() =>
    parseCompanyTable([['Компания'], ['api_key=malicious-token']], 'CSV', assertImportPrivacy),
  );
  assert.throws(() =>
    parseCompanyTable([['Компания'], ['=malicious()']], 'CSV', assertImportPrivacy),
  );
});

test('structured contact phones normalize country prefix and preserve extension separately from number', async () => {
  const { parseBusinessContacts } = await import('../server/services/company-import-parser');
  const contact = parseBusinessContacts(
    'Иван, Инженер, 8 (999) 123-45-67 доб. 42, ',
    assertImportPrivacy,
  )[0]!;
  assert.equal(contact.phone, '+79991234567');
  assert.equal(contact.role, 'Инженер');
  assert.equal(contact.extension, '42');
});

test('canonical template preserves valid client fields despite bad INN/money and unresolved project', async () => {
  const { picoTemplate, syntheticClient, syntheticProject } =
    await import('./helpers/import-fixtures');
  const { parseCompanyImport } = await import('../server/services/company-import-parser');
  const client = syntheticClient();
  client[0] = '123';
  client[4] = 'неизвестно';
  const rows = await parseCompanyImport(
    picoTemplate({ clients: [client], projects: [syntheticProject()] }),
    'xlsx',
    assertImportPrivacy,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.data.inn, undefined);
  assert.equal(rows[0]!.data.divisions?.lv, undefined);
  assert.ok(rows[0]!.data.name);
  assert.equal(rows[0]!.projects?.length, 0);
  assert.ok(rows[0]!.warnings.some((message) => message.includes('проект пропущен')));
});

test('generic XLSX accepts merged preamble and includes hidden business rows', async () => {
  const { zip } = await import('./helpers/import-fixtures');
  const { parseCompanyImport } = await import('../server/services/company-import-parser');
  const book = zip({
    'xl/workbook.xml': '<workbook/>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Список</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Компания</t></is></c><c r="B2" t="inlineStr"><is><t>Потенциал млн</t></is></c></row><row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Альфа</t></is></c><c r="B3"><v>2</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>',
  });
  const rows = await parseCompanyImport(book, 'xlsx', assertImportPrivacy);
  assert.equal(rows[0]!.data.name, 'Альфа');
  assert.equal(rows[0]!.data.potential, 2e6);
});

test('scientific minus is never a range and range endpoints must both be numeric', () => {
  assert.equal(normalizedMoneyColumn(['2.5e-1'], 'млн руб')[0]!.amount, 250000);
  assert.equal(normalizedMoneyColumn(['1e-3'], 'млн руб')[0]!.amount, 1000);
  assert.equal(normalizedMoneyColumn(['abc-5млн'], '')[0]!.amount, undefined);
  assert.equal(normalizedMoneyColumn(['30-10 млн'], '')[0]!.amount, 30000000);
  assert.equal(normalizedMoneyColumn(['1 млн-500 тыс'], '')[0]!.amount, 1000000);
});

test('import names remove only legal forms, normalize quotes and preserve business acronyms/case', () => {
  assert.equal(normalizedCompanyName("ФГУП 'НПК  Пример'"), 'НПК Пример');
  assert.equal(normalizedCompanyName('ТОО «НПП Сигнал»'), 'НПП Сигнал');
  assert.equal(
    normalizedCompanyName('Федеральное государственное унитарное предприятие «ГК Тест»'),
    'ГК Тест',
  );
  assert.equal(importedLegalForm('ФГУП «Пример»'), 'ФГУП');
  for (const acronym of ['НПК', 'НПП', 'НПО', 'ПКФ', 'ТД', 'ГК', 'СМУ', 'ПК'])
    assert.equal(normalizedCompanyName(acronym + ' Тест'), acronym + ' Тест');
  for (const placeholder of ['—', '-', 'н/д', 'неизвестно', 'Не указан', 'Крас'])
    assert.equal(normalizedCity(placeholder), '');
});

test('twenty preamble rows do not reduce the one hundred client import limit', async () => {
  const { parseCompanyImport } = await import('../server/services/company-import-parser');
  const preamble = Array.from({ length: 20 }, (_, i) => [`Заголовок ${i}`]);
  const clients = Array.from({ length: 100 }, (_, i) => [`Клиент ${i}`, 'Москва']);
  assert.equal(
    parseCompanyTable([...preamble, ['Компания', 'Город'], ...clients], 'CSV', assertImportPrivacy)
      .length,
    100,
  );
  const csv = [...preamble, ['Компания', 'Город'], ...clients]
    .map((row) => row.join(';'))
    .join('\n');
  assert.equal(
    (await parseCompanyImport(Buffer.from(csv), 'csv', assertImportPrivacy)).length,
    100,
  );
  assert.throws(
    () =>
      parseCompanyTable(
        [['Список'], ['Компания', 'Город'], ...clients, ['Лишний', 'Москва']],
        'CSV',
        assertImportPrivacy,
      ),
    /100/,
  );
  assert.throws(
    () =>
      parseCompanyTable(
        [...preamble, ['Лишняя преамбула'], ['Компания'], ['Клиент']],
        'CSV',
        assertImportPrivacy,
      ),
    /21/,
  );
});
