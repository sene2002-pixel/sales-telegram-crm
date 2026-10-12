import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Actor, projectSchema, taskSchema } from '../shared/contracts';
import { makeConfig } from '../server/config';
import { createApp, Services } from '../server/http/app';

let dir: string, app: any, db: any, s: Services, manager: Actor, other: Actor;
let token: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pico-mockup-records-'));
  const built = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      WORKER_ENABLED: 'false',
      DATA_DIR: dir,
      DATABASE_URL: '',
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
      SESSION_SECRET: 'local-test-session-secret-at-least-32-characters',
    }),
  );
  app = built.app;
  db = built.db;
  s = built.services;
  const login = await s.auth.dev('manager', '127.0.0.1');
  manager = login.user;
  token = login.token;
  other = {
    id: randomUUID(),
    telegramId: '8123456789',
    name: 'Другой менеджер',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    other.id,
    other.telegramId,
    other.name,
    other.role,
  ]);
});
after(async () => {
  await app?.close();
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('mockup record schemas retain legacy defaults and reject invalid time, dates and equipment', () => {
  const task = taskSchema.parse({ text: 'Старое поручение' });
  assert.equal(task.type, 'reminder');
  assert.equal(task.time, null);
  assert.equal(task.contactId, null);
  const project = projectSchema.parse({ name: 'Старый проект' });
  assert.deepEqual(project.equipment, []);
  assert.deepEqual(project.participants, []);
  assert.equal(project.purchaseDate, null);
  for (const time of ['24:00', '12:60', '9:00', '12:00:00'])
    assert.equal(taskSchema.safeParse({ text: 'A', time }).success, false);
  assert.equal(taskSchema.safeParse({ text: 'A', time: '23:59', type: 'call' }).success, true);
  assert.equal(taskSchema.safeParse({ text: 'A', type: 'fake' }).success, false);
  assert.equal(projectSchema.safeParse({ name: 'A', purchaseDate: '2026-02-30' }).success, false);
  assert.equal(
    projectSchema.safeParse({ name: 'A', equipment: [{ division: 'lv', name: 'КРУ', amount: -1 }] })
      .success,
    false,
  );
});

test('task contact links require a live contact belonging to the task company on create and update', async () => {
  const a = await s.crm.create(manager, { name: 'Моя компания контактов' });
  const b = await s.crm.create(manager, { name: 'Другая моя компания' });
  const own = await s.crm.createRecord(manager, a.id, 'contact', { name: 'Свой' });
  const cross = await s.crm.createRecord(manager, b.id, 'contact', { name: 'Не отсюда' });
  const task = await s.crm.createRecord(manager, a.id, 'task', {
    text: 'Звонок',
    contactId: own.id,
    type: 'call',
    time: '12:30',
  });
  assert.equal(task.data.contactId, own.id);
  await assert.rejects(
    s.crm.createRecord(manager, a.id, 'task', { text: 'Неверный контакт', contactId: cross.id }),
  );
  await assert.rejects(
    s.crm.updateRecord(manager, task.id, {
      version: task.version,
      data: { text: 'Неверный контакт', contactId: cross.id },
    }),
  );
  const fake = await s.crm.createRecord(manager, a.id, 'project', { name: 'Не контакт' });
  await assert.rejects(
    s.crm.createRecord(manager, a.id, 'task', { text: 'Тип ссылки', contactId: fake.id }),
  );
  await s.crm.deleteContact(manager, own.id);
  const completed = await s.crm.updateRecord(manager, task.id, {
    version: task.version,
    data: {
      text: task.data.text,
      due: task.data.due,
      done: true,
      type: task.data.type,
      time: task.data.time,
      contactId: own.id,
    },
  });
  assert.equal(completed.data.done, true);
  assert.equal(completed.data.contactId, own.id);
  assert.equal(completed.data.type, 'call');
  assert.equal(completed.data.time, '12:30');
  await assert.rejects(
    s.crm.createRecord(manager, a.id, 'task', { text: 'Удалённый контакт', contactId: own.id }),
  );
});

test('project participant links preserve visible companies and deny private companies and cross-company contacts', async () => {
  const a = await s.crm.create(manager, { name: 'Проектная компания' });
  const b = await s.crm.create(manager, { name: 'Видимый участник' });
  const privateCompany = await s.crm.create(other, { name: 'Чужой участник' });
  const contact = await s.crm.createRecord(manager, b.id, 'contact', {
    name: 'Представитель участника',
  });
  const project = await s.crm.createRecord(manager, a.id, 'project', {
    name: 'Новый объект',
    city: 'Казань',
    purchaseDate: '2026-10-14',
    equipment: [{ division: 'lv', name: 'КРУ', amount: 1000 }],
    participants: [{ companyId: b.id, role: 'Заказчик', contactId: contact.id }],
  });
  assert.equal(project.data.participants[0].contactId, contact.id);
  const detail = await s.crm.detail(manager, a.id);
  assert.equal(detail.records.find((r) => r.id === project.id)?.data.city, 'Казань');
  await assert.rejects(
    s.crm.createRecord(manager, a.id, 'project', {
      name: 'Утечка',
      participants: [{ companyId: privateCompany.id, role: 'Заказчик' }],
    }),
  );
  await assert.rejects(
    s.crm.updateRecord(manager, project.id, {
      version: project.version,
      data: { name: 'Утечка', participants: [{ companyId: privateCompany.id, role: 'Заказчик' }] },
    }),
  );
  await assert.rejects(
    s.crm.createRecord(manager, a.id, 'project', {
      name: 'Неверный контакт',
      participants: [{ companyId: a.id, role: 'Заказчик', contactId: contact.id }],
    }),
  );
  await assert.rejects(
    s.crm.createRecord(manager, a.id, 'project', {
      name: 'Отсутствующий участник',
      participants: [{ companyId: randomUUID(), role: 'Заказчик' }],
    }),
  );
  await assert.rejects(
    s.crm.createRecord(manager, a.id, 'project', {
      name: 'Дублирующийся участник',
      participants: [
        { companyId: b.id, role: 'Заказчик' },
        { companyId: b.id, role: 'Подрядчик' },
      ],
    }),
  );
  await db.query('UPDATE companies SET data=data || $2::jsonb WHERE id=$1', [
    b.id,
    JSON.stringify({ archived: true }),
  ]);
  await assert.rejects(
    s.crm.createRecord(manager, a.id, 'project', {
      name: 'Участник из архива',
      participants: [{ companyId: b.id, role: 'Заказчик' }],
    }),
  );
  const edited = await s.crm.updateRecord(manager, project.id, {
    version: project.version,
    data: { ...project.data, notes: 'Историческая ссылка сохранена' },
  });
  assert.equal(edited.data.notes, 'Историческая ссылка сохранена');
  assert.equal(edited.data.participants[0].companyId, b.id);
});

test('task deletion checks authentication, ownership and version and preserves soft-delete audit', async () => {
  const a = await s.crm.create(manager, { name: 'Компания удаляемой задачи' });
  const task = await s.crm.createRecord(manager, a.id, 'task', { text: 'Удаляемая задача' });
  const server = app.getHttpServer();
  await request(server).delete(`/api/tasks/${task.id}`).send({ version: task.version }).expect(401);
  await request(server)
    .delete(`/api/tasks/${task.id}`)
    .set('Authorization', `Bearer ${s.auth.issue(other)}`)
    .send({ version: task.version })
    .expect(404);
  await request(server)
    .delete(`/api/tasks/${task.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ version: task.version + 1 })
    .expect(409);
  assert.ok((await s.crm.records(manager, 'task')).some((r) => r.id === task.id));
  await request(server)
    .delete(`/api/tasks/${task.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ version: task.version })
    .expect(200);
  assert.ok(!(await s.crm.records(manager, 'task')).some((r) => r.id === task.id));
  assert.ok(!(await s.crm.detail(manager, a.id)).records.some((r) => r.id === task.id));
  const [row] = await db.query('SELECT deleted,version FROM records WHERE id=$1', [task.id]);
  assert.equal(row.deleted, true);
  assert.equal(row.version, task.version + 1);
  const events = await db.query('SELECT action FROM audit WHERE entity_id=$1', [task.id]);
  assert.ok(events.some((event: any) => event.action === 'task.deleted'));
  await request(server)
    .delete(`/api/tasks/${task.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ version: task.version })
    .expect(404);
});
