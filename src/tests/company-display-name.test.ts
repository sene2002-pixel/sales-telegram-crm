import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyDisplayName } from '../shared/company-display-name';
import { emptyDeal, emptySales, salesFeedback } from '../shared/sales';

test('company display names remove only supported anchored legal forms and their outer quotes', () => {
  for (const [input, expected] of [
    ['ООО «Энергия»', 'Энергия'],
    ['АО "ЭлектроСнаб"', 'ЭлектроСнаб'],
    ['ПАО “Россети Центр”', 'Россети Центр'],
    ['ОАО «ТЭЦ-1»', 'ТЭЦ-1'],
    ['ЗАО Инженерные решения', 'Инженерные решения'],
    ['НАО «Новый завод»', 'Новый завод'],
    ['ИП Иванов Иван Иванович', 'Иванов Иван Иванович'],
    ['Акционерное общество «Север»', 'Север'],
    ['Общество с ограниченной ответственностью «Сервис»', 'Сервис'],
    ['Публичное акционерное общество «Завод»', 'Завод'],
    ['Непубличное акционерное общество «Завод»', 'Завод'],
    ['Открытое акционерное общество «Завод»', 'Завод'],
    ['Закрытое акционерное общество «Завод»', 'Завод'],
    ['  ооо\u00a0«Нефтесервис»  ', 'Нефтесервис'],
    ['ООО«Машиностроение»', 'Машиностроение'],
    ['«Технологии», ООО', 'Технологии'],
    ['Энергетика АО', 'Энергетика'],
    ['Шахты, Акционерное общество.', 'Шахты'],
    ['АО Энерго ООО', 'Энерго'],
    ['ООО «Группа "Север"»', 'Группа "Север"'],
  ])
    assert.equal(companyDisplayName(input), expected, input);
});

test('company display names preserve brands, embedded legal-looking words and nonempty fallback labels', () => {
  for (const input of [
    'АОЭнергия',
    'ПАОСервис',
    'Интер РАО',
    'Технологии ООО будущего',
    'OOO International',
    'AO Games',
    'АОТех',
    '«Обычная марка»',
    'Компания «АО»',
    'ООО',
    'АО',
    'ПАО',
    'Акционерное общество',
    'ООО ""',
    'ООО «»',
  ])
    assert.equal(companyDisplayName(input), input, input);
  assert.equal(companyDisplayName('ООО «ООО Сервис»'), 'ООО Сервис');
  assert.equal(companyDisplayName('ООО »Незакрытая кавычка«'), '»Незакрытая кавычка«');
  assert.equal(companyDisplayName(undefined), '');
  assert.equal(companyDisplayName(null), '');
  assert.equal(companyDisplayName('   '), '');
});

test('sales feedback shortens the company heading while preserving project names and structured confirmed facts', () => {
  const rawCompany = 'ООО «Энергия»';
  const sales = emptySales();
  const deal = emptyDeal('ООО Проект заказчика');
  deal.nextStep = { value: 'Позвонить в АО отдел снабжения', certainty: 'confirmed' };
  sales.deals.push(deal);
  sales.client.contacts.push({ name: 'АО Иванов', position: 'Директор', decisionRole: null });
  const before = structuredClone(sales);
  const feedback = salesFeedback(rawCompany, sales);
  assert.equal(feedback.split('\n')[1], 'Энергия');
  assert.ok(feedback.includes('ООО Проект заказчика:'));
  assert.ok(feedback.includes('Позвонить в АО отдел снабжения'));
  assert.deepEqual(sales, before);
  assert.equal(rawCompany, 'ООО «Энергия»');
});

test('foreign countries distinguish company labels without changing legal identity', () => {
  assert.equal(companyDisplayName('ООО «Сервис»', 'Беларусь'), 'Сервис (Беларусь)');
  assert.equal(companyDisplayName('ООО «Сервис»', 'Россия'), 'Сервис');
  assert.equal(companyDisplayName('ООО «Сервис»', 'РФ'), 'Сервис');
  assert.equal(companyDisplayName('ООО «Сервис»', 'RU'), 'Сервис');
  assert.equal(companyDisplayName('', 'Беларусь'), '');
  const company = { name: 'ООО «Сервис»', country: 'Беларусь' };
  companyDisplayName(company.name, company.country);
  assert.equal(company.name, 'ООО «Сервис»');
});
