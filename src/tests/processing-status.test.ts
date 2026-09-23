import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor, extractionSchema } from '../shared/contracts';
import { Messenger, ProcessingMessageUndeletable, TelegramAdapter } from '../server/infra/telegram';
import { ReportWorker } from '../server/services/worker';
import { DomainError } from '../server/domain/errors';

test('durable processing messages disappear before results and survive retries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-processing-status-'));
  const config = makeConfig({ DATA_DIR: dir, BOT_TOKEN: 'test', WORKER_ENABLED: 'false' });
  const { app, services: s, db } = await createApp(config);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('No external calls in this test');
  });
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '4321',
    name: 'Manager',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    actor.id,
    actor.telegramId,
    actor.name,
    actor.role,
  ]);
  const events: { action: string; id?: string; text?: string }[] = [];
  let sequence = 0;
  let failDelete = false;
  let forbidDelete = false;
  const telegram: Messenger = {
    download: async () => new Uint8Array([1]),
    send: async (_chat, payload) => {
      events.push({ action: 'result', text: payload.text });
    },
    sendProcessing: async (_chat, text) => {
      const id = ++sequence;
      events.push({ action: 'status', id: String(id), text });
      return id;
    },
    editProcessing: async (_chat, id, text) => {
      events.push({ action: 'edit', id, text });
      return true;
    },
    deleteProcessing: async (_chat, id) => {
      if (forbidDelete) throw new ProcessingMessageUndeletable();
      if (failDelete) throw new Error('Temporary Telegram failure');
      events.push({ action: 'delete', id });
    },
  };
  const draft = extractionSchema.parse({
    blocks: [
      {
        companyName: 'Ромашка',
        summary: 'Обсудили поставку',
        inn: null,
        city: null,
        segment: null,
        stage: null,
        potential: null,
        divisions: [],
        occurredOn: '2026-09-23',
        contacts: [],
        tasks: [],
      },
    ],
    warnings: [],
  });
  const worker = (extract = async () => draft, transcript = '') =>
    new ReportWorker(
      db,
      s.reports,
      { transcribe: async () => transcript },
      { extract },
      telegram,
      config,
      s.voiceSignatures,
      s.letterBot,
      undefined,
      s.voiceContacts,
    );
  const enqueue = (voice = false) =>
    s.reports.enqueue(actor, {
      sourceKey: randomUUID(),
      chatId: actor.telegramId,
      ...(voice ? { audioFileId: 'audio' } : { text: 'Обсудили поставку оборудования' }),
    });
  const reset = async () => {
    await db.query('DELETE FROM outbox');
    await db.query('DELETE FROM processing_messages');
    await db.query('DELETE FROM signature_drafts');
    await db.query('DELETE FROM letter_jobs');
    await db.query('DELETE FROM reports');
    events.length = 0;
    failDelete = false;
    forbidDelete = false;
  };
  try {
    await t.test(
      'a blocked extractor does not block status delivery; result removes status first',
      async () => {
        const report = await enqueue();
        let release!: () => void;
        let extracting!: () => void;
        const started = new Promise<void>((resolve) => {
          extracting = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const w = worker(async () => {
          extracting();
          await hold;
          return draft;
        });
        const processing = w.processOne();
        await started;
        await w.deliverOne();
        assert.equal(events[0]?.action, 'status');
        assert.match(events[0]?.text || '', /черновик/);
        assert.equal(
          (await db.query('SELECT status FROM reports WHERE id=$1', [report.id]))[0].status,
          'processing',
        );
        release();
        await processing;
        await w.deliverOne();
        assert.deepEqual(
          events.map((e) => e.action),
          ['status', 'delete', 'result'],
        );
        assert.equal(
          (await db.query('SELECT active,message_id FROM processing_messages'))[0].message_id,
          null,
        );
        await reset();
      },
    );
    await t.test(
      'stage edits reuse one ID; a new worker resumes cleanup from the database',
      async () => {
        await enqueue();
        const [row] = await db.query('SELECT * FROM processing_messages');
        await worker().deliverOne();
        await s.reports.processing.stage(row.source_key, 'Собираю данные…');
        await worker().deliverOne();
        assert.deepEqual(
          events.map((e) => e.action),
          ['status', 'edit'],
        );
        assert.equal(events[0]!.id, events[1]!.id);
        await s.reports.processing.run(row.source_key, () =>
          s.reports.notify(db, actor.telegramId, { text: 'Готово' }),
        );
        await worker().deliverOne();
        assert.deepEqual(
          events.map((e) => e.action),
          ['status', 'edit', 'delete', 'result'],
        );
        await reset();
      },
    );
    await t.test(
      'cancel removes visible status and a stale in-flight result never appears',
      async () => {
        const report = await enqueue();
        let release!: () => void;
        let extracting!: () => void;
        const started = new Promise<void>((resolve) => {
          extracting = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const w = worker(async () => {
          extracting();
          await hold;
          return draft;
        });
        const processing = w.processOne();
        await started;
        await w.deliverOne();
        await s.reports.transition(actor, report.id, 'cancel');
        await w.deliverOne();
        release();
        await processing;
        await w.deliverOne();
        assert.deepEqual(
          events.map((e) => e.action),
          ['status', 'delete'],
        );
        assert.equal((await db.query('SELECT active FROM processing_messages'))[0].active, false);
        await reset();
      },
    );
    await t.test(
      'a failed deletion delays the result; recovery never duplicates the status',
      async () => {
        await enqueue();
        const w = worker();
        await w.deliverOne();
        const [row] = await db.query('SELECT * FROM processing_messages');
        await s.reports.processing.run(row.source_key, () =>
          s.reports.notify(db, actor.telegramId, { text: 'Готово' }),
        );
        failDelete = true;
        for (let i = 0; i < 6; i++) {
          await db.query('UPDATE outbox SET available_at=now()');
          await w.deliverOne();
        }
        assert.deepEqual(
          events.map((e) => e.action),
          ['status'],
        );
        assert.equal((await db.query('SELECT sent FROM outbox'))[0].sent, false);
        assert.equal((await db.query('SELECT attempts FROM outbox'))[0].attempts, 0);
        failDelete = false;
        await db.query('UPDATE outbox SET available_at=now()');
        await w.deliverOne();
        assert.deepEqual(
          events.map((e) => e.action),
          ['status', 'delete', 'result'],
        );
        await reset();
      },
    );
    await t.test(
      'permanently forbidden deletion is logged once and does not suppress the final result',
      async () => {
        await enqueue();
        const w = worker();
        await w.deliverOne();
        const [row] = await db.query('SELECT * FROM processing_messages');
        await s.reports.processing.run(row.source_key, () =>
          s.reports.notify(db, actor.telegramId, { text: 'Готово' }),
        );
        forbidDelete = true;
        await w.deliverOne();
        await w.deliverOne();
        assert.deepEqual(
          events.map((e) => e.action),
          ['status', 'result'],
        );
        assert.equal((await db.query('SELECT sent FROM outbox'))[0].sent, true);
        assert.equal(
          (await db.query('SELECT message_id FROM processing_messages'))[0].message_id,
          null,
        );
        const logs = await db.query(
          "SELECT details FROM error_logs WHERE event='telegram.processing_delete_forbidden'",
        );
        assert.equal(logs.length, 1);
        assert.equal(logs[0].details.entityId, `${row.source_key}:${row.message_id}`);
        await reset();
      },
    );
    await t.test(
      'manual retry supersedes an old queued failure without clearing its new status',
      async () => {
        const report = await enqueue();
        const w = worker();
        await w.deliverOne();
        const [row] = await db.query('SELECT * FROM processing_messages');
        await s.reports.processing.run(row.source_key, () =>
          s.reports.notify(db, actor.telegramId, { text: 'Old failure' }),
        );
        await db.query("UPDATE reports SET status='failed' WHERE id=$1", [report.id]);
        await s.reports.transition(actor, report.id, 'retry');
        await w.deliverOne();
        assert.ok(!events.some((e) => e.action === 'delete' || e.action === 'result'));
        assert.equal((await db.query('SELECT active FROM processing_messages'))[0].active, true);
        await reset();
      },
    );
    await t.test(
      'terminal processing failure is delivered only after the temporary text is removed',
      async () => {
        await enqueue();
        const w = worker(async () => {
          throw new DomainError(422, 'Не удалось разобрать запрос');
        });
        await w.deliverOne();
        await w.processOne();
        await w.deliverOne();
        assert.deepEqual(
          events.map((e) => e.action),
          ['status', 'delete', 'result'],
        );
        assert.match(events[2]!.text || '', /Не удалось/);
        await reset();
      },
    );
    await t.test(
      'voice signature and contact clarification replies share the same cleanup lifecycle',
      async () => {
        for (const command of ['Добавь подпись', 'Создай контакт']) {
          await enqueue(true);
          const w = worker(undefined, command);
          await w.deliverOne();
          await w.processOne();
          await w.deliverOne();
          assert.deepEqual(
            events.map((e) => e.action),
            ['status', 'delete', 'result'],
            command,
          );
          assert.equal((await db.query('SELECT active FROM processing_messages'))[0].active, false);
          await reset();
        }
      },
    );
    await t.test(
      'voice-to-letter handoff retains one active status until the letter result',
      async () => {
        await s.letters.writeSignature(actor, {
          lastName: 'Петров',
          firstName: 'Пётр',
          patronymic: '',
          email: '',
          workPhone: '',
          mobilePhone: '',
        });
        await enqueue(true);
        const w = worker(undefined, 'Подготовь письмо АО Стройтрансгаз');
        await w.deliverOne();
        await w.processOne();
        await w.deliverOne();
        const rows = await db.query('SELECT * FROM processing_messages');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].active, true);
        assert.equal(events.filter((e) => e.action === 'status').length, 1);
        s.letters.structured = async () => {
          throw new DomainError(422, 'Уточните компанию');
        };
        await s.letterBot.tick();
        await w.deliverOne();
        assert.deepEqual(
          events.slice(-2).map((e) => e.action),
          ['delete', 'result'],
        );
        await reset();
      },
    );
    await t.test('fast completion skips obsolete status delivery altogether', async () => {
      await enqueue();
      const w = worker();
      await w.processOne();
      await w.deliverOne();
      assert.deepEqual(
        events.map((e) => e.action),
        ['result'],
      );
    });
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Telegram processing adapter accepts repeated edit/delete but does not hide network failures', async (t) => {
  const telegram = new TelegramAdapter(makeConfig({ BOT_TOKEN: 'test' }));
  let description = 'Bad Request: message is not modified';
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    requests.push(JSON.parse(options?.body as string));
    return new Response(JSON.stringify({ ok: false, error_code: 400, description }), {
      status: 400,
    });
  });
  assert.equal(await telegram.editProcessing('123', '456', 'Думаю…'), true);
  description = 'Bad Request: message to edit not found';
  assert.equal(await telegram.editProcessing('123', '456', 'Думаю…'), false);
  description = 'Bad Request: message to delete not found';
  await telegram.deleteProcessing('123', '456');
  description = "Bad Request: message can't be deleted";
  await assert.rejects(telegram.deleteProcessing('123', '456'), ProcessingMessageUndeletable);
  description = 'Bad Request: not enough rights to delete messages';
  await assert.rejects(telegram.deleteProcessing('123', '456'), ProcessingMessageUndeletable);
  description = 'Bad Request: something else';
  await assert.rejects(telegram.deleteProcessing('123', '456'), /Telegram/);
  assert.ok(requests.every((r) => r.chat_id === '123' && r.message_id === 456));
});

test('background status delivery runs independently while processing is busy and stops cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = new ReportWorker(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    makeConfig({}),
  );
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let processCalls = 0;
  let deliveryCalls = 0;
  t.mock.method(w, 'processOne', async () => {
    processCalls++;
    await hold;
    return true;
  });
  t.mock.method(w, 'deliverOne', async () => {
    deliveryCalls++;
  });
  w.start();
  w.start();
  t.mock.timers.tick(1500);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(processCalls, 1);
  assert.equal(deliveryCalls, 1);
  t.mock.timers.tick(1500);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(processCalls, 1);
  assert.equal(deliveryCalls, 2);
  release();
  await w.stop();
  t.mock.timers.tick(1500);
  assert.equal(deliveryCalls, 2);
});
