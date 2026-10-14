import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companySchema, defaultAnalyticsSettings } from '../shared/contracts';
import {
  summarizeClientAnalytics,
  companyPotential,
  compareMetric,
  HistoricalCompany,
  AnalyticsRecord,
  AnalyticsEvent,
} from '../shared/analytics';
const now = new Date('2026-03-31T12:00:00Z');
const company = (id = 'c', potential: number | null = null): HistoricalCompany => ({
  id,
  data: companySchema.parse({ name: id, potential }),
  created_at: '2025-01-01T12:00:00Z',
  updated_at: '2025-01-01T12:00:00Z',
});
const record = (
  id: string,
  kind: string,
  data: any,
  date = '2026-03-30',
  source = 'unknown',
  companyId = 'c',
): AnalyticsRecord => ({
  id,
  kind,
  data,
  company_id: companyId,
  contact_source: source,
  created_at: date + 'T12:00:00Z',
  version: 1,
  deleted: false,
});
const calculate = (
  companies: HistoricalCompany[],
  records: AnalyticsRecord[],
  events: AnalyticsEvent[] = [],
  mode: 'all' | 'range' = 'all',
) =>
  summarizeClientAnalytics(
    companies,
    records,
    events,
    '2026-03-01',
    '2026-03-31',
    'Europe/Moscow',
    defaultAnalyticsSettings,
    mode,
    now,
  );
function changed(
  companyId: string,
  day: string,
  before: any,
  after: any,
  action = 'company.updated',
): AnalyticsEvent {
  return {
    company_id: companyId,
    entity_id: companyId,
    created_at: day + 'T12:00:00Z',
    action,
    details: { before, after },
  };
}

test('client eight points distinguish user contacts, explicit zero, completed meetings and project membership from deal score/stage', () => {
  const c = company();
  c.data.divisions.lv = 0;
  const rows = [
    record('task', 'task', { type: 'meeting', done: true }),
    record('a', 'contact', {}, undefined, 'user'),
    record('b', 'contact', {}, undefined, 'user'),
    record('bot', 'contact', {}, undefined, 'bot'),
    record('legacy', 'contact', {}, undefined, 'unknown'),
    record('p', 'project', { amount: 0, participants: [] }),
  ];
  const result = calculate([c], rows);
  assert.equal(result.clients[0]!.score, 8);
  assert.equal(result.clients[0]!.level, 'ours');
  assert.equal(c.data.stage, 'new');
  assert.equal(result.contactSourcesUnknown, 1);
  assert.equal(result.metrics.potential.value, 0);
  assert.equal(result.metrics.potential.companies, 1);
  rows[0]!.data.done = false;
  assert.equal(calculate([c], rows).clients[0]!.score, 6);
  rows[1]!.contact_source = 'bot';
  assert.equal(calculate([c], rows).clients[0]!.base.contacts, false);
  const untouched = calculate([company()], [record('onlyBot', 'contact', {}, undefined, 'bot')]);
  assert.equal(untouched.clients[0]!.score, 0);
  assert.equal(untouched.clientFunnel[0]!.count, 1);
});

test('regularity uses creation dates, one record and clamped calendar months, not completion date', () => {
  const rows = [
    record('t', 'task', { done: false }, '2026-03-17'),
    record('m', 'task', { type: 'meeting', done: true, completedAt: '2026-03-31' }, '2025-12-31'),
    record('p', 'project', { amount: 0 }, '2026-02-28'),
  ];
  const score = calculate([company()], rows).clients[0]!;
  assert.deepEqual(score.regularity, { task: true, meeting: true, project: true });
  rows[0]!.created_at = '2026-03-16T12:00:00Z';
  rows[1]!.created_at = '2025-12-30T12:00:00Z';
  rows[2]!.created_at = '2026-02-27T12:00:00Z';
  assert.deepEqual(calculate([company()], rows).clients[0]!.regularity, {
    task: false,
    meeting: false,
    project: false,
  });
  rows[1]!.data.done = false;
  assert.equal(calculate([company()], rows).clients[0]!.base.meeting, false);
  const future = record('future', 'task', { type: 'meeting', done: true }, '2026-04-01');
  assert.equal(calculate([company()], [future]).clients[0]!.base.task, false);
});

test('participant project qualifies a selected client only from supplied ACL-visible records without duplicates', () => {
  const p = record(
    'p',
    'project',
    { amount: 20, participants: [{ companyId: 'c' }, { companyId: 'c' }] },
    undefined,
    'unknown',
    'other',
  );
  const result = calculate([company()], [p]);
  assert.equal(result.clients[0]!.base.project, true);
  assert.equal(result.metrics.projects.count, 1);
  assert.equal(result.metrics.projects.value, 20);
  assert.equal(result.metrics.active.value, 1);
  assert.equal(calculate([company()], []).clients[0]!.base.project, false);
});

test('potential period sums every positive confirmed increment, not net change or division redistribution', () => {
  const c = company('c', 100);
  const a = { ...c.data, potential: 50 },
    b = { ...c.data, potential: 80 },
    d = { ...c.data, potential: 60 };
  const events = [
    changed('c', '2026-03-02', a, b),
    changed('c', '2026-03-03', b, d),
    changed('c', '2026-03-04', d, b),
    changed('c', '2026-03-05', b, { ...b, divisions: { lv: 40, mv: 40 } }),
    {
      company_id: 'c',
      entity_id: 'report',
      action: 'report.applied',
      created_at: '2026-03-06T12:00:00Z',
      details: { before: b, block: { potential: 100, stage: null, divisions: [] } },
    },
  ];
  assert.equal(calculate([c], [], events, 'range').metrics.potential.value, 70);
  assert.equal(companyPotential({ ...c.data, potential: 50, divisions: { lv: 90, mv: 10 } }), 50);
  assert.equal(
    companyPotential({ ...c.data, potential: null, divisions: { lv: 90, mv: 10 } }),
    100,
  );
  assert.equal(companyPotential({ ...c.data, potential: null, divisions: {} }), null);
  assert.deepEqual(c.data.divisions, {});
});

test('period projects include only created-in-period records with their end-state amounts; unknown is not zero', () => {
  const old = record('old', 'project', { amount: 100 }, '2026-02-15');
  const recent = record('recent', 'project', { amount: 20 }, '2026-03-02');
  const equipment = record(
    'eq',
    'project',
    { amount: null, equipment: [{ amount: 10 }] },
    '2026-03-03',
  );
  const result = calculate([company()], [old, recent, equipment], [], 'range');
  assert.equal(result.metrics.projects.value, 30);
  assert.equal(result.metrics.projects.count, 2);
  equipment.data.equipment.push({ amount: null });
  assert.equal(
    calculate([company()], [old, recent, equipment], [], 'range').metrics.projects.value,
    null,
  );
  assert.equal(calculate([company()], [old, recent], [], 'all').metrics.projects.value, 120);
});

test('historical level growth and activity derive from records, not manual stage, potential edits or archive', () => {
  const c = company();
  const r = record('t', 'task', { done: false }, '2026-03-15');
  const ev: AnalyticsEvent = {
    company_id: 'c',
    entity_id: 't',
    action: 'task.created',
    created_at: r.created_at,
    details: { recordAfter: { data: r.data, deleted: false, contactSource: 'unknown' } },
  };
  const result = calculate([c], [r], [ev], 'range');
  assert.equal(result.metrics.growth.value, 1);
  assert.equal(result.metrics.growth.share, 100);
  assert.equal(result.metrics.active.value, 1);
  const updated = changed('c', '2026-03-15', c.data, { ...c.data, potential: 10, stage: 'closed' });
  assert.equal(calculate([c], [], [updated], 'range').metrics.active.value, 0);
  const samePeriod = summarizeClientAnalytics(
    [c],
    [r],
    [ev],
    '2026-03-01',
    '2026-03-31',
    'Europe/Moscow',
    { ...defaultAnalyticsSettings, taskDays: 365 },
    'range',
    now,
  );
  assert.equal(samePeriod.metrics.growth.value, 1);
});

test('missing historical snapshots and unknown contact provenance remain distinct; comparisons never fabricate zero', () => {
  const c = company('c', 20);
  c.updated_at = '2026-03-30T12:00:00Z';
  const result = calculate([c], [record('unknown', 'contact', {}, '2026-03-20')], [], 'range');
  assert.ok(result.historyIncomplete > 0);
  assert.equal(result.contactSourcesUnknown, 1);
  assert.equal(result.metrics.potential.value, null);
  assert.equal(result.metrics.potential.delta.kind, 'unavailable');
  assert.equal(result.metrics.growth.value, null);
  assert.deepEqual(compareMetric(10, 20), { kind: 'percent', percent: -50, tone: 'negative' });
  assert.deepEqual(compareMetric(100.5, 100), { kind: 'percent', percent: 0, tone: 'neutral' });
  assert.deepEqual(compareMetric(5, 0), { kind: 'new', percent: null, tone: 'neutral' });
  assert.equal(compareMetric(0, 0).kind, 'none');
  assert.equal(compareMetric(null, 0).kind, 'unavailable');
  assert.equal(compareMetric(5, 10, true).kind, 'none');
});

test('same-day future creation and completion are excluded; future period end clamps the comparison to as-of', () => {
  const future = record('future', 'task', { type: 'meeting', done: true }, '2026-03-31');
  future.created_at = '2026-03-31T18:00:00Z';
  const futureEvent: AnalyticsEvent = {
    company_id: 'c',
    entity_id: 'future',
    action: 'task.created',
    created_at: future.created_at,
    details: { recordAfter: { data: future.data, deleted: false, contactSource: 'unknown' } },
  };
  const r = calculate([company()], [future], [futureEvent]);
  assert.equal(r.clients[0]!.score, 0);
  assert.equal(r.metrics.active.value, 0);
  const old = record('old', 'task', { type: 'meeting', done: true }, '2026-03-01');
  old.version = 2;
  const completed: AnalyticsEvent = {
    company_id: 'c',
    entity_id: 'old',
    action: 'task.updated',
    created_at: '2026-03-31T18:00:00Z',
    details: {
      recordBefore: {
        data: { type: 'meeting', done: false },
        deleted: false,
        contactSource: 'unknown',
      },
      recordAfter: { data: old.data, deleted: false, contactSource: 'unknown' },
    },
  };
  assert.equal(calculate([company()], [old], [completed]).clients[0]!.base.meeting, false);
  const current = summarizeClientAnalytics(
    [company()],
    [],
    [],
    '2026-03-01',
    '2026-04-15',
    'Europe/Moscow',
    defaultAnalyticsSettings,
    'range',
    now,
  );
  assert.equal(current.asOf, '2026-03-31');
  assert.deepEqual(current.metrics, calculate([company()], [], [], 'range').metrics);
});

test('historical record changes in one timestamp use server record versions, not random audit-ID order', () => {
  const r = record('meeting', 'task', { type: 'meeting', done: true }, '2026-03-02');
  r.version = 2;
  const date = '2026-03-02T12:00:00Z';
  const birth: AnalyticsEvent = {
    company_id: 'c',
    entity_id: r.id,
    action: 'task.created',
    created_at: date,
    details: {
      recordVersion: 1,
      recordAfter: { data: { type: 'meeting', done: false }, deleted: false },
    },
  };
  const update: AnalyticsEvent = {
    company_id: 'c',
    entity_id: r.id,
    action: 'task.updated',
    created_at: date,
    details: {
      recordVersion: 2,
      recordBefore: birth.details.recordAfter,
      recordAfter: { data: r.data, deleted: false },
    },
  };
  const result = summarizeClientAnalytics(
    [company()],
    [r],
    [update, birth],
    '2026-03-01',
    '2026-03-03',
    'Europe/Moscow',
    defaultAnalyticsSettings,
    'range',
    now,
  );
  assert.equal(result.clients[0]!.base.meeting, true);
});

test('fresh proven sequence preserves projected company state and avoids counting one report increase twice; ambiguous legacy order is unavailable', () => {
  const c = company('c', 80);
  c.updated_at = '2026-03-02T12:00:00Z';
  const before = { ...c.data, potential: 50, city: '' },
    projected = { ...c.data, potential: 80, city: 'Томск' };
  const projection = {
    ...changed('c', '2026-03-02', before, projected, 'company.sales_updated'),
    entity_id: 'activity',
    analytics_seq: 1,
    analytics_order_proven: true,
  };
  const applied: AnalyticsEvent = {
    ...changed('c', '2026-03-02', before, projected, 'report.applied'),
    entity_id: 'report',
    analytics_seq: 2,
    analytics_order_proven: true,
    details: {
      before,
      analyticsBefore: projected,
      after: projected,
      block: { potential: null, stage: null, divisions: [] },
    },
  };
  const summarize = (events: AnalyticsEvent[]) =>
    summarizeClientAnalytics(
      [c],
      [],
      events,
      '2026-03-01',
      '2026-03-03',
      'Europe/Moscow',
      defaultAnalyticsSettings,
      'range',
      now,
    );
  const fresh = summarize([applied, projection]);
  assert.equal(fresh.metrics.potential.value, 30);
  assert.equal(fresh.historyIncomplete, 0);
  const legacy = summarize([
    {
      ...applied,
      analytics_order_proven: false,
      details: { before, block: { potential: null, stage: null, divisions: [] } },
    },
    { ...projection, analytics_order_proven: false },
  ]);
  assert.equal(legacy.metrics.potential.value, null);
  assert.ok(legacy.historyIncomplete > 0);
});

test('unproven legacy record changes sharing a timestamp do not manufacture a historical held meeting', () => {
  const r = record('legacyMeeting', 'task', { type: 'meeting', done: true }, '2026-03-02');
  r.version = 2;
  const event: AnalyticsEvent = {
    company_id: 'c',
    entity_id: r.id,
    action: 'task.updated',
    created_at: r.created_at,
    details: { before: { type: 'meeting', done: false }, after: r.data },
  };
  const result = summarizeClientAnalytics(
    [company()],
    [r],
    [event, { ...event, action: 'task.created', details: {} }],
    '2026-03-01',
    '2026-03-03',
    'Europe/Moscow',
    defaultAnalyticsSettings,
    'range',
    now,
  );
  assert.ok(result.historyIncomplete > 0);
  assert.equal(result.clients[0]!.base.meeting, false);
  assert.equal(result.metrics.growth.value, null);
});

test('unknown project state is an unavailable financial total in all mode, while unknown contact history does not hide proven projects', () => {
  const p = record('unknownProject', 'project', { amount: 100 }, '2026-03-01');
  p.version = 2;
  const future: AnalyticsEvent = {
    company_id: 'c',
    entity_id: p.id,
    action: 'project.updated',
    created_at: '2026-03-31T18:00:00Z',
    details: {},
  };
  const result = calculate([company()], [p], [future], 'all');
  assert.equal(result.metrics.projects.value, null);
  assert.ok(result.historyIncomplete > 0);
  const known = record('knownProject', 'project', { amount: 25 }, '2026-03-01');
  const contact = record('unknownContact', 'contact', {}, '2026-02-01');
  contact.version = 2;
  const historical = summarizeClientAnalytics(
    [company()],
    [known, contact],
    [],
    '2026-03-01',
    '2026-03-03',
    'Europe/Moscow',
    defaultAnalyticsSettings,
    'range',
    now,
  );
  assert.ok(historical.historyIncomplete > 0);
  assert.equal(historical.metrics.projects.value, 25);
});

test('project participant activity follows proven action snapshots even after removal, without exposing foreign clients', () => {
  const project = record(
    'participantProject',
    'project',
    { amount: 20, participants: [] },
    '2026-02-01',
    'unknown',
    'other',
  );
  project.version = 3;
  const before = {
    amount: 20,
    participants: [
      { companyId: 'c', role: 'Заказчик' },
      { companyId: 'foreign', role: 'Подрядчик' },
    ],
  };
  const action: AnalyticsEvent = {
    company_id: 'other',
    entity_id: project.id,
    action: 'project.updated',
    created_at: '2026-03-10T12:00:00Z',
    analytics_order_proven: true,
    analytics_seq: 1,
    details: {
      recordVersion: 2,
      recordBefore: { data: before, deleted: false },
      recordAfter: { data: before, deleted: false },
    },
  };
  const removed: AnalyticsEvent = {
    ...action,
    created_at: '2026-03-20T12:00:00Z',
    analytics_seq: 2,
    details: {
      recordVersion: 3,
      recordBefore: { data: before, deleted: false },
      recordAfter: { data: project.data, deleted: false },
    },
  };
  const result = calculate([company()], [project], [action, removed], 'range');
  assert.equal(result.clients[0]!.base.project, false);
  assert.equal(result.metrics.active.value, 1);
  assert.deepEqual(
    result.clients.map((client) => client.id),
    ['c'],
  );
  assert.ok(!JSON.stringify(result).includes('foreign'));
});
