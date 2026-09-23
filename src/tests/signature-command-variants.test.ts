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
import { letterQuery } from '../server/services/letter-bot';
import { signatureOperation } from '../server/services/voice-signatures';

test('signature creation recognizes imperative, polite and infinitive verb forms', () => {
  for (const verb of [
    'Добавь',
    'Добавьте',
    'Добавить',
    'Создай',
    'Создайте',
    'Создать',
    'Сохрани',
    'Сохраните',
    'Сохранить',
    'Запиши',
    'Запишите',
    'Записать',
    'Сделай',
    'Сделайте',
    'Сделать',
    'Подготовь',
    'Подготовьте',
    'Подготовить',
    'Сформируй',
    'Сформируйте',
    'Сформировать',
  ]) {
    const phrase = `${verb} подпись: Иванов Иван`;
    assert.equal(signatureOperation(phrase), 'create', phrase);
  }
});

test('signature creation accepts request prefixes, modifiers and dictation punctuation', () => {
  for (const phrase of [
    'Пожалуйста, добавь подпись. Иванов Иван',
    'Нужно добавить подпись: Иванов Иван',
    'Надо создать подпись: Иванов Иван',
    'Хочу сохранить подпись: Иванов Иван',
    'Можешь записать подпись: Иванов Иван',
    'Можете сформировать подпись: Иванов Иван',
    'Пожалуйста, можете подготовить новую подпись: Иванов Иван',
    'Нужно, пожалуйста, добавить подпись: Иванов Иван',
    'Создай, пожалуйста, подпись: Иванов Иван',
    'Добавить мне подпись: Иванов Иван',
    'Создать мою подпись: Иванов Иван',
    'Сохранить новую подпись: Иванов Иван',
    'Подготовить личную подпись: Иванов Иван',
    'Сделай мне новую личную подпись: Иванов Иван',
    'Создай. Подпись: Иванов Иван',
    'Создай, подпись — Иванов Иван',
    'Сформировать; подпись! Иванов Иван',
    '  ПОЖАЛУЙСТА, СОЗДАТЬ\nПОДПИСЬ: Иванов Иван  ',
  ])
    assert.equal(signatureOperation(phrase), 'create', phrase);
});

test('flexible signature creation preserves edit, default and letter intent precedence', () => {
  for (const phrase of [
    'Измени email в подписи Иванова на test@example.com',
    'Поменяйте рабочий телефон в подписи на 123',
    'Пожалуйста, обнови подпись Иванова',
    'Исправь имя в подписи Иванова',
  ])
    assert.equal(signatureOperation(phrase), 'edit', phrase);
  for (const phrase of [
    'Сделай подпись Иванова подписью по умолчанию',
    'Выбери подпись по дефолту',
    'Назначь основную подпись',
  ])
    assert.equal(signatureOperation(phrase), 'default', phrase);
  for (const phrase of [
    'Создай письмо для ООО Ромашка с подписью по умолчанию',
    'Нужно подготовить письмо для компании Подпись',
    'Пожалуйста, сформировать письмо АО Подпись',
    'Сделай. Письмо: ООО Подпись',
  ]) {
    assert.equal(signatureOperation(phrase), null, phrase);
    assert.notEqual(letterQuery(phrase), null, phrase);
  }
});

test('signature creation rejects reports, past tense, negation and signature substrings', () => {
  for (const phrase of [
    'Получил подпись директора на договоре',
    'Вчера добавил подпись Иванова',
    'Создал подпись для письма',
    'Подготовили подпись после встречи',
    'Обсудили с директором, нужно создать подпись для письма',
    'Компания Альфа: добавь подпись после согласования',
    'Не добавляй подпись Иванова',
    'Не нужно создавать подпись',
    'Нужно не создавать подпись',
    'Пожалуйста, не добавляй подпись',
    'Добавь подписчика',
    'Нужно добавить подписчиков',
    'Создать подписку',
    'Сделай подпиську',
    'Добавить подписью',
    'Сохранить подписанные документы',
  ])
    assert.equal(signatureOperation(phrase), null, phrase);
});

test('voice signature variants require confirmation and bare commands ask for details without AI', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Signature command tests must not access the network');
  });
  const dir = await mkdtemp(join(tmpdir(), 'crm-signature-variants-'));
  const config = makeConfig({ DATA_DIR: dir, WORKER_ENABLED: 'false' });
  const { app, services: s, db } = await createApp(config);
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '12345',
    name: 'Test',
    role: 'manager',
    active: true,
  };
  const data = {
    lastName: 'Иванов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  };
  let transcript = '';
  let aiCalls = 0;
  let reportExtractions = 0;
  let sequence = 0;
  s.letters.ai.request = async () => {
    aiCalls++;
    return {
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
    };
  };
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => transcript },
    {
      extract: async () => {
        reportExtractions++;
        throw new Error('A signature command must not become a meeting report');
      },
    },
    { download: async () => new Uint8Array([1]), send: async () => {} },
    config,
    s.voiceSignatures,
    s.letterBot,
  );
  const voice = async (phrase: string) => {
    transcript = phrase;
    const sourceKey = `signature:variant:${++sequence}`;
    await s.reports.enqueue(actor, {
      sourceKey,
      chatId: actor.telegramId,
      audioFileId: 'voice',
      sentAt: new Date().toISOString(),
    });
    const messagesBefore = await db.query('SELECT id FROM outbox');
    const messageIds = new Set(messagesBefore.map((row) => row.id));
    await worker.processOne();
    const [report] = await db.query('SELECT * FROM reports WHERE source_key=$1', [sourceKey]);
    assert.ok(report, phrase);
    assert.equal(report.purpose, 'signature', phrase);
    assert.equal(report.status, 'cancelled', phrase);
    for (const field of [
      'transcript',
      'audio_file_id',
      'draft',
      'error',
      'lease_token',
      'lease_until',
    ])
      assert.equal(report[field], null, `${phrase}: cleared ${field}`);
    const messages = (await db.query('SELECT id,payload FROM outbox')).filter(
      (row) => !messageIds.has(row.id),
    );
    return { report, messages };
  };
  try {
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.telegramId,
      actor.name,
      actor.role,
    ]);
    const variants = [
      'Добавить подпись: Иванов Иван',
      'Пожалуйста, можете подготовить мне новую подпись. Иванов Иван',
      'Создай. Подпись: Иванов Иван',
    ];
    for (const [index, phrase] of variants.entries()) {
      const { report, messages } = await voice(phrase);
      const [draft] = await db.query('SELECT * FROM signature_drafts WHERE report_id=$1', [
        report.id,
      ]);
      assert.ok(draft, phrase);
      assert.equal(draft.operation, 'create', phrase);
      assert.equal(draft.status, 'pending', phrase);
      assert.deepEqual(draft.data, data, phrase);
      assert.equal((await s.letters.signatures(actor)).length, index, phrase);
      assert.ok(
        messages.some((row) =>
          row.payload.reply_markup?.inline_keyboard?.some((buttons: any[]) =>
            buttons.some((button) => button.callback_data === `sc:${draft.id}`),
          ),
        ),
        'Draft preview must offer explicit confirmation',
      );
      const saved = await s.voiceSignatures.confirm(actor, draft.id);
      assert.equal(saved.lastName, data.lastName);
      assert.equal(saved.firstName, data.firstName);
      assert.equal((await s.letters.signatures(actor)).length, index + 1, phrase);
      const repeated = await s.voiceSignatures.confirm(actor, draft.id);
      assert.equal(repeated.id, saved.id);
    }
    const { report: fourth } = await voice('Надо сформировать личную подпись: Иванов Иван');
    const [limited] = await db.query('SELECT * FROM signature_drafts WHERE report_id=$1', [
      fourth.id,
    ]);
    assert.ok(limited);
    assert.equal(limited.status, 'pending');
    await assert.rejects(s.voiceSignatures.confirm(actor, limited.id), /трёх подписей/);
    assert.equal((await s.letters.signatures(actor)).length, 3);
    await s.voiceSignatures.discard(actor, limited.id);
    assert.equal(aiCalls, variants.length + 1);

    for (const phrase of [
      'Добавить подпись',
      'Пожалуйста, создай мне новую подпись.',
      'Нужно подготовить подпись',
      'Можете сформировать мою личную подпись, пожалуйста?',
      'Создай. Подпись:',
    ]) {
      const callsBefore = aiCalls;
      const { report, messages } = await voice(phrase);
      assert.equal(aiCalls, callsBefore, `${phrase}: no extraction for an empty command`);
      assert.equal(
        (await db.query('SELECT * FROM signature_drafts WHERE report_id=$1', [report.id])).length,
        0,
        phrase,
      );
      assert.equal(messages.length, 1, `${phrase}: one clarification message`);
      assert.match(messages[0]!.payload.text, /фамил[\s\S]*имя|фио/iu, phrase);
      assert.equal((await s.letters.signatures(actor)).length, 3, phrase);
    }
    assert.equal(reportExtractions, 0);
    assert.equal((await s.reports.list(actor)).length, 0);
    assert.equal((await db.query('SELECT * FROM letter_jobs')).length, 0);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
