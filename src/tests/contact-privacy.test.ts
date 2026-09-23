import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actor } from '../shared/contracts';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { TelegramAdapter } from '../server/infra/telegram';
import { BotService } from '../server/services/bot';
import { ReportWorker } from '../server/services/worker';
import { unknownCommand } from '../server/services/command-intent';

test('voice contact commands keep personal fields out of diagnostics and use strict tool-free extraction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-contact-privacy-'));
  const config = makeConfig({
    DATA_DIR: dir,
    DIAGNOSTIC_LOG_UNTIL: '2100-01-01T00:00:00Z',
  });
  const { app, services: s, db } = await createApp(config);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Privacy tests must never access the network');
  });
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '7654321',
    name: 'Test manager',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    actor.id,
    actor.telegramId,
    actor.name,
    actor.role,
  ]);
  const privateCompany = 'СекретнаяКомпанияАльфа';
  const contact = {
    name: 'Секретов Конфиденциальный',
    role: 'Тайный руководитель',
    phone: '+79998881234',
    email: 'private-contact@example.test',
  };
  const command = `Создай контакт для ${privateCompany}. ${contact.name}, ${contact.role}, телефон ${contact.phone}, email ${contact.email}`;
  const requests: any[] = [];
  s.letters.ai.request = async (path, body) => {
    assert.equal(path, 'responses');
    requests.push(JSON.parse(String(body)));
    return {
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                companyName: privateCompany,
                city: '',
                inn: '',
                contact,
                ambiguous: false,
              }),
            },
          ],
        },
      ],
    };
  };
  const telegram = new TelegramAdapter(config);
  const telegramCalls: { method: string; payload: any }[] = [];
  telegram.call = async (method, payload) => {
    telegramCalls.push({ method, payload });
    return {};
  };
  const bot = new BotService(
    config,
    s.auth,
    s.reports,
    s.crm,
    telegram,
    s.letterBot,
    s.voiceSignatures,
    s.diagnostics,
    s.voiceContacts,
  );
  let transcript = command;
  let reportExtractions = 0;
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => transcript },
    {
      extract: async () => {
        reportExtractions++;
        throw new Error('Contact commands must never become activity reports');
      },
    },
    { download: async () => new Uint8Array([1]), send: async () => {} },
    config,
    s.voiceSignatures,
    s.letterBot,
    s.diagnostics,
    s.voiceContacts,
  );
  let sequence = 0;
  const message = async (text: string, voice: boolean) => {
    const updateId = ++sequence;
    transcript = text;
    await bot.handle({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        from: { id: Number(actor.telegramId) },
        chat: { id: Number(actor.telegramId), type: 'private' },
        ...(voice ? { voice: { file_id: 'test-voice', duration: 10 } } : { text }),
      },
    });
    if (voice) await worker.processOne();
    return { trace: `telegram:${updateId}` };
  };
  const logs = (trace: string) =>
    db.query('SELECT * FROM diagnostic_logs WHERE trace_id=$1 ORDER BY seq', [trace]);
  try {
    const company = await s.crm.create(actor, { name: privateCompany });
    const voice = await message(command, true);
    assert.equal(requests.length, 1);
    const [report] = await db.query('SELECT * FROM reports WHERE source_key=$1', [voice.trace]);
    assert.equal(report.purpose, 'contact');
    assert.equal(report.status, 'review');
    assert.equal(report.draft.company.id, company.id);
    assert.deepEqual(report.draft.data, contact);
    assert.equal((await s.crm.records(actor, 'contact')).length, 0);
    const preview = (
      await db.query('SELECT payload FROM outbox WHERE chat_id=$1', [actor.telegramId])
    )
      .map((row) => row.payload.text)
      .join('\n');
    for (const value of [privateCompany, ...Object.values(contact)])
      assert.ok(preview.includes(value));
    const voiceLogs = await logs(voice.trace);
    assert.ok(
      voiceLogs.some(
        (row) => row.event === 'voice.transcript' && row.details.redacted === 'contact',
      ),
    );
    assert.ok(voiceLogs.some((row) => row.event === 'contact.processing.started'));
    assert.ok(
      voiceLogs.some((row) => row.event === 'command.routed' && row.details.route === 'contact'),
    );
    assert.ok(
      voiceLogs.every((row) => row.actor_id === actor.id || row.event === 'telegram.received'),
    );
    const request = requests[0];
    assert.equal(request.store, false);
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
    assert.equal(request.include, undefined);
    assert.equal(request.input, command);
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.strict, true);
    const schema = request.text.format.schema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'ambiguous',
      'city',
      'companyName',
      'contact',
      'inn',
    ]);
    const contactSchema = schema.properties.contact;
    assert.equal(contactSchema.additionalProperties, false);
    assert.deepEqual([...contactSchema.required].sort(), ['email', 'name', 'phone', 'role']);
    for (const name of ['email', 'name', 'phone', 'role'])
      assert.equal(contactSchema.properties[name].type, 'string');

    const typed = await message(command, false);
    assert.equal(requests.length, 1);
    assert.equal(
      (await db.query('SELECT id FROM reports WHERE source_key=$1', [typed.trace])).length,
      0,
    );
    assert.match(telegramCalls.at(-1)!.payload.text, /голосов/iu);
    const typedLogs = await logs(typed.trace);
    assert.ok(
      typedLogs.some(
        (row) => row.event === 'telegram.received' && row.details.text === '[CONTACT]',
      ),
    );
    assert.ok(
      typedLogs.some(
        (row) => row.event === 'command.routed' && row.details.route === 'contact_voice_only',
      ),
    );

    for (const text of [
      `Для Рога и копыта создай контакты ${contact.name}, телефон ${contact.phone}, email ${contact.email}`,
      `Нужно создать контакты для ${privateCompany}. ${contact.name}, телефон ${contact.phone}, email ${contact.email}`,
    ]) {
      const unsupported = await message(text, true);
      const [row] = await db.query('SELECT * FROM reports WHERE source_key=$1', [
        unsupported.trace,
      ]);
      assert.equal(row.purpose, 'command');
      assert.equal(row.status, 'cancelled');
      assert.equal(row.transcript, null);
      assert.equal(row.audio_file_id, null);
      assert.equal(row.draft, null);
      assert.equal(requests.length, 1);
      const unknownMessages = await db.query('SELECT payload FROM outbox WHERE trace_id=$1', [
        unsupported.trace,
      ]);
      assert.ok(unknownMessages.some((entry) => entry.payload.text === unknownCommand));
      const unsupportedLogs = await logs(unsupported.trace);
      assert.ok(
        unsupportedLogs.some(
          (entry) => entry.event === 'voice.transcript' && entry.details.redacted === 'contact',
        ),
      );
      assert.ok(
        unsupportedLogs.some(
          (entry) => entry.event === 'command.routed' && entry.details.route === 'unknown',
        ),
      );

      const typedUnsupported = await message(text, false);
      assert.equal(telegramCalls.at(-1)!.payload.text, unknownCommand);
      assert.equal(
        (await db.query('SELECT id FROM reports WHERE source_key=$1', [typedUnsupported.trace]))
          .length,
        0,
      );
      assert.ok(
        (await logs(typedUnsupported.trace)).some(
          (entry) => entry.event === 'telegram.received' && entry.details.text === '[CONTACT]',
        ),
      );
    }
    assert.equal(reportExtractions, 0);
    assert.equal(requests.length, 1);
    assert.equal((await s.reports.list(actor)).length, 0);
    assert.equal((await db.query('SELECT id FROM records')).length, 0);
    assert.equal((await db.query('SELECT id FROM letter_jobs')).length, 0);
    assert.equal((await db.query('SELECT id FROM signature_drafts')).length, 0);
    const encodedLogs = JSON.stringify(await db.query('SELECT * FROM diagnostic_logs'));
    for (const value of [privateCompany, 'Рога и копыта', ...Object.values(contact)]) {
      assert.equal(encodedLogs.includes(value), false, `diagnostics must not contain ${value}`);
    }
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
