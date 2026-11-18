import request from 'supertest';
import test from 'node:test';
import { createApp } from '../server/http/app';
import { Pool } from 'pg';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/infra/database';
import { makeConfig } from '../server/config';
import { activeActor } from '../server/services/auth';
import { AiBudget, AiBudgetLimit } from '../server/infra/ai-budget';
import { SharedRateLimits } from '../server/infra/rate-limit';
import { DomainError } from '../server/domain/errors';

test('current user controls and shared AI admission use committed database state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-security-controls-'));
  let nativeUrl = process.env.TEST_DATABASE_URL || '';
  const schema = 'controls_' + randomUUID().replaceAll('-', '');
  const setup = nativeUrl ? new Pool({ connectionString: nativeUrl }) : null;
  if (setup) {
    await setup.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(nativeUrl);
    url.searchParams.set('options', '-c search_path=' + schema);
    nativeUrl = url.toString();
  }
  const config = makeConfig({
    DATA_DIR: dir,
    DATABASE_URL: nativeUrl,
    AI_BUDGET_ENABLED: 'true',
    AI_USER_CALLS_PER_DAY: '2',
    AI_SYSTEM_CONCURRENT: '1',
  });
  const first = new Database(config);
  await first.init();
  const second = config.databaseUrl ? new Database(config) : first;
  if (second !== first) await second.init({ migrate: false });
  t.after(async () => {
    if (second !== first) await second.close();
    await first.close();
    if (setup) {
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
    await rm(dir, { recursive: true, force: true });
  });
  const identity = 'test:' + randomUUID();
  assert.equal(await new SharedRateLimits(first).consume(identity, 1), 0);
  assert.ok((await new SharedRateLimits(second).consume(identity, 1)) > 0);
  const id = randomUUID();
  await first.query("INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,'Test','manager')", [
    id,
    id,
  ]);
  assert.equal((await first.transaction((tx) => activeActor(tx, id))).role, 'manager');
  if (second !== first) {
    await first.transaction(async (tx) => {
      await activeActor(tx, id);
      await assert.rejects(
        second.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [id]),
        (error: unknown) => (error as { code?: string }).code === '55P03',
      );
    });
    assert.equal(
      (await second.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [id])).length,
      1,
    );
  }
  const a = new AiBudget(first, config.aiBudget),
    b = new AiBudget(second, config.aiBudget);
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const end = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const pending = a.run(id, async () => {
    calls++;
    start();
    await end;
  });
  await started;
  try {
    await assert.rejects(
      b.run(id, async () => {
        calls++;
      }),
      AiBudgetLimit,
    );
    assert.equal(calls, 1);
  } finally {
    finish();
    await pending;
  }
  await assert.rejects(
    b.run(id, async () => {
      calls++;
      throw new Error('provider unavailable');
    }),
    /provider unavailable/,
  );
  const [usage] = await first.query(
    'SELECT count(*)::int AS calls, count(lease_until)::int AS leases FROM ai_budget_requests WHERE actor_id=$1',
    [id],
  );
  assert.deepEqual(usage, { calls: 2, leases: 0 });
  await assert.rejects(
    a.run(id, async () => {
      calls++;
    }),
    AiBudgetLimit,
  );
  await second.query('UPDATE users SET active=false WHERE id=$1', [id]);
  await assert.rejects(
    first.transaction((tx) => activeActor(tx, id)),
    (e: unknown) => e instanceof DomainError && e.status === 403,
  );
  assert.equal(calls, 2);
});

test('operational switches require explicit boolean values', () => {
  assert.throws(() => makeConfig({ AI_BUDGET_ENABLED: 'yes' }), /AI_BUDGET_ENABLED/);
  assert.throws(() => makeConfig({ DATABASE_MIGRATE_ON_START: 'no' }), /DATABASE_MIGRATE_ON_START/);
  assert.throws(() => makeConfig({ TRUSTED_PROXY_ADDRESSES: '*' }), /TRUSTED_PROXY_ADDRESSES/);
});

test('signature HTTP and both background queues share one AI limit without losing queued work', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-ai-contract-'));
  const config = makeConfig({
    DATA_DIR: dir,
    DEV_AUTH: 'true',
    AI_BUDGET_ENABLED: 'true',
    AI_SYSTEM_CONCURRENT: '1',
    OPENAI_API_KEY: 'test-double',
  });
  const { app, db, services } = await createApp(config);
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { user, token } = await services.auth.dev('manager', '127.0.0.1');
  const signature = {
    lastName: 'Иванов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  };
  const saved = await services.letters.writeSignature(user, signature);
  const letterId = randomUUID();
  await db.query(
    "INSERT INTO letter_jobs(id,source_key,user_id,chat_id,query,signature_id,attempts) VALUES ($1,$2,$3,$4,'Проверка',$5,2)",
    [letterId, randomUUID(), user.id, user.telegramId, saved.id],
  );
  const text = 'Рабочая встреча с заказчиком';
  const job = await services.reports.enqueue(user, { sourceKey: randomUUID(), text });
  await db.query('UPDATE reports SET attempts=2 WHERE id=$1', [job.id]);

  let start!: () => void, release!: () => void;
  const active = new Promise<void>((resolve) => {
    start = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = t.mock.method(globalThis, 'fetch', async () => {
    start();
    await released;
    return Response.json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(signature) }] }],
    });
  });
  const recognize = () =>
    request(app.getHttpServer())
      .post('/api/me/letter-signature/recognize')
      .set('Authorization', 'Bearer ' + token)
      .attach('file', Buffer.from([255, 216, 255, 0]), 'card.jpg');
  const first = recognize()
    .expect(201)
    .then((r) => r.body);
  try {
    await Promise.race([
      active,
      first.then(() => {
        throw new Error('Provider was not called');
      }),
    ]);
    const denied = await recognize().expect(429);
    assert.ok(Number(denied.headers['retry-after']) > 0);
    assert.match(denied.body.message, /лимит/);
    await services.worker.processOne();
    await services.letterBot.tick();
    const [report] = await db.query(
      'SELECT status,attempts,transcript,lease_token,available_at>now() AS waiting FROM reports WHERE id=$1',
      [job.id],
    );
    assert.deepEqual(report, {
      status: 'queued',
      attempts: 2,
      transcript: text,
      lease_token: null,
      waiting: true,
    });
    const [letter] = await db.query(
      'SELECT status,attempts,query,lease_token,available_at>now() AS waiting FROM letter_jobs WHERE id=$1',
      [letterId],
    );
    assert.deepEqual(letter, {
      status: 'queued',
      attempts: 2,
      query: 'Проверка',
      lease_token: null,
      waiting: true,
    });
    assert.equal(provider.mock.callCount(), 1);
  } finally {
    release();
    await first;
  }
  await recognize().expect(201, signature);
  assert.equal(provider.mock.callCount(), 2);
});

test('reports and letters share bounded paid queue admission and release', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-shared-ai-queue-'));
  const config = makeConfig({
    DATA_DIR: dir,
    DEV_AUTH: 'true',
    AI_BUDGET_ENABLED: 'true',
    AI_USER_QUEUE: '1',
    AI_SYSTEM_QUEUE: '2',
  });
  const { app, db, services: s } = await createApp(config);
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const owner = (await s.auth.dev('manager', '127.0.0.1')).user;
  const second = (await s.auth.dev('supervisor', '127.0.0.1')).user;
  const third = (await s.auth.dev('admin', '127.0.0.1')).user;
  const signature = {
    lastName: 'Петров',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  };
  const selected = await s.letters.writeSignature(owner, signature);
  const voice = await s.reports.enqueue(owner, {
    sourceKey: 'queue:voice',
    audioFileId: 'voice',
    chatId: owner.telegramId,
  });
  await assert.rejects(
    s.letterBot.enqueue(owner, 'queue:direct', 'Первая компания'),
    AiBudgetLimit,
  );
  assert.equal(
    (
      await s.reports.enqueue(owner, {
        sourceKey: 'queue:voice',
        audioFileId: 'voice',
        chatId: owner.telegramId,
      })
    ).id,
    voice.id,
  );
  const token = randomUUID();
  const [claimed] = await db.query(
    "UPDATE reports SET status='processing',lease_token=$2 WHERE id=$1 RETURNING *",
    [voice.id, token],
  );
  assert.equal(
    await s.letterBot.processVoice(claimed!, token, 'Подготовь письмо Первая компания'),
    true,
  );
  const [letter] = await db.query('SELECT * FROM letter_jobs WHERE source_key=$1', ['queue:voice']);
  assert.equal(letter.status, 'queued');
  assert.equal(
    (await db.query('SELECT status FROM reports WHERE id=$1', [voice.id]))[0].status,
    'cancelled',
  );
  await s.letterBot.enqueue(owner, 'queue:voice', 'Первая компания');
  const other = await s.reports.enqueue(second, { sourceKey: 'queue:second', text: 'Отчёт' });
  await assert.rejects(
    s.reports.enqueue(third, { sourceKey: 'queue:third', text: 'Отчёт' }),
    AiBudgetLimit,
  );
  // The worker's confirmed handoff to a waiting screen releases its paid slot.
  await db.query(
    "UPDATE letter_jobs SET status='waiting_signature',signature_options=$2 WHERE id=$1",
    [letter.id, JSON.stringify([{ id: selected.id, data: signature }])],
  );
  const personal = await s.reports.enqueue(owner, { sourceKey: 'queue:owner', text: 'Отчёт' });
  await assert.rejects(s.letterBot.chooseSignature(owner, letter.id, 0), AiBudgetLimit);
  assert.equal(
    (await db.query('SELECT status FROM letter_jobs WHERE id=$1', [letter.id]))[0].status,
    'waiting_signature',
  );
  await s.reports.transition(owner, personal.id, 'cancel');
  await s.letterBot.chooseSignature(owner, letter.id, 0);
  await assert.rejects(
    s.reports.enqueue(owner, { sourceKey: 'queue:owner2', text: 'Отчёт' }),
    AiBudgetLimit,
  );
  await s.reports.transition(second, other.id, 'cancel');
  await s.reports.enqueue(third, { sourceKey: 'queue:third', text: 'Отчёт' });
  await db.query("UPDATE letter_jobs SET status='waiting_signature' WHERE id=$1", [letter.id]);
  await s.letterBot.chooseSignature(owner, letter.id);
  const [cancelled] = await db.query('SELECT status FROM letter_jobs WHERE id=$1', [letter.id]);
  assert.equal(cancelled.status, 'cancelled');
  await s.reports.enqueue(owner, { sourceKey: 'queue:owner2', text: 'Отчёт' });
});
