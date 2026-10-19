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
import { assertImportPrivacy } from '../server/services/company-import-parser';
import { Actor } from '../shared/contracts';

test('registry enrichment preserves supplied city, original name, verified legal form and per-import lookup cache', async (t) => {
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
  let calls = 0;
  const crm = new CrmService(db);
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
