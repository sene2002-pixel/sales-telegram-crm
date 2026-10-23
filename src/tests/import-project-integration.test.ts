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
async function choices(imports: CompanyImports, actor: Actor, preview: any, allowParallel = false) {
  for (let attempts = 0; attempts < 30; attempts++) {
    const buttons = preview.replyMarkup.inline_keyboard.flat();
    const choice =
      buttons.find((b: any) => /:j\d+m0$/.test(b.callback_data)) ||
      buttons.find((b: any) => /:s$/.test(b.callback_data)) ||
      (allowParallel && buttons.find((b: any) => /:p$/.test(b.callback_data)));
    if (!choice) return preview;
    const parts = choice.callback_data.split(':');
    preview = await imports.decide(actor, preview.id, preview.version, Number(parts[3]), parts[4]);
  }
  throw new Error('Import choices did not settle');
}
test('generic project import uses own named customer, preserves contextual month and undoes only previewed companies', async (t) => {
  const { db, actor, crm, imports } = await fixture(t);
  const input = {
    sourceKey: randomUUID(),
    format: 'csv' as const,
    sourceDate: '2026-10-18T00:00:00Z',
    bytes: Buffer.from(
      'Компания;Проект;Заказчик;Реализация;Сумма проекта, млн руб.\nQA Integrator;Campus;QA Customer;Сентябрь;5',
    ),
  };
  let p = await imports.prepare(actor, input);
  assert.deepEqual(p.rows.map((r) => r.data.name).sort(), ['QA Customer', 'QA Integrator']);
  p = await choices(imports, actor, p);
  const result = await imports.confirm(actor, p.id, p.version);
  assert.equal(result.created.length, 2);
  const companies = await crm.list(actor);
  assert.equal(companies.length, 2);
  const customer = companies.find((c: any) => c.name === 'QA Customer')!;
  const projects = await db.query("SELECT * FROM records WHERE kind='project' AND NOT deleted");
  assert.equal(projects.length, 1);
  assert.equal(projects[0].data.amount, 5e6);
  assert.match(projects[0].data.notes, /09\.2027/);
  assert.ok(
    projects[0].data.participants.some(
      (p: any) => p.companyId === customer.id && p.role === 'Заказчик',
    ),
  );
  await imports.undo(actor, p.id, result.version!);
  assert.equal((await crm.list(actor)).filter((c: any) => !c.archived).length, 0);
  assert.equal(
    (await db.query("SELECT * FROM records WHERE kind='project' AND NOT deleted")).length,
    0,
  );
});
test('role-column contractor survives explicit project merge and undo restores existing project', async (t) => {
  const { db, actor, crm, imports } = await fixture(t);
  const owner = await crm.create(actor, { name: 'QA Lead' }),
    customer = await crm.create(actor, { name: 'QA Customer' });
  const existing = await crm.createRecord(
    actor,
    owner.id,
    'project',
    {
      name: 'Campus',
      participants: [
        {
          companyId: customer.id,
          role: 'Заказчик',
          contactId: null,
          currentTask: '',
          nextStep: '',
        },
      ],
    },
    null,
  );
  const before = await db.query('SELECT data,version FROM records WHERE id=$1', [existing.id]);
  let p = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    format: 'csv',
    bytes: Buffer.from(
      'Компания;Проект;Заказчик;Подрядчик\nQA Lead;Campus;QA Customer;QA Contractor',
    ),
  });
  assert.ok(
    p.replyMarkup.inline_keyboard.flat().some((b: any) => /:j\d+m0$/.test(b.callback_data)),
    'merge must require an explicit decision',
  );
  p = await choices(imports, actor, p);
  const saved = await imports.confirm(actor, p.id, p.version);
  const rows = await db.query("SELECT * FROM records WHERE kind='project' AND NOT deleted");
  assert.equal(rows.length, 1);
  const contractor = (await crm.list(actor)).find((c: any) => c.name === 'QA Contractor')!;
  assert.ok(
    rows[0].data.participants.some(
      (p: any) => p.companyId === contractor.id && p.role === 'Подрядчик',
    ),
  );
  await imports.undo(actor, p.id, saved.version!);
  assert.deepEqual(
    (await db.query('SELECT data,version FROM records WHERE id=$1', [existing.id]))[0].data,
    before[0].data,
  );
});
test('foreign-owner customer INN requires explicit parallel decision and never links foreign company', async (t) => {
  const { db, actor, crm, imports } = await fixture(t);
  const other: Actor = { ...actor, id: randomUUID(), telegramId: randomUUID() };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    other.id,
    other.telegramId,
    other.name,
    other.role,
  ]);
  const foreign = await crm.create(other, { name: 'QA Customer', inn: '7707083893' });
  let p = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    format: 'csv',
    bytes: Buffer.from(
      'Компания;Проект;Заказчик;ИНН заказчика\nQA Integrator;Campus;QA Customer;7707083893',
    ),
  });
  assert.ok(p.rows.some((r) => r.disposition === 'foreign'));
  const skipped = await imports.confirm(actor, p.id, p.version);
  const withoutChoice = await db.query(
    "SELECT * FROM records WHERE kind='project' AND NOT deleted",
  );
  assert.ok(
    withoutChoice.every((r: any) =>
      r.data.participants.every((entry: any) => entry.companyId !== foreign.id),
    ),
  );
  assert.equal(
    (await crm.list(actor)).filter((c: any) => c.ownerId === actor.id && c.inn === '7707083893')
      .length,
    0,
  );
  await imports.undo(actor, p.id, skipped.version!);
  p = await imports.prepare(actor, {
    sourceKey: randomUUID(),
    format: 'csv',
    bytes: Buffer.from(
      'Компания;Проект;Заказчик;ИНН заказчика\nQA Integrator;Campus;QA Customer;7707083893',
    ),
  });
  p = await choices(imports, actor, p, true);
  await imports.confirm(actor, p.id, p.version);
  const rows = await db.query("SELECT * FROM records WHERE kind='project' AND NOT deleted");
  assert.equal(rows.length, 1);
  assert.ok(rows[0].data.participants.every((p: any) => p.companyId !== foreign.id));
  const own = (await crm.list(actor)).find(
    (c: any) => c.inn === '7707083893' && c.ownerId === actor.id,
  );
  assert.ok(own);
  assert.ok(rows[0].data.participants.some((p: any) => p.companyId === own.id));
});
