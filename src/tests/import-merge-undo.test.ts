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
import { picoTemplate, syntheticClient } from './helpers/import-fixtures';

test('import explicit decisions, safe merge, privacy and conditional 24-hour undo', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'import-merge-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const a: Actor = {
    id: randomUUID(),
    name: 'Импортёр',
    telegramId: '1',
    role: 'manager',
    active: true,
  };
  const b: Actor = { ...a, id: randomUUID(), name: 'Другой', telegramId: '2' };
  for (const actor of [a, b])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.telegramId,
      actor.name,
      actor.role,
    ]);
  const crm = new CrmService(db),
    service = new CompanyImports(db, crm, assertImportPrivacy);
  const prepare = (text: string, actor = a) =>
    service.prepare(actor, { sourceKey: randomUUID(), format: 'csv', bytes: Buffer.from(text) });
  await t.test(
    'preview never writes; explicit update fills contacts, preserves confirmed money, undo restores precisely',
    async () => {
      const company = await crm.create(a, {
        name: 'ООО «Меридиан»',
        city: 'Казань',
        inn: '7707083893',
        potential: 9_000_000,
        divisions: { lv: 9_000_000 },
        notes: 'Ранее',
      });
      const contact = await crm.createRecord(a, company.id, 'contact', {
        name: 'Иванов Иван',
        role: '',
        phone: '+79990000001',
        email: '',
      });
      const c = syntheticClient();
      c[0] = '7707083893';
      c[1] = 'Меридиан';
      c[2] = 'Казань';
      c[3] = 'Заказчик';
      for (let i = 4; i < 12; i++) c[i] = '';
      c[4] = '2';
      c[5] = '3';
      c[14] = 'Иванов Иван, инженер, +79990000001, business@example.test';
      c[13] = '';
      c[15] = 'Из файла';
      const p = await service.prepare(a, {
        sourceKey: randomUUID(),
        format: 'xlsx',
        bytes: picoTemplate({ clients: [c] }),
      });
      assert.equal(p.rows[0]!.disposition, 'skip_duplicate');
      assert.ok(p.messages.join('\n').includes('→'));
      assert.equal((await crm.company(a, company.id)).notes, 'Ранее');
      assert.equal((await crm.detail(a, company.id)).records.length, 1);
      assert.ok(
        p.replyMarkup.inline_keyboard.flat().some((x) => x.callback_data.startsWith('iu:')),
      );
      await assert.rejects(service.decide(b, p.id, p.version, 0, 'u'));
      const selected = await service.decide(a, p.id, p.version, 0, 'u');
      await assert.rejects(service.confirm(a, p.id, p.version));
      const result = await service.confirm(a, p.id, selected.version);
      assert.deepEqual(result.updated, [company.id]);
      const saved = await crm.company(a, company.id);
      assert.equal(saved.potential, 12_000_000);
      assert.equal(saved.divisions.lv, 9_000_000);
      assert.equal(saved.divisions.mv, 3_000_000);
      assert.ok(saved.notes.includes('Ранее'));
      assert.ok(saved.notes.includes('Из файла'));
      const records = (await crm.detail(a, company.id)).records;
      assert.equal(records.length, 1);
      assert.equal(records[0]!.data.role, 'инженер');
      assert.equal(records[0]!.data.email, 'business@example.test');
      assert.deepEqual(await service.confirm(a, p.id, selected.version), result);
      await assert.rejects(service.undo(b, p.id, result.version!));
      assert.deepEqual(await service.undo(a, p.id, result.version!), { undone: true });
      assert.deepEqual(await service.undo(a, p.id, result.version!), { undone: true });
      const restored = await crm.company(a, company.id);
      assert.equal(restored.notes, 'Ранее');
      assert.equal(restored.divisions.mv, undefined);
      const restoredContact = (await crm.detail(a, company.id)).records.find(
        (r) => r.id === contact.id,
      )!;
      assert.equal(restoredContact.data.role, '');
      assert.equal(restoredContact.data.email, '');
    },
  );
  await t.test(
    'same-file maxima and valid-INN/organizational-form conflicts prevent accidental combination',
    async () => {
      const p = await prepare(
        'Название;ИНН;Город;Потенциал млн руб\nООО «Единая»;7736050003;Самара;2\nООО «Единая»;7736050003;Самара;5\nАО «Единая»;;Самара;7\nООО «Единая»;7702070139;Самара;8',
      );
      assert.equal(p.rows.length, 3);
      assert.equal(p.rows[0]!.data.potential, 5_000_000);
      const result = await service.confirm(a, p.id, p.version);
      assert.equal(result.created.length, 3);
      assert.equal((await crm.list(a)).filter((c) => c.name === 'Единая').length, 3);
    },
  );
  await t.test(
    'similar or missing-city identity asks; no answer keeps separate; explicit same shows changes',
    async () => {
      const old = await crm.create(a, { name: 'Завод Полярный', city: 'Омск' });
      const p = await prepare('Название;Заметки\nЗавод Полярный;Дополнение');
      assert.equal(p.rows[0]!.disposition, 'ask_same');
      assert.ok(p.messages.join('\n').includes('Это одна компания?'));
      const separate = await service.confirm(a, p.id, p.version);
      assert.equal(separate.created.length, 1);
      assert.ok(!separate.created.includes(old.id));
      const q = await prepare('Название;Заметки\nЗавод Полярный;Ещё');
      const selected = await service.decide(a, q.id, q.version, 0, 's');
      assert.ok(selected.messages.join('\n').includes('→'));
      const result = await service.confirm(a, q.id, selected.version);
      assert.equal(result.updated!.length, 1);
    },
  );
  await t.test(
    'foreign duplicates reveal no private data; explicit parallel creation is owner-scoped',
    async () => {
      const foreign = await crm.create(b, {
        name: 'Закрытый Завод',
        city: 'Тула',
        inn: '7812014560',
        notes: 'СЕКРЕТНАЯ ЗАМЕТКА',
        potential: 987_654_321,
      });
      const p = await prepare('Название;ИНН;Город\nЗакрытый Завод;7812014560;Тула');
      const publicText = JSON.stringify(p);
      for (const secret of [foreign.id, b.id, 'СЕКРЕТНАЯ ЗАМЕТКА', '987654321'])
        assert.ok(!publicText.includes(secret));
      assert.equal(p.rows[0]!.disposition, 'foreign');
      const selected = await service.decide(a, p.id, p.version, 0, 'p');
      const parallel = await service.confirm(a, p.id, selected.version);
      assert.equal(parallel.created.length, 1);
      assert.equal((await crm.company(a, parallel.created[0]!)).ownerId, a.id);
      assert.equal((await crm.company(b, foreign.id)).ownerId, b.id);
    },
  );
  await t.test(
    'created companies undo soft-archives; later records or company edits block whole undo; expiry enforced',
    async () => {
      const p = await prepare('Название\nСозданный для отмены');
      const result = await service.confirm(a, p.id, p.version);
      const id = result.created[0]!;
      await service.undo(a, p.id, result.version!);
      assert.equal((await crm.company(a, id)).archived, true);
      const q = await prepare('Название\nПозднее изменение\nДругая неизменённая');
      const changed = await service.confirm(a, q.id, q.version);
      await crm.createRecord(a, changed.created[0]!, 'contact', { name: 'Позже' });
      await assert.rejects(service.undo(a, q.id, changed.version!));
      assert.equal((await crm.company(a, changed.created[1]!)).archived, false);
      const z = await prepare('Название\nИстекший импорт');
      const expired = await service.confirm(a, z.id, z.version);
      await db.query(
        "UPDATE company_imports SET draft=jsonb_set(draft,'{result,undoUntil}',$2::jsonb) WHERE id=$1",
        [z.id, JSON.stringify('2000-01-01T00:00:00.000Z')],
      );
      await assert.rejects(service.undo(a, z.id, expired.version!));
    },
  );
  await t.test('stale preview records reject selected merge before any writes', async () => {
    const old = await crm.create(a, { name: 'Версионный', city: 'Томск' });
    const contact = await crm.createRecord(a, old.id, 'contact', { name: 'До' });
    const p = await prepare('Название;Город;Заметки\nВерсионный;Томск;Новая');
    const selected = await service.decide(a, p.id, p.version, 0, 'u');
    await crm.updateRecord(a, contact.id, { version: contact.version, data: { name: 'После' } });
    await assert.rejects(service.confirm(a, p.id, selected.version));
    assert.equal((await crm.company(a, old.id)).notes, '');
  });
  await t.test(
    'undo validates restored holding type and newly referenced contacts atomically',
    async () => {
      const company = await crm.create(a, {
        name: 'Превращение',
        city: 'Омск',
        segment: 'unknown',
      });
      const p = await prepare('Название;Город;Тип\nПревращение;Омск;Холдинг');
      const selected = await service.decide(a, p.id, p.version, 0, 'u');
      const saved = await service.confirm(a, p.id, selected.version);
      const child = await crm.create(a, { name: 'Послеимпортный заказчик', holdingId: company.id });
      await assert.rejects(service.undo(a, p.id, saved.version!));
      assert.equal((await crm.company(a, company.id)).segment, 'holding');
      assert.equal((await crm.company(a, child.id)).holdingId, company.id);
      const target = await crm.create(a, { name: 'Контактный клиент', city: 'Уфа' });
      const c = syntheticClient();
      c[0] = '';
      c[1] = 'Контактный клиент';
      c[2] = 'Уфа';
      c[3] = 'Заказчик';
      for (let i = 4; i < 12; i++) c[i] = '';
      c[13] = '';
      c[14] = 'Петров Пётр, инженер, +79990000002, person@example.test';
      c[15] = '';
      const q = await service.prepare(a, {
        sourceKey: randomUUID(),
        format: 'xlsx',
        bytes: picoTemplate({ clients: [c] }),
      });
      const chosen = await service.decide(a, q.id, q.version, 0, 'u');
      const imported = await service.confirm(a, q.id, chosen.version);
      const contact = (await crm.detail(a, target.id)).records.find((r) => r.kind === 'contact')!;
      const external = await crm.create(a, { name: 'Другая компания проекта' });
      await crm.createRecord(a, external.id, 'project', {
        name: 'Внешний проект',
        participants: [
          {
            companyId: target.id,
            contactId: contact.id,
            role: 'Заказчик',
            currentTask: '',
            nextStep: '',
          },
        ],
      });
      await assert.rejects(service.undo(a, q.id, imported.version!));
      assert.ok((await crm.detail(a, target.id)).records.some((r) => r.id === contact.id));
    },
  );
});
