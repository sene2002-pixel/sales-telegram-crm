import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor } from '../shared/contracts';
import { ReportWorker } from '../server/services/worker';
import { BotService } from '../server/services/bot';
import { TelegramAdapter } from '../server/infra/telegram';
import { signatureOperation } from '../server/services/voice-signatures';

test('signature edit accepts polite and infinitive forms, including the default signature', () => {
  for (const verb of [
    'Измени',
    'Измените',
    'Изменить',
    'Отредактируй',
    'Отредактируйте',
    'Отредактировать',
    'Поменяй',
    'Поменяйте',
    'Поменять',
    'Обнови',
    'Обновите',
    'Обновить',
    'Исправь',
    'Исправьте',
    'Исправить',
  ]) {
    const phrase = `${verb} email в подписи по умолчанию на new@example.com`;
    assert.equal(signatureOperation(phrase), 'edit', phrase);
  }
  for (const phrase of [
    'Пожалуйста, изменить email в подписи Иванова',
    'Нужно отредактировать мою подпись',
    'Надо поменять телефон в подписи',
    'Хочу обновить подпись Иванова',
    'Можете исправить подпись по дефолту',
    'Пожалуйста, можете обновить основную подпись',
    'Нужно, пожалуйста, исправить имя в подписи',
    'Изменить. Подпись: Иванов Иван',
  ])
    assert.equal(signatureOperation(phrase), 'edit', phrase);
});

test('signature deletion recognizes only an explicit whole-signature command', () => {
  for (const verb of ['Удали', 'Удалите', 'Удалить', 'Убери', 'Уберите', 'Убрать']) {
    for (const subject of ['подпись', 'подпись Иванова']) {
      const phrase = `${verb} ${subject}`;
      assert.equal(signatureOperation(phrase), 'delete', phrase);
    }
  }
  for (const phrase of [
    'Пожалуйста, удали подпись Иванова',
    'Нужно удалить подпись',
    'Надо убрать подпись',
    'Хочу удалить мою подпись',
    'Можешь убрать подпись Иванова',
    'Можете удалить личную подпись',
    'Пожалуйста, можете удалить основную подпись',
    'Нужно, пожалуйста, удалить подпись',
    'Удали, пожалуйста, подпись',
    'Удали подпись по умолчанию',
    'Удалите подпись по дефолту',
    'Удалить подпись по умолчанию',
    'Удалить мне подпись',
    'Убрать. Подпись: Иванов Иван',
    '  ПОЖАЛУЙСТА, УДАЛИТЬ\nПОДПИСЬ!  ',
  ])
    assert.equal(signatureOperation(phrase), 'delete', phrase);
  for (const phrase of [
    'Удали телефон из подписи',
    'Убрать email в подписи по умолчанию',
    'Удалить подпись из письма',
    'Убрать подпись из документа',
    'Удали все подписи',
    'Удали все подписи Иванова',
    'Убрать подписи',
    'Удали подпись и все остальные подписи',
    'Удали подпись Иванова и Петрова',
    'Убери подпись по умолчанию',
    'Уберите подпись по дефолту',
    'Убрать подпись по умолчанию',
    'Удали подпись. Нет, не надо',
    'Удалить подпись не нужно',
    'Не удаляй подпись',
    'Не нужно удалить подпись',
    'Нужно не удалять подпись',
    'Пожалуйста, не убирай подпись',
    'Я удалил подпись',
    'Вчера убрали подпись Иванова',
    'Удалили подпись',
    'Компания Альфа попросила удалить подпись',
    'Удали подписчика',
    'Убрать подписку',
    'Удалить подпиську',
    'Создай письмо для ООО Подпись',
  ])
    assert.notEqual(signatureOperation(phrase), 'delete', phrase);
});

test('voice deletion uses private preview and confirmation, with durable transactional protection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Signature deletion tests must not access the network');
  });
  const dir = await mkdtemp(join(tmpdir(), 'crm-signature-delete-'));
  const config = makeConfig({ DATA_DIR: dir, WORKER_ENABLED: 'false' });
  const { app, services: s, db } = await createApp(config);
  const data = {
    lastName: 'Иванов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '123',
    mobilePhone: '456',
    email: 'ivan@example.com',
  };
  let sequence = 0;
  let transcript = '';
  let response: unknown = { targetName: '' };
  let reportExtractions = 0;
  const requests: any[] = [];
  s.letters.ai.request = async (_endpoint, body) => {
    requests.push(JSON.parse(String(body)));
    return {
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(response) }] }],
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
  const telegram = new TelegramAdapter(config);
  const answers: any[] = [];
  telegram.call = async (method, payload) => {
    answers.push({ method, ...(payload as Record<string, unknown>) });
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
  const owner = async (): Promise<Actor> => {
    const actor: Actor = {
      id: randomUUID(),
      telegramId: String(100000 + ++sequence),
      name: 'Signature owner',
      role: 'manager',
      active: true,
    };
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.telegramId,
      actor.name,
      actor.role,
    ]);
    return actor;
  };
  const callback = async (
    actor: Actor,
    value: string,
    chatType = 'private',
    chatId = actor.telegramId,
  ) => {
    await bot.handle({
      update_id: ++sequence,
      callback_query: {
        id: String(sequence),
        from: { id: Number(actor.telegramId) },
        message: { chat: { id: Number(chatId), type: chatType } },
        data: value,
      },
    });
  };
  const draftById = async (id: string) =>
    (await db.query('SELECT * FROM signature_drafts WHERE id=$1', [id]))[0];
  const messages = async (actor: Actor) =>
    (await db.query('SELECT payload FROM outbox WHERE chat_id=$1', [actor.telegramId])).map(
      (row) => row.payload,
    );
  const voice = async (
    actor: Actor,
    phrase = 'Удалить подпись Иванова',
    extracted: unknown = { targetName: '' },
  ) => {
    transcript = phrase;
    response = extracted;
    const sourceKey = `signature:delete:${++sequence}`;
    await s.reports.enqueue(actor, {
      sourceKey,
      chatId: actor.telegramId,
      audioFileId: 'voice',
      sentAt: new Date().toISOString(),
    });
    const callsBefore = requests.length;
    await worker.processOne();
    const [report] = await db.query('SELECT * FROM reports WHERE source_key=$1', [sourceKey]);
    assert.equal(report.purpose, 'signature');
    assert.equal(report.status, 'cancelled');
    for (const field of [
      'transcript',
      'audio_file_id',
      'draft',
      'error',
      'lease_token',
      'lease_until',
    ])
      assert.equal(report[field], null, `signature report clears ${field}`);
    if (signatureOperation(phrase) === 'delete') {
      for (const request of requests.slice(callsBefore)) {
        assert.deepEqual(Object.keys(request.text.format.schema.properties), ['targetName']);
        assert.equal(request.store, false);
        assert.equal(request.tools, undefined);
      }
    }
    const [draft] = await db.query('SELECT * FROM signature_drafts WHERE report_id=$1', [
      report.id,
    ]);
    return draft;
  };
  const bare = async (actor: Actor, phrase = 'Удали подпись') => {
    const callsBefore = requests.length;
    const draft = await voice(actor, phrase);
    assert.equal(requests.length, callsBefore, 'bare deletion must not call AI extraction');
    if (draft) {
      assert.equal(draft.operation, 'delete');
      assert.equal(draft.status, 'selecting_delete');
      assert.equal(draft.target_id, null);
      assert.equal((await s.voiceSignatures.list(actor)).length, 0);
      const selection = (await messages(actor)).find((payload) =>
        payload.reply_markup?.inline_keyboard
          ?.flat()
          .some((button: any) => button.callback_data.startsWith(`sp:${draft.id}:`)),
      );
      assert.ok(selection, 'bare deletion displays an explicit selectable list');
      assert.match(selection.text, /удал/iu);
      assert.match(selection.text, /нажат|выбор/iu, 'list warns that selection deletes');
      const buttons = selection.reply_markup.inline_keyboard.flat();
      assert.equal(
        buttons.filter((button: any) => button.callback_data.startsWith(`sp:${draft.id}:`)).length,
        draft.options.length,
      );
      assert.ok(buttons.some((button: any) => button.callback_data === `sx:${draft.id}`));
      assert.ok(buttons.every((button: any) => button.callback_data !== `sc:${draft.id}`));
    }
    return draft;
  };
  const assertPreview = async (actor: Actor, id: string) => {
    const previews = (await messages(actor)).filter((payload) =>
      payload.reply_markup?.inline_keyboard
        ?.flat()
        .some((button: any) => button.callback_data === `sc:${id}`),
    );
    assert.ok(previews.length, 'deletion must require a separate confirmation button');
    assert.match(previews.at(-1).text, /удал/iu);
    assert.match(previews.at(-1).text, /Иван/iu);
    assert.ok(
      previews
        .at(-1)
        .reply_markup.inline_keyboard.flat()
        .some((button: any) => button.callback_data === `sx:${id}`),
    );
  };
  try {
    await t.test('no signatures yields an explanation without a draft', async () => {
      const actor = await owner();
      assert.equal(await bare(actor), undefined);
      assert.equal((await s.letters.signatures(actor)).length, 0);
      assert.ok(
        (await messages(actor)).some((payload) => /подписей пока нет/iu.test(payload.text)),
      );
    });

    await t.test(
      'bare deletion always lists even the only signature and deletes on selection',
      async () => {
        for (const phrase of [
          'Удали подпись',
          'Удалить подпись',
          'Уберите подпись, пожалуйста!',
          'Пожалуйста, можешь удалить мою подпись?',
        ]) {
          const actor = await owner();
          const signature = await s.letters.writeSignature(actor, data);
          await s.letters.setDefault(actor, signature.id);
          const before = await s.letters.signatures(actor);
          const draft = await bare(actor, phrase);
          assert.equal(draft.options.length, 1);
          assert.equal(draft.options[0].id, signature.id);
          assert.deepEqual(await s.letters.signatures(actor), before);
          await assert.rejects(s.voiceSignatures.confirm(actor, draft.id), /выбор/);
          await assert.rejects(s.voiceSignatures.save(actor, draft.id, data));
          await callback(actor, `sp:${draft.id}:0`, 'group');
          await callback(actor, `sp:${draft.id}:0`, 'private', '999999');
          assert.deepEqual(await s.letters.signatures(actor), before);
          await callback(actor, `sp:${draft.id}:0`);
          assert.equal(answers.at(-1).show_alert, undefined);
          assert.equal((await s.letters.signatures(actor)).length, 0);
          const deleted = await draftById(draft.id);
          assert.equal(deleted.status, 'saved');
          assert.equal(deleted.signature_id, signature.id);
          assert.deepEqual(deleted.data, {});
          assert.deepEqual(deleted.options, []);
          assert.equal(deleted.base_data, null);
          assert.equal(deleted.transcript, '');
          const messageCount = (await messages(actor)).length;
          await callback(actor, `sp:${draft.id}:0`);
          await callback(actor, `sc:${draft.id}`);
          assert.equal((await messages(actor)).length, messageCount);
          assert.equal((await s.letters.signatures(actor)).length, 0);
        }
      },
    );

    await t.test(
      'bare deletion lists all three own signatures and a repeat cannot delete another one',
      async () => {
        const actor = await owner();
        const foreign = await owner();
        await s.letters.writeSignature(foreign, { ...data, lastName: 'Чужой' });
        const created: Array<{ id: string }> = [];
        for (const lastName of ['Иванов', 'Петров', 'Сидоров'])
          created.push(await s.letters.writeSignature(actor, { ...data, lastName }));
        await s.letters.setDefault(actor, created[1]!.id);
        const before = await s.letters.signatures(actor);
        const draft = await bare(actor);
        assert.equal(draft.options.length, 3);
        assert.deepEqual(
          draft.options.map((option: any) => option.id).sort(),
          created.map((signature) => signature.id).sort(),
        );
        for (const invalid of [-1, 0.5, draft.options.length])
          await assert.rejects(
            s.voiceSignatures.choose(actor, draft.id, invalid),
            /Выберите подпись/,
          );
        assert.deepEqual(await s.letters.signatures(actor), before);
        const index = draft.options.findIndex((option: any) => option.id === created[1]!.id);
        await callback(actor, `sp:${draft.id}:${index}`);
        const remaining = await s.letters.signatures(actor);
        assert.equal(remaining.length, 2);
        assert.ok(remaining.every((signature) => signature.id !== created[1]!.id));
        assert.ok(remaining.every((signature) => !signature.isDefault));
        const messageCount = (await messages(actor)).length;
        await callback(actor, `sp:${draft.id}:${index}`);
        await callback(actor, `sp:${draft.id}:${(index + 1) % 3}`);
        await callback(actor, `sx:${draft.id}`);
        assert.deepEqual(await s.letters.signatures(actor), remaining);
        assert.equal((await messages(actor)).length, messageCount);
        assert.equal((await s.letters.signatures(foreign)).length, 1);
        await s.letters.writeSignature(actor, { ...data, lastName: 'Новая' });
        assert.equal((await s.letters.signatures(actor)).length, 3);
      },
    );

    await t.test('bare deletion respects ownership, active access and cancellation', async () => {
      const actor = await owner();
      const foreign = await owner();
      foreign.role = 'admin';
      await db.query("UPDATE users SET role='admin' WHERE id=$1", [foreign.id]);
      const signature = await s.letters.writeSignature(actor, data);
      await s.letters.setDefault(actor, signature.id);
      const before = await s.letters.signatures(actor);
      const draft = await bare(actor);
      for (const action of [`sp:${draft.id}:0`, `sc:${draft.id}`, `sx:${draft.id}`]) {
        await callback(foreign, action);
        assert.equal(answers.at(-1).show_alert, true);
      }
      await db.query('UPDATE users SET active=false WHERE id=$1', [actor.id]);
      await assert.rejects(s.voiceSignatures.choose(actor, draft.id, 0), /Доступ отозван/);
      await callback(actor, `sx:${draft.id}`);
      assert.equal(answers.at(-1).show_alert, true);
      assert.equal((await draftById(draft.id)).status, 'selecting_delete');
      assert.deepEqual(await s.letters.signatures(actor), before);
      await db.query('UPDATE users SET active=true WHERE id=$1', [actor.id]);
      await callback(actor, `sx:${draft.id}`);
      assert.equal((await draftById(draft.id)).status, 'cancelled');
      await callback(actor, `sp:${draft.id}:0`);
      await assert.rejects(s.voiceSignatures.confirm(actor, draft.id), /отменён/);
      assert.deepEqual(await s.letters.signatures(actor), before);
    });

    await t.test(
      'bare deletion rejects a changed or missing list item and rolls back on notification failure',
      async () => {
        const actor = await owner();
        const first = await s.letters.writeSignature(actor, data);
        const second = await s.letters.writeSignature(actor, { ...data, lastName: 'Петров' });
        const draft = await bare(actor);
        const firstIndex = draft.options.findIndex((option: any) => option.id === first.id);
        const secondIndex = draft.options.findIndex((option: any) => option.id === second.id);
        await s.letters.writeSignature(actor, { ...data, email: 'updated@example.com' }, first.id);
        await assert.rejects(s.voiceSignatures.choose(actor, draft.id, firstIndex), /изменилась/);
        await s.letters.deleteSignature(actor, second.id);
        await assert.rejects(s.voiceSignatures.choose(actor, draft.id, secondIndex), /удалена/);
        assert.deepEqual(await draftById(draft.id), draft);
        const fresh = await bare(actor);
        const before = await s.letters.signatures(actor);
        const notify = s.reports.notify;
        s.reports.notify = async () => {
          throw new Error('outbox unavailable');
        };
        try {
          await assert.rejects(s.voiceSignatures.choose(actor, fresh.id, 0), /outbox unavailable/);
        } finally {
          s.reports.notify = notify;
        }
        assert.deepEqual(await draftById(fresh.id), fresh);
        assert.deepEqual(await s.letters.signatures(actor), before);
        await callback(actor, `sp:${fresh.id}:0`);
        assert.equal((await s.letters.signatures(actor)).length, 0);
      },
    );

    await t.test(
      'infinitive edits and field removal preserve the signature and its default status',
      async () => {
        const actor = await owner();
        const signature = await s.letters.writeSignature(actor, data);
        await s.letters.setDefault(actor, signature.id);
        const unchanged = await s.letters.signatures(actor);
        const changes = {
          lastName: null,
          firstName: null,
          patronymic: null,
          workPhone: null,
          mobilePhone: null,
          email: null,
        };
        const edit = await voice(actor, 'Нужно изменить email в подписи по умолчанию', {
          targetName: '',
          changes: { ...changes, email: 'new@example.com' },
        });
        assert.equal(edit.operation, 'edit');
        assert.deepEqual(await s.letters.signatures(actor), unchanged);
        await callback(actor, `sc:${edit.id}`);
        assert.deepEqual(await s.letters.signatures(actor), [
          { ...data, id: signature.id, isDefault: true, email: 'new@example.com' },
        ]);
        const remove = await voice(actor, 'Убери телефон из подписи', {
          targetName: '',
          changes: { ...changes, workPhone: '' },
        });
        assert.equal(remove.operation, 'edit');
        assert.equal((await s.letters.signatures(actor))[0]!.workPhone, '123');
        await callback(actor, `sc:${remove.id}`);
        assert.deepEqual(await s.letters.signatures(actor), [
          { ...data, id: signature.id, isDefault: true, email: 'new@example.com', workPhone: '' },
        ]);
      },
    );

    await t.test(
      'a request targeting the default signature stays intact until private confirmation; repeats are harmless',
      async () => {
        const actor = await owner();
        const signature = await s.letters.writeSignature(actor, data);
        await s.letters.setDefault(actor, signature.id);
        const before = await s.letters.signatures(actor);
        const draft = await voice(actor, 'Удалить подпись по умолчанию');
        assert.equal(draft.operation, 'delete');
        assert.equal(draft.status, 'pending');
        assert.equal(draft.target_id, signature.id);
        assert.deepEqual(await s.letters.signatures(actor), before);
        assert.equal((await s.voiceSignatures.list(actor)).length, 0);
        await assertPreview(actor, draft.id);
        await assert.rejects(s.voiceSignatures.save(actor, draft.id, data), /Telegram/);
        await callback(actor, `sc:${draft.id}`, 'group');
        await callback(actor, `sc:${draft.id}`, 'private', '999999');
        assert.deepEqual(await s.letters.signatures(actor), before);
        await callback(actor, `sc:${draft.id}`);
        assert.equal(answers.at(-1).show_alert, undefined);
        assert.equal((await s.letters.signatures(actor)).length, 0);
        const messageCount = (await messages(actor)).length;
        await callback(actor, `sc:${draft.id}`);
        assert.equal(answers.at(-1).show_alert, undefined);
        await s.voiceSignatures.confirm(actor, draft.id);
        assert.equal(
          (await messages(actor)).length,
          messageCount,
          'repeat confirmation must not re-enqueue completion',
        );
        const cleared = await draftById(draft.id);
        assert.equal(cleared.status, 'saved');
        assert.deepEqual(cleared.data, {});
        assert.deepEqual(cleared.options, []);
        assert.equal(cleared.base_data, null);
        assert.equal(cleared.transcript, '');
      },
    );

    await t.test('unique name targets one signature and preserves another default', async () => {
      const actor = await owner();
      const target = await s.letters.writeSignature(actor, data);
      const other = await s.letters.writeSignature(actor, { ...data, lastName: 'Петров' });
      await s.letters.setDefault(actor, other.id);
      const before = await s.letters.signatures(actor);
      const draft = await voice(actor, 'Удали подпись Иванова', { targetName: 'Иванов' });
      assert.equal(draft.status, 'pending');
      assert.equal(draft.target_id, target.id);
      assert.deepEqual(await s.letters.signatures(actor), before);
      await callback(actor, `sc:${draft.id}`);
      assert.deepEqual(
        await s.letters.signatures(actor),
        before.filter((signature) => signature.id !== target.id),
      );
    });

    await t.test(
      'duplicate names require selection, then preview, then a separate confirmation',
      async () => {
        const actor = await owner();
        const first = await s.letters.writeSignature(actor, data);
        const second = await s.letters.writeSignature(actor, {
          ...data,
          email: 'second@example.com',
        });
        await s.letters.setDefault(actor, second.id);
        const before = await s.letters.signatures(actor);
        const draft = await voice(actor, 'Удали подпись Иванова', { targetName: 'Иванов' });
        assert.equal(draft.status, 'selecting');
        assert.equal(draft.options.length, 2);
        await assert.rejects(s.voiceSignatures.confirm(actor, draft.id), /выбор/);
        for (const invalid of [-1, 0.5, draft.options.length])
          await assert.rejects(
            s.voiceSignatures.choose(actor, draft.id, invalid),
            /Выберите подпись/,
          );
        const index = draft.options.findIndex((option: any) => option.id === second.id);
        await callback(actor, `sp:${draft.id}:${index}`);
        assert.deepEqual(await s.letters.signatures(actor), before);
        assert.equal((await draftById(draft.id)).status, 'pending');
        await assertPreview(actor, draft.id);
        await callback(actor, `sp:${draft.id}:${1 - index}`);
        assert.equal(
          (await draftById(draft.id)).target_id,
          second.id,
          'a repeated selection cannot change the previewed target',
        );
        await callback(actor, `sc:${draft.id}`);
        const remaining = await s.letters.signatures(actor);
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0]!.id, first.id);
        assert.equal(
          remaining[0]!.isDefault,
          false,
          'deleting the default must not promote another signature',
        );
      },
    );

    await t.test(
      'missing target names never fall back to the only signature; an unresolved named command retains selection and preview',
      async () => {
        const actor = await owner();
        await s.letters.writeSignature(actor, data);
        const missing = await voice(actor, 'Удалить подпись Сидорова', { targetName: 'Сидоров' });
        assert.equal(missing.status, 'selecting');
        assert.equal(missing.target_id, null);
        assert.equal(missing.options.length, 1);
        await callback(actor, `sx:${missing.id}`);
        await s.letters.writeSignature(actor, { ...data, lastName: 'Петров' });
        const unnamed = await voice(actor);
        assert.equal(unnamed.status, 'selecting');
        assert.equal(unnamed.options.length, 2);
        assert.equal((await s.letters.signatures(actor)).length, 2);
      },
    );

    await t.test(
      'cancelling pending and selecting drafts leaves signature data and defaults intact',
      async () => {
        const actor = await owner();
        const signature = await s.letters.writeSignature(actor, data);
        await s.letters.setDefault(actor, signature.id);
        const pending = await voice(actor);
        const before = await s.letters.signatures(actor);
        await callback(actor, `sx:${pending.id}`);
        await assert.rejects(s.voiceSignatures.confirm(actor, pending.id), /отменён/);
        assert.deepEqual(await s.letters.signatures(actor), before);
        await s.letters.writeSignature(actor, { ...data, lastName: 'Петров' });
        const selecting = await voice(actor);
        const twoBefore = await s.letters.signatures(actor);
        await callback(actor, `sx:${selecting.id}`);
        await callback(actor, `sp:${selecting.id}:0`);
        await assert.rejects(s.voiceSignatures.confirm(actor, selecting.id), /отменён/);
        assert.deepEqual(await s.letters.signatures(actor), twoBefore);
      },
    );

    await t.test(
      'foreign and blocked callers cannot select, cancel or confirm another owner’s deletion',
      async () => {
        const actor = await owner();
        const foreign = await owner();
        foreign.role = 'admin';
        await db.query("UPDATE users SET role='admin' WHERE id=$1", [foreign.id]);
        await s.letters.writeSignature(actor, data);
        await s.letters.writeSignature(actor, { ...data, lastName: 'Петров' });
        const before = await s.letters.signatures(actor);
        const selecting = await voice(actor);
        for (const action of [`sp:${selecting.id}:0`, `sc:${selecting.id}`, `sx:${selecting.id}`]) {
          await callback(foreign, action);
          assert.equal(answers.at(-1).show_alert, true);
        }
        await db.query('UPDATE users SET active=false WHERE id=$1', [actor.id]);
        await assert.rejects(s.voiceSignatures.choose(actor, selecting.id, 0), /Доступ отозван/);
        await callback(actor, `sp:${selecting.id}:0`);
        assert.equal(answers.at(-1).show_alert, true);
        assert.equal((await draftById(selecting.id)).status, 'selecting');
        await db.query('UPDATE users SET active=true WHERE id=$1', [actor.id]);
        await callback(actor, `sp:${selecting.id}:0`);
        await db.query('UPDATE users SET active=false WHERE id=$1', [actor.id]);
        await assert.rejects(s.voiceSignatures.confirm(actor, selecting.id), /Доступ отозван/);
        await callback(actor, `sc:${selecting.id}`);
        assert.equal(answers.at(-1).show_alert, true);
        await callback(actor, `sx:${selecting.id}`);
        assert.equal(answers.at(-1).show_alert, true);
        assert.equal((await draftById(selecting.id)).status, 'pending');
        assert.deepEqual(await s.letters.signatures(actor), before);
      },
    );

    await t.test(
      'a changed or deleted target cannot be selected or confirmed from a stale preview',
      async () => {
        const actor = await owner();
        const signature = await s.letters.writeSignature(actor, data);
        const pending = await voice(actor);
        await s.letters.writeSignature(actor, { ...data, workPhone: 'changed' }, signature.id);
        await assert.rejects(s.voiceSignatures.confirm(actor, pending.id), /изменилась/);
        assert.equal((await draftById(pending.id)).status, 'pending');
        const current = await voice(actor);
        await s.letters.deleteSignature(actor, signature.id);
        await assert.rejects(s.voiceSignatures.confirm(actor, current.id), /удалена/);
        assert.equal((await draftById(current.id)).status, 'pending');
        const first = await s.letters.writeSignature(actor, data);
        const second = await s.letters.writeSignature(actor, { ...data, lastName: 'Петров' });
        const selecting = await voice(actor);
        const firstIndex = selecting.options.findIndex((option: any) => option.id === first.id);
        const secondIndex = selecting.options.findIndex((option: any) => option.id === second.id);
        await s.letters.writeSignature(actor, { ...data, email: 'changed@example.com' }, first.id);
        await assert.rejects(
          s.voiceSignatures.choose(actor, selecting.id, firstIndex),
          /изменилась/,
        );
        await s.letters.deleteSignature(actor, second.id);
        await assert.rejects(s.voiceSignatures.choose(actor, selecting.id, secondIndex), /удалена/);
        assert.equal((await draftById(selecting.id)).status, 'selecting');
        assert.equal((await s.letters.signatures(actor))[0]!.email, 'changed@example.com');
      },
    );

    await t.test('failed outbox enqueue rolls back selection and confirmed deletion', async () => {
      const actor = await owner();
      const signature = await s.letters.writeSignature(actor, data);
      await s.letters.writeSignature(actor, { ...data, lastName: 'Петров' });
      await s.letters.setDefault(actor, signature.id);
      const before = await s.letters.signatures(actor);
      const selecting = await voice(actor);
      const index = selecting.options.findIndex((option: any) => option.id === signature.id);
      const notify = s.reports.notify;
      s.reports.notify = async () => {
        throw new Error('outbox unavailable');
      };
      try {
        await assert.rejects(
          s.voiceSignatures.choose(actor, selecting.id, index),
          /outbox unavailable/,
        );
      } finally {
        s.reports.notify = notify;
      }
      assert.deepEqual(await draftById(selecting.id), selecting);
      assert.deepEqual(await s.letters.signatures(actor), before);
      await callback(actor, `sp:${selecting.id}:${index}`);
      const pending = await draftById(selecting.id);
      s.reports.notify = async () => {
        throw new Error('outbox unavailable');
      };
      try {
        await assert.rejects(s.voiceSignatures.confirm(actor, pending.id), /outbox unavailable/);
      } finally {
        s.reports.notify = notify;
      }
      assert.deepEqual(await draftById(pending.id), pending);
      assert.deepEqual(await s.letters.signatures(actor), before);
      await callback(actor, `sc:${pending.id}`);
      assert.equal((await s.letters.signatures(actor)).length, 1);
    });

    await t.test(
      'only confirmed deletion frees a slot under the maximum of three signatures',
      async () => {
        const actor = await owner();
        for (const lastName of ['Иванов', 'Петров', 'Сидоров'])
          await s.letters.writeSignature(actor, { ...data, lastName });
        const deletion = await voice(actor, 'Удалить подпись Иванова', { targetName: 'Иванов' });
        const creation = await voice(actor, 'Создать подпись. Козлов Иван', {
          ...data,
          lastName: 'Козлов',
        });
        await assert.rejects(s.voiceSignatures.confirm(actor, creation.id), /трёх подписей/);
        assert.equal((await s.letters.signatures(actor)).length, 3);
        await callback(actor, `sc:${deletion.id}`);
        await callback(actor, `sc:${creation.id}`);
        const saved = await s.letters.signatures(actor);
        assert.equal(saved.length, 3);
        assert.ok(saved.some((signature) => signature.lastName === 'Козлов'));
        assert.ok(saved.every((signature) => signature.lastName !== 'Иванов'));
      },
    );

    await t.test(
      'deleting a signature preserves an already stored PDF and sent letter job',
      async () => {
        const actor = await owner();
        const signature = await s.letters.writeSignature(actor, data);
        const companyId = randomUUID();
        const fileId = randomUUID();
        const fileKey = randomUUID();
        const jobId = randomUUID();
        const filePath = join(dir, 'files', fileKey);
        const pdf = Buffer.from('%PDF-1.4\nStored letter with Иванов Иван\n%%EOF\n');
        await mkdir(join(dir, 'files'), { recursive: true });
        await writeFile(filePath, pdf);
        await db.query('INSERT INTO companies(id,owner_id,data) VALUES($1,$2,$3)', [
          companyId,
          actor.id,
          JSON.stringify({ name: 'ООО Ромашка' }),
        ]);
        await db.query(
          "INSERT INTO records(id,kind,company_id,author_id,data) VALUES($1,'file',$2,$3,$4)",
          [
            fileId,
            companyId,
            actor.id,
            JSON.stringify({ name: 'letter.pdf', key: fileKey, size: pdf.length }),
          ],
        );
        await db.query(
          "INSERT INTO letter_jobs(id,source_key,user_id,chat_id,query,signature_id,status,file_id) VALUES($1,$2,$3,$4,$5,$6,'sent',$7)",
          [jobId, `sent:${jobId}`, actor.id, actor.telegramId, 'ООО Ромашка', signature.id, fileId],
        );
        const [fileBefore] = await db.query('SELECT * FROM records WHERE id=$1', [fileId]);
        const [jobBefore] = await db.query('SELECT * FROM letter_jobs WHERE id=$1', [jobId]);
        const draft = await bare(actor);
        await callback(actor, `sp:${draft.id}:0`);
        assert.equal((await s.letters.signatures(actor)).length, 0);
        assert.deepEqual(await readFile(filePath), pdf);
        assert.deepEqual(
          (await db.query('SELECT * FROM records WHERE id=$1', [fileId]))[0],
          fileBefore,
        );
        assert.deepEqual(
          (await db.query('SELECT * FROM letter_jobs WHERE id=$1', [jobId]))[0],
          jobBefore,
        );
      },
    );
    assert.equal(reportExtractions, 0);
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
