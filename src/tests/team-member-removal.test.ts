import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import request from 'supertest';
import { Actor, Role } from '../shared/contracts';
import { makeConfig } from '../server/config';
import { createApp } from '../server/http/app';

let running: Awaited<ReturnType<typeof createApp>>;
let dir: string;
let admin: Actor, firstLeader: Actor, secondLeader: Actor;
let sequence = 71002400;
const configOverrides = { BOOTSTRAP_ADMIN_TELEGRAM_ID: '71002400' };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pico-remove-member-'));
  running = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      WORKER_ENABLED: 'false',
      DATA_DIR: dir,
      DATABASE_URL: '',
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
      SESSION_SECRET: 'test-remove-member-session-secret-at-least32',
      ...configOverrides,
    }),
  );
  admin = await running.services.auth.byTelegram(configOverrides.BOOTSTRAP_ADMIN_TELEGRAM_ID);
  firstLeader = await user('supervisor');
  secondLeader = await user('supervisor');
});

after(async () => {
  await running?.app.close();
  await running?.db.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function user(role: Role, supervisorId: string | null = null, active = true): Promise<Actor> {
  const actor: Actor = {
    id: randomUUID(),
    telegramId: String(++sequence),
    name: `${role} ${sequence}`,
    role,
    active,
    supervisorId,
  };
  await running.db.query(
    'INSERT INTO users(id,telegram_id,name,role,active,supervisor_id) VALUES($1,$2,$3,$4,$5,$6)',
    [actor.id, actor.telegramId, actor.name, actor.role, actor.active, actor.supervisorId],
  );
  return actor;
}

function api(method: 'get' | 'post' | 'delete', route: string, actor?: Actor | string) {
  const req = request(running.app.getHttpServer())[method](`/api${route}`);
  if (actor) {
    const token = typeof actor === 'string' ? actor : running.services.auth.issue(actor);
    req.set('Authorization', 'Bearer ' + token);
  }
  return req;
}

async function invite(issuer: Actor) {
  const link = await running.services.invitations.create(issuer, {}, 'PicoSalesBot');
  return new URL(link.url).searchParams.get('start')!.slice(7);
}

test('only admins or direct supervisors can remove members, including disabled reports', async () => {
  const { auth } = running.services;
  const own = await user('manager', firstLeader.id);
  const disabled = await user('manager', firstLeader.id, false);
  const foreign = await user('manager', secondLeader.id);
  const stale = await user('supervisor');
  const staleReport = await user('manager', stale.id);
  const demoId = randomUUID();
  await running.db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    demoId,
    'dev-manager',
    'Демо менеджер',
    'manager',
  ]);
  await running.db.query("UPDATE users SET role='manager' WHERE id=$1", [stale.id]);
  const ownPath = '/users/' + own.id;

  await api('delete', ownPath).expect(401);
  await api('delete', ownPath, foreign).expect(403);
  await api('delete', ownPath, secondLeader).expect(403);
  await api('delete', '/users/' + secondLeader.id, firstLeader).expect(403);
  await api('delete', '/users/not-an-id', admin).expect(400);
  await api('delete', '/users/' + randomUUID(), admin).expect(404);
  await api('delete', '/users/' + demoId, admin).expect(404);
  await assert.rejects(auth.removeTeamMember(stale, staleReport.id), { status: 403 });
  const removed = await api('delete', ownPath, firstLeader).expect(204);
  assert.equal(removed.text, '');
  await api('delete', ownPath, firstLeader).expect(404);
  await api('delete', '/users/' + disabled.id, firstLeader).expect(204);
  await api('delete', '/users/' + foreign.id, admin).expect(204);
  const [row] = await running.db.query(
    "SELECT actor_id,details FROM audit WHERE action='user.removed_from_team' AND entity_id=$1",
    [own.id],
  );
  assert.equal(row.actor_id, firstLeader.id);
  assert.deepEqual(row.details, { role: 'manager', supervisorId: firstLeader.id });
});

test('removal revokes the old account, keeps its CRM history and only a fresh invite opens a new account', async () => {
  const { auth, invitations } = running.services;
  const employee = await user('manager', firstLeader.id);
  const blocked = await user('manager', secondLeader.id, false);
  const oldSession = auth.issue(employee);
  const clientId = randomUUID();
  const taskId = randomUUID();
  const fileId = randomUUID();
  await running.db.query('INSERT INTO companies(id,owner_id,data) VALUES($1,$2,$3)', [
    clientId,
    employee.id,
    JSON.stringify({ name: 'Компания прежней команды' }),
  ]);
  await running.db.query(
    "INSERT INTO records(id,kind,company_id,author_id,assignee_id,data) VALUES($1,'task',$2,$3,$3,$4),($5,'file',$2,$3,NULL,$6)",
    [
      taskId,
      clientId,
      employee.id,
      JSON.stringify({ text: 'Старая задача', done: false }),
      fileId,
      JSON.stringify({ name: 'Старый файл', key: randomUUID() }),
    ],
  );
  const file = await running.services.fileDownloads.issue(employee, fileId);
  const fileToken = file.path.split('/').at(-1)!;
  const oldInvite = await invite(secondLeader);
  await api('get', '/me', oldSession).expect(200);
  await api('delete', '/users/' + employee.id, firstLeader).expect(204);

  await api('get', '/me', oldSession).expect(403);
  await assert.rejects(auth.byTelegram(employee.telegramId), { status: 403 });
  await assert.rejects(running.services.fileDownloads.read(fileToken), { status: 404 });
  await api('post', '/users', admin)
    .send({
      telegramId: employee.telegramId,
      name: employee.name,
      role: employee.role,
      active: true,
    })
    .expect(409);
  await api('post', '/users/admit', admin).send({ telegramId: employee.telegramId }).expect(409);
  for (const [route, leader] of [
    ['/users', admin],
    ['/users', firstLeader],
    ['/employee-filter/options', admin],
  ] as const) {
    const { body } = await api('get', route, leader).expect(200);
    assert.equal(
      body.some((row: { id: string }) => row.id === employee.id),
      false,
    );
  }
  const [old] = await running.db.query(
    'SELECT active,supervisor_id,team_removed_at FROM users WHERE id=$1',
    [employee.id],
  );
  assert.equal(old.active, false);
  assert.equal(old.supervisor_id, firstLeader.id);
  assert.ok(old.team_removed_at);
  assert.deepEqual(
    await running.db.query('SELECT owner_id FROM companies WHERE id=$1', [clientId]),
    [{ owner_id: employee.id }],
  );
  assert.deepEqual(
    await running.db.query('SELECT author_id,assignee_id FROM records WHERE id=$1', [taskId]),
    [{ author_id: employee.id, assignee_id: employee.id }],
  );
  const dashboard = await api(
    'get',
    '/dashboard?from=2026-11-01&to=2026-11-26',
    firstLeader,
  ).expect(200);
  const former = dashboard.body.find((row: { id: string }) => row.id === employee.id);
  assert.equal(former.removedFromTeam, true);
  assert.deepEqual(former.inactiveCompanies, [{ id: clientId, name: 'Компания прежней команды' }]);
  assert.ok(
    !(await running.services.dashboard.csv(firstLeader, '2026-11-01', '2026-11-26')).includes(
      employee.name,
    ),
  );

  await assert.rejects(
    invitations.redeem(oldInvite, employee.telegramId, employee.name),
    /новое приглашение/,
  );
  const newInvite = await invite(secondLeader);
  await assert.rejects(
    invitations.redeem(newInvite, blocked.telegramId, blocked.name),
    /уже добавлены/,
  );
  assert.deepEqual(await invitations.redeem(newInvite, employee.telegramId, employee.name), {
    alreadyJoined: false,
  });
  const rejoined = await auth.byTelegram(employee.telegramId);
  assert.notEqual(rejoined.id, employee.id);
  assert.equal(rejoined.supervisorId, secondLeader.id);
  const newClients = await api('get', '/companies', rejoined).expect(200);
  assert.deepEqual(newClients.body, []);
  await api('get', '/me', oldSession).expect(403);
  await assert.rejects(running.services.fileDownloads.read(fileToken), { status: 404 });
  await api('delete', '/users/' + rejoined.id, firstLeader).expect(403);
  const staleUpdate = {
    telegramId: employee.telegramId,
    expectedUserId: employee.id,
    name: 'Устаревшее изменение роли и команды',
    role: 'admin',
    active: false,
  };
  await api('post', '/users', admin).send(staleUpdate).expect(409);
  await api('post', '/users', admin)
    .send({ ...staleUpdate, expectedUserId: randomUUID(), telegramId: String(++sequence) })
    .expect(409);
  assert.deepEqual(await auth.byTelegram(employee.telegramId), rejoined);
  const updated = await api('post', '/users', admin)
    .send({
      ...staleUpdate,
      expectedUserId: rejoined.id,
      role: 'manager',
      active: true,
      name: 'Новое имя',
    })
    .expect(201);
  assert.equal(updated.body.id, rejoined.id);
  assert.equal(updated.body.supervisorId, secondLeader.id);
  assert.equal(updated.body.expectedUserId, undefined);
  const companyPath = `/companies/${clientId}`;
  const ownDetail = await api('get', companyPath, firstLeader).expect(200);
  assert.equal(ownDetail.body.canManageOwnership, true);
  const otherDetail = await api('get', companyPath, secondLeader).expect(200);
  assert.equal(otherDetail.body.canManageOwnership, false);
  await api('post', `${companyPath}/assign`, firstLeader)
    .send({ ownerId: firstLeader.id, version: ownDetail.body.company.version })
    .expect(201);
  assert.deepEqual(
    await running.db.query('SELECT author_id,assignee_id FROM records WHERE id=$1', [taskId]),
    [{ author_id: employee.id, assignee_id: firstLeader.id }],
  );
});

test('admin removal detaches current reports, retains historical links, and protects the last active admin', async () => {
  const leader = await user('supervisor');
  const report = await user('manager', leader.id);
  const former = await user('manager', leader.id);
  const expiredTeamLink = await invite(leader);
  await api('delete', '/users/' + former.id, leader).expect(204);
  await api('delete', '/users/' + leader.id, admin).expect(204);
  const team = await running.db.query(
    'SELECT id,supervisor_id FROM users WHERE id IN ($1,$2) ORDER BY supervisor_id DESC NULLS LAST',
    [former.id, report.id],
  );
  assert.deepEqual(team, [
    { id: former.id, supervisor_id: leader.id },
    { id: report.id, supervisor_id: null },
  ]);
  await assert.rejects(
    running.services.invitations.redeem(expiredTeamLink, String(++sequence), 'Ещё сотрудник'),
    /не действует/,
  );

  await api('delete', '/users/' + admin.id, admin).expect(409);
  const substituteAdmin = await user('admin');
  await api('delete', '/users/' + admin.id, admin).expect(204);
  const { auth, invitations } = running.services;
  await assert.rejects(auth.byTelegram(admin.telegramId), { status: 403 });
  const newInvite = await invite(secondLeader);
  await invitations.redeem(newInvite, admin.telegramId, 'Бывший администратор');
  const rejoined = await auth.byTelegram(admin.telegramId);
  assert.notEqual(rejoined.id, admin.id);
  assert.equal(rejoined.role, 'manager');
  await api('get', '/me', admin).expect(403);
  await api('delete', '/users/' + substituteAdmin.id, substituteAdmin).expect(409);
});
