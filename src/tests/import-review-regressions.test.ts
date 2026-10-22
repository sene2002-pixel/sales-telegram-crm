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
import { companySchema, type Actor } from '../shared/contracts';

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'pico-import-review-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor: Actor = {
    id: randomUUID(),
    telegramId: 'review-' + randomUUID(),
    name: 'QA',
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
    imports = new CompanyImports(db, crm, assertImportPrivacy);
  return { db, actor, crm, imports };
}
test('legacy catalogue aliases are reviewed as existing and undo never archives pre-existing groups', async (t) => {
  const { db, actor, crm, imports } = await fixture(t),
    id = randomUUID();
  const before = companySchema.parse({ name: 'Русская медная компания', segment: 'holding' });
  await db.query('INSERT INTO companies(id,owner_id,data) VALUES($1,$2,$3)', [
    id,
    actor.id,
    JSON.stringify(before),
  ]);
  const preview = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    bytes: Buffer.from('Компания;Тип\nРМК;Холдинг'),
    format: 'csv',
  });
  assert.equal(preview.rows[0]!.disposition, 'skip_duplicate');
  const result = await imports.confirm(actor, preview.id, preview.version);
  assert.deepEqual(result.created, []);
  await imports.undo(actor, preview.id, result.version!);
  const after = await crm.company(actor, id);
  assert.equal(after.archived, false);
  assert.equal(after.version, 1);
  assert.equal(after.name, before.name);
});
test('unexpected existing CRM create result fails closed and rolls back before journal publication', async (t) => {
  const { db, actor, crm, imports } = await fixture(t),
    existing = await crm.create(actor, { name: 'Existing', notes: 'Keep me' });
  const preview = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    bytes: Buffer.from('Компания\nUnique brand-new company'),
    format: 'csv',
  });
  assert.equal(preview.rows[0]!.disposition, 'create');
  t.mock.method(crm, 'create', async (_a: any, _raw: any, _owner: any, tx: any) => {
    await tx.query(
      "UPDATE companies SET data=jsonb_set(data,'{notes}','\"Should roll back\"'::jsonb),version=version+1 WHERE id=$1",
      [existing.id],
    );
    return crm.company(actor, existing.id, tx);
  });
  await assert.rejects(
    imports.confirm(actor, preview.id, preview.version),
    /Существующая компания/,
  );
  assert.equal((await crm.company(actor, existing.id)).notes, 'Keep me');
  const [saved] = await db.query('SELECT status,draft FROM company_imports WHERE id=$1', [
    preview.id,
  ]);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.draft.journal, undefined);
});
test('import actor locking follows hierarchy-before-actor order in every short transaction', async (t) => {
  const { db, actor, imports } = await fixture(t),
    original = db.transaction.bind(db);
  let checked = 0;
  t.mock.method(db, 'transaction', async (fn: any) =>
    original(async (tx) => {
      let hierarchy = false;
      return fn({
        query: async (sql: string, args?: any[]) => {
          if (sql === 'SELECT pg_advisory_xact_lock(7142532)') hierarchy = true;
          if (/FROM users WHERE id=\$1 FOR SHARE/.test(sql)) {
            assert.equal(hierarchy, true);
            checked++;
          }
          return tx.query(sql, args);
        },
      });
    }),
  );
  const preview = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    bytes: Buffer.from('Компания\nLock order company'),
    format: 'csv',
  });
  const result = await imports.confirm(actor, preview.id, preview.version);
  await imports.undo(actor, preview.id, result.version!);
  assert.ok(checked >= 4);
});
test('owner INN migration replaces legacy index repeatably and database rejects same-owner race', async (t) => {
  const { db, actor, crm } = await fixture(t),
    inn = '7707083893';
  const first = await crm.create(actor, { name: 'First', inn });
  await db.query('DROP INDEX companies_owner_inn');
  await db.query(
    "CREATE UNIQUE INDEX companies_inn ON companies ((data->>'inn')) WHERE data->>'inn'<>''",
  );
  await db.migrate();
  await db.migrate();
  const indexes = await db.query(
    "SELECT indexname,indexdef FROM pg_indexes WHERE tablename='companies'",
  );
  assert.ok(
    indexes.some((i) => i.indexname === 'companies_owner_inn' && i.indexdef.includes('owner_id')),
  );
  assert.ok(!indexes.some((i) => i.indexname === 'companies_inn'));
  const other = { ...actor, id: randomUUID(), telegramId: randomUUID() };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    other.id,
    other.telegramId,
    other.name,
    other.role,
  ]);
  const second = await crm.create(other, { name: 'Other owner same INN', inn });
  await assert.rejects(
    db.query('INSERT INTO companies(id,owner_id,data) VALUES($1,$2,$3)', [
      randomUUID(),
      actor.id,
      JSON.stringify(companySchema.parse({ name: 'Illegal duplicate', inn })),
    ]),
  );
  await assert.rejects(
    db.query('UPDATE companies SET owner_id=$1 WHERE id=$2', [actor.id, second.id]),
  );
  assert.equal((await crm.company(other, second.id)).ownerId, other.id);
  assert.equal((await crm.company(actor, first.id)).inn, inn);
});

test('registry-discovered catalogue parent is visible before confirmation and included in undo', async (t) => {
  const { db, actor, crm } = await fixture(t);
  const imports = new CompanyImports(db, crm, assertImportPrivacy, {
    lookup: async () => ({ name: 'ПАО «ТГК-1»', legalForm: 'ПАО' }),
  });
  const preview = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    bytes: Buffer.from('Компания;ИНН;Тип\nНеизвестное имя;7707083893;Заказчик'),
    format: 'csv',
  });
  assert.equal(preview.rows.length, 2);
  assert.ok(preview.rows.some((r) => r.data.segment === 'holding' && r.data.name === 'ТГК-1'));
  assert.ok(preview.rows.some((r) => r.data.segment === 'end_client' && r.holdingName === 'ТГК-1'));
  assert.equal((await crm.list(actor)).length, 0);
  const result = await imports.confirm(actor, preview.id, preview.version);
  assert.equal(result.created.length, 2);
  await imports.undo(actor, preview.id, result.version!);
  assert.ok((await crm.list(actor)).every((c) => c.archived));
});
test('unexpected implicit CRM creation fails closed instead of leaving an unjournalled group', async (t) => {
  const { db, actor, crm, imports } = await fixture(t),
    original = crm.create.bind(crm);
  const preview = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    bytes: Buffer.from('Компания\nUnique safe company'),
    format: 'csv',
  });
  t.mock.method(crm, 'create', async (a: any, raw: any, owner: any, tx: any) => {
    await tx.query('INSERT INTO companies(id,owner_id,data) VALUES($1,$2,$3)', [
      randomUUID(),
      actor.id,
      JSON.stringify(
        companySchema.parse({ name: 'Unreviewed implicit parent', segment: 'holding' }),
      ),
    ]);
    return original(a, raw, owner, tx);
  });
  await assert.rejects(
    imports.confirm(actor, preview.id, preview.version),
    /Состав компаний изменился/,
  );
  assert.equal((await crm.list(actor)).length, 0);
  const [row] = await db.query('SELECT status,draft FROM company_imports WHERE id=$1', [
    preview.id,
  ]);
  assert.equal(row.status, 'pending');
  assert.equal(row.draft.journal, undefined);
});

test('different countries never consolidate and foreign Russian-looking INN is omitted before matching', async (t) => {
  const { actor, crm, imports } = await fixture(t);
  const preview = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    bytes: Buffer.from(
      'Компания;ИНН;Страна;Город\nРусская компания;7707083893;Россия;Москва\nДругая иностранная компания;7707083893;Беларусь;Минск',
    ),
    format: 'csv',
  });
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.rows.find((r) => r.data.country === 'Беларусь')!.data.inn, undefined);
  const result = await imports.confirm(actor, preview.id, preview.version);
  assert.equal(result.created.length, 2);
  assert.equal((await crm.list(actor)).length, 2);
});
test('pending twins with the same file hash become independent no-op results after the first save', async (t) => {
  const { actor, crm, imports } = await fixture(t),
    input = { bytes: Buffer.from('Компания\nUnique pending twin company'), format: 'csv' as const };
  const first = await imports.prepare(actor, { ...input, sourceKey: randomUUID() });
  const second = await imports.prepare(actor, { ...input, sourceKey: randomUUID() });
  const a = await imports.confirm(actor, first.id, first.version);
  const b = await imports.confirm(actor, second.id, second.version);
  assert.equal(a.created.length, 1);
  assert.deepEqual(b.created, []);
  assert.deepEqual(b.updated, []);
  assert.equal(b.unchanged, true);
  assert.equal(b.undoUntil, undefined);
  assert.equal((await crm.list(actor)).length, 1);
  assert.deepEqual(await imports.confirm(actor, second.id, second.version), b);
  await assert.rejects(imports.undo(actor, second.id, b.version!), /Отмена недоступна/);
  await imports.undo(actor, first.id, a.version!);
  assert.equal((await crm.company(actor, a.created[0]!)).archived, true);
  const afterUndo = await imports.prepare(actor, { ...input, sourceKey: randomUUID() });
  assert.ok(
    afterUndo.rows.length > 0,
    'no-op twin must not block a new reviewed import after original undo',
  );
  assert.ok(!afterUndo.messages.some((message) => /Этот файл уже загружался/.test(message)));
});

test('same-name contacts with distinct known phones survive save and explicit import undo', async (t) => {
  const { actor, crm, imports } = await fixture(t);
  const preview = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    bytes: Buffer.from(
      'Компания;Контакты\nQA Contact Company;Иван Петров, инженер, 89026000439 / 89026000440',
    ),
    format: 'csv',
  });
  assert.deepEqual(preview.rows[0]!.contacts!.map((c) => c.phone).sort(), [
    '+79026000439',
    '+79026000440',
  ]);
  const result = await imports.confirm(actor, preview.id, preview.version);
  const contacts = (await crm.detail(actor, result.created[0]!)).records.filter(
    (r: any) => r.kind === 'contact',
  );
  assert.deepEqual(contacts.map((r: any) => r.data.phone).sort(), ['+79026000439', '+79026000440']);
  await imports.undo(actor, preview.id, result.version!);
  assert.equal(
    (await crm.detail(actor, result.created[0]!)).records.filter((r: any) => r.kind === 'contact')
      .length,
    0,
  );
});

test('RU country alias retains Russian INN throughout preview and confirmation', async (t) => {
  const { actor, crm, imports } = await fixture(t);
  const preview = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    format: 'csv',
    bytes: Buffer.from('Компания;Страна;ИНН\nAlias QA;RU;7707083893'),
  });
  assert.equal(preview.rows[0]!.data.inn, '7707083893');
  const saved = await imports.confirm(actor, preview.id, preview.version);
  assert.equal((await crm.company(actor, saved.created[0]!)).inn, '7707083893');
});

test('same-INN names consolidated within a file remain searchable aliases', async (t) => {
  const { actor, crm, imports } = await fixture(t);
  const preview = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    format: 'csv',
    bytes: Buffer.from('Компания;ИНН\nПервое название;7707083893\nВторое название;7707083893'),
  });
  assert.equal(preview.rows.length, 1);
  assert.ok(preview.rows[0]!.data.alternativeNames!.includes('Второе название'));
  const saved = await imports.confirm(actor, preview.id, preview.version);
  assert.ok(
    (await crm.company(actor, saved.created[0]!)).alternativeNames!.includes('Второе название'),
  );
});
