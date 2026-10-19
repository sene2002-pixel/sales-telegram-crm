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

test('holding allocation is explicit, atomic, versioned and preserves group/equipment totals', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-allocation-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '1001',
    name: 'Allocation',
    role: 'manager',
    active: true,
  };
  const other: Actor = { ...actor, id: randomUUID(), telegramId: '1002' };
  for (const person of [actor, other])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      person.id,
      person.telegramId,
      person.name,
      person.role,
    ]);
  const crm = new CrmService(db);
  const holding = await crm.create(actor, {
    name: 'Group',
    segment: 'holding',
    potential: 30_000_000,
    divisions: { lv: 30_000_000 },
    sites: ['Площадка 1'],
  });
  const a = await crm.create(actor, {
    name: 'A',
    holdingId: holding.id,
    potential: 1_000_000,
    divisions: { lv: 1_000_000 },
  });
  const b = await crm.create(actor, { name: 'B', holdingId: holding.id });
  const input = {
    version: holding.version,
    allocations: [
      { companyId: a.id, version: a.version, potential: 20_000_000, divisions: { lv: 20_000_000 } },
      { companyId: b.id, version: b.version, potential: 10_000_000, divisions: { lv: 10_000_000 } },
    ],
  };
  await assert.rejects(crm.allocateHolding(other, holding.id, input));
  await assert.rejects(
    crm.allocateHolding(actor, holding.id, {
      ...input,
      allocations: input.allocations.slice(0, 1),
    }),
  );
  await assert.rejects(
    crm.allocateHolding(actor, holding.id, {
      ...input,
      allocations: [
        input.allocations[0],
        { ...input.allocations[1], potential: 11_000_000, divisions: { lv: 11_000_000 } },
      ],
    }),
  );
  await assert.rejects(
    crm.allocateHolding(actor, holding.id, {
      ...input,
      allocations: [{ ...input.allocations[0], version: 99 }, input.allocations[1]],
    }),
  );
  assert.equal((await crm.company(actor, a.id)).version, a.version);
  assert.equal((await crm.company(actor, holding.id)).potential, 30_000_000);
  const result = await crm.allocateHolding(actor, holding.id, input);
  assert.equal(result.company.potential, null);
  assert.deepEqual(result.company.divisions, {});
  assert.deepEqual(result.company.sites, ['Площадка 1']);
  assert.equal(result.holdingPotential, 30_000_000);
  assert.equal(result.holdingDivisions.lv, 30_000_000);
  assert.equal((await crm.company(actor, a.id)).potential, 20_000_000);
  assert.equal((await crm.company(actor, b.id)).version, b.version + 1);
  await assert.rejects(crm.allocateHolding(actor, holding.id, input));
  const audits = await db.query(
    "SELECT * FROM audit WHERE details->>'holdingAllocation' IS NOT NULL",
  );
  assert.equal(audits.length, 3);
});
