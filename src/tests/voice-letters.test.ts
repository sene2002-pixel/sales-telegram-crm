import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor } from '../shared/contracts';
import { ReportWorker } from '../server/services/worker';
import { voiceHelp } from '../server/services/voice-help';

test('voice letters route atomically, require signature, deduplicate and guard stale leases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-voice-letter-'));
  const config = makeConfig({ DATA_DIR: dir });
  const { app, services: s, db } = await createApp(config);
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '12345',
    name: 'Test',
    role: 'manager',
    active: true,
  };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    actor.id,
    actor.telegramId,
    actor.name,
    actor.role,
  ]);
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => 'Подготовь письмо для ООО Ромашка, ИНН 1234567890' },
    {
      extract: async () => {
        throw new Error('Letter must not become report');
      },
    },
    { download: async () => new Uint8Array([1]), send: async () => {} },
    config,
    s.voiceSignatures,
    s.letterBot,
  );
  const enqueue = (sourceKey: string) =>
    s.reports.enqueue(actor, {
      sourceKey,
      chatId: actor.telegramId,
      audioFileId: 'voice',
      sentAt: new Date().toISOString(),
    });
  try {
    await enqueue('voice:no-signature');
    await worker.processOne();
    const [failed] = await db.query('SELECT * FROM reports WHERE source_key=$1', [
      'voice:no-signature',
    ]);
    assert.equal(failed.purpose, 'letter');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Сначала создайте подпись/);
    assert.equal((await db.query('SELECT * FROM letter_jobs')).length, 0);
    const signature = await s.letters.writeSignature(actor, {
      lastName: 'Иванов',
      firstName: 'Иван',
      patronymic: '',
      workPhone: '',
      mobilePhone: '',
      email: '',
    });
    await enqueue('voice:letter');
    const [pending] = await db.query('SELECT * FROM reports WHERE source_key=$1', ['voice:letter']);
    await s.letterBot.processVoice(pending, randomUUID(), 'Подготовь письмо для ООО Ромашка');
    assert.equal((await db.query('SELECT * FROM letter_jobs')).length, 0);
    await worker.processOne();
    await enqueue('voice:letter');
    await worker.processOne();
    const jobs = await db.query('SELECT * FROM letter_jobs');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].signature_id, signature.id);
    assert.equal(jobs[0].chat_id, actor.telegramId);
    assert.equal(jobs[0].query, 'ООО Ромашка, ИНН 1234567890');
    const [converted] = await db.query('SELECT * FROM reports WHERE id=$1', [pending.id]);
    assert.equal(converted.purpose, 'letter');
    assert.equal(converted.status, 'cancelled');
    assert.equal(converted.transcript, null);
    assert.equal(converted.audio_file_id, null);
    assert.equal((await s.reports.list(actor)).length, 0);
    await enqueue('voice:busy');
    await worker.processOne();
    const [busy] = await db.query('SELECT * FROM reports WHERE source_key=$1', ['voice:busy']);
    assert.match(busy.error, /Предыдущее письмо/);
    assert.equal((await db.query('SELECT * FROM letter_jobs')).length, 1);
    assert.equal(
      await s.letterBot.processVoice(
        { audio_file_id: 'voice' },
        '',
        'Обсудили письмо с директором',
      ),
      false,
    );
    assert.equal(
      await s.letterBot.processVoice(
        { audio_file_id: null },
        '',
        'Подготовь письмо для ООО Ромашка',
      ),
      false,
    );
    assert.match(voiceHelp(config), /3\. Генерация информационного письма/);
    assert.ok(voiceHelp(config).length < 4096);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
