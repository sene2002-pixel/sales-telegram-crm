import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Actor } from '../shared/contracts';
import { createApp, Services } from '../server/http/app';
import { makeConfig } from '../server/config';
import { resolveEmployeeFilter } from '../server/services/employee-filter';

let app: any, db: any, s: Services, dir: string;
let admin: Actor, supervisor: Actor, manager: Actor, teammate: Actor, foreign: Actor;
let own: any, other: any, foreignCompany: any, project: any, completed: any, open: any;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'employee-filter-tests-'));
  const built = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      WORKER_ENABLED: 'false',
      DATA_DIR: dir,
      DATABASE_URL: '',
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
      SESSION_SECRET: 'local-employee-test-secret-at-least-32-characters',
    }),
  );
  app = built.app;
  db = built.db;
  s = built.services;
  admin = (await s.auth.dev('admin', '127.0.0.1')).user;
  supervisor = (await s.auth.dev('supervisor', '127.0.0.1')).user;
  manager = (await s.auth.dev('manager', '127.0.0.1')).user;
  await db.query('UPDATE users SET supervisor_id=$2 WHERE id=$1', [manager.id, supervisor.id]);
  async function person(
    name: string,
    telegramId: string,
    supervisorId: string | null,
  ): Promise<Actor> {
    const actor: Actor = {
      id: randomUUID(),
      name,
      telegramId,
      role: 'manager',
      active: true,
      supervisorId,
    };
    await db.query(
      'INSERT INTO users(id,telegram_id,name,role,supervisor_id) VALUES($1,$2,$3,$4,$5)',
      [actor.id, telegramId, name, actor.role, supervisorId],
    );
    return actor;
  }
  teammate = await person('Своя команда', '920011', supervisor.id);
  foreign = await person('Другая команда', '920012', null);
  own = await s.crm.create(manager, { name: 'Компания своего менеджера' });
  other = await s.crm.create(teammate, { name: 'Компания коллеги' });
  foreignCompany = await s.crm.create(foreign, { name: 'Компания другой команды' });
  project = await s.crm.createRecord(manager, own.id, 'project', { name: 'Контекст проекта' });
});
after(async () => {
  await app?.close();
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
function get(actor: Actor, path: string) {
  return request(app.getHttpServer())
    .get('/api' + path)
    .set('Authorization', `Bearer ${s.auth.issue(actor)}`);
}
const range = 'from=2025-01-01&to=2030-01-01';

test('employee options are minimal and reflect admin, direct-team supervisor and manager permissions', async () => {
  for (const [actor, included, excluded] of [
    [admin, foreign.id, ''],
    [supervisor, teammate.id, foreign.id],
    [manager, manager.id, teammate.id],
  ] as const) {
    const result = await get(actor, '/employee-filter/options').expect(200);
    assert.ok(result.body.some((row: any) => row.id === included));
    assert.ok(!result.body.some((row: any) => row.id === excluded));
    for (const row of result.body)
      assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'role']);
  }
});

test('employee filter rejects malformed, array, unknown, inactive and foreign targets across protected reads', async () => {
  const paths = [
    '/companies',
    '/records/task',
    '/records/project',
    '/records/contact',
    '/records/file',
    '/reports',
    '/analytics?' + range,
    '/dashboard/commercial?' + range,
  ];
  for (const path of paths) {
    const separator = path.includes('?') ? '&' : '?';
    await get(supervisor, path + separator + 'employeeId=' + foreign.id).expect(403);
    await get(admin, path + separator + 'employeeId=not-a-uuid').expect(400);
    await get(
      admin,
      path + separator + 'employeeId=' + manager.id + '&employeeId=' + teammate.id,
    ).expect(400);
    await get(admin, path + separator + 'employeeId=' + randomUUID()).expect(403);
  }
  await db.query('UPDATE users SET active=false WHERE id=$1', [foreign.id]);
  await get(admin, '/companies?employeeId=' + foreign.id).expect(403);
  const options = await get(admin, '/employee-filter/options').expect(200);
  assert.ok(!options.body.some((row: any) => row.id === foreign.id));
  await db.query('UPDATE users SET active=true WHERE id=$1', [foreign.id]);
});

test('owner filter narrows established company ACL without granting manager foreign reads or rewriting supervisor global scope', async () => {
  await get(manager, '/companies?employeeId=' + teammate.id).expect(403);
  const ownOnly = await get(manager, '/companies?employeeId=' + manager.id).expect(200);
  assert.deepEqual(
    ownOnly.body.map((row: any) => row.id),
    [own.id],
  );
  const teamOnly = await get(supervisor, '/companies?employeeId=' + teammate.id).expect(200);
  assert.deepEqual(
    teamOnly.body.map((row: any) => row.id),
    [other.id],
  );
  const all = await get(supervisor, '/companies').expect(200);
  assert.ok(all.body.some((row: any) => row.id === foreignCompany.id));
  await get(supervisor, '/companies/' + foreignCompany.id).expect(200);
  await get(manager, '/companies/' + foreignCompany.id + '?employeeId=' + manager.id).expect(404);
  assert.deepEqual(
    (await get(manager, '/companies?employeeId=').expect(200)).body,
    (await get(manager, '/companies').expect(200)).body,
  );
});

test('non-task records use company owner while task filter follows completed and open assignees after transfer', async () => {
  const contact = await s.crm.createRecord(manager, own.id, 'contact', { name: 'Контакт' });
  const projects = await get(supervisor, '/records/project?employeeId=' + manager.id).expect(200);
  assert.ok(projects.body.some((row: any) => row.id === project.id));
  assert.ok(
    !(await get(supervisor, '/records/contact?employeeId=' + teammate.id).expect(200)).body.some(
      (row: any) => row.id === contact.id,
    ),
  );
  const handoff = await s.crm.create(manager, { name: 'Передача исполнителя' });
  const linkedProject = await s.crm.createRecord(manager, handoff.id, 'project', {
    name: 'Проект переданной компании',
  });
  completed = await s.crm.createRecord(
    manager,
    handoff.id,
    'task',
    { text: 'Завершена прежним менеджером', done: true },
    linkedProject.id,
  );
  open = await s.crm.createRecord(
    manager,
    handoff.id,
    'task',
    { text: 'Передана коллеге', done: false },
    linkedProject.id,
  );
  await s.crm.assign(admin, handoff.id, teammate.id, handoff.version);
  const foreignProject = await s.crm.createRecord(foreign, foreignCompany.id, 'project', {
    name: 'Чужой секретный проект',
  });
  await db.query('UPDATE records SET project_id=$2 WHERE id=$1', [open.id, foreignProject.id]);
  const oldTasks = await get(supervisor, '/records/task?employeeId=' + manager.id).expect(200);
  assert.ok(
    oldTasks.body.some(
      (row: any) => row.id === completed.id && row.projectName === linkedProject.data.name,
    ),
  );
  assert.ok(!oldTasks.body.some((row: any) => row.id === open.id));
  const newTasks = await get(supervisor, '/records/task?employeeId=' + teammate.id).expect(200);
  assert.ok(newTasks.body.some((row: any) => row.id === open.id));
  assert.equal(newTasks.body.find((row: any) => row.id === open.id).projectName, null);
  assert.ok(
    !(await get(manager, '/records/task?employeeId=' + manager.id).expect(200)).body.some(
      (row: any) => row.id === completed.id,
    ),
  );
});

test('analytics filters company and historical events consistently and commercial rejects conflicting author', async () => {
  const ownAnalytics = await get(
    supervisor,
    '/analytics?' + range + '&employeeId=' + manager.id,
  ).expect(200);
  const otherAnalytics = await get(
    admin,
    '/analytics?' + range + '&employeeId=' + foreign.id,
  ).expect(200);
  assert.equal(ownAnalytics.body.activeClients, 1);
  assert.equal(otherAnalytics.body.activeClients, 1);
  assert.deepEqual(
    ownAnalytics.body.funnel.map((row: any) => row.count),
    otherAnalytics.body.funnel.map((row: any) => row.count),
  );
  await get(
    supervisor,
    '/dashboard/commercial?' + range + '&employeeId=' + manager.id + '&authorId=' + teammate.id,
  ).expect(400);
  await get(
    supervisor,
    '/dashboard/commercial?' + range + '&employeeId=' + manager.id + '&authorId=' + manager.id,
  ).expect(200);
  await get(manager, '/dashboard/commercial?' + range + '&employeeId=' + manager.id).expect(403);
});

test('reports filter uses author and file/activity context uses owner without changing direct report ACL', async () => {
  const mine = await s.reports.enqueue(manager, {
    text: 'Подтверждённый локальный отчёт',
    sourceKey: 'employee-test-own',
  });
  const theirs = await s.reports.enqueue(teammate, {
    text: 'Отчёт коллеги',
    sourceKey: 'employee-test-other',
  });
  const reports = await get(supervisor, '/reports?employeeId=' + manager.id).expect(200);
  assert.ok(reports.body.some((row: any) => row.id === mine.id));
  assert.ok(!reports.body.some((row: any) => row.id === theirs.id));
  await get(manager, '/reports/' + theirs.id + '?employeeId=' + manager.id).expect(404);
  const file = await s.crm.createRecord(manager, own.id, 'file', {
    name: 'Документ.txt',
    category: 'docs',
    mime: 'text/plain',
    size: 1,
    key: randomUUID(),
  });
  const activity = await s.crm.createRecord(manager, own.id, 'activity', {
    text: 'Общение',
    occurredOn: '2026-10-13',
  });
  for (const [kind, id] of [
    ['file', file.id],
    ['activity', activity.id],
  ] as const) {
    assert.ok(
      (
        await get(supervisor, '/records/' + kind + '?employeeId=' + manager.id).expect(200)
      ).body.some((row: any) => row.id === id),
    );
    assert.ok(
      !(
        await get(supervisor, '/records/' + kind + '?employeeId=' + teammate.id).expect(200)
      ).body.some((row: any) => row.id === id),
    );
  }
});

test('same session rechecks team, role and active access rather than caching eligibility', async () => {
  const token = s.auth.issue(supervisor);
  const scoped = () =>
    request(app.getHttpServer())
      .get('/api/companies?employeeId=' + teammate.id)
      .set('Authorization', 'Bearer ' + token);
  await scoped().expect(200);
  await db.query('UPDATE users SET supervisor_id=NULL WHERE id=$1', [teammate.id]);
  await scoped().expect(403);
  await db.query('UPDATE users SET supervisor_id=$2 WHERE id=$1', [teammate.id, supervisor.id]);
  await db.query("UPDATE users SET role='manager' WHERE id=$1", [supervisor.id]);
  await scoped().expect(403);
  await assert.rejects(resolveEmployeeFilter(db, supervisor, manager.id));
  await db.query("UPDATE users SET role='supervisor',active=false WHERE id=$1", [supervisor.id]);
  await scoped().expect(403);
  await db.query('UPDATE users SET active=true WHERE id=$1', [supervisor.id]);
});
