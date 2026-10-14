import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor, companySchema, defaultAnalyticsSettings } from '../shared/contracts';
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-analytics-settings-'));
  const {
    app,
    services: s,
    db,
  } = await createApp(
    makeConfig({
      DATA_DIR: dir,
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      WORKER_ENABLED: 'false',
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
    }),
  );
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const admin = await s.auth.dev('admin', '127.0.0.1'),
    manager = await s.auth.dev('manager', '127.0.0.1'),
    supervisor = await s.auth.dev('supervisor', '127.0.0.1');
  return { app, s, db, admin, manager, supervisor };
}
test('analytics settings are revisioned, bounded, repeatably migrated and require a fresh active administrator', async (t) => {
  const f = await fixture(t);
  const http = f.app.getHttpServer();
  assert.deepEqual(await f.s.dashboard.analyticsSettings(f.manager.user), defaultAnalyticsSettings);
  for (const actor of [f.manager, f.supervisor])
    await request(http)
      .put('/api/analytics/settings')
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ ...defaultAnalyticsSettings, updatedAt: undefined })
      .expect(403);
  await request(http)
    .put('/api/analytics/settings')
    .set('Authorization', `Bearer ${f.admin.token}`)
    .send({ revision: 1, taskDays: 0, meetingMonths: 3, projectMonths: 1 })
    .expect(400);
  await request(http)
    .put('/api/analytics/settings')
    .set('Authorization', `Bearer ${f.admin.token}`)
    .send({ revision: 1, taskDays: 14, meetingMonths: 3, projectMonths: 1, role: 'admin' })
    .expect(400);
  const saved = await f.s.dashboard.updateAnalyticsSettings(f.admin.user, {
    revision: 1,
    taskDays: 21,
    meetingMonths: 4,
    projectMonths: 2,
  });
  assert.equal(saved.revision, 2);
  assert.equal(saved.taskDays, 21);
  assert.ok(saved.updatedAt);
  await assert.rejects(
    f.s.dashboard.updateAnalyticsSettings(f.admin.user, {
      revision: 1,
      taskDays: 14,
      meetingMonths: 3,
      projectMonths: 1,
    }),
    /Настройки изменены/,
  );
  await f.db.migrate();
  assert.deepEqual(await f.s.dashboard.analyticsSettings(f.manager.user), saved);
  assert.equal(
    (await f.db.query("SELECT * FROM audit WHERE action='analytics.settings_updated'")).length,
    1,
  );
  await f.db.query("UPDATE users SET role='manager' WHERE id=$1", [f.admin.user.id]);
  await assert.rejects(
    f.s.dashboard.updateAnalyticsSettings(f.admin.user, {
      revision: 2,
      taskDays: 14,
      meetingMonths: 3,
      projectMonths: 1,
    }),
    /администратору/,
  );
  await f.db.query('UPDATE users SET active=false WHERE id=$1', [f.manager.user.id]);
  await assert.rejects(f.s.dashboard.analyticsSettings(f.manager.user), /Доступ изменён/);
  await assert.rejects(
    f.s.dashboard.analytics(f.manager.user, '2026-01-01', '2026-12-31'),
    /Доступ изменён/,
  );
});

test('contact provenance is server-owned, defaults user for confirmed input, preserves edits and leaves old unknown contacts out of score', async (t) => {
  const f = await fixture(t),
    c = await f.s.crm.create(f.manager.user, { name: 'Источники контактов', potential: 0 });
  const user = await f.s.crm.createRecord(f.manager.user, c.id, 'contact', {
    name: 'Первый',
    role: 'Инженер',
  });
  const user2 = await f.s.crm.createRecord(f.manager.user, c.id, 'contact', {
    name: 'Второй',
    role: 'Инженер',
  });
  const bot = await f.s.crm.createRecord(
    f.manager.user,
    c.id,
    'contact',
    { name: 'Найденный', role: 'Директор' },
    null,
    undefined,
    { contactSource: 'bot' },
  );
  const legacyId = randomUUID();
  await f.db.query(
    "INSERT INTO records(id,kind,company_id,author_id,data) VALUES($1,'contact',$2,$3,$4)",
    [legacyId, c.id, f.manager.user.id, JSON.stringify({ name: 'Старый', role: 'Инженер' })],
  );
  assert.equal(user.contactSource, 'user');
  assert.equal(bot.contactSource, 'bot');
  const updated = await f.s.crm.updateRecord(f.manager.user, bot.id, {
    version: bot.version,
    data: { ...bot.data, name: 'Исправленный' },
  });
  assert.equal(updated.contactSource, 'bot');
  await request(f.app.getHttpServer())
    .post(`/api/companies/${c.id}/records/contact`)
    .set('Authorization', `Bearer ${f.manager.token}`)
    .send({ data: { name: 'Подделка', contactSource: 'user' } })
    .expect(400);
  await assert.rejects(
    f.s.crm.updateRecord(f.manager.user, bot.id, {
      version: updated.version,
      data: { ...updated.data, contactSource: 'user' },
    }),
  );
  let analytics = await f.s.dashboard.analytics(
    f.manager.user,
    '2026-01-01',
    '2026-12-31',
    undefined,
    'all',
  );
  assert.equal(analytics.clientAnalytics!.clients[0]!.base.contacts, true);
  assert.equal(analytics.clientAnalytics!.contactSourcesUnknown, 1);
  await f.s.crm.deleteContact(f.manager.user, user2.id);
  analytics = await f.s.dashboard.analytics(
    f.manager.user,
    '2026-01-01',
    '2026-12-31',
    undefined,
    'all',
  );
  assert.equal(analytics.clientAnalytics!.clients[0]!.base.contacts, false);
  const [createdAudit] = await f.db.query(
    "SELECT details FROM audit WHERE action='contact.created' AND entity_id=$1",
    [user.id],
  );
  assert.equal(createdAudit.details.recordAfter.contactSource, 'user');
  const [editedAudit] = await f.db.query(
    "SELECT details FROM audit WHERE action='contact.updated' AND entity_id=$1",
    [bot.id],
  );
  assert.equal(editedAudit.details.recordAfter.contactSource, 'bot');
});

test('computed analytics preserves owner scope, employee permissions and visible participant projects without exposing foreign companies', async (t) => {
  const f = await fixture(t);
  const foreign: Actor = {
    id: randomUUID(),
    telegramId: '998877',
    name: 'Другой',
    role: 'manager',
    active: true,
  };
  await f.db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    foreign.id,
    foreign.telegramId,
    foreign.name,
    foreign.role,
  ]);
  const own = await f.s.crm.create(f.manager.user, { name: 'Свой клиент' }),
    other = await f.s.crm.create(foreign, { name: 'Чужой клиент' });
  await f.s.crm.createRecord(f.admin.user, other.id, 'project', {
    name: 'Видимый админу',
    amount: 100,
    participants: [{ companyId: own.id, role: 'Заказчик' }],
  });
  const manager = await f.s.dashboard.analytics(
    f.manager.user,
    '2026-01-01',
    '2026-12-31',
    undefined,
    'all',
  );
  assert.equal(manager.clientAnalytics!.clients.length, 1);
  assert.equal(manager.clientAnalytics!.clients[0]!.base.project, false);
  const admin = await f.s.dashboard.analytics(
    f.admin.user,
    '2026-01-01',
    '2026-12-31',
    f.manager.user.id,
    'all',
  );
  assert.deepEqual(
    admin.clientAnalytics!.clients.map((c) => c.id),
    [own.id],
  );
  assert.equal(admin.clientAnalytics!.clients[0]!.base.project, true);
  assert.equal(admin.clientAnalytics!.metrics.projects.value, 100);
  assert.ok(!JSON.stringify(admin.clientAnalytics).includes('Чужой клиент'));
  await assert.rejects(
    f.s.dashboard.analytics(f.manager.user, '2026-01-01', '2026-12-31', foreign.id, 'all'),
    /недоступен/,
  );
  await assert.rejects(
    f.s.dashboard.analytics(f.manager.user, '2026-01-01', '2026-12-31', undefined, ['all']),
  );
  await f.db.query("UPDATE users SET role='manager' WHERE id=$1", [f.admin.user.id]);
  await assert.rejects(
    f.s.dashboard.analytics(f.admin.user, '2026-01-01', '2026-12-31', undefined, 'all'),
    /Доступ изменён/,
  );
});

test('real report application records exact before/after with proven sequence and does not infer CRM totals from sales potential', async (t) => {
  const f = await fixture(t),
    c = await f.s.crm.create(f.manager.user, { name: 'Отчёт и потенциал', potential: 50 });
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
  await f.db.query('UPDATE companies SET created_at=$2,updated_at=$2 WHERE id=$1', [c.id, oldDate]);
  await f.db.query(
    "UPDATE audit SET created_at=$2 WHERE company_id=$1 AND action='company.created'",
    [c.id, oldDate],
  );
  const { emptySales } = await import('../shared/sales');
  async function apply(key: string, potential: number | null, annual: number) {
    const sales = emptySales();
    sales.client.city = { value: 'Томск', certainty: 'confirmed' };
    sales.annualPotential = [
      {
        direction: 'lv',
        equipment: null,
        amount: { value: annual, certainty: 'confirmed' },
        vendor: null,
      },
    ];
    const draft = {
      warnings: [],
      blocks: [
        {
          companyName: c.name,
          inn: null,
          city: null,
          segment: null,
          stage: null,
          potential,
          divisions: [],
          summary: 'Подтверждённый итог',
          occurredOn: today,
          contacts: [],
          tasks: [],
          sales,
        },
      ],
    };
    const report = await f.s.reports.enqueue(f.manager.user, { sourceKey: key, text: 'Отчёт' });
    await f.db.query("UPDATE reports SET status='review',draft=$2 WHERE id=$1", [
      report.id,
      JSON.stringify(draft),
    ]);
    await f.s.reports.confirm(f.manager.user, report.id, {
      version: report.version,
      draft,
      companyIds: [c.id],
    });
    return report.id;
  }
  const first = await apply('analytics-report-null', null, 80);
  const [a] = await f.db.query(
    "SELECT details,analytics_seq,analytics_order_proven FROM audit WHERE entity_id=$1 AND action='report.applied'",
    [first],
  );
  assert.equal(a.details.analyticsBefore.city, 'Томск');
  assert.equal(a.details.after.city, 'Томск');
  assert.equal(a.details.after.potential, 50);
  assert.equal(a.details.afterVersion, a.details.beforeVersion + 1);
  assert.equal(a.analytics_order_proven, true);
  await apply('analytics-report-primary', 80, 100);
  const result = await f.s.dashboard.analytics(f.manager.user, today, today, undefined, 'range');
  assert.equal(result.clientAnalytics!.metrics.potential.value, 30);
  assert.equal((await f.s.crm.company(f.manager.user, c.id)).potential, 80);
  assert.equal(result.clientAnalytics!.historyIncomplete, 0);
  const [projection] = await f.db.query(
    "SELECT analytics_seq FROM audit WHERE company_id=$1 AND action='company.sales_updated'",
    [c.id],
  );
  assert.ok(Number(projection.analytics_seq) < Number(a.analytics_seq));
});

test('company detail HTTP exposes the original audit fields without global analytical ordering and preserves foreign-company denial', async (t) => {
  const f = await fixture(t);
  const own = await f.s.crm.create(f.manager.user, { name: 'Публичная история QA' });
  await f.s.crm.createRecord(f.manager.user, own.id, 'task', {
    text: 'Сохранённая история',
    type: 'call',
  });
  const foreign: Actor = {
    id: randomUUID(),
    telegramId: '887744551',
    name: 'Чужой владелец QA',
    role: 'manager',
    active: true,
  };
  await f.db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    foreign.id,
    foreign.telegramId,
    foreign.name,
    foreign.role,
  ]);
  const other = await f.s.crm.create(foreign, { name: 'Чужая история QA' });
  const [internal] = await f.db.query(
    'SELECT analytics_seq,analytics_order_proven FROM audit WHERE company_id=$1 LIMIT 1',
    [own.id],
  );
  assert.ok(Number(internal.analytics_seq) > 0);
  assert.equal(internal.analytics_order_proven, true);
  const response = await request(f.app.getHttpServer())
    .get(`/api/companies/${own.id}`)
    .set('Authorization', `Bearer ${f.manager.token}`)
    .expect(200);
  assert.ok(response.body.audit.length >= 2);
  for (const event of response.body.audit) {
    assert.deepEqual(
      Object.keys(event).sort(),
      [
        'id',
        'actor_id',
        'company_id',
        'action',
        'entity_id',
        'details',
        'created_at',
        'actor_name',
      ].sort(),
    );
    assert.equal(event.company_id, own.id);
    assert.equal(event.actor_id, f.manager.user.id);
    assert.equal(event.actor_name, f.manager.user.name);
  }
  assert.equal(
    response.body.audit.find((event: any) => event.action === 'company.created').details.after.name,
    own.name,
  );
  assert.equal(response.body.records[0].data.text, 'Сохранённая история');
  assert.doesNotMatch(JSON.stringify(response.body), /analytics_seq|analytics_order_proven/);
  await request(f.app.getHttpServer())
    .get(`/api/companies/${other.id}`)
    .set('Authorization', `Bearer ${f.manager.token}`)
    .expect(404);
  const analytical = await request(f.app.getHttpServer())
    .get('/api/analytics?from=2026-01-01&to=2026-12-31&mode=all')
    .set('Authorization', `Bearer ${f.manager.token}`)
    .expect(200);
  assert.doesNotMatch(JSON.stringify(analytical.body), /analytics_seq|analytics_order_proven/);
});
