import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/infra/database';
import { makeConfig } from '../server/config';
import { CrmService } from '../server/services/crm';
import { Actor } from '../shared/contracts';

test('holding links enforce ownership/type and aggregates; creation contacts is atomic', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-holding-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor: Actor = {
    id: randomUUID(),
    name: 'A',
    telegramId: '1234',
    role: 'manager',
    active: true,
  };
  const other: Actor = { ...actor, id: randomUUID(), telegramId: '5678' };
  for (const a of [actor, other])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      a.id,
      a.telegramId,
      a.name,
      a.role,
    ]);
  const crm = new CrmService(db);
  await assert.rejects(
    crm.create(actor, { name: 'Bad holding', segment: 'holding', inn: '7707083893' }),
  );
  const holding = await crm.create(actor, { name: 'Group', segment: 'holding', potential: 999 });
  await assert.rejects(crm.create(other, { name: 'Foreign', holdingId: holding.id }));
  await assert.rejects(
    crm.create(actor, { name: 'Wrong type', segment: 'oem', holdingId: holding.id }),
  );
  const child = await crm.createWithContacts(actor, {
    name: 'Child',
    holdingId: holding.id,
    potential: 42,
    divisions: { automation_cabinets: 42 },
    initialContacts: [{ name: 'Contact' }],
  });
  assert.equal((await crm.detail(actor, child.id)).records[0]!.contactSource, 'user');
  const detail = await crm.detail(actor, holding.id);
  assert.equal(detail.holdingPotential, 42);
  assert.equal(detail.holdingMembers.length, 1);
  assert.equal(detail.holdingDivisions.automation_cabinets, 42);
  await assert.rejects(crm.createRecord(actor, holding.id, 'project', { name: 'Project' }));
  await assert.rejects(
    crm.update(actor, holding.id, {
      version: holding.version,
      data: { name: 'Group', segment: 'oem' },
    }),
  );
  await assert.rejects(
    crm.createWithContacts(actor, { name: 'Invalid', initialContacts: [{ name: '' }] }),
  );
  assert.equal((await crm.list(actor)).filter((c) => c.name === 'Invalid').length, 0);
  const candidate = await crm.create(actor, { name: 'Existing buyer' });
  const foreign = await crm.create(other, { name: 'Another buyer' });
  const selection = { id: candidate.id, version: candidate.version };
  for (const invalid of [
    { id: foreign.id, version: foreign.version },
    { id: child.id, version: child.version },
    { id: candidate.id, version: candidate.version + 1 },
    selection,
  ]) {
    await assert.rejects(
      crm.createWithContacts(actor, {
        name: 'Rolled back group',
        segment: 'holding',
        initialMembers: [selection, invalid],
      }),
    );
    assert.equal((await crm.company(actor, candidate.id)).version, candidate.version);
    assert.ok(!(await crm.list(actor)).some((entry) => entry.name === 'Rolled back group'));
  }
  const group = await crm.createWithContacts(actor, {
    name: 'Group with buyers',
    segment: 'holding',
    initialMembers: [selection, { name: 'New buyer', inn: '7707083893', city: 'Москва' }],
  });
  const groupDetail = await crm.detail(actor, group.id);
  assert.deepEqual(groupDetail.holdingMembers.map((member) => member.name).sort(), [
    'Existing buyer',
    'New buyer',
  ]);
  assert.equal(
    groupDetail.holdingMembers.find((member) => member.name === 'New buyer')!.inn,
    '7707083893',
  );
  assert.equal((await crm.company(actor, candidate.id)).version, candidate.version + 1);
  await assert.rejects(crm.create(actor, { name: 'Bad website', website: 'javascript:alert(1)' }));
});
