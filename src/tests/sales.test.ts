import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { z } from 'zod';
import {
  confirmed,
  dealScore,
  emptyDeal,
  emptySales,
  normalizeSales,
  projectSales,
  salesQuestions,
  salesUpdateSchema,
  SalesUpdate,
  Fact,
  resolveDealKey,
} from '../shared/sales';
import { extractionSchema, activitySchema, Extraction } from '../shared/contracts';
import { dialogueActionSchema } from '../server/services/dialogue-plan';
import { makeConfig } from '../server/config';
import { createApp } from '../server/http/app';
import { CommercialReportService } from '../server/services/commercial-report';

const fact = <T>(value: T): Fact<T> => ({ value, certainty: 'confirmed' });
function sales(name = 'Проект А', amount: number | null = 6_000_000): SalesUpdate {
  const s = emptySales(),
    d = emptyDeal(name);
  d.direction = 'lv';
  d.amount = amount === null ? null : fact(amount);
  s.deals = [d];
  return s;
}
function event(id: string, s: SalesUpdate, day = '2026-10-01') {
  return { id, occurredOn: day, createdAt: `${day}T12:00:00Z`, sales: s };
}
function extraction(s: SalesUpdate, name = 'Компания А'): Extraction {
  return {
    warnings: [],
    blocks: [
      {
        companyName: name,
        inn: null,
        city: null,
        segment: null,
        stage: null,
        potential: null,
        divisions: [],
        summary: 'Обсудили проект',
        occurredOn: '2026-10-01',
        contacts: [],
        tasks: [],
        sales: s,
      },
    ],
  };
}

test('SALES-01 strict schema, legacy compatibility and valid dates', () => {
  assert.equal(
    activitySchema.parse({ text: 'Старый отчёт', occurredOn: '2026-10-01' }).sales,
    null,
  );
  assert.equal(
    dialogueActionSchema.parse({
      kind: 'activity_create',
      company: { mode: 'named', name: 'А', inn: '', city: '' },
      text: 'Встреча',
      occurredOn: '2026-10-01',
    }).kind,
    'activity_create',
  );
  assert.throws(() => salesUpdateSchema.parse({ ...emptySales(), score: 6 }));
  const s = sales();
  s.deals[0]!.due = fact('2026-02-30');
  assert.throws(() => salesUpdateSchema.parse(s));
  const city=emptySales();city.client.city=fact('x'.repeat(151));assert.throws(()=>salesUpdateSchema.parse(city));
  const check = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
    Object.values(node).forEach((v) => {
      if (Array.isArray(v)) v.forEach(check);
      else check(v);
    });
  };
  check(z.toJSONSchema(extractionSchema, { target: 'draft-7' }));
});
test('SALES-02 six confirmed points; direct decision maker is one joint point', () => {
  const d = emptyDeal('А');
  assert.equal(dealScore(d).score, 0);
  d.equipment = fact('Выключатели');
  d.budget = fact(true);
  d.decisionMaker = fact('Иван, главный инженер');
  d.directAccess = fact(false);
  d.criteria = fact('Надёжность');
  d.approvalConditions = fact('Аудит');
  d.quoteSent = fact(true);
  assert.equal(dealScore(d).score, 5);
  d.directAccess = fact(true);
  assert.equal(dealScore(d).score, 6);
  d.budget = { value: true, certainty: 'assumption' };
  assert.equal(dealScore(d).score, 5);
  d.quoteSent = fact(false);
  d.competitorQuoteReceived = fact(true);
  assert.equal(dealScore(d).score, 4);
});
test('SALES-03 question boundaries, suppression and global limit', () => {
  assert.equal(salesQuestions(sales('А', null)).length, 1);
  for (const n of [0, 999999]) assert.equal(salesQuestions(sales('А', n)).length, 0);
  for (const n of [1000000, 5000000]) {
    const q = salesQuestions(sales('А', n));
    assert.equal(q.length, 3);
    assert.ok(q.every((v) => !v.includes('ЛПР') && !v.includes('конкурентное предложение')));
  }
  const s = sales();
  assert.equal(salesQuestions(s).length, 3);
  s.deferred = true;
  assert.deepEqual(salesQuestions(s), []);
  s.deferred = false;
  for (const status of ['unassigned', 'no_potential'] as const) {
    s.client.disposition = { status, on: '2026-10-01', reason: 'Менеджер сообщил' };
    assert.deepEqual(salesQuestions(s), []);
  }
  s.client.disposition = null;
  s.unknownAnswers = true;
  assert.match(salesQuestions(s)[0]!, /следующем созвоне/);
});
test('SALES-04 projection retains confirmed facts, false revokes score, assumptions/null do not erase', () => {
  const first = sales();
  first.deals[0]!.budget = fact(true);
  first.deals[0]!.equipment = fact('Выключатели');
  const update = sales();
  update.deals[0]!.amount = { value: null, certainty: 'confirmed' };
  update.deals[0]!.budget = { value: false, certainty: 'assumption' };
  let p = projectSales([event('1', first), event('2', update, '2026-10-02')]);
  assert.equal(confirmed(p.current.deals[0]!.amount), 6000000);
  assert.equal(confirmed(p.current.deals[0]!.budget), true);
  update.deals[0]!.budget = fact(false);
  p = projectSales([event('1', first), event('2', update, '2026-10-02')]);
  assert.equal(confirmed(p.current.deals[0]!.budget), false);
  assert.equal(dealScore(p.current.deals[0]!).score, 1);
  assert.equal(first.deals[0]!.budget!.value, true);
});
test('SALES-05 project identity: missing/new customer, multiple projects and ambiguity', () => {
  const a = sales();
  a.deals[0]!.equipment = fact('Выключатели');
  const b = sales();
  b.deals[0]!.endCustomer = 'Заказчик';
  b.deals[0]!.budget = fact(true);
  let p = projectSales([
    event('1', a),
    event('2', b, '2026-10-02'),
    event('3', sales(), '2026-10-03'),
  ]);
  assert.equal(p.deals.length, 1);
  assert.equal(dealScore(p.deals[0]!.deal).score, 2);
  const other = sales('Проект Б');
  p = projectSales([event('1', a), event('2', other)]);
  assert.equal(p.deals.length, 2);
  assert.equal(dealScore(p.deals[1]!.deal).score, 0);
  const c = sales();
  c.deals[0]!.endCustomer = 'Другой заказчик';
  p = projectSales([event('1', b), event('2', c), event('3', a, '2026-10-03')]);
  assert.equal(p.deals.length, 3);
  assert.equal(dealScore(p.deals[2]!.deal).score, 1);
  assert.equal(p.eventKeys['1']![0], p.deals[0]!.key);
  assert.equal(p.eventKeys['2']![0], p.deals[1]!.key);
  assert.equal(p.eventKeys['3']![0], p.deals[2]!.key);
  const unnamed = sales();
  unnamed.deals[0]!.name = null;
  assert.equal(projectSales([event('1', unnamed), event('2', unnamed)]).deals.length, 2);
});
test('SALES-06 sparse vendors and block-specific restrictions', () => {
  const a = sales(),
    b = sales();
  a.deals[0]!.competitor = fact('ABB');
  b.deals[0]!.direction = null;
  b.deals[0]!.competitor = fact('CHINT');
  assert.equal(
    confirmed(projectSales([event('1', a), event('2', b, '2026-10-02')]).deals[0]!.deal.competitor),
    'CHINT',
  );
  b.deals[0]!.direction = 'heat';
  b.annualPotential = [{ direction: 'heat', equipment: null, amount: null, vendor: fact('X') }];
  b.additionalNeeds = [
    {
      direction: 'heat',
      description: 'Нагреватели',
      amount: null,
      vendor: fact('X'),
      on: '2026-10-01',
    },
  ];
  const normalized = normalizeSales(b);
  assert.equal(normalized.deals[0]!.competitor, null);
  assert.equal(normalized.annualPotential[0]!.vendor, null);
  assert.equal(confirmed(normalized.additionalNeeds[0]!.vendor), 'X');
});
test('SALES-07 known CRM data suppresses questions and missing deadlines are requested', () => {
  const a = sales('А', 2000000);
  a.deals[0]!.due = fact('2026-11-01');
  a.deals[0]!.alternatives = fact('ABB');
  a.deals[0]!.offerPosition = fact('В топе');
  const b = sales('А', null);
  const p = projectSales([event('1', a), event('2', b, '2026-10-02')]);
  assert.deepEqual(salesQuestions(p.current), []);
  const s = sales();
  const d = s.deals[0]!;
  d.equipment = fact('Выключатели');
  d.budget = fact(true);
  d.decisionMaker = fact('Иван');
  d.directAccess = fact(true);
  d.introduction = fact('Напрямую');
  d.criteria = fact('Надёжность');
  d.approvalConditions = fact('Аудит');
  d.quoteSent = fact(true);
  d.competitorQuoteReceived = fact(false);
  d.nextStep = fact('Созвон');
  assert.ok(salesQuestions(s).some((q) => q.includes('в какой срок')));
  s.agreements.nextStep = fact('Созвон');
  s.agreements.due = fact('2026-10-10');
  d.nextStep = null;
  assert.ok(
    !salesQuestions(projectSales([event('1', s)]).current).some((q) => q.includes('следующий шаг')),
  );
});
test('SALES-10 next steps stay scoped to the original project', () => {
  const a = sales('А');
  a.agreements.nextStep = fact('Отправить КП для А');
  a.agreements.due = fact('2026-10-10');
  const b = sales('Б');
  const p = projectSales([event('1', a), event('2', b, '2026-10-02')]);
  assert.equal(confirmed(p.deals[0]!.deal.nextStep), 'Отправить КП для А');
  assert.equal(p.deals[1]!.deal.nextStep, null);
  const next=sales('А');next.agreements.nextStep=fact('Получить конкурентное предложение');next.agreements.due=fact('2026-10-12');
  const updated=projectSales([event('1',a),event('2',next,'2026-10-02')]);
  assert.equal(confirmed(updated.deals[0]!.deal.nextStep),'Получить конкурентное предложение');
  assert.equal(confirmed(updated.deals[0]!.deal.nextDue),'2026-10-12');
});
test('SALES-11 report preserves historical identity, result-only updates and independent amounts', async () => {
  const a = sales('Одинаковый', 2000000);
  a.deals[0]!.endCustomer = 'А';
  a.deals[0]!.volume = fact('in_work');
  const b = sales('Одинаковый', 3000000);
  b.deals[0]!.endCustomer = 'Б';
  b.deals[0]!.volume = fact('potential');
  const unknown = sales('Одинаковый', 5000000);
  unknown.deals[0]!.volume = fact('in_work');
  const result = emptySales();
  result.results = [
    {
      dealName: 'Одинаковый',
      endCustomer: 'А',
      verb: 'shipped',
      detail: 'Выключатели',
      amount: fact(1000000),
      approximate: false,
      volume: fact('confirmed'),
    },
  ];
  const rows = [
    event('1', a),
    event('2', b, '2026-10-02'),
    event('3', unknown, '2026-10-03'),
    event('4', result, '2026-10-04'),
  ].map((e) => ({
    id: e.id,
    company_id: 'company',
    author_id: 'author',
    created_at: e.createdAt,
    company_data: { name: 'Клиент' },
    data: { occurredOn: e.occurredOn, sales: e.sales },
  }));
  const db = {
    query: async (_q: string, args: string[]) => rows.filter((r) => r.data.occurredOn <= args[0]!),
  } as any;
  const service = new CommercialReportService(db);
  const actor = {
    id: randomUUID(),
    name: 'Руководитель',
    role: 'supervisor' as const,
    telegramId: 'test',
    active: true,
  };
  const all = await service.generate(actor, '2026-10-01', '2026-10-04');
  assert.equal(all.totals.in_work, 2000000);
  assert.equal(all.totals.potential, 3000000);
  assert.equal(all.resultTotals.confirmed, 1000000);
  assert.match(all.text, /не включён в общие суммы/);
  const onlyResult = await service.generate(actor, '2026-10-04', '2026-10-04');
  assert.equal(onlyResult.totals.in_work, 2000000);
  assert.equal(onlyResult.totals.potential, 0);
  assert.equal(onlyResult.resultTotals.confirmed, 1000000);
  assert.match(onlyResult.text, /Одинаковый: Отгрузили/);
});

test('SALES-08 integration: confirm/history/ACL/commercial period and no duplicate volume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-sales-'));
  const config = makeConfig({
    NODE_ENV: 'test',
    DEV_AUTH: 'true',
    WORKER_ENABLED: 'false',
    DATA_DIR: dir,
    SESSION_SECRET: 'local-sales-tests-only-32-characters',
  });
  const { app, services: s, db } = await createApp(config);
  try {
    const manager = await s.auth.dev('manager', '127.0.0.1'),
      admin = await s.auth.dev('admin', '127.0.0.1');
    const c = await s.crm.create(manager.user, { name: 'Компания А', potential: 99 });
    const data = sales();
    data.deals[0]!.volume = fact('in_work');
    data.deals[0]!.approximate = fact(true);
    data.deals[0]!.equipment = fact('Выключатели');
    data.results = [
      {
        dealName: 'Проект А',
        endCustomer: null,
        verb: 'recalculated',
        detail: 'КП на выключатели',
        amount: fact(6000000),
        approximate: true,
        volume: fact('in_work'),
      },
    ];
    async function apply(update: SalesUpdate, day = '2026-10-01', targetCompany=c) {
      const draft = extraction(update,targetCompany.name);
      draft.blocks[0]!.occurredOn = day;
      const r = await s.reports.enqueue(manager.user, {
        text: 'Сообщение',
        sourceKey: randomUUID(),
      });
      await db.query("UPDATE reports SET status='review',draft=$2 WHERE id=$1", [
        r.id,
        JSON.stringify(draft),
      ]);
      const input = { version: 1, draft, companyIds: [targetCompany.id] };
      await s.reports.confirm(manager.user, r.id, input);
      await s.reports.confirm(manager.user, r.id, input);
      return r;
    }
    const r = await apply(data);
    const lifecycleCompany=await s.crm.create(manager.user,{name:'Клиент с историей'});
    const currentClient=sales();currentClient.client.city=fact('Казань');currentClient.client.segment=fact('design_institute');
    await apply(currentClient,'2026-08-04',lifecycleCompany);
    const backdated=sales();backdated.client.city=fact('Москва');backdated.client.segment=fact('oem');
    await apply(backdated,'2026-08-03',lifecycleCompany);
    assert.equal((await s.crm.company(manager.user,lifecycleCompany.id)).city,'Казань');assert.equal((await s.crm.company(manager.user,lifecycleCompany.id)).segment,'design_institute');
    assert.equal((await s.crm.salesHistory(manager.user, c.id)).length, 1);
    assert.equal((await s.crm.company(manager.user, c.id)).potential, 99);
    const legacy = await s.crm.createRecord(manager.user, c.id, 'project', {
      name: 'Старый проект',
      amount: 2000000,
      due: '2026-11-01',
    });
    const legacyUpdate = sales('Старый проект', null);
    const known = await s.crm.salesPreview(
      manager.user,
      c.id,
      legacyUpdate,
      'legacy',
      '2026-10-01',
    );
    assert.equal(confirmed(known.current.deals[0]!.amount), 2000000);
    assert.ok(!salesQuestions(known.current).some((q) => q.includes('планируется реализация')));
    assert.equal((await s.crm.salesHistory(manager.user, c.id)).length, 1);
    const partial = sales('Проект А', null);
    partial.deals[0]!.budget = fact(true);
    partial.deals[0]!.direction = null;
    partial.deals[0]!.endCustomer = 'Заказчик';
    await apply(partial, '2026-10-02');
    const history = await s.crm.salesHistory(manager.user, c.id);
    assert.equal(history.length, 2);
    assert.equal(projectSales(history).deals.length, 1);
    assert.equal(dealScore(projectSales(history).deals[0]!.deal).score, 2);
    assert.equal(
      (await s.crm.detail(manager.user, c.id)).records.filter((v) => v.kind === 'activity')[0]!.data
        .reportId !== undefined,
      true,
    );
    const service = new CommercialReportService(db);
    const commercial = await service.generate(admin.user, '2026-10-01', '2026-10-02');
    assert.equal(commercial.totals.in_work, 6000000);
    assert.equal(commercial.totals.confirmed, 0);
    assert.equal(commercial.approximate.in_work, true);
    assert.match(commercial.text, /Проект А: Пересчитали/);
    assert.match(commercial.text, /около/);
    assert.deepEqual((await service.generate(admin.user, '2026-09-01', '2026-09-30')).clients, []);
    await assert.rejects(
      service.generate(manager.user, '2026-10-01', '2026-10-02'),
      /руководителю/,
    );
    await request(app.getHttpServer())
      .get('/api/dashboard/commercial?from=2026-10-01&to=2026-10-02')
      .set('Authorization', `Bearer ${manager.token}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/dashboard/commercial?from=2026-10-01&to=2026-10-02')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/dashboard/commercial?from=2026-10-03&to=2026-10-02')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(400);
    await assert.rejects(
      s.crm.salesHistory({ ...manager.user, id: randomUUID() }, c.id),
      /не найдена/,
    );
    const feedback = await s.reports.feedback(manager.user, extraction(partial));
    assert.doesNotMatch(feedback, /какая примерно сумма/);
    const defer = sales();
    defer.client.disposition = {
      status: 'unassigned',
      on: '2026-10-03',
      reason: 'Откреплён по просьбе менеджера',
    };
    await apply(defer, '2026-10-03');
    assert.equal(
      (await service.generate(admin.user, '2026-10-01', '2026-10-03')).clients.length,
      0,
    );
    assert.equal(
      (await service.generate(admin.user, '2026-10-01', '2026-10-02')).clients.length,
      1,
    );
    const stored = await s.reports.get(manager.user, r.id);
    assert.equal(stored.status, 'saved');
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SALES-09 Telegram preview and confirmation use identical facts without auto-followup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-sales-dialogue-'));
  const config = makeConfig({
    NODE_ENV: 'test',
    DEV_AUTH: 'true',
    WORKER_ENABLED: 'false',
    DATA_DIR: dir,
    SESSION_SECRET: 'local-sales-tests-only-32-characters',
  });
  const { app, services: s, db } = await createApp(config);
  try {
    const { user: actor } = await s.auth.dev('manager', '127.0.0.1');
    const c = await s.crm.create(actor, { name: 'Компания А' });
    const data = sales();
    (s.letters as any).structured = async () => ({
      mode: 'append',
      actions: [
        {
          kind: 'activity_create',
          company: { mode: 'named', name: c.name, inn: '', city: '' },
          text: 'Обсудили проект на 6 млн',
          occurredOn: '2026-10-01',
          sales: data,
        },
      ],
      discussedCompany: null,
      reply: '',
    });
    const dialogue = s.dialogue;
    const report = await s.reports.enqueue(actor, {
      sourceKey: randomUUID(),
      text: 'Созвонились',
      purpose: 'dialogue',
      chatId: actor.telegramId,
    });
    const lease = randomUUID();
    await db.query("UPDATE reports SET status='processing',lease_token=$2 WHERE id=$1", [
      report.id,
      lease,
    ]);
    await dialogue.process(
      { ...report, author_id: actor.id, created_at: '2026-10-01T12:00:00Z' },
      lease,
      'Созвонились',
    );
    const [action] = await db.query('SELECT * FROM dialogue_actions WHERE report_id=$1', [
      report.id,
    ]);
    assert.equal(action.status, 'ready');
    assert.equal((await s.crm.salesHistory(actor, c.id)).length, 0);
    const notifications = await db.query('SELECT payload FROM outbox WHERE chat_id=$1', [
      actor.telegramId,
    ]);
    assert.ok(notifications.some((v) => v.payload.text?.includes('сделка оценивается на 0 из 6')));
    await dialogue.callback(actor, action.id, 'confirm', action.preview_version);
    assert.equal((await s.crm.salesHistory(actor, c.id)).length, 1);
    assert.equal(
      (await s.crm.salesHistory(actor, c.id))[0]!.sales.deals[0]!.amount!.value,
      6000000,
    );
    const [r] = await db.query('SELECT result FROM reports WHERE id=$1', [report.id]);
    assert.equal(r.result.salesQuestionsUsed, 3);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
