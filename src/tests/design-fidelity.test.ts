import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
  Actor,
  companySchema,
  projectSchema,
  primarySegments,
  primaryDivisions,
  equipmentKeys,
} from '../shared/contracts';
import { emptySales, emptyDeal, salesUpdateSchema } from '../shared/sales';
import {
  previousRange,
  summarizeAnalytics,
  HistoricalCompany,
  CompanyEvent,
} from '../shared/analytics';
import { createApp, Services } from '../server/http/app';
import { makeConfig } from '../server/config';

let dir: string, app: any, db: any, s: Services;
let admin: Actor, manager: Actor, supervisor: Actor, foreign: Actor;
const botToken = 'synthetic-design-fidelity-bot-token';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pico-fidelity-tests-'));
  const built = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      WORKER_ENABLED: 'false',
      DATA_DIR: dir,
      DATABASE_URL: '',
      BOT_TOKEN: botToken,
      OPENAI_API_KEY: '',
      SESSION_SECRET: 'local-design-test-secret-at-least-32-characters',
    }),
  );
  app = built.app;
  db = built.db;
  s = built.services;
  admin = (await s.auth.dev('admin', '127.0.0.1')).user;
  manager = (await s.auth.dev('manager', '127.0.0.1')).user;
  supervisor = (await s.auth.dev('supervisor', '127.0.0.1')).user;
  await db.query('UPDATE users SET telegram_id=$2 WHERE id=$1', [admin.id, '910001']);
  admin.telegramId = '910001';
  foreign = {
    id: randomUUID(),
    telegramId: '910002',
    name: 'Чужой менеджер',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    foreign.id,
    foreign.telegramId,
    foreign.name,
    foreign.role,
  ]);
});
after(async () => {
  await app?.close();
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
function api(actor: Actor, method: 'get' | 'post', path: string, data?: object) {
  const r = request(app.getHttpServer())
    [method]('/api' + path)
    .set('Authorization', `Bearer ${s.auth.issue(actor)}`);
  return data ? r.send(data) : r;
}
function signedUser(id: number, name: string) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: name }),
  });
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const source = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  params.set('hash', createHmac('sha256', secret).update(source).digest('hex'));
  return params.toString();
}

test('fidelity taxonomy persists eight categories, seven directions and distinct legacy drives', async () => {
  assert.equal(primarySegments.length, 8);
  assert.equal(primaryDivisions.length, 7);
  for (const segment of primarySegments)
    assert.equal(companySchema.parse({ name: 'Компания', segment }).segment, segment);
  const values = { drives: 100, drives_lv: 200, drives_mv: 300 };
  const company = await s.crm.create(manager, {
    name: 'Три независимых направления',
    segment: 'general_contractor',
    divisions: values,
  });
  assert.deepEqual((await s.crm.detail(manager, company.id)).company.divisions, values);
  const equipment = equipmentKeys.map((division, index) => ({
    division,
    name: `Оборудование ${division}`,
    amount: index === 0 ? null : index * 100,
  }));
  const project = await s.crm.createRecord(manager, company.id, 'project', {
    name: 'Все типы оборудования',
    equipment,
  });
  assert.deepEqual(project.data.equipment, equipment);
  assert.equal(project.data.amount, null);
  assert.equal(
    projectSchema.safeParse({
      name: 'A',
      equipment: [{ division: 'unknown', name: 'A', amount: 1 }],
    }).success,
    false,
  );
  const sales = emptySales();
  sales.client.segment = { value: 'commercial', certainty: 'confirmed' };
  sales.annualPotential = ['drives_lv', 'drives_mv', 'cells'].map((direction) => ({
    direction: direction as any,
    amount: { value: 1, certainty: 'confirmed' },
    equipment: null,
    vendor: null,
  }));
  assert.deepEqual(
    salesUpdateSchema.parse(sales).annualPotential.map((p) => p.direction),
    ['drives_lv', 'drives_mv', 'cells'],
  );
});

test('ID-only admission requires admin, rejects duplicates and cannot reactivate or demote an existing user', async () => {
  await request(app.getHttpServer())
    .post('/api/users/admit')
    .send({ telegramId: '920001' })
    .expect(401);
  for (const actor of [manager, supervisor])
    await api(actor, 'post', '/users/admit', { telegramId: '920001' }).expect(403);
  for (const telegramId of ['0', '-1', 'abc', '1.5', '12345678901234567', '9999999999999999'])
    await api(admin, 'post', '/users/admit', { telegramId }).expect(400);
  await api(admin, 'post', '/users/admit', { telegramId: '920001', role: 'admin' }).expect(400);
  const added = await api(admin, 'post', '/users/admit', { telegramId: '920001' }).expect(201);
  assert.equal(added.body.name, 'Telegram ID 920001');
  assert.equal(added.body.role, 'manager');
  assert.equal(added.body.active, true);
  const concurrent = await Promise.allSettled([
    s.auth.admitUser(admin, { telegramId: '920002' }),
    s.auth.admitUser(admin, { telegramId: '920002' }),
  ]);
  assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = concurrent.find((r) => r.status === 'rejected');
  assert.equal(rejected?.status === 'rejected' && rejected.reason.status, 409);
  await api(admin, 'post', '/users/admit', { telegramId: admin.telegramId }).expect(409);
  await db.query('UPDATE users SET active=false WHERE id=$1', [added.body.id]);
  await api(admin, 'post', '/users/admit', { telegramId: '920001' }).expect(409);
  const [blocked] = await db.query('SELECT active,role FROM users WHERE id=$1', [added.body.id]);
  assert.equal(blocked.active, false);
  assert.equal(blocked.role, 'manager');
  await api(admin, 'post', '/users', {
    telegramId: admin.telegramId,
    name: admin.name,
    role: 'manager',
    active: true,
  }).expect(409);
  assert.equal((await s.auth.authenticate(s.auth.issue(admin))).role, 'admin');
});

test('signed Telegram profile replaces only admission placeholder and rejects an unsigned name change', async () => {
  await api(admin, 'post', '/users/admit', { telegramId: '920003' }).expect(201);
  const signed = signedUser(920003, 'Иван');
  await request(app.getHttpServer())
    .post('/api/auth/telegram')
    .send({ initData: signed.replace('hash=', 'hash=00') })
    .expect(401);
  assert.equal((await s.auth.byTelegram('920003')).name, 'Telegram ID 920003');
  const login = await request(app.getHttpServer())
    .post('/api/auth/telegram')
    .send({ initData: signed })
    .expect(201);
  assert.equal(login.body.user.name, 'Иван');
  await s.auth.saveUser(admin, {
    telegramId: '920003',
    name: 'Имя администратора',
    role: 'manager',
    active: true,
  });
  const again = await request(app.getHttpServer())
    .post('/api/auth/telegram')
    .send({ initData: signedUser(920003, 'Другой профиль') })
    .expect(201);
  assert.equal(again.body.user.name, 'Имя администратора');
});

test('analytics reconstructs true period end states and previous comparisons without inventing missing history', () => {
  assert.deepEqual(previousRange('2026-03-01', '2026-03-31'), {
    previousFrom: '2026-01-29',
    previousTo: '2026-02-28',
  });
  const companies: HistoricalCompany[] = [],
    events: CompanyEvent[] = [];
  const add = (id: string, created: string, stage: 'new' | 'closed') => {
    const data = companySchema.parse({ name: id, stage });
    companies.push({
      id,
      data,
      created_at: created + 'T12:00:00Z',
      updated_at: created + 'T12:00:00Z',
    });
    events.push({
      company_id: id,
      action: 'company.created',
      details: { after: data },
      created_at: created + 'T12:00:00Z',
    });
    return data;
  };
  const before = add('a', '2026-01-10', 'new');
  add('b', '2026-01-20', 'closed');
  add('c', '2026-02-10', 'new');
  add('d', '2026-02-11', 'closed');
  const after = { ...before, stage: 'closed' as const };
  companies[0]!.data = after;
  companies[0]!.updated_at = '2026-02-15T12:00:00Z';
  events.push({
    company_id: 'a',
    action: 'company.updated',
    details: { before, after },
    created_at: '2026-02-15T12:00:00Z',
  });
  const result = summarizeAnalytics(
    companies,
    events,
    '2026-02-01',
    '2026-02-28',
    'Europe/Moscow',
    new Date('2026-03-05T12:00:00Z'),
  );
  assert.equal(result.activeClients, 4);
  assert.equal(result.activeDelta, 100);
  assert.equal(result.conversion, 50);
  assert.equal(result.conversionDelta, 0);
  assert.equal(result.historyIncomplete, 0);
  assert.equal(result.funnel.find((v) => v.key === 'closed')?.count, 1);
  const unknown = summarizeAnalytics(
    [{ ...companies[0]!, updated_at: '2026-03-05T12:00:00Z' }],
    [],
    '2026-02-01',
    '2026-02-28',
    'Europe/Moscow',
    new Date('2026-03-05T12:00:00Z'),
  );
  assert.equal(unknown.activeDelta, null);
  assert.equal(unknown.conversionDelta, null);
  assert.ok(unknown.historyIncomplete > 0);
  const empty = summarizeAnalytics([], [], '2026-02-01', '2026-02-28', 'Europe/Moscow');
  assert.equal(empty.conversion, null);
  assert.equal(empty.activeDelta, null);
});

test('analytics endpoint validates ranges and scopes managers to their own companies', async () => {
  const own = await s.crm.create(manager, { name: 'Своя аналитика' });
  const theirs = await s.crm.create(foreign, { name: 'Чужая аналитика' });
  assert.notEqual(own.id, theirs.id);
  const day = new Date().toISOString().slice(0, 10),
    path = `/analytics?from=${day}&to=${day}`;
  await request(app.getHttpServer())
    .get('/api' + path)
    .expect(401);
  const mine = await api(manager, 'get', path).expect(200),
    other = await api(foreign, 'get', path).expect(200),
    leader = await api(supervisor, 'get', path).expect(200);
  assert.equal(other.body.activeClients, 1);
  assert.ok(mine.body.activeClients >= 1);
  assert.ok(leader.body.activeClients >= mine.body.activeClients + other.body.activeClients);
  await api(manager, 'get', '/analytics?from=2026-02-30&to=2026-03-01').expect(400);
  await api(manager, 'get', '/analytics?from=2026-03-02&to=2026-03-01').expect(400);
  await api(manager, 'get', '/analytics?from=2000-01-01&to=2026-01-01').expect(400);
});

test('task advice uses confirmed scoped facts, excludes assumptions and avoids ambiguous project advice', async () => {
  const company = await s.crm.create(manager, { name: 'Подсказки по фактам' });
  const project = await s.crm.createRecord(manager, company.id, 'project', { name: 'Проект А' });
  const task = await s.crm.createRecord(
    manager,
    company.id,
    'task',
    { text: 'Созвон' },
    project.id,
  );
  const sales = emptySales(),
    deal = emptyDeal('Проект А');
  deal.nextStep = { value: 'Подтвердить спецификацию', certainty: 'assumption' };
  sales.deals = [deal];
  sales.agreements.nextStep = { value: 'Неподтверждённая договорённость', certainty: 'assumption' };
  await s.crm.createRecord(manager, company.id, 'activity', {
    text: 'Предположения',
    occurredOn: '2026-10-12',
    sales,
  });
  const uncertain = await api(manager, 'get', `/tasks/${task.id}/advice`).expect(200);
  assert.equal(uncertain.body.source, 'guidance');
  assert.doesNotMatch(uncertain.body.text, /спецификацию|Неподтверждённая/);
  deal.nextStep = { value: 'Подтвердить спецификацию', certainty: 'confirmed' };
  deal.blocker = { value: 'Нет бюджета', certainty: 'assumption' };
  await s.crm.createRecord(manager, company.id, 'activity', {
    text: 'Подтверждение',
    occurredOn: '2026-10-13',
    sales,
  });
  const confirmed = await api(manager, 'get', `/tasks/${task.id}/advice`).expect(200);
  assert.equal(confirmed.body.source, 'confirmed_sales');
  assert.match(confirmed.body.text, /Подтвердить спецификацию/);
  assert.doesNotMatch(confirmed.body.text, /Нет бюджета/);
  await api(foreign, 'get', `/tasks/${task.id}/advice`).expect(404);
  await request(app.getHttpServer()).get(`/api/tasks/${task.id}/advice`).expect(401);
  const second = emptyDeal('Проект Б');
  second.nextStep = { value: 'Другой шаг', certainty: 'confirmed' };
  sales.deals = [second];
  await s.crm.createRecord(manager, company.id, 'activity', {
    text: 'Второй проект',
    occurredOn: '2026-10-14',
    sales,
  });
  const genericTask = await s.crm.createRecord(manager, company.id, 'task', {
    text: 'Без проекта',
  });
  const ambiguous = await api(manager, 'get', `/tasks/${genericTask.id}/advice`).expect(200);
  assert.equal(ambiguous.body.source, 'guidance');
});
