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
import { BotService } from '../server/services/bot';
import { TelegramAdapter } from '../server/infra/telegram';

test('voice contacts require an existing accessible company and an explicit confirmation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-voice-contacts-'));
  const config = makeConfig({ DATA_DIR: dir });
  const { app, services: s, db } = await createApp(config);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Voice contact tests must not use the network');
  });
  let sequence = 0;
  let transcript = '';
  let response: unknown;
  let aiCalls = 0;
  const contact = {
    name: 'Иван Петров',
    role: 'Коммерческий директор',
    phone: '+79991112233',
    email: 'petrov@example.com',
  };
  const extraction = (companyName = 'Рога и копыта', overrides: Record<string, unknown> = {}) => ({
    companyName,
    inn: '',
    city: '',
    contact,
    ambiguous: false,
    ...overrides,
  });
  s.letters.ai.request = async () => {
    aiCalls++;
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
        throw new Error('Contact commands must not become activity reports');
      },
    },
    { download: async () => new Uint8Array([1]), send: async () => {} },
    config,
    s.voiceSignatures,
    s.letterBot,
    undefined,
    s.voiceContacts,
  );
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
    undefined,
    s.voiceContacts,
  );
  const owner = async (role: Actor['role'] = 'manager'): Promise<Actor> => {
    const actor: Actor = {
      id: randomUUID(),
      telegramId: String(400000 + ++sequence),
      name: 'Contact owner',
      role,
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
  const read = async (id: string) => (await db.query('SELECT * FROM reports WHERE id=$1', [id]))[0];
  const records = async (companyId: string) =>
    db.query('SELECT * FROM records WHERE company_id=$1 AND NOT deleted', [companyId]);
  const messages = async (actor: Actor) =>
    (await db.query('SELECT payload FROM outbox WHERE chat_id=$1', [actor.telegramId])).map(
      (row) => row.payload,
    );
  const voice = async (
    actor: Actor,
    text = 'Создай контакт для Рога и копыта. Иван Петров, коммерческий директор',
    result: unknown = extraction(),
  ) => {
    transcript = text;
    response = result;
    const report = await s.reports.enqueue(actor, {
      sourceKey: `voice-contact:${++sequence}`,
      chatId: actor.telegramId,
      audioFileId: 'voice',
    });
    await worker.processOne();
    const row = await read(report.id);
    assert.equal(row.purpose, 'contact', text);
    assert.equal(row.lease_token, null);
    assert.equal(row.lease_until, null);
    assert.equal(
      (await s.reports.list(actor)).some((r) => r.id === report.id),
      false,
    );
    return row;
  };
  const callback = async (
    actor: Actor,
    data: string,
    chatType = 'private',
    chatId = actor.telegramId,
  ) => {
    await bot.handle({
      update_id: ++sequence,
      callback_query: {
        id: String(sequence),
        from: { id: Number(actor.telegramId) },
        message: { chat: { id: Number(chatId), type: chatType } },
        data,
      },
    });
  };
  const cancelled = async (row: any) => {
    assert.equal(row.status, 'cancelled');
    assert.equal(row.draft, null);
    assert.equal(row.transcript, null);
    assert.equal(row.audio_file_id, null);
    assert.equal(row.result, null);
    assert.equal(row.error, null);
  };
  try {
    await t.test('bare aliases ask for company and contact data without calling AI', async () => {
      const actor = await owner();
      const before = aiCalls;
      for (const text of [
        'Создай контакт',
        'Создать контакт',
        'Сделай контакт',
        'Нужен контакт',
        'Добавь контакт',
      ]) {
        await cancelled(await voice(actor, text));
      }
      assert.equal(aiCalls, before);
      const texts = (await messages(actor)).map((m) => m.text).join('\n');
      assert.match(texts, /компан/iu);
      assert.match(texts, /контакт|имя|ФИО/iu);
      assert.equal((await s.crm.list(actor)).length, 0);
    });

    await t.test(
      'unknown company asks to create it first, never creates a company or contact',
      async () => {
        const actor = await owner();
        await cancelled(await voice(actor));
        assert.equal((await s.crm.list(actor)).length, 0);
        assert.equal((await s.crm.records(actor, 'contact')).length, 0);
        assert.match((await messages(actor)).map((m) => m.text).join('\n'), /сначала.*созда/isu);
      },
    );

    await t.test(
      'missing name, company, invalid email and ambiguity only request clarification',
      async () => {
        const actor = await owner();
        const company = await s.crm.create(actor, { name: 'Рога и копыта' });
        for (const invalid of [
          extraction('', {}),
          extraction('Рога и копыта', { contact: { ...contact, name: '' } }),
          extraction('Рога и копыта', { contact: { ...contact, email: 'not-an-email' } }),
          extraction('Рога и копыта', { ambiguous: true }),
          extraction('Рога и копыта', { inn: '123' }),
        ]) {
          await cancelled(await voice(actor, undefined, invalid));
        }
        assert.equal((await records(company.id)).length, 0);
      },
    );

    await t.test(
      'a single normalized company match shows all fields, and only a private author confirms',
      async () => {
        const actor = await owner();
        const other = await owner('admin');
        const company = await s.crm.create(actor, { name: 'ООО «Рога и копыта»', city: 'Москва' });
        const draft = await voice(actor, 'Для рога и копыта создай контакт Иван Петров');
        assert.equal(draft.status, 'review');
        assert.equal(draft.draft.company.id, company.id);
        assert.deepEqual(draft.draft.data, contact);
        assert.equal((await records(company.id)).length, 0);
        const preview = (await messages(actor)).at(-1);
        for (const value of Object.values(contact)) assert.ok(preview.text.includes(value));
        const callbacks = preview.reply_markup.inline_keyboard
          .flat()
          .map((b: any) => b.callback_data);
        assert.ok(callbacks.includes(`cc:${draft.id}`));
        assert.ok(callbacks.includes(`cx:${draft.id}`));
        await callback(other, `cc:${draft.id}`);
        assert.equal(answers.at(-1).show_alert, true);
        await callback(actor, `cc:${draft.id}`, 'group');
        await callback(actor, `cc:${draft.id}`, 'private', other.telegramId);
        assert.equal((await records(company.id)).length, 0);
        await callback(actor, `cc:${draft.id}`);
        await callback(actor, `cc:${draft.id}`);
        const saved = await records(company.id);
        assert.equal(saved.length, 1);
        assert.equal(saved[0].kind, 'contact');
        assert.deepEqual(saved[0].data, contact);
        assert.equal(saved[0].author_id, actor.id);
        const row = await read(draft.id);
        assert.equal(row.status, 'saved');
        assert.deepEqual(row.result, { companyId: company.id, contactId: saved[0].id });
        assert.equal(row.draft, null);
        assert.equal(row.transcript, null);
        assert.equal(row.audio_file_id, null);
        assert.equal((await s.crm.list(actor)).length, 1);
      },
    );

    await t.test(
      'multiple company matches require selection, then a separate confirmation',
      async () => {
        const actor = await owner();
        const first = await s.crm.create(actor, { name: 'Рога и копыта', city: 'Москва' });
        const second = await s.crm.create(actor, { name: 'ООО Рога и копыта', city: 'Казань' });
        const draft = await voice(actor);
        assert.equal(draft.status, 'review');
        assert.equal(draft.draft.company, null);
        assert.equal(draft.draft.options.length, 2);
        const choices = (await messages(actor)).at(-1);
        assert.match(choices.text, /Москва/);
        assert.match(choices.text, /Казань/);
        await assert.rejects(s.voiceContacts.confirm(actor, draft.id));
        for (const index of [-1, 2, 0.5, Number.NaN]) {
          await assert.rejects(s.voiceContacts.choose(actor, draft.id, index));
        }
        const index = draft.draft.options.findIndex((option: any) => option.id === second.id);
        await callback(actor, `cp:${draft.id}:${index}`);
        assert.equal((await read(draft.id)).draft.company.id, second.id);
        assert.equal((await records(first.id)).length + (await records(second.id)).length, 0);
        await callback(actor, `cc:${draft.id}`);
        assert.equal((await records(first.id)).length, 0);
        assert.equal((await records(second.id)).length, 1);
      },
    );

    await t.test(
      'a name-only contact keeps optional fields empty without invented data',
      async () => {
        const actor = await owner();
        const company = await s.crm.create(actor, { name: 'Рога и копыта' });
        const minimal = { name: 'Иван', role: '', phone: '', email: '' };
        const draft = await voice(
          actor,
          'Нужен контакт для Рога и копыта. Иван',
          extraction('Рога и копыта', { contact: minimal }),
        );
        assert.deepEqual(draft.draft.data, minimal);
        await s.voiceContacts.confirm(actor, draft.id);
        const saved = await records(company.id);
        assert.equal(saved.length, 1);
        assert.deepEqual(saved[0].data, minimal);
      },
    );

    await t.test(
      'city and valid INN disambiguate company matches; arbitrary substrings do not match',
      async () => {
        const actor = await owner();
        await s.crm.create(actor, { name: 'Рога и копыта', city: 'Москва' });
        const target = await s.crm.create(actor, {
          name: 'Рога и копыта',
          city: 'Казань',
          inn: '7707083893',
        });
        for (const result of [
          extraction('Рога и копыта', { city: 'казань' }),
          extraction('Рога и копыта', { inn: '7707083893' }),
        ]) {
          const draft = await voice(actor, undefined, result);
          assert.equal(draft.draft.company.id, target.id);
          await s.voiceContacts.discard(actor, draft.id);
        }
        await cancelled(await voice(actor, 'Добавь контакт для Рога', extraction('Рога')));
        assert.equal((await s.crm.records(actor, 'contact')).length, 0);
      },
    );

    await t.test(
      'too many company matches ask for INN or city instead of truncating the list',
      async () => {
        const actor = await owner();
        for (let index = 0; index < 11; index++) {
          await s.crm.create(actor, { name: 'Рога и копыта', city: `Город ${index}` });
        }
        await cancelled(await voice(actor));
        assert.match((await messages(actor)).at(-1).text, /ИНН|город/iu);
        assert.equal((await s.crm.records(actor, 'contact')).length, 0);
      },
    );

    await t.test('foreign and archived companies are not offered as targets', async () => {
      const actor = await owner();
      const other = await owner();
      await s.crm.create(other, { name: 'Рога и копыта', city: 'Секретный город' });
      await s.crm.create(actor, { name: 'Рога и копыта', archived: true });
      await cancelled(await voice(actor));
      const texts = (await messages(actor)).map((m) => m.text).join('\n');
      assert.equal(texts.includes('Секретный город'), false);
      assert.equal((await s.crm.records(actor, 'contact')).length, 0);
    });

    await t.test(
      'active author and current ACL are rechecked for choose, confirm and cancel',
      async () => {
        const actor = await owner();
        const other = await owner('admin');
        const company = await s.crm.create(actor, { name: 'Рога и копыта' });
        const draft = await voice(actor);
        await assert.rejects(s.voiceContacts.confirm(other, draft.id));
        await assert.rejects(s.voiceContacts.discard(other, draft.id));
        await assert.rejects(s.voiceContacts.choose(other, draft.id, 0));
        await db.query('UPDATE users SET active=false WHERE id=$1', [actor.id]);
        await assert.rejects(s.voiceContacts.confirm(actor, draft.id));
        await assert.rejects(s.voiceContacts.discard(actor, draft.id));
        await db.query('UPDATE users SET active=true WHERE id=$1', [actor.id]);
        await s.crm.assign(other, company.id, other.id, company.version);
        await assert.rejects(s.voiceContacts.confirm(actor, draft.id));
        assert.equal((await records(company.id)).length, 0);
        assert.equal((await read(draft.id)).status, 'review');
      },
    );

    await t.test(
      'changed, archived or reassigned company snapshots cannot be selected or confirmed',
      async () => {
        for (const mode of ['edited', 'archived', 'reassigned']) {
          const actor = await owner();
          const other = await owner('admin');
          const company = await s.crm.create(actor, { name: 'Рога и копыта' });
          const single = await voice(actor);
          await s.crm.create(actor, { name: 'Рога и копыта', city: 'Казань' });
          const multiple = await voice(actor);
          const index = multiple.draft.options.findIndex((o: any) => o.id === company.id);
          if (mode === 'reassigned') {
            await s.crm.assign(other, company.id, other.id, company.version);
          } else {
            await db.query(
              'UPDATE companies SET data=data || $1::jsonb,version=version+1 WHERE id=$2',
              [
                JSON.stringify(
                  mode === 'archived' ? { archived: true } : { notes: 'Changed after preview' },
                ),
                company.id,
              ],
            );
          }
          await assert.rejects(s.voiceContacts.confirm(actor, single.id), mode);
          await assert.rejects(s.voiceContacts.choose(actor, multiple.id, index), mode);
          assert.equal((await records(company.id)).length, 0);
        }
      },
    );

    await t.test(
      'an admin role removed after preview cannot be supplied back in a stale actor object',
      async () => {
        const actor = await owner('admin');
        const companyOwner = await owner();
        const company = await s.crm.create(companyOwner, { name: 'Административный доступ' });
        const draft = await voice(
          actor,
          'Создай контакт для Административный доступ. Иван Петров',
          extraction('Административный доступ'),
        );
        assert.equal(draft.draft.company.id, company.id);
        await db.query("UPDATE users SET role='manager' WHERE id=$1", [actor.id]);
        await assert.rejects(s.voiceContacts.confirm(actor, draft.id));
        assert.equal((await records(company.id)).length, 0);
      },
    );

    await t.test('cancelling both selection and preview leaves CRM untouched', async () => {
      const actor = await owner();
      const company = await s.crm.create(actor, { name: 'Рога и копыта' });
      const preview = await voice(actor);
      await callback(actor, `cx:${preview.id}`);
      await callback(actor, `cx:${preview.id}`);
      await cancelled(await read(preview.id));
      await assert.rejects(s.voiceContacts.confirm(actor, preview.id));
      await s.crm.create(actor, { name: 'Рога и копыта', city: 'Казань' });
      const selecting = await voice(actor);
      await callback(actor, `cx:${selecting.id}`);
      await cancelled(await read(selecting.id));
      await s.voiceContacts.choose(actor, selecting.id, 0);
      await cancelled(await read(selecting.id));
      assert.equal((await records(company.id)).length, 0);
      assert.equal((await s.crm.records(actor, 'contact')).length, 0);
    });

    await t.test(
      'identical existing contacts and simultaneous duplicate confirmations are idempotent',
      async () => {
        const actor = await owner();
        const company = await s.crm.create(actor, { name: 'Рога и копыта' });
        const first = await voice(actor);
        const second = await voice(actor);
        await Promise.all([
          s.voiceContacts.confirm(actor, first.id),
          s.voiceContacts.confirm(actor, second.id),
          s.voiceContacts.confirm(actor, first.id),
        ]);
        const saved = await records(company.id);
        assert.equal(saved.length, 1);
        assert.equal((await read(first.id)).result.contactId, saved[0].id);
        assert.equal((await read(second.id)).result.contactId, saved[0].id);
        const third = await voice(actor);
        await s.voiceContacts.confirm(actor, third.id);
        assert.equal((await read(third.id)).result.contactId, saved[0].id);
        const differentRole = await voice(
          actor,
          undefined,
          extraction('Рога и копыта', {
            contact: { ...contact, role: 'Генеральный директор' },
          }),
        );
        await s.voiceContacts.confirm(actor, differentRole.id);
        assert.equal((await records(company.id)).length, 2);
      },
    );

    await t.test('a deleted old contact is not silently reused', async () => {
      const actor = await owner();
      const company = await s.crm.create(actor, { name: 'Рога и копыта' });
      const removed = await s.crm.createRecord(actor, company.id, 'contact', contact);
      await db.query('UPDATE records SET deleted=true WHERE id=$1', [removed.id]);
      const draft = await voice(actor);
      await s.voiceContacts.confirm(actor, draft.id);
      const saved = await records(company.id);
      assert.equal(saved.length, 1);
      assert.notEqual(saved[0].id, removed.id);
      assert.equal((await read(draft.id)).result.contactId, saved[0].id);
    });

    await t.test('outbox failure rolls back contact insertion and company selection', async () => {
      const actor = await owner();
      const company = await s.crm.create(actor, { name: 'Рога и копыта' });
      const draft = await voice(actor);
      const notify = s.reports.notify;
      s.reports.notify = async () => {
        throw new Error('outbox unavailable');
      };
      try {
        await assert.rejects(s.voiceContacts.confirm(actor, draft.id), /outbox unavailable/);
      } finally {
        s.reports.notify = notify;
      }
      assert.equal((await records(company.id)).length, 0);
      assert.equal((await read(draft.id)).status, 'review');
      await s.voiceContacts.discard(actor, draft.id);
      await s.crm.create(actor, { name: 'Рога и копыта', city: 'Казань' });
      const selecting = await voice(actor);
      s.reports.notify = async () => {
        throw new Error('outbox unavailable');
      };
      try {
        await assert.rejects(s.voiceContacts.choose(actor, selecting.id, 0), /outbox unavailable/);
      } finally {
        s.reports.notify = notify;
      }
      assert.equal((await read(selecting.id)).draft.company, null);
      assert.equal((await s.crm.records(actor, 'contact')).length, 0);
    });

    await t.test('stale worker lease cannot publish a draft or mutate CRM', async () => {
      const actor = await owner();
      const company = await s.crm.create(actor, { name: 'Рога и копыта' });
      const enqueued = await s.reports.enqueue(actor, {
        sourceKey: `voice-contact:${++sequence}`,
        chatId: actor.telegramId,
        audioFileId: 'voice',
      });
      const currentToken = randomUUID();
      await db.query(
        "UPDATE reports SET status='processing',lease_token=$1,lease_until=now()+interval '4 minutes' WHERE id=$2",
        [currentToken, enqueued.id],
      );
      const report = await read(enqueued.id);
      response = extraction();
      const before = (await messages(actor)).length;
      await s.voiceContacts.process(
        report,
        randomUUID(),
        'Создай контакт для Рога и копыта. Иван Петров',
      );
      const after = await read(enqueued.id);
      assert.equal(after.status, 'processing');
      assert.equal(after.lease_token, currentToken);
      assert.equal(after.draft, null);
      assert.equal((await messages(actor)).length, before);
      assert.equal((await records(company.id)).length, 0);
    });

    await t.test('lease lost during AI extraction cannot publish an obsolete preview', async () => {
      const actor = await owner();
      const company = await s.crm.create(actor, { name: 'Рога и копыта' });
      const enqueued = await s.reports.enqueue(actor, {
        sourceKey: `voice-contact:${++sequence}`,
        chatId: actor.telegramId,
        audioFileId: 'voice',
      });
      const firstToken = randomUUID();
      const replacementToken = randomUUID();
      await db.query(
        "UPDATE reports SET status='processing',lease_token=$1,lease_until=now()+interval '4 minutes' WHERE id=$2",
        [firstToken, enqueued.id],
      );
      const report = await read(enqueued.id);
      const request = s.letters.ai.request;
      const messageCount = (await messages(actor)).length;
      let extracted = false;
      s.letters.ai.request = async () => {
        extracted = true;
        await db.query('UPDATE reports SET lease_token=$1 WHERE id=$2', [
          replacementToken,
          enqueued.id,
        ]);
        return {
          status: 'completed',
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(extraction()) }] }],
        };
      };
      try {
        await s.voiceContacts.process(
          report,
          firstToken,
          'Создай контакт для Рога и копыта. Иван Петров',
        );
      } finally {
        s.letters.ai.request = request;
      }
      assert.equal(extracted, true);
      const after = await read(enqueued.id);
      assert.equal(after.status, 'processing');
      assert.equal(after.lease_token, replacementToken);
      assert.equal(after.draft, null);
      assert.equal((await messages(actor)).length, messageCount);
      assert.equal((await records(company.id)).length, 0);
    });

    await t.test('other report, letter and signature voice intents are not consumed', async () => {
      const actor = await owner();
      const before = aiCalls;
      for (const text of [
        'Встреча с компанией Рога и копыта. Иван обещал позвонить завтра',
        'Подготовь письмо для Рога и копыта',
        'Создай подпись Иванов Иван',
        'Измени телефон в подписи Иванова',
        'Удали подпись',
      ]) {
        assert.equal(
          await s.voiceContacts.process(
            { audio_file_id: 'voice', author_id: actor.id },
            randomUUID(),
            text,
          ),
          false,
          text,
        );
      }
      assert.equal(aiCalls, before);
    });
    await t.test('text input does not enter the voice-only contact workflow', async () => {
      const actor = await owner();
      const before = aiCalls;
      assert.equal(
        await s.voiceContacts.process(
          { audio_file_id: null, author_id: actor.id },
          randomUUID(),
          'Создай контакт для Рога и копыта. Иван Петров',
        ),
        false,
      );
      assert.equal(aiCalls, before);
    });
    for (const row of await db.query('SELECT payload FROM outbox')) {
      for (const buttons of row.payload.reply_markup?.inline_keyboard || []) {
        for (const button of buttons) {
          if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
        }
      }
    }
    assert.equal(
      (await db.query("SELECT id FROM records WHERE kind IN ('activity','task')")).length,
      0,
    );
    assert.equal((await db.query('SELECT id FROM letter_jobs')).length, 0);
    assert.equal((await db.query('SELECT id FROM signature_drafts')).length, 0);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
