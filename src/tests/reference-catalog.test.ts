import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { industryGroups, normalizeIndustry } from '../shared/reference-industries';
import {
  parseReferenceCatalog,
  selectReferences,
  renderReferences,
  shortenReferences,
  neutralReferences,
  type ReferenceEntry,
} from '../server/services/reference-catalog';

const entry = (
  id: string,
  group: ReferenceEntry['group'],
  changes: Partial<ReferenceEntry> = {},
): ReferenceEntry => ({
  id,
  group,
  name: id,
  facts: 'ПЧ ESQ',
  profile: '',
  region: '',
  star: false,
  allowed: true,
  ...changes,
});
test('industry aliases do not infer ambiguous energy or unknown industry', () => {
  assert.equal(normalizeIndustry('Энергетика'), null);
  assert.equal(normalizeIndustry('Неизвестно'), null);
  assert.equal(normalizeIndustry('ДГУ')?.id, 'oem');
  assert.equal(normalizeIndustry('ОПК')?.id, 'defense');
});
test('reference parser requires unique tagged objects and explicit permission', () => {
  const record = entry('example', 'oem');
  const markdown = '```reference\n' + JSON.stringify(record) + '\n```';
  assert.deepEqual(parseReferenceCatalog(markdown), [record]);
  assert.throws(() => parseReferenceCatalog(markdown + '\n' + markdown));
  assert.throws(() =>
    parseReferenceCatalog(
      '```reference\n' + JSON.stringify({ ...record, allowed: undefined }) + '\n```',
    ),
  );
  assert.deepEqual(parseReferenceCatalog('- Untagged prose'), []);
});
test('main industry wins over stars outside industry; adjacent only when fewer than two main', () => {
  const catalog = [
    entry('a', 'oem'),
    entry('b', 'oem'),
    entry('c', 'oem'),
    entry('d', 'switchboards', { star: true }),
    entry('e', 'mining', { star: true }),
  ];
  assert.deepEqual(
    selectReferences(catalog, 'Машиностроение/OEM').selected.map((x) => x.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    selectReferences(catalog.slice(2), 'Машиностроение/OEM').selected.map((x) => x.id),
    ['c', 'd'],
  );
  assert.deepEqual(
    selectReferences(catalog.slice(3), 'Машиностроение/OEM').selected.map((x) => x.id),
    ['d'],
  );
});
test('profile specificity precedes star and history only diversifies equals', () => {
  const catalog = [
    entry('a', 'oem', { star: true }),
    entry('b', 'oem', { profile: 'вентиляция' }),
    entry('c', 'oem', { profile: 'вентиляция' }),
    entry('d', 'oem', { profile: 'вентиляция' }),
  ];
  const result = selectReferences(catalog, 'oem', { profile: 'вентиляция', recentIds: ['b'] });
  assert.deepEqual(
    result.selected.map((x) => x.id),
    ['c', 'd', 'b'],
  );
});
test('short industry and equipment abbreviations count as precise profile matches', () => {
  const catalog = [
    entry('generic', 'oem', { star: true, facts: 'ВЛК ESQ' }),
    entry('diesel', 'oem', { profile: 'ДГУ ДЭС', facts: 'ВЛК ESQ' }),
    entry('drive', 'oem', { facts: 'ПЧ ESQ' }),
  ];
  assert.equal(selectReferences(catalog, 'oem', { profile: 'ДГУ' }).selected[0]?.id, 'diesel');
  assert.equal(selectReferences(catalog, 'oem', { profile: 'ДЭС' }).selected[0]?.id, 'diesel');
  assert.equal(selectReferences(catalog, 'oem', { equipment: 'ПЧ' }).selected[0]?.id, 'drive');
});
test('generic equipment words do not outrank a starred relevant group object', () => {
  const catalog = [
    entry('star', 'oem', { star: true }),
    entry('gas', 'oem', { profile: 'нефтегазовое оборудование' }),
  ];
  assert.equal(
    selectReferences(catalog, 'oem', { profile: 'холодильное оборудование' }).selected[0]?.id,
    'star',
  );
});
test('unpermitted defense and prohibited products are never selected', () => {
  const catalog = [
    entry('secret', 'defense', { allowed: false }),
    entry('ups', 'defense', { facts: 'ИБП' }),
    entry('allowed', 'defense'),
    entry('other', 'oem'),
  ];
  assert.deepEqual(
    selectReferences(catalog, 'defense').selected.map((x) => x.id),
    ['allowed', 'other'],
  );
  assert.equal(selectReferences(catalog, 'unknown').group, null);
  assert.equal(selectReferences([], 'defense').group?.id, 'defense');
});
test('rendering uses only trusted facts and shortening preserves first main object', () => {
  const selected = [entry('a', 'oem'), entry('b', 'oem'), entry('c', 'switchboards')].map(
    (x, i) => ({ ...x, adjacent: i === 2 }),
  );
  assert.deepEqual(
    shortenReferences(selected).map((x) => x.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    shortenReferences(shortenReferences(selected)).map((x) => x.id),
    ['a'],
  );
  assert.equal(renderReferences([]), neutralReferences);
  assert.match(renderReferences(selected), /^Продукция ESQ уже применяется на объектах a — /);
  assert.equal(shortenReferences([selected[0]!]).length, 1);
});
test('glossary expansion meets normal paragraph size without adding projects or quantities', () => {
  const selected = [
    entry('alpha', 'oem', { name: 'ООО «Промышленное оборудование»', facts: 'ВЛК, ПЧ, УПП, БМЗ' }),
    entry('beta', 'oem', { name: 'ООО «Машиностроительный завод»', facts: 'ВЛК, ПЧ, УПП, ЭВН' }),
  ].map((value) => ({ ...value, adjacent: false }));
  const text = renderReferences(selected);
  assert.ok(text.length >= 330 && text.length <= 420, `${text.length}: ${text}`);
  assert.match(text, /частотные преобразователи/);
  assert.match(text, /Промышленное оборудование/);
  assert.match(text, /Машиностроительный завод/);
});
test('length selection removes only whole last objects and rendering does not hide selected IDs', () => {
  const catalog = [
    entry('first', 'oem', { facts: 'Коммутационное оборудование ESQ '.repeat(5) }),
    entry('second', 'oem', { facts: 'Комплектное оборудование ESQ '.repeat(5) }),
    entry('third', 'oem', { facts: 'Комплектное оборудование ESQ '.repeat(5) }),
  ];
  const result = selectReferences(catalog, 'oem');
  assert.equal(result.selected[0]?.id, 'first');
  assert.ok(renderReferences(result.selected).length <= 420);
  for (const selected of result.selected)
    assert.ok(renderReferences(result.selected).includes(selected.name));
});
test('production catalog is tagged, individual, permission-safe and bounded for every industry', () => {
  const catalog = parseReferenceCatalog(readFileSync('assets/esq/REFERENCES_ESQ.md', 'utf8'));
  assert.ok(catalog.length > 150);
  assert.ok(catalog.filter((value) => value.group === 'defense').every((value) => !value.allowed));
  for (const group of industryGroups) {
    const { selected } = selectReferences(catalog, group.id);
    assert.ok(selected.length <= 3);
    assert.ok(renderReferences(selected).length <= 420, group.id);
    assert.ok(selected.filter((value) => value.adjacent).length <= 1);
    for (const item of selected) assert.ok(item.allowed);
  }
  assert.equal(catalog.find((value) => value.name.includes('Альфа Балт'))?.group, 'oem');
  assert.equal(catalog.find((value) => value.name.includes('Салаватстекло'))?.group, 'materials');
  assert.equal(catalog.find((value) => value.name.includes('Вертикаль'))?.group, 'commercial');
});
test('real profile selection prioritizes gold, refrigeration, ventilation and diesel generators', () => {
  const catalog = parseReferenceCatalog(readFileSync('assets/esq/REFERENCES_ESQ.md', 'utf8'));
  const names = (industry: string, profile: string) =>
    selectReferences(catalog, industry, { profile, equipment: profile })
      .selected.map((x) => x.name)
      .join(' ');
  assert.match(names('mining', 'золотодобыча'), /Тарынская/);
  assert.doesNotMatch(names('mining', 'золотодобыча'), /Амур Минералс/);
  assert.match(
    selectReferences(catalog, 'oem', { profile: 'холодильное оборудование' }).selected[0]!.name,
    /Газхолодтехника/,
  );
  assert.match(names('oem', 'вентиляция'), /ВЕЗА/);
  assert.match(names('oem', 'ДЭС'), /Альфа Балт/);
  assert.match(names('oem', 'ДЭС'), /НГ-Энерго/);
});
