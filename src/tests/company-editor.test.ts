import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/infra/database';
import { makeConfig } from '../server/config';
import { CrmService } from '../server/services/crm';
import { companySchema, type Actor } from '../shared/contracts';

test('company editor is atomic, versioned, own-company only and never deletes omitted contacts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-editor-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const a: Actor = {
    id: randomUUID(),
    telegramId: '88111',
    name: 'A',
    role: 'manager',
    active: true,
  };
  const b: Actor = { ...a, id: randomUUID(), telegramId: '88112' };
  for (const actor of [a, b])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.telegramId,
      actor.name,
      actor.role,
    ]);
  const crm = new CrmService(db);
  const c = await crm.create(a, {
    name: 'Editable',
    country: 'Россия',
    region: 'Мурманская область',
  });
  const contact = await crm.createRecord(
    a,
    c.id,
    'contact',
    { name: 'Existing', extension: '123' },
    null,
    undefined,
    { contactSource: 'bot' },
  );
  const omitted = await crm.createRecord(a, c.id, 'contact', { name: 'Keep' });
  const data = companySchema.strip().parse({ ...c, name: 'Updated' });
  const draft = {
    version: c.version,
    data,
    contacts: [
      { id: contact.id, version: contact.version, data: { name: 'Edited' } },
      { data: { name: 'New' } },
    ],
  };
  await assert.rejects(crm.updateWithContacts(b, c.id, draft));
  await assert.rejects(
    crm.updateWithContacts(a, c.id, {
      ...draft,
      contacts: [{ ...draft.contacts[0], version: 999 }],
    }),
    /Контакт изменён/,
  );
  assert.equal((await crm.company(a, c.id)).name, 'Editable');
  await assert.rejects(
    crm.updateWithContacts(a, c.id, {
      ...draft,
      contacts: [...draft.contacts, { id: randomUUID(), version: 1, data: { name: 'Wrong' } }],
    }),
  );
  assert.equal((await crm.detail(a, c.id)).records.length, 2);
  const updated = await crm.updateWithContacts(a, c.id, draft);
  assert.equal(updated.version, c.version + 1);
  assert.equal(updated.name, 'Updated');
  assert.equal(updated.region, 'Мурманская область');
  const records = (await crm.detail(a, c.id)).records;
  assert.equal(records.length, 3);
  assert.equal(records.find((r) => r.id === omitted.id)?.data.name, 'Keep');
  assert.equal(records.find((r) => r.id === contact.id)?.contactSource, 'bot');
  assert.equal(records.find((r) => r.id === contact.id)?.data.extension, '123');
  assert.equal(records.find((r) => r.data.name === 'New')?.contactSource, 'user');
  const patched = await crm.updateRecord(a, contact.id, {
    version: 2,
    data: { name: 'Patched', role: '', phone: '', email: '' },
  });
  assert.equal(patched.data.extension, '123');

  await assert.rejects(crm.updateWithContacts(a, c.id, draft), /Карточка изменена/);
  const foreign = await crm.create(b, { name: 'Foreign' });
  const foreignContact = await crm.createRecord(b, foreign.id, 'contact', {
    name: 'Foreign person',
  });
  await assert.rejects(
    crm.updateWithContacts(a, c.id, {
      ...draft,
      version: updated.version,
      contacts: [{ id: foreignContact.id, version: 1, data: { name: 'Attack' } }],
    }),
    /Контакт не найден/,
  );
});

test('INN uniqueness is owner-scoped on create, edit and atomic reassignment including archive', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-owner-inn-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const a: Actor = {
    id: randomUUID(),
    telegramId: '77111',
    name: 'A',
    role: 'admin',
    active: true,
  };
  const b: Actor = { ...a, id: randomUUID(), telegramId: '77112', role: 'manager' };
  for (const actor of [a, b])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.telegramId,
      actor.name,
      actor.role,
    ]);
  const crm = new CrmService(db),
    inn = '7707083893';
  const first = await crm.create(a, { name: 'A first', inn });
  const second = await crm.create(b, { name: 'B same', inn });
  await assert.rejects(crm.create(a, { name: 'Duplicate', inn }), /этого ответственного/);
  await assert.rejects(crm.assign(a, second.id, a.id, second.version), /этого ответственного/);
  assert.equal((await crm.company(a, second.id)).ownerId, b.id);
  const empty = await crm.create(a, { name: 'Empty' });
  await assert.rejects(
    crm.update(a, empty.id, { version: empty.version, data: { name: 'Edit', inn } }),
    /этого ответственного/,
  );
  await assert.rejects(
    crm.updateWithContacts(a, empty.id, {
      version: empty.version,
      data: { name: 'Editor', inn },
      contacts: [],
    }),
    /этого ответственного/,
  );
  await crm.update(a, first.id, {
    version: first.version,
    data: { name: first.name, inn, archived: true },
  });
  await assert.rejects(crm.create(a, { name: 'Archive duplicate', inn }), /этого ответственного/);
});

test('editor rechecks active actor and role after advisory lock rather than trusting an HTTP snapshot', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-editor-revocation-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const admin: Actor = {
    id: randomUUID(),
    telegramId: '55111',
    name: 'Admin',
    role: 'admin',
    active: true,
  };
  const owner: Actor = { ...admin, id: randomUUID(), telegramId: '55112', role: 'manager' };
  for (const a of [admin, owner])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      a.id,
      a.telegramId,
      a.name,
      a.role,
    ]);
  const crm = new CrmService(db),
    c = await crm.create(owner, { name: 'Unchanged' });
  const original = db.transaction.bind(db);
  for (const update of ["role='manager'", 'active=false']) {
    let revokedAfterLock = false;
    // Deterministic transaction hook models revocation becoming visible after a waiter obtains its lock.
    // It verifies ordering/fresh authorization, not native PostgreSQL scheduling.
    const mock = t.mock.method(db, 'transaction', async (fn: any) =>
      original(async (tx) =>
        fn({
          query: async (sql: string, args?: any[]) => {
            const result = await tx.query(sql, args);
            if (sql === 'SELECT pg_advisory_xact_lock(7142532)' && !revokedAfterLock) {
              revokedAfterLock = true;
              await tx.query(`UPDATE users SET ${update} WHERE id=$1`, [admin.id]);
            }
            return result;
          },
        }),
      ),
    );
    await assert.rejects(
      crm.updateWithContacts(admin, c.id, {
        version: c.version,
        data: { name: 'Unauthorized edit' },
        contacts: [{ data: { name: 'Unauthorized contact' } }],
      }),
    );
    mock.mock.restore();
    assert.equal(revokedAfterLock, true);
    assert.equal((await crm.company(owner, c.id)).name, 'Unchanged');
    assert.equal((await crm.detail(owner, c.id)).records.length, 0);
  }
});

test('leader report preview matches the report author instead of a viewer same-INN company', async (t) => {
  const { createApp } = await import('../server/http/app');
  const { default: request } = await import('supertest');
  const dir = await mkdtemp(join(tmpdir(), 'pico-report-owner-preview-'));
  const { app, db, services } = await createApp(
    makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }),
  );
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const leader: Actor = {
    id: randomUUID(),
    telegramId: '44111',
    name: 'Leader',
    role: 'admin',
    active: true,
  };
  const author: Actor = {
    ...leader,
    id: randomUUID(),
    telegramId: '44112',
    name: 'Author',
    role: 'manager',
  };
  for (const actor of [leader, author])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.telegramId,
      actor.name,
      actor.role,
    ]);
  const viewerCompany = await services.crm.create(leader, {
    name: 'Viewer company',
    inn: '7707083893',
  });
  const authorCompany = await services.crm.create(author, {
    name: 'Author company',
    inn: '7707083893',
  });
  const draft = {
    blocks: [
      {
        companyName: 'Author company',
        inn: '7707083893',
        city: null,
        segment: null,
        stage: null,
        potential: null,
        divisions: [],
        summary: 'Confirmed meeting',
        occurredOn: '2026-10-20',
        sales: null,
        contacts: [],
        tasks: [],
      },
    ],
    warnings: [],
  };
  const report = await services.reports.enqueue(author, {
    sourceKey: randomUUID(),
    text: 'Report',
  });
  await db.query("UPDATE reports SET status='review',draft=$1 WHERE id=$2", [
    JSON.stringify(draft),
    report.id,
  ]);
  const response = await request(app.getHttpServer())
    .get('/api/reports/' + report.id)
    .set('Authorization', 'Bearer ' + services.auth.issue(leader))
    .expect(200);
  assert.deepEqual(response.body.candidates, [[authorCompany.id]]);
  assert.ok(!response.body.candidates.flat().includes(viewerCompany.id));
});
