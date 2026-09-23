import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeConfig } from '../server/config';
import { createApp } from '../server/http/app';
import { ErrorLog } from '../server/infra/error-log';
import { DomainError } from '../server/domain/errors';
import { ReportWorker } from '../server/services/worker';
import { randomUUID } from 'node:crypto';

test('error log migration, HTTP errors, privacy and three-month retention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-error-log-'));
  const { app, services, db } = await createApp(makeConfig({ DATA_DIR: dir }));
  try {
    await db.migrate();
    const response = await request(app.getHttpServer()).get('/api/me?token=secret').expect(401);
    const [entry] = await db.query('SELECT * FROM error_logs');
    assert.equal(entry.status, 401);
    assert.equal(entry.request_id, response.headers['x-request-id']);
    assert.equal(entry.details.route, 'GET /api/me');
    assert.ok(!JSON.stringify(entry).includes('secret'));
    await services.errors.record(new Error('password=secret contact@example.com'), {
      event: 'test.external',
    });
    await services.errors.record(new DomainError(502, 'ИИ отклонил параметры запроса'), {
      event: 'test.ai',
    });
    const rows = await db.query('SELECT * FROM error_logs ORDER BY created_at');
    assert.ok(!JSON.stringify(rows).includes('password'));
    assert.ok(rows.some((r) => r.message === 'ИИ отклонил параметры запроса'));
    await db.query(
      "UPDATE error_logs SET created_at=now()-interval '3 months'-interval '1 day' WHERE event='test.external'",
    );
    await db.query(
      "UPDATE error_logs SET created_at=now()-interval '3 months'+interval '1 day' WHERE event='test.ai'",
    );
    await services.errors.cleanup();
    const retained = await db.query('SELECT event FROM error_logs');
    assert.ok(!retained.some((r) => r.event === 'test.external'));
    assert.ok(retained.some((r) => r.event === 'test.ai'));
    const messageId = randomUUID();
    await db.query('INSERT INTO outbox(id,chat_id,payload) VALUES($1,$2,$3)', [
      messageId,
      '123',
      '{}',
    ]);
    const worker = new ReportWorker(
      db,
      services.reports,
      { transcribe: async () => '' },
      {
        extract: async () => {
          throw new Error('unused');
        },
      },
      {
        send: async () => {
          throw new DomainError(502, 'Telegram недоступен');
        },
        download: async () => new Uint8Array(),
      },
      { ...services.config, botToken: 'test' },
    );
    await worker.deliverOne();
    const [delivery] = await db.query(
      "SELECT * FROM error_logs WHERE event='telegram.delivery_failed'",
    );
    assert.equal(delivery.details.entityId, messageId);
    assert.equal(delivery.details.attempt, 1);
    const [outbox] = await db.query('SELECT attempts FROM outbox WHERE id=$1', [messageId]);
    assert.equal(outbox.attempts, 1);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cleanup starts immediately and runs hourly without overlapping', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const queries: string[] = [];
  let release!: () => void;
  let blocked = true;
  const firstCleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const logs = new ErrorLog({
    query: async (sql) => {
      queries.push(sql);
      if (blocked) await firstCleanup;
      return [];
    },
  });
  logs.start();
  logs.start();
  assert.equal(queries.length, 1);
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(queries.length, 1, 'an in-flight cleanup must not overlap the next interval');
  blocked = false;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const expectedCleanup = [
    "DELETE FROM error_logs WHERE created_at < now() - interval '3 months'",
    "DELETE FROM diagnostic_logs WHERE created_at < now() - interval '3 months'",
  ];
  assert.deepEqual(queries, expectedCleanup);
  t.mock.timers.tick(60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queries, [...expectedCleanup, ...expectedCleanup]);
  await logs.stop();
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(queries.length, 4);
});

test('database logging failure falls back safely without recursion', async (t) => {
  const output: string[] = [];
  t.mock.method(console, 'error', (text: string) => output.push(text));
  let calls = 0;
  const logs = new ErrorLog({
    query: async () => {
      calls++;
      throw new Error('database password');
    },
  });
  await logs.record(new Error('private request'), { event: 'test.failed' });
  assert.equal(calls, 1);
  assert.match(output[0]!, /error_log.write_failed/);
  assert.doesNotMatch(output[0]!, /password|private request/);
});
