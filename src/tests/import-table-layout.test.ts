import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLayout } from '../server/services/import-table-layout';
test('explicit ERP hierarchy retains deepest companies and physical provenance without shipment money', () => {
  const r = normalizeLayout(
    [
      ['Контрагент', 'Отгружено'],
      ['Менеджер', '900'],
      ['  Покупают', '900'],
      ['    04кВ ООО', '500'],
      ['    QA', '400'],
      ['Итого', '900'],
    ],
    [10, 11, 12, 13, 14, 15],
  );
  assert.deepEqual(r.rows, [['Контрагент'], ['04кВ ООО'], ['QA']]);
  assert.deepEqual(r.sourceRows, [10, 13, 14]);
  assert.equal(r.kind, 'erp');
});
test('explicit legends apply only type columns, never identifiers or unknown codes', () => {
  const r = normalizeLayout([
    ['Компания', 'Тип', 'ИНН'],
    ['QA', '1', '1'],
    ['Other', '8', '2'],
    ['1 - Сборка'],
    ['2 - АСУ ТП'],
  ]);
  assert.deepEqual(r.rows, [
    ['Компания', 'Тип', 'ИНН'],
    ['QA', 'Сборка', '1'],
    ['Other', '8', '2'],
  ]);
  assert.deepEqual(r.sourceRows, [1, 2, 3]);
});
test('contract lists extract company tail but discard all financial and operational history', () => {
  const r = normalizeLayout([
    ['Договор', 'Город', 'Сумма', 'Комментарий', 'Оборудование'],
    ['[8312042] Дог 30-051644 от 16.06.2025 г. ЭЩС ООО', 'Москва', '100000', 'ждём самолёт', 'Щит'],
    ['Дог 2 от 31.02.2025 г. Invalid', '', '1', '', ''],
    ['', '', '', '', 'Щит'],
  ]);
  assert.deepEqual(r.rows, [
    ['Компания', 'Город'],
    ['ЭЩС ООО', 'Москва'],
  ]);
  assert.deepEqual(r.sourceRows, [1, 2]);
});
test('ordinary flat rows and project columns remain unchanged; inputs are not mutated', () => {
  const rows = [
    ['Компания', 'Проект', 'Заказчик'],
    ['  QA', 'Object', 'Client'],
    ['Manager', '', ''],
  ];
  assert.deepEqual(normalizeLayout(rows).rows, rows);
  assert.equal(rows[1]![0], '  QA');
  assert.throws(() => normalizeLayout([['x'.repeat(1001)]]), /ограничения/);
  assert.throws(
    () => normalizeLayout([['Компания', 'Тип'], ['QA', '1'], ['1 - A1'], ['1 - B2']]),
    /легенда/,
  );
});
test('explicit industry sections and textual adjacent notes preserve provenance, never infer numeric symbols', () => {
  const r = normalizeLayout(
    [
      ['Компания', 'Отрасль', '', ''],
      ['Отрасль: Энергетика'],
      ['QA', '', 'заметка менеджера', '12000'],
      ['Other', 'Химия', 'уточнить позже', '✔'],
    ],
    [8, 9, 10, 11],
  );
  assert.equal(r.rows[0]![2], 'Заметка из таблицы 3');
  assert.equal(r.rows[0]![3], '');
  assert.equal(r.rows[2]![1], 'Энергетика');
  assert.equal(r.rows[3]![1], 'Химия');
  assert.deepEqual(r.sourceRows, [8, 9, 10, 11]);
});
test('ERP keeps leaves at different indentation depths across manager branches', () => {
  const r = normalizeLayout([
    ['Контрагент'],
    ['Менеджер A'],
    [' Покупают'],
    ['   QA A'],
    ['Менеджер B'],
    [' Не покупают'],
    ['  QA B'],
  ]);
  assert.deepEqual(r.rows, [['Контрагент'], ['QA A'], ['QA B']]);
  assert.deepEqual(r.sourceRows, [1, 4, 7]);
});

test('explicit industry legend expands only known code preserving unknown source values', () => {
  const r = normalizeLayout([
    ['Компания', 'Отрасль'],
    ['QA', '1'],
    ['Other', '8'],
    ['1 - Энергетика'],
  ]);
  assert.deepEqual(r.rows, [
    ['Компания', 'Отрасль'],
    ['QA', 'Энергетика'],
    ['Other', '8'],
  ]);
});

test('annual demand is potential in ordinary company lists, while shipments remain excluded', () => {
  const r = normalizeLayout([
    ['Компания', 'Годовая потребность, млн руб.', 'Отгружено'],
    ['QA', '5', '400000'],
  ]);
  assert.deepEqual(r.rows, [
    ['Компания', 'Годовая потребность, млн руб.'],
    ['QA', '5'],
  ]);
});

test('numeric-looking real company is not consumed as legend without a used category code', () => {
  const rows = [
    ['Компания', 'Город'],
    ['1 - Сервис ООО', ''],
    ['QA', 'Москва'],
  ];
  assert.deepEqual(normalizeLayout(rows).rows, rows);
});
