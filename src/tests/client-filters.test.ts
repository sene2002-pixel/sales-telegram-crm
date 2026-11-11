import test from 'node:test';
import assert from 'node:assert/strict';
import { Company, companySchema } from '../shared/contracts';
import { ClientScore, displayedClientPotential } from '../shared/analytics';
import { ClientSort, compareClients, matchesClientFilters } from '../shared/client-filters';
const company = (id: string, data: Record<string, unknown> = {}): Company => ({
  ...companySchema.parse({ name: id, ...data }),
  id,
  ownerId: 'owner',
  ownerName: 'Owner',
  version: 1,
  createdAt: '2026-11-01T12:00:00Z',
  updatedAt: '2026-11-01T12:00:00Z',
});
const score = (id: string, level: ClientScore['level'], value: number): ClientScore => ({
  id,
  level,
  score: value,
  base: { task: false, contacts: false, potential: false, meeting: false, project: false },
  regularity: { task: false, meeting: false, project: false },
});

test('client filter groups are OR internally and AND together, including zero equipment', () => {
  const c = company('c', { city: 'Москва', segment: 'oem', divisions: { lv: 0 } });
  assert.equal(matchesClientFilters(c, '', [], []), true);
  assert.equal(matchesClientFilters(c, 'Москва', ['oem', 'end_client'], ['mv', 'lv']), true);
  assert.equal(matchesClientFilters(c, 'Казань', ['oem'], ['lv']), false);
  assert.equal(matchesClientFilters(c, '', ['end_client'], ['lv']), false);
  assert.equal(matchesClientFilters(c, '', ['oem'], ['mv']), false);
});

test('all seven client sorts are deterministic and preserve unknown values at the end', () => {
  const a = company('a', { name: 'ООО «Янтарь»', potential: 0 });
  const b = {
    ...company('b', { name: 'АО «Альфа»', potential: 10 }),
    updatedAt: '2026-11-02T12:00:00Z',
  };
  const c = company('c', { name: 'Бета', potential: null });
  const items = [c, a, b];
  const scores = { a: score('a', 'ours', 8), b: score('b', 'development', 5) };
  const ordered = (sort: ClientSort) =>
    [...items].sort((x, y) => compareClients(x, y, sort, scores, items)).map((item) => item.id);
  assert.deepEqual(ordered('name'), ['b', 'c', 'a']);
  assert.deepEqual(ordered('potential'), ['b', 'a', 'c']);
  assert.deepEqual(ordered('potentialAsc'), ['a', 'b', 'c']);
  assert.deepEqual(ordered('updated'), ['b', 'c', 'a']);
  assert.deepEqual(ordered('updatedAsc'), ['c', 'a', 'b']);
  assert.deepEqual(ordered('processed'), ['a', 'b', 'c']);
  assert.deepEqual(ordered('processedAsc'), ['b', 'a', 'c']);
  const tie = company('0', { name: 'Янтарь' });
  assert.ok(compareClients(tie, a, 'name', {}, items) < 0);
});

test('processed order uses the API level first and score within it, never manual company stage', () => {
  const a = company('a', { stage: 'new' });
  const b = company('b', { stage: 'closed' });
  const c = company('c');
  const scores = {
    a: score('a', 'ours', 1),
    b: score('b', 'development', 8),
    c: score('c', 'development', 3),
  };
  const rows = [c, b, a];
  assert.deepEqual(
    [...rows].sort((x, y) => compareClients(x, y, 'processed', scores, rows)).map((c) => c.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    [...rows].sort((x, y) => compareClients(x, y, 'processedAsc', scores, rows)).map((c) => c.id),
    ['c', 'b', 'a'],
  );
});

test('holding sorting and displayed potential share only the supplied visible members', () => {
  const holdingId = '11111111-1111-4111-8111-111111111111';
  const holding = company(holdingId, { segment: 'holding', potential: 999 });
  const first = company('first', { holdingId, potential: 2 });
  const second = company('second', { holdingId, potential: null, divisions: { lv: 3 } });
  const archived = company('archived', { holdingId, potential: 100, archived: true });
  const other = company('other', { potential: 6 });
  assert.equal(displayedClientPotential(holding, [first, second]), 5);
  assert.ok(
    compareClients(holding, other, 'potential', {}, [holding, first, second, archived, other]) > 0,
  );
  assert.equal(displayedClientPotential(holding, [first]), 2);
  assert.ok(
    compareClients(holding, other, 'potential', {}, [holding, first, other]) > 0,
    'narrowed member list does not include children outside that scope',
  );
  assert.equal(
    displayedClientPotential(holding, []),
    999,
    'an explicitly empty visible member list keeps the company’s own declared potential rather than reading hidden children',
  );
  assert.equal(
    displayedClientPotential(second),
    null,
    'ordinary card unknown potential stays unknown rather than inventing a displayed total',
  );
});
