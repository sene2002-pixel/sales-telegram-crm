import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../server/infra/database';
import { makeConfig } from '../server/config';
import { CrmService } from '../server/services/crm';
import { CompanyImports } from '../server/services/company-imports';
import { assertImportPrivacy, parseCompanyTable } from '../server/services/company-import-parser';
import { Actor } from '../shared/contracts';

async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pico-registry-import-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '1',
    name: 'Registry',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    actor.id,
    actor.telegramId,
    actor.name,
    actor.role,
  ]);
  return { actor, db, crm: new CrmService(db) };
}

test('registry enrichment preserves supplied city, original name, verified legal form and per-import lookup cache', async (t) => {
  const { actor, db, crm } = await fixture(t);
  let calls = 0;
  const service = new CompanyImports(db, crm, assertImportPrivacy, {
    lookup: async (inn, signal) => {
      calls++;
      assert.equal(inn, '7707083893');
      assert.ok(signal);
      return {
        name: 'ПАО «Проверенное»',
        legalForm: 'ПАО',
        registrationCity: 'Москва',
        okved: '64.19',
      };
    },
  });
  const preview = await service.prepare(actor, {
    sourceKey: randomUUID(),
    format: 'csv',
    bytes: Buffer.from(
      'Название;Город;ИНН\nООО Исходное;Казань;7707083893\nООО Второе;Казань;7707083893',
    ),
  });
  assert.equal(calls, 1);
  const result = await service.confirm(actor, preview.id, preview.version);
  assert.equal(result.created.length, 1);
  const company = await crm.company(actor, result.created[0]!);
  assert.equal(company.name, 'Проверенное');
  assert.equal(company.legalForm, 'ПАО');
  assert.equal(company.city, 'Казань');
  assert.equal(company.registrationCity, 'Москва');
  assert.equal(company.okved, '64.19');
  assert.ok(company.alternativeNames?.includes('Исходное'));
});

test('without a usable INN, only verified names and unique prefixes enrich an import before confirmation', async (t) => {
  const { actor, db, crm } = await fixture(t);
  const searched: string[] = [];
  const inns = ['7707083893', '7736050003'];
  const service = new CompanyImports(db, crm, assertImportPrivacy, {
    search: async (name, city) => {
      searched.push([name, city].join('|'));
      return name === 'Отраслевой' ? inns : name === 'Примерный' ? [inns[0]!] : [];
    },
    lookup: async (inn) => ({
      name: inn === inns[0] ? 'ООО «Примерный завод»' : 'ООО «Отраслевой склад»',
      legalForm: 'ООО',
      registrationCity: 'Москва',
    }),
  });
  const preview = await service.prepare(actor, {
    sourceKey: randomUUID(),
    format: 'csv',
    bytes: Buffer.from(
      'Компания;ИНН;Город;Страна;Тип клиента\nООО «Примерный…»;124;Мск;Россия;\nОтраслевой; ;Москва;Россия;\nИностранный;;Москва;Казахстан;\nГруппа Подготовки;;Москва;Россия;Холдинг\nБез географии;;;;',
    ),
  });
  assert.deepEqual(searched.sort(), ['Отраслевой|Москва', 'Примерный|Москва']);
  const row = preview.rows.find((row) => row.data.name === 'Примерный завод');
  assert.equal(row?.data.inn, inns[0]);
  assert.equal(row?.data.registrationCity, 'Москва');
  assert.ok(row?.data.alternativeNames?.includes('Примерный…'));
  assert.ok(!row?.missing.includes('ИНН'));
  assert.equal(preview.rows.find((row) => row.data.name === 'Отраслевой')?.data.inn, undefined);
  assert.equal((await db.query('SELECT id FROM companies')).length, 0);
  const confirmed = await service.confirm(actor, preview.id, preview.version);
  const companies = await Promise.all(confirmed.created.map((id) => crm.company(actor, id)));
  assert.equal(companies.find((row) => row.inn === inns[0])?.name, 'Примерный завод');
});

test('truncation inside quotes produces a searchable prefix without changing the original row', () => {
  for (const name of ['ООО «Примерный…', 'ООО «Примерный…»', 'ООО "Примерный..."']) {
    const [row] = parseCompanyTable(
      [
        ['Компания', 'Город'],
        [name, 'Москва'],
      ],
      'Таблица',
      assertImportPrivacy,
    );
    assert.equal(row?.registryPrefix, 'Примерный');
    assert.equal(row?.raw?.['Компания'], name);
    assert.equal(row?.legalForm, 'ООО');
  }
});
