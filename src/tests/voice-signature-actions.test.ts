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
import { signatureOperation } from '../server/services/voice-signatures';
import { BotService } from '../server/services/bot';
import { TelegramAdapter } from '../server/infra/telegram';
import { voiceHelp } from '../server/services/voice-help';

test('voice signature intent distinguishes commands from letter requests and reports', () => {
  for (const phrase of [
    'Сделай подпись Иванова подписью по умолчанию',
    'Выбери подпись по дефолту',
    'Назначь основную подпись',
  ])
    assert.equal(signatureOperation(phrase), 'default');
  for (const phrase of [
    'Измени email в подписи Иванова на test@example.com',
    'Поменяй рабочий телефон в подписи на 123',
  ])
    assert.equal(signatureOperation(phrase), 'edit');
  assert.equal(signatureOperation('Сохрани подпись. Иванов Иван'), 'create');
  for (const phrase of [
    'Вчера изменил подпись директора',
    'Создай письмо для ООО Ромашка с подписью по умолчанию',
    'Добавь подписчика',
    'Напиши письмо для компании Подпись',
  ])
    assert.equal(signatureOperation(phrase), null);
});

test('voice signature confirmation, edits, defaults, ambiguity, ACL and letter continuation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-signature-actions-'));
  const config = makeConfig({ DATA_DIR: dir });
  const { app, services: s, db } = await createApp(config);
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '12345',
    name: 'Test',
    role: 'manager',
    active: true,
  };
  const other: Actor = { ...actor, id: randomUUID(), telegramId: '67890', role: 'admin' };
  for (const user of [actor, other])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      user.id,
      user.telegramId,
      user.name,
      user.role,
    ]);
  const data = {
    lastName: 'Иванов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '123',
    mobilePhone: '456',
    email: 'old@example.com',
  };
  const changes = {
    lastName: null,
    firstName: null,
    patronymic: null,
    workPhone: null,
    mobilePhone: null,
    email: null,
  };
  let transcript = '';
  let response: unknown = data;
  let sequence = 0;
  s.letters.ai.request = async () => ({
    status: 'completed',
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(response) }] }],
  });
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => transcript },
    {
      extract: async () => {
        throw new Error('Must not extract a report');
      },
    },
    { download: async () => new Uint8Array([1]), send: async () => {} },
    config,
    s.voiceSignatures,
    s.letterBot,
  );
  const voice = async (text: string, result: unknown) => {
    transcript = text;
    response = result;
    const sourceKey = `action:${++sequence}`;
    await s.reports.enqueue(actor, {
      sourceKey,
      chatId: actor.telegramId,
      audioFileId: 'voice',
      sentAt: new Date().toISOString(),
    });
    await worker.processOne();
    const [draft] = await db.query(
      'SELECT d.* FROM signature_drafts d JOIN reports r ON d.report_id=r.id WHERE r.source_key=$1',
      [sourceKey],
    );
    assert.ok(draft, 'voice must yield a durable draft');
    return draft;
  };
  const telegram = new TelegramAdapter(config);
  const answers: any[] = [];
  telegram.call = async (_method: string, payload: any) => {
    answers.push(payload);
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
  );
  const callback = async (value: string, user = actor) =>
    bot.handle({
      update_id: ++sequence,
      callback_query: {
        id: String(sequence),
        from: { id: Number(user.telegramId) },
        message: { chat: { id: Number(user.telegramId), type: 'private' } },
        data: value,
      },
    });
  let firstId = '';
  let secondId = '';
  try {
    await t.test(
      'create remains a draft until private confirmation; duplicate save is harmless',
      async () => {
        const draft = await voice('Сохрани подпись. Иванов Иван', data);
        assert.equal((await s.letters.signatures(actor)).length, 0);
        await callback(`sc:${draft.id}`, other);
        assert.equal(answers.at(-1).show_alert, true);
        assert.equal((await s.letters.signatures(actor)).length, 0);
        await callback(`sc:${draft.id}`);
        await callback(`sc:${draft.id}`);
        const saved = await s.letters.signatures(actor);
        assert.equal(saved.length, 1);
        assert.ok(saved[0]);
        firstId = saved[0].id;
        assert.equal(saved[0].email, data.email);
        const [cleared] = await db.query('SELECT * FROM signature_drafts WHERE id=$1', [draft.id]);
        assert.deepEqual(cleared.data, {});
        assert.equal(cleared.transcript, '');
      },
    );
    await t.test('cancel does not create a signature', async () => {
      const draft = await voice('Добавь подпись. Иванов Иван', data);
      await callback(`sx:${draft.id}`);
      await assert.rejects(s.voiceSignatures.confirm(actor, draft.id), /отменён/);
      assert.equal((await s.letters.signatures(actor)).length, 1);
    });
    await t.test(
      'edit preserves omitted fields and default flag, requires confirmation',
      async () => {
        await s.letters.setDefault(actor, firstId);
        const draft = await voice('Измени email в подписи на новый', {
          targetName: '',
          changes: { ...changes, email: 'new@example.com' },
        });
        assert.equal((await s.letters.signatures(actor))[0]!.email, 'old@example.com');
        await callback(`sc:${draft.id}`);
        const saved = (await s.letters.signatures(actor))[0];
        assert.ok(saved);
        assert.equal(saved.email, 'new@example.com');
        assert.equal(saved.workPhone, '123');
        assert.equal(saved.mobilePhone, '456');
        assert.equal(saved.isDefault, true);
      },
    );
    await t.test('stale preview cannot overwrite a profile edit', async () => {
      const draft = await voice('Измени телефон в подписи', {
        targetName: '',
        changes: { ...changes, workPhone: '999' },
      });
      await s.letters.writeSignature(actor, { ...data, email: 'profile@example.com' }, firstId);
      await assert.rejects(s.voiceSignatures.confirm(actor, draft.id), /изменилась/);
      await s.voiceSignatures.discard(actor, draft.id);
      assert.equal((await s.letters.signatures(actor))[0]!.workPhone, '123');
    });
    await t.test(
      'duplicate names show a list; edit selection does not change default',
      async () => {
        secondId = (await s.letters.writeSignature(actor, { ...data, email: 'second@example.com' }))
          .id;
        const draft = await voice('Измени email в подписи Иванова', {
          targetName: 'Иванов',
          changes: { ...changes, email: 'selected@example.com' },
        });
        assert.equal(draft.status, 'selecting');
        assert.equal(draft.options.length, 2);
        const index = draft.options.findIndex((o: any) => o.id === secondId);
        await assert.rejects(s.voiceSignatures.choose(other, draft.id, index), /не найден/);
        await callback(`sp:${draft.id}:${index}`);
        assert.equal(
          (await s.letters.signatures(actor)).find((s) => s.id === secondId)!.email,
          'second@example.com',
        );
        await callback(`sc:${draft.id}`);
        const saved = await s.letters.signatures(actor);
        assert.equal(saved.find((s) => s.id === secondId)!.email, 'selected@example.com');
        assert.equal(saved.find((s) => s.isDefault)!.id, firstId);
      },
    );
    await t.test(
      'default selection explains effect and cannot be replayed to select another',
      async () => {
        const draft = await voice('Выбери подпись по умолчанию', { targetName: '', changes });
        assert.equal(draft.status, 'selecting');
        const messages = await db.query('SELECT payload FROM outbox');
        assert.ok(messages.some((m) => m.payload.text.includes('Ваш выбор назначит')));
        const index = draft.options.findIndex((o: any) => o.id === secondId);
        await callback(`sp:${draft.id}:${index}`);
        await callback(`sp:${draft.id}:${1 - index}`);
        assert.equal((await s.letters.signatures(actor)).find((s) => s.isDefault)!.id, secondId);
      },
    );
    await t.test('unambiguous default confirmation and deleted target protection', async () => {
      await s.letters.writeSignature(actor, { ...data, lastName: 'Петров' }, secondId);
      const draft = await voice('Сделай подпись Иванова по умолчанию', {
        targetName: 'Иванов',
        changes,
      });
      assert.equal(draft.status, 'pending');
      assert.equal((await s.letters.signatures(actor)).find((s) => s.isDefault)!.id, secondId);
      await callback(`sc:${draft.id}`);
      assert.equal((await s.letters.signatures(actor)).find((s) => s.isDefault)!.id, firstId);
      const stale = await voice('Сделай подпись Петрова по умолчанию', {
        targetName: 'Петров',
        changes,
      });
      await s.letters.deleteSignature(actor, secondId);
      await assert.rejects(s.voiceSignatures.confirm(actor, stale.id), /удалена/);
      secondId = (await s.letters.writeSignature(actor, data)).id;
    });
    await t.test(
      'letter waits for signature, resumes atomically and uses default next time',
      async () => {
        await db.query('UPDATE letter_signatures SET is_default=false WHERE user_id=$1', [
          actor.id,
        ]);
        await s.letterBot.enqueue(actor, 'waiting:1', 'ООО Рога и копыта');
        await s.letterBot.enqueue(actor, 'waiting:1', 'ООО Рога и копыта');
        const [job] = await db.query('SELECT * FROM letter_jobs WHERE source_key=$1', [
          'waiting:1',
        ]);
        assert.equal(job.status, 'waiting_signature');
        assert.equal(job.signature_id, null);
        await assert.rejects(
          s.letterBot.enqueue(actor, 'waiting:2', 'ООО Рога и копыта'),
          /ещё обрабатывается/,
        );
        const index = job.signature_options.findIndex((o: any) => o.id === secondId);
        await assert.rejects(s.letterBot.chooseSignature(other, job.id, index), /не найден/);
        await callback(`lp:${job.id}:${index}`);
        await callback(`lp:${job.id}:${1 - index}`);
        const [queued] = await db.query('SELECT * FROM letter_jobs WHERE id=$1', [job.id]);
        assert.equal(queued.status, 'queued');
        assert.equal(queued.signature_id, secondId);
        assert.equal((await s.letters.signatures(actor)).find((s) => s.isDefault)!.id, secondId);
        await db.query("UPDATE letter_jobs SET status='sent' WHERE id=$1", [job.id]);
        await s.letterBot.enqueue(actor, 'next:1', 'ООО Рога и копыта');
        const [next] = await db.query('SELECT * FROM letter_jobs WHERE source_key=$1', ['next:1']);
        assert.equal(next.status, 'queued');
        assert.equal(next.signature_id, secondId);
        await db.query("UPDATE letter_jobs SET status='sent' WHERE id=$1", [next.id]);
      },
    );
    await t.test(
      'letter cancel does not set default and stale choices cannot continue cancelled job',
      async () => {
        await db.query('UPDATE letter_signatures SET is_default=false WHERE user_id=$1', [
          actor.id,
        ]);
        await s.letterBot.enqueue(actor, 'cancel:1', 'ООО Рога и копыта');
        const [job] = await db.query('SELECT * FROM letter_jobs WHERE source_key=$1', ['cancel:1']);
        await callback(`lc:${job.id}`);
        await callback(`lp:${job.id}:0`);
        assert.equal(
          (await s.letters.signatures(actor)).some((s) => s.isDefault),
          false,
        );
        assert.equal(
          (await db.query('SELECT status FROM letter_jobs WHERE id=$1', [job.id]))[0].status,
          'cancelled',
        );
      },
    );
    await t.test(
      'failed delivery enqueue rolls back default assignment and letter resume',
      async () => {
        await s.letterBot.enqueue(actor, 'rollback:1', 'ООО Рога и копыта');
        const [job] = await db.query('SELECT * FROM letter_jobs WHERE source_key=$1', [
          'rollback:1',
        ]);
        const notify = s.reports.notify;
        s.reports.notify = async () => {
          throw new Error('outbox unavailable');
        };
        try {
          await assert.rejects(s.letterBot.chooseSignature(actor, job.id, 0), /outbox unavailable/);
        } finally {
          s.reports.notify = notify;
        }
        assert.equal(
          (await db.query('SELECT status FROM letter_jobs WHERE id=$1', [job.id]))[0].status,
          'waiting_signature',
        );
        assert.equal(
          (await s.letters.signatures(actor)).some((s) => s.isDefault),
          false,
        );
        const option = job.signature_options[0];
        await s.letters.writeSignature(actor, { ...option.data, workPhone: 'changed' }, option.id);
        await assert.rejects(s.letterBot.chooseSignature(actor, job.id, 0), /изменилась/);
        await s.letterBot.chooseSignature(actor, job.id);
      },
    );
    await t.test(
      'blocked owner cannot confirm or choose; edit cancellation leaves data intact',
      async () => {
        const draft = await voice('Поменяй email в подписи', {
          targetName: '',
          changes: { ...changes, email: 'cancelled@example.com' },
        });
        assert.equal(draft.status, 'selecting');
        await db.query('UPDATE users SET active=false WHERE id=$1', [actor.id]);
        await assert.rejects(s.voiceSignatures.choose(actor, draft.id, 0), /Доступ отозван/);
        await assert.rejects(s.letterBot.enqueue(actor, 'blocked', 'Ромашка'), /Доступ отозван/);
        await db.query('UPDATE users SET active=true WHERE id=$1', [actor.id]);
        await s.voiceSignatures.choose(actor, draft.id, 0);
        await s.voiceSignatures.discard(actor, draft.id);
        await assert.rejects(s.voiceSignatures.confirm(actor, draft.id), /отменён/);
        assert.equal(
          (await s.letters.signatures(actor)).some((s) => s.email === 'cancelled@example.com'),
          false,
        );
      },
    );
    assert.ok(voiceHelp(config).length < 4096);
    assert.match(voiceHelp(config), /Редактирование подписи/);
    for (const row of await db.query('SELECT payload FROM outbox'))
      for (const buttons of row.payload.reply_markup?.inline_keyboard || [])
        for (const button of buttons)
          if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
