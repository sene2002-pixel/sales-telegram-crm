import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../server/infra/database';
import { makeConfig } from '../server/config';
import { CrmService } from '../server/services/crm';
import { CompanyImports } from '../server/services/company-imports';
import { assertImportPrivacy } from '../server/services/company-import-parser';
import {
  normalizedCompanyName,
  importedLegalForm,
  normalizedPhones,
  normalizedImportDate,
  candidateSimilarity,
  normalizedCity,
} from '../server/services/import-normalization';
import { Actor } from '../shared/contracts';

test('source normalizers preserve identity and deterministically interpret dates and telephones', () => {
  for (const form of ['ФГБУ', 'ГБУ', 'АНО', 'НКО']) {
    assert.equal(importedLegalForm(form + ' «Пример»'), form);
    assert.equal(normalizedCompanyName(form + ' «Пример»'), 'Пример');
  }
  assert.equal(normalizedCompanyName('ИП Иванов Иван Иванович'), 'ИП Иванов И.И.');
  assert.equal(normalizedCompanyName('ИП Иванов И.И.'), 'ИП Иванов И.И.');
  assert.equal(normalizedCity('гор. Н.Новгород'), 'Нижний Новгород');
  assert.equal(normalizedCity('?'), '');
  assert.equal(normalizedImportDate('IV кв 2026'), '12.2026');
  assert.equal(normalizedImportDate('ноя 26'), '11.2026');
  assert.equal(normalizedImportDate('2027'), '12.2027');
  assert.equal(normalizedImportDate('след. неделя'), undefined);
  assert.equal(normalizedImportDate('след. неделя', '2026-12-28'), '01.2027');
  assert.equal(normalizedImportDate('Сентябрь', '2026-10-20'), '09.2027');
  assert.equal(normalizedImportDate('31.02.2026'), undefined);
  assert.deepEqual(normalizedPhones('(3522) 644-745, 644-746'), [
    { phone: '+73522644745' },
    { phone: '+73522644746' },
  ]);
  assert.deepEqual(normalizedPhones('363-52-50 доб. 123', 'Екатеринбург'), [
    { phone: '+73433635250', extension: '123' },
  ]);
  assert.equal(normalizedPhones('1234567890').length, 0);
  assert.deepEqual(normalizedPhones('+375 29 123-45-67'), [{ phone: '+375291234567' }]);
  assert.ok(candidateSimilarity('Sibur', 'СИБУР'));
  assert.ok(candidateSimilarity('Завод Полярный', 'Полярный Завод'));
  assert.ok(!candidateSimilarity('Альфа', 'Другая компания'));
});

test('confirmed facts and notes survive imports; dated money uses latest source and same-day maximum; hash scopes to author', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-source-rules-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const a: Actor = {
    id: randomUUID(),
    name: 'А',
    telegramId: '991001',
    role: 'manager',
    active: true,
  };
  const b: Actor = { ...a, id: randomUUID(), name: 'Б', telegramId: '991002' };
  for (const u of [a, b])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      u.id,
      u.telegramId,
      u.name,
      u.role,
    ]);
  const crm = new CrmService(db),
    service = new CompanyImports(db, crm, assertImportPrivacy);
  const prepare = async (text: string, date?: string, actor = a) =>
    service.prepare(actor, {
      sourceKey: randomUUID(),
      format: 'csv',
      bytes: Buffer.from(text),
      sourceDate: date,
    });
  const start = await prepare(
    'Компания;ИНН;Город;Тип;Заметки;lv млн\nПроверенное;7707083893;Казань;Заказчик;Ранее;2',
    '2020-01-01',
  );
  const first = await service.confirm(a, start.id, start.version),
    id = first.created[0]!;
  const merge = async (text: string, date?: string) => {
    const p = await prepare(text, date);
    const selected = await service.decide(a, p.id, p.version, 0, 'u');
    return service.confirm(a, p.id, selected.version);
  };
  await merge(
    'Компания;ИНН;Город;Тип;Заметки;lv млн\nНовое имя;7707083893;Москва;Интегратор;Добавленная заметка;9',
    '2021-01-01',
  );
  const saved = await crm.company(a, id);
  assert.equal(saved.name, 'Проверенное');
  assert.equal(saved.city, 'Казань');
  assert.equal(saved.segment, 'end_client');
  assert.ok(saved.alternativeNames!.includes('Новое имя'));
  assert.ok(saved.notes.includes('Ранее'));
  assert.ok(saved.notes.includes('Добавленная заметка'));
  assert.ok(saved.notes.includes('2021-01-01'));
  assert.equal(saved.divisions.lv, 9e6);
  assert.equal(saved.potential, 9e6);
  await merge('Компания;ИНН;lv млн\nПроверенное;7707083893;4', '2021-01-01T12:00:00Z');
  assert.equal((await crm.company(a, id)).divisions.lv, 9e6);
  await merge('Компания;ИНН;lv млн\nПроверенное;7707083893;12', '2019-01-01');
  assert.equal((await crm.company(a, id)).divisions.lv, 9e6);
  await merge('Компания;ИНН;lv млн\nПроверенное;7707083893;7', '2022-01-01');
  assert.equal((await crm.company(a, id)).divisions.lv, 7e6);
  const repeat = await prepare('Компания;ИНН;lv млн\nПроверенное;7707083893;7', '2022-01-01');
  assert.ok(repeat.messages.join('').includes('уже загружался'));
  assert.equal(repeat.rows.length, 0);
  const foreign = await prepare('Компания;ИНН;lv млн\nПроверенное;7707083893;7', '2022-01-01', b);
  assert.equal(foreign.rows[0]!.disposition, 'foreign');
  const chosen = await service.decide(b, foreign.id, foreign.version, 0, 'p');
  const parallel = await service.confirm(b, foreign.id, chosen.version);
  assert.equal(parallel.created.length, 1);
  assert.equal((await crm.company(b, parallel.created[0]!)).ownerId, b.id);
  await db.migrate();
  await db.migrate();
  const indexes = await db.query("SELECT indexname FROM pg_indexes WHERE tablename='companies'");
  assert.ok(indexes.some((r) => r.indexname === 'companies_owner_inn'));
  assert.ok(!indexes.some((r) => r.indexname === 'companies_inn'));
  await assert.rejects(crm.create(a, { name: 'Own duplicate', inn: '7707083893' }));
});

test('cross-company project merge requires explicit review, preserves both participants and safely undoes the graph', async (t) => {
  const { picoTemplate, syntheticClient, syntheticProject } =
    await import('./helpers/import-fixtures');
  const dir = await mkdtemp(join(tmpdir(), 'pico-project-review-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const a: Actor = {
    id: randomUUID(),
    name: 'А',
    telegramId: '992001',
    role: 'manager',
    active: true,
  };
  const b: Actor = { ...a, id: randomUUID(), name: 'Б', telegramId: '992002' };
  for (const u of [a, b])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      u.id,
      u.telegramId,
      u.name,
      u.role,
    ]);
  const crm = new CrmService(db),
    service = new CompanyImports(db, crm, assertImportPrivacy);
  const owner = await crm.create(a, {
    name: 'Щитовой завод',
    inn: '7736050003',
    segment: 'integrator',
  });
  const customer = await crm.create(a, { name: 'Заказчик', inn: '7707083893' });
  const existing = await crm.createRecord(a, owner.id, 'project', {
    name: 'Объект ГПП',
    amount: 2e6,
    notes: 'Ранее подтверждено',
    participants: [
      { companyId: customer.id, role: 'Заказчик', contactId: null, currentTask: '', nextStep: '' },
    ],
  });
  const secretOwner = await crm.create(b, { name: 'Чужой участник' });
  await crm.createRecord(b, secretOwner.id, 'project', {
    name: 'Объект ГПП',
    notes: 'Чужое содержимое',
  });
  const client = syntheticClient();
  client[0] = '7702070139';
  client[1] = 'Новый подрядчик';
  client[2] = 'Казань';
  client[3] = 'Подрядчик';
  client[14] = '';
  const project = syntheticProject();
  project[0] = client[1]!;
  project[1] = client[0]!;
  project[2] = 'Реконструкция ГПП';
  project[3] = 'Заказчик';
  project[4] = '7707083893';
  const p = await service.prepare(a, {
    sourceKey: randomUUID(),
    format: 'xlsx',
    bytes: picoTemplate({ clients: [client], projects: [project] }),
  });
  assert.ok(!JSON.stringify(p).includes('Чужое содержимое'));
  assert.ok(!JSON.stringify(p).includes(secretOwner.id));
  const button = p.replyMarkup.inline_keyboard
    .flat()
    .find((b) => b.callback_data.endsWith(':j0m0'));
  assert.ok(button, 'Explicit project review must be offered');
  assert.equal(
    (await crm.detail(a, owner.id)).records.filter((r) => r.kind === 'project').length,
    1,
  );
  const chosen = await service.decide(a, p.id, p.version, 0, 'j0m0');
  const result = await service.confirm(a, p.id, chosen.version);
  const all = await db.query(
    "SELECT * FROM records WHERE kind='project' AND NOT deleted AND company_id IN (SELECT id FROM companies WHERE owner_id=$1)",
    [a.id],
  );
  assert.equal(all.length, 1);
  assert.equal(all[0].id, existing.id);
  assert.ok(all[0].data.participants.some((x: any) => x.companyId === owner.id));
  assert.ok(all[0].data.participants.some((x: any) => x.companyId === result.created[0]));
  await service.undo(a, p.id, result.version!);
  assert.equal((await crm.company(a, result.created[0]!)).archived, true);
  const restored = (await crm.detail(a, owner.id)).records.find((r) => r.id === existing.id)!;
  assert.equal(restored.data.participants.length, 1);
  assert.equal(restored.data.participants[0].companyId, customer.id);
  assert.equal(restored.data.notes, 'Ранее подтверждено');
});

test('same-upload projects are reviewed before combining participants and undone/restored cards keep INN uniqueness', async (t) => {
  const { picoTemplate, syntheticClient, syntheticProject } =
    await import('./helpers/import-fixtures');
  const dir = await mkdtemp(join(tmpdir(), 'pico-project-local-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor: Actor = {
    id: randomUUID(),
    name: 'А',
    telegramId: '993001',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    actor.id,
    actor.telegramId,
    actor.name,
    actor.role,
  ]);
  const crm = new CrmService(db),
    service = new CompanyImports(db, crm, assertImportPrivacy);
  const first = syntheticClient(),
    second = syntheticClient();
  first[1] = 'Компания А';
  first[3] = 'Заказчик';
  first[14] = '';
  second[0] = '7702070139';
  second[1] = 'Компания Б';
  second[3] = 'Подрядчик';
  second[14] = '';
  const a = syntheticProject(),
    b = syntheticProject();
  for (const p of [a, b]) {
    p[2] = 'Кампус';
    p[3] = 'Компания А';
    p[4] = first[0]!;
  }
  a[0] = first[1]!;
  a[1] = first[0]!;
  b[0] = second[1]!;
  b[1] = second[0]!;
  const bytes = picoTemplate({ clients: [first, second], projects: [a, b] });
  const draft = await service.prepare(actor, { sourceKey: randomUUID(), format: 'xlsx', bytes });
  assert.ok(
    draft.replyMarkup.inline_keyboard.flat().some((x) => x.callback_data.endsWith(':1:j0m0')),
  );
  const chosen = await service.decide(actor, draft.id, draft.version, 1, 'j0m0');
  const result = await service.confirm(actor, draft.id, chosen.version);
  const records = await db.query("SELECT * FROM records WHERE kind='project' AND NOT deleted");
  assert.equal(records.length, 1);
  assert.equal(records[0].data.participants.length, 2);
  await service.undo(actor, draft.id, result.version!);
  assert.equal(
    (await db.query("SELECT * FROM records WHERE kind='project' AND NOT deleted")).length,
    0,
  );
  const again = await service.prepare(actor, { sourceKey: randomUUID(), format: 'xlsx', bytes });
  assert.ok(again.replyMarkup.inline_keyboard.flat().some((x) => x.callback_data.endsWith(':0:r')));
  const restoredA = await service.decide(actor, again.id, again.version, 0, 'r');
  const restoredB = await service.decide(actor, again.id, restoredA.version, 1, 'r');
  const saved = await service.confirm(actor, again.id, restoredB.version);
  assert.equal(saved.created.length, 0);
  assert.equal(saved.updated!.length, 2);
  assert.equal((await crm.list(actor)).filter((c) => !c.archived).length, 2);
});
