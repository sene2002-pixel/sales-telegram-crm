import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig } from '../server/config';
import { DomainError } from '../server/domain/errors';
import { createApp } from '../server/http/app';
import { DiagnosticLog } from '../server/infra/diagnostic-log';
import { Sql } from '../server/infra/database';

const enabledConfig = () => makeConfig({ DIAGNOSTIC_LOG_UNTIL: '2100-01-01T00:00:00Z' });

function capture() {
  const rows: {
    traceId: string;
    actorId: string | null;
    entityId: string | null;
    attempt: number | null;
    event: string;
    details: any;
    encoded: string;
  }[] = [];
  const db: Sql = {
    query: async (_sql, args = []) => {
      rows.push({
        traceId: args[0],
        actorId: args[1],
        entityId: args[2],
        attempt: args[3],
        event: args[4],
        details: JSON.parse(args[5]),
        encoded: args[5],
      });
      return [];
    },
  };
  return { rows, db };
}

test('diagnostic logging is opt-in, stops at its deadline, and rejects an invalid deadline', async () => {
  const { db, rows } = capture();
  const disabled = new DiagnosticLog(db, makeConfig({}));
  assert.equal(disabled.enabled, false);
  await disabled.record('disabled', { query: 'not stored' });
  assert.equal(await disabled.span('disabled.operation', {}, async () => 'result'), 'result');
  const expired = new DiagnosticLog(
    db,
    makeConfig({ DIAGNOSTIC_LOG_UNTIL: '2000-01-01T00:00:00Z' }),
  );
  await expired.record('expired');
  assert.equal(rows.length, 0);
  const config = enabledConfig();
  const logs = new DiagnosticLog(db, config);
  await logs.run({ traceId: 'deadline' }, async () => {
    await logs.record('before.expiry');
    config.diagnosticUntil = Date.now() - 1;
    await logs.record('after.expiry');
  });
  assert.deepEqual(
    rows.map((row) => row.event),
    ['before.expiry'],
  );
  assert.equal(logs.enabled, false);
  assert.throws(() => makeConfig({ DIAGNOSTIC_LOG_UNTIL: 'not-a-date' }), /DIAGNOSTIC_LOG_UNTIL/);
  assert.throws(
    () => makeConfig({ DIAGNOSTIC_LOG_UNTIL: '2100-01-01T00:00:00' }),
    /DIAGNOSTIC_LOG_UNTIL/,
  );
  assert.throws(() => makeConfig({ DIAGNOSTIC_LOG_UNTIL: '2100-01-01' }), /DIAGNOSTIC_LOG_UNTIL/);
  assert.equal(
    makeConfig({ DIAGNOSTIC_LOG_UNTIL: '2100-01-01T03:00:00+03:00' }).diagnosticUntil,
    enabledConfig().diagnosticUntil,
  );
});

test('diagnostic context survives async work, isolates concurrent requests and restores nested context', async () => {
  const { db, rows } = capture();
  const logs = new DiagnosticLog(db, enabledConfig());
  let releaseA!: () => void;
  let releaseB!: () => void;
  const aStarted = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const bStarted = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  await Promise.all([
    logs.run(
      { traceId: 'trace-a', actorId: 'actor-a', entityId: 'report-a', attempt: 2 },
      async () => {
        await logs.record('a.started');
        releaseA();
        await bStarted;
        await logs.run({ traceId: 'trace-a', entityId: 'letter-a' }, async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          await logs.record('a.nested');
        });
        await logs.record('a.completed');
      },
    ),
    logs.run(
      { traceId: 'trace-b', actorId: 'actor-b', entityId: 'report-b', attempt: 1 },
      async () => {
        await aStarted;
        await logs.record('b.started');
        releaseB();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await logs.record('b.completed');
      },
    ),
  ]);
  assert.equal(logs.context, undefined);
  for (const row of rows.filter((row) => row.event.startsWith('a.'))) {
    assert.equal(row.traceId, 'trace-a');
    assert.equal(row.actorId, 'actor-a');
    assert.equal(row.attempt, 2);
    assert.equal(row.entityId, row.event === 'a.nested' ? 'letter-a' : 'report-a');
  }
  for (const row of rows.filter((row) => row.event.startsWith('b.'))) {
    assert.equal(row.traceId, 'trace-b');
    assert.equal(row.actorId, 'actor-b');
    assert.equal(row.entityId, 'report-b');
    assert.equal(row.attempt, 1);
  }
  await logs.record('outside');
  assert.equal(rows.at(-1)!.traceId, 'system');
  assert.equal(rows.at(-1)!.actorId, null);
});

test('diagnostic spans record duration, return results and rethrow errors without external messages', async () => {
  const { db, rows } = capture();
  const logs = new DiagnosticLog(db, enabledConfig());
  const result = { id: 'business-result' };
  assert.equal(await logs.span('work', { model: 'test-model' }, async () => result), result);
  assert.deepEqual(
    rows.map((row) => row.event),
    ['work.started', 'work.completed'],
  );
  assert.equal(rows[0]!.details.model, 'test-model');
  assert.ok(rows[1]!.details.durationMs >= 0);

  const external = new Error('private provider body with customer details');
  await assert.rejects(
    logs.span('external', {}, async () => {
      throw external;
    }),
    (error) => error === external,
  );
  const failure = rows.at(-1)!;
  assert.equal(failure.event, 'external.failed');
  assert.equal(failure.details.errorType, 'Error');
  assert.ok(failure.details.durationMs >= 0);
  assert.equal(failure.details.message, undefined);
  assert.equal(failure.details.status, undefined);
  assert.ok(!JSON.stringify(rows).includes(external.message));

  const expected = new DomainError(422, 'Не найдена компания');
  await assert.rejects(
    logs.span('domain', {}, async () => {
      throw expected;
    }),
    (error) => error === expected,
  );
  assert.equal(rows.at(-1)!.details.status, 422);
  assert.equal(rows.at(-1)!.details.message, expected.message);
});

test('diagnostic details redact credentials, contact data and URL secrets while preserving URL comparison', async () => {
  const { db, rows } = capture();
  const config = makeConfig({
    DIAGNOSTIC_LOG_UNTIL: '2100-01-01T00:00:00Z',
    OPENAI_API_KEY: 'configured-openai-secret',
    BOT_TOKEN: 'configured-telegram-secret',
    TELEGRAM_WEBHOOK_SECRET: 'configured-webhook-secret',
    SESSION_SECRET: 'configured-session-secret',
    DATABASE_URL: 'postgres://private-user:private-password@db.example.test/crm',
  });
  const logs = new DiagnosticLog(db, config);
  const url =
    'https://url-user:url-password@example.test/company?q=private-query-value&language=ru#private-fragment';
  await logs.record('redaction', {
    request: 'Подготовь письмо для Стройтрансгаз',
    text: [
      config.apiKey,
      config.botToken,
      config.webhookSecret,
      config.sessionSecret,
      config.databaseUrl,
      'Bearer bearer-private-value',
      'sk-unconfigured-private-value',
      'token=unconfigured-token',
      'person@example.test',
      '+7 (999) 123-45-67',
    ].join(' '),
    authorization: 'auth-private-value',
    nested: {
      apiKey: 'nested-private-value',
      rawBody: 'raw-private-body',
      headers: { anything: 'header-private-value' },
    },
    sources: [url, url, url.replace('private-query-value', 'different-query-value')],
  });
  const data = rows[0]!.details;
  assert.equal(data.request, 'Подготовь письмо для Стройтрансгаз');
  assert.equal(data.authorization, '[REDACTED]');
  assert.equal(data.nested.apiKey, '[REDACTED]');
  assert.equal(data.nested.rawBody, '[REDACTED]');
  assert.equal(data.nested.headers, '[REDACTED]');
  assert.equal(data.sources[0], data.sources[1]);
  assert.notEqual(data.sources[0], data.sources[2]);
  assert.match(data.sources[0], /^https:\/\/example\.test\/company\?/);
  assert.match(data.sources[0], /sha256/);
  for (const privateValue of [
    config.apiKey,
    config.botToken,
    config.webhookSecret,
    config.sessionSecret,
    config.databaseUrl,
    'bearer-private-value',
    'sk-unconfigured-private-value',
    'unconfigured-token',
    'person@example.test',
    '+7 (999) 123-45-67',
    'auth-private-value',
    'nested-private-value',
    'raw-private-body',
    'header-private-value',
    'url-user',
    'url-password',
    'private-query-value',
    'different-query-value',
    'private-fragment',
  ])
    assert.ok(!rows[0]!.encoded.includes(privateValue), privateValue);
});

test('diagnostic URL masking preserves token differences, repeated parameter order and fragment differences', async () => {
  const { db, rows } = capture();
  const logs = new DiagnosticLog(db, enabledConfig());
  const url =
    'https://example.test/company?token=first-private-token&q=first-private-query&q=second-private-query#first-private-fragment';
  await logs.record('sources.comparison', {
    sources: [
      url,
      url,
      url.replace('first-private-token', 'second-private-token'),
      url.replace(
        'q=first-private-query&q=second-private-query',
        'q=second-private-query&q=first-private-query',
      ),
      url.replace('first-private-fragment', 'second-private-fragment'),
    ],
  });
  const sources: string[] = rows[0]!.details.sources;
  assert.equal(sources[0], sources[1]);
  for (const alternative of sources.slice(2)) assert.notEqual(sources[0], alternative);
  const first = new URL(sources[0]!);
  const changedToken = new URL(sources[2]!);
  const reordered = new URL(sources[3]!);
  assert.deepEqual([...first.searchParams.keys()], ['token', 'q', 'q']);
  assert.match(first.searchParams.get('token')!, /^sha256:[a-f0-9]{12}$/);
  assert.notEqual(first.searchParams.get('token'), changedToken.searchParams.get('token'));
  assert.deepEqual(first.searchParams.getAll('q'), changedToken.searchParams.getAll('q'));
  assert.deepEqual(first.searchParams.getAll('q'), reordered.searchParams.getAll('q').reverse());
  assert.match(first.hash, /^#sha256:[a-f0-9]{12}$/);
  assert.notEqual(first.hash, new URL(sources[4]!).hash);
  assert.doesNotMatch(rows[0]!.encoded, /private-token|private-query|private-fragment/);
});

test('diagnostic payload size, collection lengths and nesting are bounded', async () => {
  const { db, rows } = capture();
  const logs = new DiagnosticLog(db, enabledConfig());
  await logs.record('limits', {
    text: 'a'.repeat(10_000),
    values: Array.from({ length: 100 }, (_, i) => i),
    fields: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field-${i}`, i])),
  });
  assert.equal(rows[0]!.details.text.length, 4000);
  assert.equal(rows[0]!.details.values.length, 60);
  assert.equal(Object.keys(rows[0]!.details.fields).length, 60);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await logs.record('depth', { cyclic });
  assert.match(rows[1]!.encoded, /TRUNCATED/);
  await logs.record('oversized', { payload: Array.from({ length: 60 }, () => '\\"'.repeat(4000)) });
  const oversized = rows.at(-1)!;
  assert.equal(oversized.details.truncated, true);
  assert.ok(
    Buffer.byteLength(oversized.encoded, 'utf8') <= 32_000,
    `Diagnostic payload is ${Buffer.byteLength(oversized.encoded, 'utf8')} bytes`,
  );
  await logs.record('utf8.oversized', {
    payload: Array.from({ length: 6 }, () => '😀'.repeat(2000)),
  });
  const utf8 = rows.at(-1)!;
  assert.equal(utf8.details.truncated, true);
  assert.ok(Buffer.byteLength(utf8.encoded, 'utf8') <= 32_000);
});

test('diagnostic database failures do not affect work or emit console output', async (t) => {
  const output: unknown[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    t.mock.method(console, method, (...args: unknown[]) => {
      output.push(args);
    });
  let calls = 0;
  const logs = new DiagnosticLog(
    {
      query: async () => {
        calls++;
        throw new Error('database secret');
      },
    },
    enabledConfig(),
  );
  await logs.record('unavailable');
  assert.equal(await logs.span('work', {}, async () => 'still works'), 'still works');
  assert.equal(calls, 3);
  assert.deepEqual(output, []);
});

test('diagnostic savepoints preserve business writes on logging failure, and logs retain only three months', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-diagnostic-log-'));
  const { app, services, db } = await createApp(
    makeConfig({
      DATA_DIR: dir,
      WORKER_ENABLED: 'false',
      DIAGNOSTIC_LOG_UNTIL: '2100-01-01T00:00:00Z',
    }),
  );
  try {
    await db.migrate();
    const logs = new DiagnosticLog(db, enabledConfig());
    const actorId = randomUUID();
    await logs.run({ traceId: 'invalid-actor', actorId: 'not-a-uuid' }, () =>
      db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO users(id,telegram_id,name,role) VALUES($1,'diagnostic-user','Before','manager')",
          [actorId],
        );
        await logs.record('test.business', { stage: 'between writes' }, tx);
        await tx.query("UPDATE users SET name='After' WHERE id=$1", [actorId]);
      }),
    );
    assert.equal(
      (await db.query('SELECT name FROM users WHERE id=$1', [actorId]))[0]!.name,
      'After',
    );
    assert.equal(
      (await db.query("SELECT * FROM diagnostic_logs WHERE event='test.business'")).length,
      0,
    );

    await logs.run({ traceId: 'committed', actorId, entityId: 'report-one', attempt: 1 }, () =>
      db.transaction(async (tx) => {
        await logs.record('test.committed', { query: 'Подготовь письмо' }, tx);
      }),
    );
    const [committed] = await db.query(
      "SELECT * FROM diagnostic_logs WHERE event='test.committed'",
    );
    assert.equal(committed.trace_id, 'committed');
    assert.equal(committed.actor_id, actorId);
    assert.equal(committed.entity_id, 'report-one');
    assert.equal(committed.attempt, 1);
    assert.ok(committed.created_at);
    const failure = new Error('Business rollback');
    await assert.rejects(
      db.transaction(async (tx) => {
        await logs.record('test.rolled_back', {}, tx);
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(
      (await db.query("SELECT * FROM diagnostic_logs WHERE event='test.rolled_back'")).length,
      0,
    );

    await logs.record('test.old');
    await logs.record('test.recent');
    await db.query(
      "UPDATE diagnostic_logs SET created_at=now()-interval '3 months'-interval '1 day' WHERE event='test.old'",
    );
    await db.query(
      "UPDATE diagnostic_logs SET created_at=now()-interval '3 months'+interval '1 day' WHERE event='test.recent'",
    );
    await services.errors.cleanup();
    const retained = await db.query('SELECT event FROM diagnostic_logs');
    assert.ok(!retained.some((row) => row.event === 'test.old'));
    assert.ok(retained.some((row) => row.event === 'test.recent'));
    assert.ok(retained.some((row) => row.event === 'test.committed'));
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
