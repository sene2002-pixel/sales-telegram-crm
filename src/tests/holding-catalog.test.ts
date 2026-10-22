import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHoldingMention, referenceHoldingKey } from '../shared/holding-catalog';
import {
  parseReferenceCatalog,
  selectReferences,
  type ReferenceEntry,
} from '../server/services/reference-catalog';
import { Database } from '../server/infra/database';
import { makeConfig } from '../server/config';
import { CrmService } from '../server/services/crm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '../shared/contracts';

test('confirmed holding catalogue distinguishes groups, legal entities, sites and ambiguity', () => {
  assert.deepEqual(classifyHoldingMention('РМК'), { holdingName: 'РМК', isHolding: true });
  assert.equal(classifyHoldingMention('Русская медная компания').holdingName, 'РМК');
  assert.equal(classifyHoldingMention('ПАО «ТГК-1»').companyName, 'ПАО «ТГК-1»');
  assert.equal(classifyHoldingMention('ТГК-1 — ООО ГЭХ-Закупки').holdingName, 'ТГК-1');
  assert.equal(classifyHoldingMention('был на Карабашмеди, это РМК').companyName, 'Карабашмедь');
  assert.equal(classifyHoldingMention('Евраз — ООО «Пример»').companyName, 'ООО «Пример»');
  assert.equal(classifyHoldingMention('ТГК-1 - Апатитская ТЭЦ').isHolding, true);
  assert.deepEqual(classifyHoldingMention('Апатитская ТЭЦ').sites, ['Апатитская ТЭЦ']);
  const single = classifyHoldingMention('ООО «Альфа» — филиал Кольский');
  assert.equal(single.companyName, 'ООО «Альфа»');
  assert.equal(single.holdingName, undefined);
  assert.equal(classifyHoldingMention('Михеевский ГОК и Карабашмедь').companyName, undefined);
  assert.deepEqual(classifyHoldingMention('Неизвестная компания'), {});
  for (const name of [
    'ООО Энергия, филиал Кольский',
    'ООО Энергия: филиал Кольский',
    'ООО Энергия — филиал Кольский',
  ]) {
    assert.equal(classifyHoldingMention(name).companyName, 'ООО Энергия');
    assert.deepEqual(classifyHoldingMention(name).sites, ['филиал Кольский']);
  }

  for (const unknown of [
    'ООО Сервис Карабашмеди',
    'ООО Поставщик Михеевский ГОК',
    'ООО ТГК-1',
    'Сервис Карабашмеди',
    'был у ООО Сервис Карабашмеди',
    'посетил ООО Поставщик Михеевский ГОК',
  ]) {
    const result = classifyHoldingMention(unknown);
    assert.equal(result.holdingName, undefined, unknown);
    assert.notEqual(result.companyName, 'Карабашмедь', unknown);
  }
});
test('reference selection never picks two confirmed objects of one holding and backfills others', () => {
  const names = [
    'Кыштымский МЭЗ',
    'Михеевский ГОК',
    'Карабашмедь',
    'Независимый завод',
    'ООО «ГЭХ-Закупки»',
  ];
  const catalog: ReferenceEntry[] = names.map((name, i) => ({
    id: `r${i}`,
    name,
    group: 'mining',
    facts: 'ПЧ ESQ',
    profile: '',
    region: '',
    star: false,
    allowed: true,
  }));
  const selected = selectReferences(catalog, 'Горнодобывающая промышленность').selected;
  assert.equal(selected.length, 3);
  assert.deepEqual(
    selected.map((entry) => entry.name),
    [names[0], names[3], names[4]],
  );
});
test('catalogue creates and reuses same-owner groups atomically, keeps sites in owners and manual links', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-catalog-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const a: Actor = {
    id: randomUUID(),
    telegramId: '99111',
    name: 'A',
    role: 'manager',
    active: true,
  };
  const b: Actor = { ...a, id: randomUUID(), telegramId: '99112' };
  for (const actor of [a, b])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.telegramId,
      actor.name,
      actor.role,
    ]);
  const crm = new CrmService(db);
  await assert.rejects(
    crm.create(a, {
      name: 'Inconsistent',
      segment: 'holding',
      potential: 0,
      divisions: { lv: 100 },
    }),
    /совпадать/,
  );
  const legacyId = randomUUID();
  await db.query('INSERT INTO companies(id,owner_id,data) VALUES($1,$2,$3)', [
    legacyId,
    a.id,
    JSON.stringify({
      name: 'Русская медная компания',
      inn: '',
      city: '',
      segment: 'holding',
      industry: '',
      stage: 'new',
      archived: false,
      revenue: null,
      potential: null,
      divisions: {},
      notes: '',
    }),
  ]);
  const group = await crm.create(a, { name: 'РМК' });
  assert.equal(group.id, legacyId);
  assert.equal(group.segment, 'holding');
  assert.equal(group.inn, '');
  const child = await crm.create(a, { name: 'Михеевский ГОК' });
  assert.equal(child.segment, 'end_client');
  assert.equal(child.holdingId, group.id);
  assert.equal((await crm.create(a, { name: 'Михеевский ГОК' })).id, child.id);
  const sameNameOne = await crm.create(a, { name: 'Карабашмедь', inn: '7736050003' });
  const sameNameTwo = await crm.createWithContacts(a, {
    name: 'Карабашмедь',
    inn: '7812014560',
    initialContacts: [{ name: 'Only second entity' }],
  });
  assert.notEqual(sameNameOne.id, sameNameTwo.id);
  assert.equal(sameNameTwo.inn, '7812014560');
  assert.equal((await crm.detail(a, sameNameOne.id)).records.length, 0);
  assert.equal((await crm.detail(a, sameNameTwo.id)).records[0]!.data.name, 'Only second entity');
  const foreignEntity = await crm.create(a, {
    name: 'Карабашмедь',
    country: 'Беларусь',
    segment: 'end_client',
  });
  assert.equal(foreignEntity.segment, 'end_client');
  assert.equal(foreignEntity.holdingId, undefined);
  const domesticEntity = await crm.create(a, {
    name: 'Карабашмедь',
    country: 'Россия',
    segment: 'end_client',
    inn: '7736050003',
  });
  assert.notEqual(domesticEntity.id, foreignEntity.id);
  assert.equal(domesticEntity.holdingId, group.id);
  const foreignFirst = await crm.create(a, {
    name: 'Красноярский завод СК',
    country: 'Беларусь',
    segment: 'end_client',
  });
  assert.equal(foreignFirst.holdingId, undefined);
  assert.ok(!(await crm.list(a)).some((c) => c.segment === 'holding' && c.name === 'СИБУР'));
  const domesticSecond = await crm.create(a, {
    name: 'Красноярский завод СК',
    segment: 'end_client',
  });
  assert.notEqual(domesticSecond.id, foreignFirst.id);
  assert.equal((await crm.company(a, domesticSecond.holdingId!)).name, 'СИБУР');

  const foreign = await crm.create(b, { name: 'РМК' });
  assert.notEqual(foreign.id, group.id);
  const site = await crm.create(a, { name: 'ТГК-1 - Апатитская ТЭЦ' });
  assert.equal(site.segment, 'holding');
  assert.deepEqual(site.sites, ['Апатитская ТЭЦ']);
  await assert.rejects(crm.create(a, { name: 'Апатитская ТЭЦ' }), /юридическое лицо/);
  const single = await crm.create(a, { name: 'ООО «Альфа» — филиал Кольский' });
  assert.equal(single.segment, 'end_client');
  assert.equal(single.holdingId, undefined);
  assert.deepEqual(single.sites, ['филиал Кольский']);
  const base = await crm.create(a, { name: 'ООО Энергия' });
  const commaSite = await crm.create(a, { name: 'ООО Энергия, филиал Кольский' });
  assert.equal(commaSite.id, base.id);
  assert.deepEqual(commaSite.sites, ['филиал Кольский']);

  const manualSiteGroup = await crm.create(a, {
    name: 'Новая группа — филиал Кольский',
    segment: 'holding',
  });
  assert.equal(manualSiteGroup.segment, 'holding');
  assert.equal(manualSiteGroup.name, 'Новая группа');
  assert.deepEqual(manualSiteGroup.sites, ['филиал Кольский']);
  const manual = await crm.create(a, { name: 'Manual', segment: 'holding' });
  await assert.rejects(
    crm.create(a, { name: 'Апатитская ТЭЦ', holdingId: manual.id }),
    /юридическое лицо/,
  );
  const override = await crm.create(a, { name: 'Карабашмедь', holdingId: manual.id });
  assert.equal(override.holdingId, manual.id);
  await assert.rejects(
    crm.create(a, { name: 'РМК', segment: 'holding', inn: '7707083893' }),
    /нет ИНН/,
  );
  const concrete = await crm.create(a, { name: 'РМК', inn: '7707083893' });
  assert.equal(concrete.segment, 'end_client');
  assert.equal(concrete.inn, '7707083893');
  assert.equal(concrete.holdingId, undefined);
  const legal = await crm.create(a, { name: 'ТГК-1', legalForm: 'ПАО', segment: 'end_client' });
  assert.equal(legal.segment, 'end_client');
  assert.equal(legal.name, 'ПАО «ТГК-1»');
  assert.equal(
    (await crm.create(a, { name: legal.name, legalForm: 'ПАО', segment: 'end_client' })).id,
    legal.id,
  );
  assert.equal((await crm.company(a, legal.holdingId!)).name, 'ТГК-1');
  const after = await crm.list(a);
  assert.equal(
    after.filter(
      (c) => c.segment === 'holding' && classifyHoldingMention(c.name).holdingName === 'РМК',
    ).length,
    1,
  );
});

test('dialogue previews confirmed parent before writes and asks for an unknown site owner', async (t) => {
  const { createApp } = await import('../server/http/app');
  const dir = await mkdtemp(join(tmpdir(), 'pico-holding-dialogue-'));
  const { db, services } = await createApp(
    makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }),
  );
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('No external requests');
  });
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '66111',
    name: 'Dialog',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    actor.id,
    actor.telegramId,
    actor.name,
    actor.role,
  ]);
  let checkingDialogue = false;
  const originalTransaction = db.transaction.bind(db);
  t.mock.method(db, 'transaction', async (fn: any) =>
    originalTransaction(async (tx) => {
      let companyLock = false;
      return fn({
        query: async (sql: string, args?: any[]) => {
          if (sql === 'SELECT pg_advisory_xact_lock(7142532)') companyLock = true;
          if (checkingDialogue && /FROM users WHERE id=\$1 FOR UPDATE/.test(sql))
            assert.equal(companyLock, true, 'dialogue must obtain company lock before actor row');
          return tx.query(sql, args);
        },
      });
    }),
  );
  let targetName = 'ТГК-1 — ООО ГЭХ-Закупки';
  services.letters.ai.request = async () => ({
    status: 'completed',
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              mode: 'append',
              discussedCompany: null,
              reply: '',
              actions: [
                {
                  kind: 'company_create',
                  company: { mode: 'named', name: targetName, inn: '', city: '' },
                  data: {
                    city: null,
                    inn: null,
                    industry: null,
                    segment: null,
                    stage: null,
                    potential: null,
                    notes: null,
                  },
                },
              ],
            }),
          },
        ],
      },
    ],
  });
  async function submit() {
    const report = await services.reports.enqueue(actor, {
      sourceKey: randomUUID(),
      text: 'Создай ' + targetName,
      purpose: 'dialogue',
    });
    const token = randomUUID();
    await db.query('UPDATE reports SET lease_token=$1 WHERE id=$2', [token, report.id]);
    const [row] = await db.query('SELECT * FROM reports WHERE id=$1', [report.id]);
    checkingDialogue = true;
    try {
      await services.dialogue.process(row, token, 'Создай ' + targetName);
    } finally {
      checkingDialogue = false;
    }
    const rows = await db.query(
      "SELECT * FROM dialogue_actions WHERE user_id=$1 AND status NOT IN ('done','cancelled') ORDER BY sequence",
      [actor.id],
    );
    return rows.at(-1)!;
  }
  const action = await submit();
  assert.equal(action.status, 'ready');
  assert.equal((await services.crm.list(actor)).length, 0);
  const notices = (
    await db.query('SELECT payload FROM outbox WHERE chat_id=$1', [actor.telegramId])
  )
    .map((row) => row.payload.text)
    .join('\n');
  assert.match(notices, /Холдинг: ТГК-1/);
  await services.dialogue.callback(actor, action.id, 'confirm');
  const companies = await services.crm.list(actor);
  assert.equal(companies.length, 2);
  assert.equal(
    companies.find((c) => c.segment === 'end_client')?.holdingId,
    companies.find((c) => c.segment === 'holding')?.id,
  );
  targetName = 'Апатитская ТЭЦ';
  const site = await submit();
  assert.equal(site.status, 'needs_info');
  assert.match(site.snapshot.question, /юридическому лицу/);
  assert.equal((await services.crm.list(actor)).length, 2);
  await services.dialogue.callback(actor, site.id, 'skip');
  targetName = 'НЛМК';
  services.letters.ai.request = async () => ({
    status: 'completed',
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              mode: 'append',
              discussedCompany: null,
              reply: '',
              actions: [
                {
                  kind: 'company_create',
                  company: { mode: 'named', name: 'НЛМК', inn: '7707083893', city: '' },
                  data: {
                    city: null,
                    inn: '7707083893',
                    industry: null,
                    segment: 'end_client',
                    stage: null,
                    potential: null,
                    notes: null,
                  },
                },
              ],
            }),
          },
        ],
      },
    ],
  });
  const legalAction = await submit();
  assert.equal(legalAction.status, 'ready');
  assert.equal(legalAction.snapshot.data.inn, '7707083893');
  assert.equal(legalAction.snapshot.data.segment, 'end_client');
  await services.dialogue.callback(actor, legalAction.id, 'confirm');
  assert.equal((await services.crm.list(actor)).find((c) => c.name === 'НЛМК')?.inn, '7707083893');
  function proposal(name: string, segment: string, inn = '') {
    targetName = name;
    services.letters.ai.request = async () => ({
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                mode: 'append',
                discussedCompany: null,
                reply: '',
                actions: [
                  {
                    kind: 'company_create',
                    company: { mode: 'named', name, inn, city: '' },
                    data: {
                      city: null,
                      inn: inn || null,
                      industry: null,
                      segment,
                      stage: null,
                      potential: null,
                      notes: null,
                    },
                  },
                ],
              }),
            },
          ],
        },
      ],
    });
  }
  for (const segment of ['contractor', 'integrator', 'design_institute']) {
    proposal(`РМК — ООО Независимый ${segment}`, segment);
    const participant = await submit();
    assert.equal(participant.status, 'ready');
    assert.equal(participant.snapshot.data.segment, segment);
    assert.equal(participant.snapshot.data.holdingId, undefined);
    await services.dialogue.callback(actor, participant.id, 'confirm');
    const company = (await services.crm.list(actor)).find(
      (c) => c.name === `ООО Независимый ${segment}`,
    )!;
    assert.equal(company.segment, segment);
    assert.equal(company.holdingId, undefined);
  }
  proposal('НЛМК', 'holding', '7736050003');
  const contradiction = await submit();
  assert.equal(contradiction.status, 'needs_info');
  assert.match(contradiction.snapshot.question, /У холдинга нет ИНН/);
  assert.equal(contradiction.payload.data.inn, '7736050003');
});

test('approved ESQ catalogue uses the same confirmed ownership and cannot select two SIBUR objects', () => {
  const catalog = parseReferenceCatalog(readFileSync('assets/esq/REFERENCES_ESQ.md', 'utf8'));
  assert.equal(referenceHoldingKey(catalog.find((entry) => entry.id === 'esq-013')!.name), 'СИБУР');
  assert.equal(referenceHoldingKey(catalog.find((entry) => entry.id === 'esq-014')!.name), 'СИБУР');
  assert.equal(referenceHoldingKey(catalog.find((entry) => entry.id === 'esq-017')!.name), 'РМК');
  assert.equal(referenceHoldingKey(catalog.find((entry) => entry.id === 'esq-043')!.name), 'РУСАЛ');
  const selected = selectReferences(catalog, 'chemical').selected;
  assert.equal(selected.filter((entry) => referenceHoldingKey(entry.name) === 'СИБУР').length, 1);
});
