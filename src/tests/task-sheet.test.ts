import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../server/infra/database';
import { makeConfig } from '../server/config';
import { CrmService } from '../server/services/crm';
import { Actor, companySchema, defaultAnalyticsSettings, taskSchema } from '../shared/contracts';
import { summarizeClientAnalytics } from '../shared/analytics';

test('task sheet metadata and closed deletion remain versioned, authorized and recoverable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-task-sheet-'));
  const db = new Database(makeConfig({ DATA_DIR: dir, DATABASE_URL: '', WORKER_ENABLED: 'false' }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  let telegramId = 90000000;
  const actor = (role: Actor['role'], name: string): Actor => ({
    id: randomUUID(),
    telegramId: String(telegramId++),
    name,
    role,
    active: true,
  });
  const supervisor = actor('supervisor', 'Supervisor');
  const manager = actor('manager', 'Owner');
  const outsider = actor('manager', 'Other team');
  const teammate = actor('manager', 'Same team non-owner');
  const admin = actor('admin', 'Admin');
  const inactive = { ...actor('manager', 'Inactive'), active: false };
  for (const user of [supervisor, manager, outsider, teammate, admin, inactive])
    await db.query(
      'INSERT INTO users(id,telegram_id,name,role,active,supervisor_id) VALUES($1,$2,$3,$4,$5,$6)',
      [
        user.id,
        user.telegramId,
        user.name,
        user.role,
        user.active,
        [manager.id, teammate.id].includes(user.id) ? supervisor.id : null,
      ],
    );
  const crm = new CrmService(db);
  const company = await crm.create(manager, { name: 'Task owner' });
  const foreign = await crm.create(outsider, { name: 'Foreign' });
  const project = await crm.createRecord(manager, company.id, 'project', { name: 'Own project' });
  const foreignProject = await crm.createRecord(outsider, foreign.id, 'project', {
    name: 'Foreign project',
  });
  const foreignContact = await crm.createRecord(outsider, foreign.id, 'contact', {
    name: 'Foreign contact',
  });
  let task = await crm.createRecord(manager, company.id, 'task', { text: 'Call', type: 'meeting' });
  const data = () => taskSchema.strip().parse(task.data);
  await assert.rejects(
    crm.updateRecord(outsider, task.id, { version: task.version, data: data() }),
  );
  await assert.rejects(
    crm.updateRecord(manager, task.id, {
      version: task.version,
      data: data(),
      projectId: foreignProject.id,
    }),
    /Проект не принадлежит/,
  );
  await assert.rejects(
    crm.updateRecord(manager, task.id, {
      version: task.version,
      data: { ...data(), contactId: foreignContact.id },
    }),
    /Контакт не принадлежит/,
  );
  await assert.rejects(
    crm.updateRecord(supervisor, task.id, {
      version: task.version,
      data: data(),
      assigneeId: outsider.id,
    }),
    /Сотрудник недоступен/,
  );
  await assert.rejects(
    crm.updateRecord(admin, task.id, {
      version: task.version,
      data: data(),
      assigneeId: inactive.id,
    }),
    /Сотрудник недоступен/,
  );
  await assert.rejects(
    crm.updateRecord(supervisor, task.id, {
      version: task.version,
      data: data(),
      assigneeId: teammate.id,
    }),
    /Сотрудник недоступен/,
  );
  task = await crm.updateRecord(supervisor, task.id, {
    version: task.version,
    data: data(),
    assigneeId: supervisor.id,
  });
  assert.equal(
    task.assigneeId,
    supervisor.id,
    'a leader in the allowed actor scope can read the task',
  );
  task = await crm.updateRecord(supervisor, task.id, {
    version: task.version,
    data: data(),
    assigneeId: manager.id,
    projectId: project.id,
  });
  assert.equal(task.assigneeId, manager.id);
  assert.equal(task.projectId, project.id);
  await db.query('UPDATE users SET active=false WHERE id=$1', [manager.id]);
  await assert.rejects(
    crm.updateRecord(manager, task.id, { version: task.version, data: data(), assigneeId: null }),
    /Доступ изменён/,
  );
  await db.query('UPDATE users SET active=true WHERE id=$1', [manager.id]);
  await assert.rejects(
    crm.updateRecord(manager, task.id, {
      version: task.version - 1,
      data: { ...data(), deleted: true },
    }),
    /Запись изменена/,
  );
  task = await crm.updateRecord(manager, task.id, {
    version: task.version,
    data: { ...data(), deleted: true, done: false },
  });
  assert.equal(task.data.deleted, true);
  assert.equal(task.data.done, true);
  assert.equal(task.data.completedAt, null);
  assert.equal(
    (await crm.records(manager, 'task')).some((row) => row.id === task.id && row.data.deleted),
    true,
  );
  const [raw] = await db.query('SELECT deleted FROM records WHERE id=$1', [task.id]);
  assert.equal(raw.deleted, false, 'closed deletion does not hard-hide the record');
  const { deleted: _omitted, ...legacy } = data();
  await assert.rejects(
    crm.updateRecord(manager, task.id, {
      version: task.version,
      data: { ...legacy, text: 'Hidden edit' },
    }),
    /Сначала верните/,
  );
  assert.equal(
    (await crm.records(manager, 'task')).find((row) => row.id === task.id)?.data.deleted,
    true,
  );
  await assert.rejects(
    crm.updateRecord(manager, task.id, {
      version: task.version,
      data: { ...data(), done: false, deleted: false, text: 'Changed while restoring' },
    }),
    /Сначала верните/,
  );
  task = await crm.updateRecord(manager, task.id, {
    version: task.version,
    data: { ...data(), done: false, deleted: false },
  });
  assert.equal(task.data.deleted, false);
  assert.equal(task.data.done, false);
  assert.equal(task.data.completedAt, null);
  const { deleted: _legacyFlag, ...legacyOpen } = data();
  task = await crm.updateRecord(manager, task.id, {
    version: task.version,
    data: { ...legacyOpen, text: 'Legacy edit' },
  });
  assert.equal(task.data.deleted, false);
  assert.equal(task.projectId, project.id, 'omitted task metadata is preserved');
  assert.equal(task.assigneeId, manager.id);
  await assert.rejects(
    crm.updateRecord(manager, project.id, {
      version: project.version,
      data: project.data,
      assigneeId: manager.id,
    }),
    /Связи доступны только/,
  );
});

test('closed deleted tasks contribute neither task nor meeting scoring or regularity', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const company = {
    id: 'c',
    data: companySchema.parse({ name: 'Client' }),
    created_at: '2026-01-01T12:00:00Z',
    updated_at: '2026-01-01T12:00:00Z',
  };
  const task = {
    id: 't',
    kind: 'task',
    company_id: 'c',
    data: { text: 'Meeting', type: 'meeting', done: true, deleted: true, completedAt: null },
    contact_source: 'unknown',
    created_at: '2026-11-09T12:00:00Z',
    version: 2,
    deleted: false,
  };
  const calculate = () =>
    summarizeClientAnalytics(
      [company],
      [task],
      [],
      '2026-11-01',
      '2026-11-10',
      'Europe/Moscow',
      defaultAnalyticsSettings,
      'all',
      now,
    );
  const deleted = calculate().clients[0]!;
  assert.equal(deleted.score, 0);
  assert.equal(deleted.base.task, false);
  assert.equal(deleted.base.meeting, false);
  assert.equal(deleted.regularity.task, false);
  assert.equal(deleted.regularity.meeting, false);
  task.data.deleted = false;
  assert.ok(
    calculate().clients[0]!.score > 0,
    'the fixture would score as a normal completed task',
  );
});
