import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import type { HandoffQueue, RemovalHandoff } from '../shared/client-handoff';
import {
  Actor,
  CompanyData,
  companySchema,
  projectSchema,
  Role,
  taskSchema,
} from '../shared/contracts';
import { makeConfig } from '../server/config';
import { createApp } from '../server/http/app';

let app: Awaited<ReturnType<typeof createApp>>;
let dir: string;
let pool: Pool | undefined;
let schema: string | undefined;
let sequence = 75000000;
let admin: Actor, lead: Actor, otherLead: Actor, former: Actor, peer: Actor, other: Actor;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pico-handoff-'));
  let databaseUrl = '';
  if (process.env.TEST_DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = 'handoff_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE SCHEMA ${schema}`);
    const configUrl = new URL(process.env.TEST_DATABASE_URL);
    configUrl.searchParams.set('options', '-c search_path=' + schema);
    databaseUrl = configUrl.toString();
  }
  app = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      DATABASE_URL: databaseUrl,
      WORKER_ENABLED: 'false',
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
      SESSION_SECRET: 'pico-client-handoff-tests-at-least-32-chars',
    }),
  );
});
beforeEach(async () => {
  await app.db.query('TRUNCATE audit,records,companies,users CASCADE');
  admin = await employee('admin', 'Администратор');
  lead = await employee('supervisor', 'Вадим');
  otherLead = await employee('supervisor', 'Ирина');
  former = await employee('manager', 'Юрий', lead.id);
  peer = await employee('manager', 'Анна', lead.id);
  other = await employee('manager', 'Олег', otherLead.id);
});
after(async () => {
  await app?.app.close();
  await app?.db.close();
  if (pool && schema) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool?.end();
  if (dir) await rm(dir, { force: true, recursive: true });
});

async function employee(
  role: Role,
  name: string,
  supervisorId: string | null = null,
  active = true,
): Promise<Actor> {
  const actor: Actor = {
    id: randomUUID(),
    name,
    role,
    active,
    supervisorId,
    telegramId: String(++sequence),
  };
  await app.db.query(
    'INSERT INTO users(id,telegram_id,name,role,active,supervisor_id) VALUES($1,$2,$3,$4,$5,$6)',
    [actor.id, actor.telegramId, actor.name, actor.role, actor.active, actor.supervisorId],
  );
  return actor;
}

async function company(owner: Actor, name: string, extra: Partial<CompanyData> = {}) {
  const id = randomUUID();
  await app.db.query('INSERT INTO companies(id,owner_id,data) VALUES($1,$2,$3)', [
    id,
    owner.id,
    JSON.stringify(companySchema.parse({ name, ...extra })),
  ]);
  return id;
}

async function record(
  kind: 'task' | 'project',
  companyId: string,
  author: Actor,
  input: unknown,
  assignee: Actor | null = null,
  projectId: string | null = null,
  deleted = false,
) {
  const id = randomUUID();
  const value = (kind === 'task' ? taskSchema : projectSchema).parse(input);
  await app.db.query(
    'INSERT INTO records(id,kind,company_id,author_id,assignee_id,data,project_id,deleted) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      id,
      kind,
      companyId,
      author.id,
      assignee?.id ?? null,
      JSON.stringify(value),
      projectId,
      deleted,
    ],
  );
  return id;
}

function api(actor: Actor, method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  return request(app.app.getHttpServer())
    [method]('/api' + path)
    .set('Authorization', 'Bearer ' + app.services.auth.issue(actor));
}

const queue = async (actor: Actor): Promise<HandoffQueue> =>
  (await api(actor, 'get', '/client-handoff').expect(200)).body;
const preview = async (actor: Actor, member = former): Promise<RemovalHandoff> =>
  (await api(actor, 'get', '/users/' + member.id + '/handoff').expect(200)).body;
const remove = (actor: Actor, member = former) => api(actor, 'delete', '/users/' + member.id);
const owner = async (id: string) =>
  (await app.db.query('SELECT owner_id FROM companies WHERE id=$1', [id]))[0].owner_id;
const assignee = async (id: string) =>
  (await app.db.query('SELECT assignee_id FROM records WHERE id=$1', [id]))[0].assignee_id;

test('deferred queue scopes former work, skips closed or blocked-only cards and sorts priority', async () => {
  const open = await company(former, 'Северный привод');
  const undated = await company(former, 'Вектор');
  const closed = await company(former, 'Закрытый', { stage: 'closed' });
  await company(former, 'Архивный', { archived: true });
  await company(other, 'Чужой');
  const blocked = await employee('manager', 'Заблокированный', lead.id, false);
  await company(blocked, 'Временно заблокирован');
  const elsewhere = await company(other, 'С действующим владельцем');
  const first = await record('project', open, former, {
    name: 'Поставка',
    due: '2026-01-10',
    stage: 'proposal',
  });
  await record('project', open, former, { name: 'Завершённый проект', stage: 'closed' });
  const work = await record(
    'task',
    open,
    former,
    { text: 'Отправить КП', due: '2026-01-12' },
    former,
    first,
  );
  await record('task', closed, former, { text: 'В закрытой компании' }, former);
  await record('task', open, former, { text: 'Выполнено', done: true }, former);
  await record('task', open, former, { text: 'Удалена', deleted: true }, former);
  await record('task', open, former, { text: 'Удалена как запись' }, former, null, true);
  await record('task', open, peer, { text: 'Чужое назначение' }, peer);
  const separate = await record('task', elsewhere, former, { text: 'Отдельная задача' }, former);

  assert.deepEqual(await queue(lead), { companies: [], tasks: [] });
  await api(otherLead, 'get', '/users/' + former.id + '/handoff').expect(403);
  await api(peer, 'get', '/client-handoff').expect(403);
  await remove(lead).expect(204);
  const result = await queue(lead);
  assert.deepEqual(
    result.companies.map(({ id }) => id),
    [open, undated],
  );
  assert.deepEqual(result.companies[0]!.formerOwner, { id: former.id, name: former.name });
  assert.deepEqual(result.companies[0]!.projects, [
    { id: first, name: 'Поставка', stage: 'proposal', due: '2026-01-10' },
  ]);
  assert.deepEqual(result.companies[0]!.tasks, [
    { id: work, text: 'Отправить КП', due: '2026-01-12' },
  ]);
  assert.deepEqual(
    new Set(result.companies[0]!.candidates.map(({ id }) => id)),
    new Set([lead.id, peer.id]),
  );
  assert.deepEqual(
    result.tasks.map(({ id, companyId }) => [id, companyId]),
    [[separate, elsewhere]],
  );
  assert.deepEqual(
    new Set(result.tasks[0]!.candidates.map(({ id }) => id)),
    new Set([other.id, lead.id]),
  );
  assert.deepEqual(await queue(otherLead), { companies: [], tasks: [] });
  assert.deepEqual(await queue(admin), result);
  assert.equal(await owner(open), former.id);
  assert.equal(await assignee(separate), former.id);
});

test('queue company handoff rejects inaccessible and stale changes; peers, history and company of a standalone task stay put', async () => {
  const client = await company(former, 'На передачу');
  const foreignClient = await company(other, 'Остаётся у Олега');
  const project = await record('project', client, former, { name: 'Новый проект' });
  const open = await record('task', client, former, { text: 'Открытая задача' }, former, project);
  const completed = await record('task', client, former, { text: 'Выполнено', done: true }, former);
  const peerTask = await record('task', client, peer, { text: 'Задача коллеги' }, peer);
  const standalone = await record(
    'task',
    foreignClient,
    former,
    { text: 'Чужая компания' },
    former,
  );
  await remove(lead).expect(204);
  const first = (await queue(lead)).companies[0]!;
  const command = { recipientId: peer.id, revision: first.revision, version: first.version };
  const companyPath = '/client-handoff/companies/' + client;
  await api(otherLead, 'post', companyPath).send(command).expect(404);
  await api(admin, 'post', companyPath)
    .send({ ...command, recipientId: other.id })
    .expect(403);
  await app.db.query('UPDATE records SET version=version+1 WHERE id=$1', [open]);
  await api(lead, 'post', companyPath).send(command).expect(409);
  const current = (await queue(lead)).companies[0]!;
  assert.equal(first.version, current.version);
  assert.notEqual(first.revision, current.revision);
  await api(lead, 'post', companyPath)
    .send({ ...command, revision: current.revision })
    .expect(204);
  assert.equal(await owner(client), peer.id);
  assert.equal(await assignee(open), peer.id);
  assert.equal(await assignee(completed), former.id);
  assert.equal(await assignee(peerTask), peer.id);
  const [details] = await app.db.query('SELECT author_id,company_id FROM records WHERE id=$1', [
    project,
  ]);
  assert.deepEqual(details, { author_id: former.id, company_id: client });
  const next = await queue(lead);
  assert.deepEqual(next.companies, []);
  assert.equal(next.tasks[0]!.id, standalone);
  const taskPath = '/client-handoff/tasks/' + standalone;
  await api(lead, 'post', taskPath)
    .send({ recipientId: peer.id, version: next.tasks[0]!.version })
    .expect(403);
  await api(lead, 'post', taskPath)
    .send({ recipientId: other.id, version: next.tasks[0]!.version + 1 })
    .expect(409);
  await api(lead, 'post', taskPath)
    .send({ recipientId: other.id, version: next.tasks[0]!.version })
    .expect(204);
  assert.equal(await owner(foreignClient), other.id);
  assert.equal(await assignee(standalone), other.id);
  assert.deepEqual(await queue(lead), { companies: [], tasks: [] });
});

test('immediate removal checks exact portfolio preview, moves open work and returns a standalone task to the active company owner', async () => {
  const client = await company(former, 'Портфель Юрия');
  const elsewhere = await company(other, 'Клиент другой команды');
  const project = await record('project', client, former, { name: 'В работе' });
  const open = await record('task', client, former, { text: 'Подготовить КП' }, former, project);
  const alone = await record(
    'task',
    elsewhere,
    former,
    { text: 'Действие на чужой карточке' },
    former,
  );
  const first = await preview(lead);
  assert.deepEqual(
    [
      first.companyCount,
      first.projectCount,
      first.taskCount,
      first.separateTaskCount,
      first.unassignableTaskCount,
    ],
    [1, 1, 2, 1, 0],
  );
  assert.equal(first.suggestedRecipientId, lead.id);
  await record('task', client, former, { text: 'Задача после просмотра' }, former);
  await remove(lead).send({ recipientId: peer.id, revision: first.revision }).expect(409);
  await api(former, 'get', '/me').expect(200);
  assert.equal(await owner(client), former.id);
  const latest = await preview(lead);
  await remove(lead).send({ revision: latest.revision }).expect(400);
  await remove(lead).send({ recipientId: peer.id, revision: latest.revision }).expect(204);
  await api(former, 'get', '/me').expect(403);
  assert.equal(await owner(client), peer.id);
  assert.equal(await assignee(open), peer.id);
  assert.equal(await owner(elsewhere), other.id);
  assert.equal(await assignee(alone), other.id);
  assert.deepEqual(await queue(lead), { companies: [], tasks: [] });
});

test('INN and holding conflicts leave immediate removal atomic and keep deferred cards available', async () => {
  const early = await company(former, 'Первая компания');
  const earlyTask = await record(
    'task',
    early,
    former,
    { text: 'Срочно', due: '2026-01-01' },
    former,
  );
  const duplicate = await company(former, 'Дубль в другом портфеле', { inn: '7707083893' });
  await company(peer, 'Уже есть у Анны', { inn: '7707083893' });
  await record('task', duplicate, former, { text: 'Позже', due: '2026-01-02' }, former);
  const holding = await company(former, 'Холдинг', { segment: 'holding' });
  const child = await company(former, 'Заказчик холдинга', { holdingId: holding });
  const snapshot = await preview(lead);
  const duplicateError = await remove(lead)
    .send({ recipientId: peer.id, revision: snapshot.revision })
    .expect(409);
  assert.match(duplicateError.body.message, /с таким ИНН/);
  await api(former, 'get', '/me').expect(200);
  assert.equal(await owner(early), former.id);
  assert.equal(await assignee(earlyTask), former.id);
  await remove(lead).send({ recipientId: lead.id, revision: snapshot.revision }).expect(409);
  await api(former, 'get', '/me').expect(200);
  assert.equal(await owner(early), former.id);
  assert.equal(await owner(holding), former.id);
  assert.equal(await owner(child), former.id);
  await remove(lead).expect(204);
  const item = (await queue(lead)).companies.find(({ id }) => id === holding)!;
  const failed = await api(lead, 'post', '/client-handoff/companies/' + holding)
    .send({ recipientId: lead.id, version: item.version, revision: item.revision })
    .expect(409);
  assert.match(failed.body.message, /отсоедините заказчиков/i);
  const pending = (await queue(lead)).companies;
  assert.ok(pending.some(({ id }) => id === holding));
  const pendingChild = pending.find(({ id }) => id === child)!;
  const childFailure = await api(lead, 'post', '/client-handoff/companies/' + child)
    .send({ recipientId: lead.id, version: pendingChild.version, revision: pendingChild.revision })
    .expect(409);
  assert.match(childFailure.body.message, /снимите связь с холдингом/i);

  await api(lead, 'patch', '/companies/' + child)
    .send({
      version: pendingChild.version,
      data: companySchema.parse({ name: 'Заказчик холдинга', holdingId: null }),
    })
    .expect(200);
  for (const id of [holding, child]) {
    const available = (await queue(lead)).companies.find((company) => company.id === id)!;
    await api(lead, 'post', '/client-handoff/companies/' + id)
      .send({ recipientId: lead.id, version: available.version, revision: available.revision })
      .expect(204);
    assert.equal(await owner(id), lead.id);
  }
  const [childAfterTransfer] = await app.db.query('SELECT version FROM companies WHERE id=$1', [
    child,
  ]);
  const reconnected = await api(lead, 'patch', '/companies/' + child)
    .send({
      version: childAfterTransfer.version,
      data: companySchema.parse({ name: 'Заказчик холдинга', holdingId: holding }),
    })
    .expect(200);
  assert.equal(reconnected.body.holdingId, holding);
  assert.ok(!(await queue(lead)).companies.some(({ id }) => id === holding || id === child));
});

test('work consisting only of standalone tasks needs no company recipient; inactive owner requires deferral', async () => {
  const activeClient = await company(other, 'С активным владельцем');
  const activeTask = await record(
    'task',
    activeClient,
    former,
    { text: 'Отдельная задача' },
    former,
  );
  const ready = await preview(lead);
  assert.equal(ready.companyCount, 0);
  assert.equal(ready.separateTaskCount, 1);
  await remove(lead).send({ revision: ready.revision }).expect(204);
  assert.equal(await assignee(activeTask), other.id);

  const employee2 = await employee('manager', 'Второй участник', lead.id);
  const blockedOwner = await employee('manager', 'Заблокирован', otherLead.id, false);
  const blockedClient = await company(blockedOwner, 'Без активного владельца');
  const pending = await record(
    'task',
    blockedClient,
    employee2,
    { text: 'Некому вернуть' },
    employee2,
  );
  const blocked = await preview(lead, employee2);
  assert.equal(blocked.unassignableTaskCount, 1);
  await remove(lead, employee2).send({ revision: blocked.revision }).expect(409);
  await api(employee2, 'get', '/me').expect(200);
  await remove(lead, employee2).expect(204);
  const pendingTask = (await queue(lead)).tasks[0]!;
  assert.equal(pendingTask.id, pending);
  assert.ok(!pendingTask.candidates.some(({ id }) => id === blockedOwner.id));
  assert.equal(await assignee(pending), employee2.id);
  await api(lead, 'post', '/client-handoff/tasks/' + pending)
    .send({ recipientId: lead.id, version: pendingTask.version })
    .expect(204);
  assert.equal(await owner(blockedClient), blockedOwner.id);
  assert.equal(await assignee(pending), lead.id);
});
