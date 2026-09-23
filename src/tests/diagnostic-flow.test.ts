import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { ReportWorker } from '../server/services/worker';
import { Actor } from '../shared/contracts';
import { TelegramAdapter } from '../server/infra/telegram';
import { BotService } from '../server/services/bot';
import { OpenAiAdapter } from '../server/infra/ai';

test(
  'diagnostics correlate voice, letter source mismatch, retries and outbox delivery',
  { timeout: 30_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'crm-diagnostic-flow-'));
    const config = makeConfig({
      DATA_DIR: dir,
      BOT_TOKEN: 'fake-bot-credential',
      OPENAI_API_KEY: 'fake-ai-credential',
      DIAGNOSTIC_LOG_UNTIL: new Date(Date.now() + 60_000).toISOString(),
      WORKER_ENABLED: 'false',
    });

    // This regression is entirely local: any accidental external call must fail.
    const network = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('No network is permitted in diagnostic-flow.test');
    });
    const { app, services: s, db } = await createApp(config);
    const actor: Actor = {
      id: randomUUID(),
      telegramId: '12345',
      name: 'Test manager',
      role: 'manager',
      active: true,
    };
    const updateId = 453210;
    const traceId = `telegram:${updateId}`;
    const transcript = 'Подготовь письмо для АО Стройтрансгаз';
    const observedUrl = 'https://example.com/company';
    const claimedUrl = 'https://example.com/different-company';
    const delivered: { chatId: string; payload: any }[] = [];
    let transcriptions = 0;
    let researchCalls = 0;
    const worker = new ReportWorker(
      db,
      s.reports,
      {
        transcribe: async () => {
          transcriptions++;
          return transcript;
        },
      },
      {
        extract: async () => {
          throw new Error('Letter request must not become a report');
        },
      },
      {
        download: async () => new Uint8Array([1, 2, 3]),
        send: async (chatId, payload) => {
          delivered.push({ chatId, payload });
        },
      },
      config,
      s.voiceSignatures,
      s.letterBot,
      s.diagnostics,
    );
    s.letters.ai.request = async () => {
      researchCalls++;
      return {
        id: 'resp_test_search',
        _request_id: 'req_test_search',
        status: 'completed',
        output: [
          {
            id: 'search_test',
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', sources: [{ type: 'url', url: observedUrl }] },
          },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  status: 'found',
                  company: {
                    name: 'АО Стройтрансгаз',
                    inn: '7707083893',
                    city: 'Москва',
                    industry: 'Строительство',
                  },
                  recipient: { name: 'Иванов Иван Иванович', role: 'Генеральный директор' },
                  sources: [claimedUrl],
                }),
              },
            ],
          },
        ],
      };
    };
    try {
      await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
        actor.id,
        actor.telegramId,
        actor.name,
        actor.role,
      ]);
      await s.letters.writeSignature(actor, {
        lastName: 'Петров',
        firstName: 'Пётр',
        patronymic: '',
        workPhone: '',
        mobilePhone: '',
        email: '',
      });
      const update = {
        update_id: updateId,
        message: {
          message_id: 71,
          date: Math.floor(Date.now() / 1000),
          from: { id: Number(actor.telegramId) },
          chat: { id: Number(actor.telegramId), type: 'private' },
          voice: { file_id: 'test-audio-file', duration: 3, file_size: 3 },
        },
      };
      await s.bot.handle(update);
      // Telegram webhook retries must remain correlated without duplicate jobs.
      await s.bot.handle(update);
      await worker.processOne();
      await s.letterBot.tick();
      assert.equal(transcriptions, 1);
      assert.equal(researchCalls, 1);
      const [report] = await db.query('SELECT * FROM reports WHERE source_key=$1', [traceId]);
      const jobs = await db.query('SELECT * FROM letter_jobs WHERE source_key=$1', [traceId]);
      assert.equal(jobs.length, 1);
      const job = jobs[0];
      assert.equal(report.purpose, 'letter');
      assert.equal(report.transcript, null);
      assert.equal(job.query, 'АО Стройтрансгаз');
      assert.equal(job.status, 'queued');
      assert.equal(job.attempts, 1);
      assert.match(job.error, /не смог подтвердить источники/);
      assert.equal((await db.query('SELECT * FROM companies')).length, 0);

      const outbox = await db.query('SELECT * FROM outbox ORDER BY available_at,id');
      assert.equal(outbox.length, 2);
      for (const message of outbox) {
        assert.equal(message.trace_id, traceId);
        assert.equal(message.actor_id, actor.id);
        assert.equal(message.chat_id, actor.telegramId);
      }
      await worker.deliverOne();
      await worker.deliverOne();
      assert.equal(delivered.length, 2);
      assert.ok(delivered.every((message) => message.chatId === actor.telegramId));
      assert.equal((await db.query('SELECT * FROM outbox WHERE NOT sent')).length, 0);

      const logs = await db.query('SELECT * FROM diagnostic_logs ORDER BY seq');
      assert.ok(logs.length > 15);
      for (const entry of logs) {
        assert.equal(entry.trace_id, traceId, `trace of ${entry.event}`);
        // The initial receipt is intentionally recorded before authorization resolves the user.
        if (entry.event !== 'telegram.received')
          assert.equal(entry.actor_id, actor.id, `actor of ${entry.event}`);
        assert.ok(Number.isFinite(new Date(entry.created_at).getTime()));
      }
      const event = (name: string) => {
        const entry = logs.find((log) => log.event === name);
        assert.ok(entry, `missing diagnostic event ${name}`);
        return entry;
      };
      assert.equal(event('report.duplicate').details.reportId, report.id);
      assert.equal(event('voice.transcript').details.text, transcript);
      assert.equal(event('command.routed').details.route, 'letter');
      assert.equal(event('letter.enqueued').entity_id, job.id);
      assert.equal(event('letter.claimed').attempt, 1);
      assert.equal(event('letter.ai.response').details.responseId, 'resp_test_search');
      assert.equal(event('letter.ai.response').details.requestId, 'req_test_search');
      const checked = event('letter.sources.checked');
      assert.equal(checked.entity_id, job.id);
      assert.equal(checked.details.observedCount, 1);
      assert.equal(checked.details.claimedCount, 1);
      assert.equal(checked.details.unmatchedCount, 1);
      assert.equal(checked.details.matched, false);
      assert.equal(checked.details.missing, false);
      assert.deepEqual(checked.details.observed, [{ exact: observedUrl, normalized: observedUrl }]);
      assert.deepEqual(checked.details.claimed, [{ exact: claimedUrl, normalized: claimedUrl }]);
      assert.deepEqual(checked.details.unmatched, checked.details.claimed);
      assert.equal(event('letter.company_research.failed').details.status, 502);
      const retry = event('letter.processing_failed');
      assert.equal(retry.entity_id, job.id);
      assert.equal(retry.attempt, 1);
      assert.equal(retry.details.terminal, false);
      assert.equal(retry.details.nextStatus, 'queued');
      assert.equal(retry.details.retryDelaySeconds, 30);
      assert.equal(retry.details.status, 502);
      const deliveries = logs.filter((log) => log.event === 'notification.delivery.completed');
      assert.equal(deliveries.length, 2);
      for (const delivery of deliveries) {
        assert.ok(outbox.some((message) => message.id === delivery.entity_id));
        assert.equal(delivery.details.outboxId, delivery.entity_id);
        assert.ok(delivery.details.durationMs >= 0);
      }
      assert.equal(network.mock.callCount(), 0);
    } finally {
      await app.close();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'signature commands keep names, dictated contacts and previews out of diagnostics',
  { timeout: 30_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'crm-diagnostic-signature-'));
    const config = makeConfig({
      DATA_DIR: dir,
      WORKER_ENABLED: 'false',
      DIAGNOSTIC_LOG_UNTIL: new Date(Date.now() + 60_000).toISOString(),
    });
    const { app, services: s, db } = await createApp(config);
    const actor: Actor = {
      id: randomUUID(),
      telegramId: '12345',
      name: 'Manager',
      role: 'manager',
      active: true,
    };
    const privateData = {
      lastName: 'Конфиденциев',
      firstName: 'Секретослав',
      patronymic: 'Приватнович',
      workPhone: '+7 812 555-66-77 доб. 99',
      mobilePhone: '+7 900 555-44-33',
      email: 'private.signature@example.com',
    };
    const transcript = `Добавь подпись: ${privateData.lastName} ${privateData.firstName} ${privateData.patronymic}. Телефон восемь девятьсот пять пять пять четыре четыре три три. Почта прайват собака пример точка ру.`;
    const network = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('External network is forbidden');
    });
    const telegram = new TelegramAdapter(config);
    telegram.send = async () => {};
    const bot = new BotService(
      config,
      s.auth,
      s.reports,
      s.crm,
      telegram,
      s.letterBot,
      s.voiceSignatures,
      s.diagnostics,
    );
    const worker = new ReportWorker(
      db,
      s.reports,
      { transcribe: async () => transcript },
      {
        extract: async () => {
          throw new Error('Signature must not become report');
        },
      },
      { download: async () => new Uint8Array([1]), send: async () => {} },
      config,
      s.voiceSignatures,
      s.letterBot,
      s.diagnostics,
    );
    s.letters.ai.request = async () => ({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(privateData) }],
        },
      ],
    });
    const message = {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      from: { id: 12345 },
      chat: { id: 12345, type: 'private' },
    };
    try {
      await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
        actor.id,
        actor.telegramId,
        actor.name,
        actor.role,
      ]);
      await bot.handle({
        update_id: 700,
        message: { ...message, voice: { file_id: 'voice', duration: 5 } },
      });
      await worker.processOne();
      // Text commands are logged at receipt too; they must use the same privacy boundary.
      await bot.handle({ update_id: 701, message: { ...message, text: transcript } });
      const [draft] = await db.query('SELECT * FROM signature_drafts');
      assert.equal(draft.status, 'pending');
      assert.equal(draft.data.lastName, privateData.lastName);
      assert.equal(draft.data.email, privateData.email);
      assert.equal(draft.transcript, transcript);
      const preview = (await db.query('SELECT payload FROM outbox')).find((row) =>
        row.payload.text.includes('Проверьте подпись'),
      );
      assert.ok(
        preview.payload.text.includes(privateData.email),
        'the user can still review their real data',
      );
      const logs = await db.query('SELECT * FROM diagnostic_logs ORDER BY seq');
      const encoded = JSON.stringify(logs);
      for (const value of [
        ...Object.values(privateData),
        'восемь девятьсот',
        'прайват собака',
        transcript,
      ])
        assert.ok(!encoded.includes(value), `signature data leaked: ${value}`);
      const voice = logs.find((row) => row.event === 'voice.transcript');
      assert.deepEqual(voice.details, {
        redacted: 'signature',
        operation: 'create',
        characters: transcript.length,
      });
      assert.equal(voice.trace_id, 'telegram:700');
      assert.equal(voice.actor_id, actor.id);
      const receivedText = logs.find(
        (row) => row.event === 'telegram.received' && row.trace_id === 'telegram:701',
      );
      assert.equal(receivedText.details.text, '[SIGNATURE]');
      assert.ok(
        logs.some((row) => row.event === 'command.routed' && row.details.route === 'signature'),
      );
      assert.equal(network.mock.callCount(), 0);
    } finally {
      await app.close();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'HTTP diagnostics share request and actor context without URL, cookie or authorization secrets',
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crm-diagnostic-http-'));
    const {
      app,
      services: s,
      db,
    } = await createApp(
      makeConfig({
        DATA_DIR: dir,
        WORKER_ENABLED: 'false',
        DIAGNOSTIC_LOG_UNTIL: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const actor: Actor = {
      id: randomUUID(),
      telegramId: '12345',
      name: 'Manager',
      role: 'manager',
      active: true,
    };
    const querySecret = 'PrivateQuerySecret879';
    const cookieSecret = 'PrivateCookieSecret673';
    const headerSecret = 'PrivateHeaderSecret843';
    const downloadToken = 'ab'.repeat(32);
    try {
      await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
        actor.id,
        actor.telegramId,
        actor.name,
        actor.role,
      ]);
      const auth = s.auth.issue(actor);
      const sent = await request(app.getHttpServer())
        .post(`/api/reports?token=${querySecret}`)
        .set('Authorization', `Bearer ${auth}`)
        .set('Cookie', `private=${cookieSecret}`)
        .set('X-Private', headerSecret)
        .send({
          text: 'Встретился с компанией Ромашка, обсудили поставку.',
          requestId: randomUUID(),
        })
        .expect(201);
      const failed = await request(app.getHttpServer())
        .get(`/api/reports/${randomUUID()}?token=${querySecret}`)
        .set('Authorization', `Bearer ${auth}`)
        .set('Cookie', `private=${cookieSecret}`)
        .expect(404);
      const download = await request(app.getHttpServer())
        .get(`/api/downloads/files/${downloadToken}?token=${querySecret}`)
        .set('X-Private', headerSecret)
        .expect(404);
      // finish handlers are asynchronous; yield once, then use the queued DB read as a barrier.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const logs = await db.query('SELECT * FROM diagnostic_logs ORDER BY seq');
      const errors = await db.query('SELECT * FROM error_logs ORDER BY created_at');
      const encoded = JSON.stringify({ logs, errors });
      for (const secret of [auth, querySecret, cookieSecret, headerSecret, downloadToken])
        assert.ok(!encoded.includes(secret), `HTTP secret leaked: ${secret}`);
      const forResponse = (response: request.Response) =>
        logs.filter((row) => row.trace_id === `http:${response.headers['x-request-id']}`);
      const successful = forResponse(sent);
      assert.ok(successful.some((row) => row.event === 'http.started'));
      const queued = successful.find((row) => row.event === 'report.queued');
      assert.ok(queued, 'authenticated service inherits HTTP request context');
      assert.equal(queued.actor_id, actor.id);
      const completed = successful.find((row) => row.event === 'http.completed');
      assert.equal(completed.actor_id, actor.id);
      assert.equal(completed.details.route, '/api/reports');
      assert.equal(completed.details.status, 201);
      assert.ok(completed.details.durationMs >= 0);
      const unsuccessful = forResponse(failed);
      const failure = unsuccessful.find((row) => row.event === 'http.failed');
      assert.ok(failure);
      assert.equal(failure.actor_id, actor.id);
      assert.equal(failure.details.route, 'GET /api/reports/:id');
      assert.equal(failure.details.status, 404);
      assert.equal(unsuccessful.find((row) => row.event === 'http.completed').actor_id, actor.id);
      const downloadLogs = forResponse(download);
      assert.equal(
        downloadLogs.find((row) => row.event === 'http.failed').details.route,
        'GET /api/downloads/files/:token',
      );
      assert.equal(
        downloadLogs.find((row) => row.event === 'http.completed').details.route,
        '/api/downloads/files/:token',
      );
      assert.ok(
        errors.some(
          (row) => row.request_id === failed.headers['x-request-id'] && row.actor_id === actor.id,
        ),
      );
    } finally {
      await app.close();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'OpenAI HTTP diagnostic events retain provider request IDs but never raw request or error bodies',
  { timeout: 30_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'crm-diagnostic-openai-'));
    const config = makeConfig({
      DATA_DIR: dir,
      OPENAI_API_KEY: 'sk-test-private-provider-credential',
      WORKER_ENABLED: 'false',
      DIAGNOSTIC_LOG_UNTIL: new Date(Date.now() + 60_000).toISOString(),
    });
    const { app, services: s, db } = await createApp(config);
    const ai = new OpenAiAdapter(config, s.diagnostics);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              id: 'resp_success',
              status: 'completed',
              output: [{ content: 'PrivateProviderResult532' }],
            }),
            { status: 200, headers: { 'x-request-id': 'req_success' } },
          )
        : new Response(
            JSON.stringify({
              error: {
                code: 'invalid_json_schema',
                param: 'text.format',
                message: 'PrivateProviderError415 contact@example.com',
              },
            }),
            { status: 400, headers: { 'x-request-id': 'req_failure' } },
          );
    });
    try {
      await s.diagnostics.run({ traceId: 'provider-test' }, async () => {
        const result = await ai.request(
          'responses',
          JSON.stringify({ model: config.letterModel, input: 'PrivateInput987' }),
        );
        assert.equal(result.id, 'resp_success');
        await assert.rejects(
          ai.request('responses', JSON.stringify({ input: 'PrivateInput654' })),
          /HTTP 400/,
        );
      });
      const logs = await db.query('SELECT * FROM diagnostic_logs ORDER BY seq');
      const encoded = JSON.stringify(logs);
      assert.equal(calls, 2);
      assert.ok(logs.every((row) => row.trace_id === 'provider-test'));
      assert.deepEqual(
        logs
          .filter((row) => row.event === 'openai.http_response')
          .map((row) => ({ requestId: row.details.requestId, status: row.details.status })),
        [
          { requestId: 'req_success', status: 200 },
          { requestId: 'req_failure', status: 400 },
        ],
      );
      assert.ok(
        logs.some(
          (row) => row.event === 'openai.result' && row.details.responseId === 'resp_success',
        ),
      );
      assert.ok(
        logs.some(
          (row) =>
            row.event === 'openai.rejected' &&
            row.details.code === 'invalid_json_schema' &&
            row.details.param === 'text.format',
        ),
      );
      assert.ok(
        logs.some((row) => row.event === 'openai.http.failed' && row.details.status === 502),
      );
      for (const secret of [
        config.apiKey,
        'PrivateInput987',
        'PrivateInput654',
        'PrivateProviderResult532',
        'PrivateProviderError415',
        'contact@example.com',
      ])
        assert.ok(!encoded.includes(secret), `provider body leaked: ${secret}`);
    } finally {
      await app.close();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
