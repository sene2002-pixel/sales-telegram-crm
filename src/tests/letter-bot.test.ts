import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor } from '../shared/contracts';
import { LetterBot, letterQuery, recipientResearchSchema } from '../server/services/letter-bot';
import { ProcessingMessageUndeletable, TelegramAdapter } from '../server/infra/telegram';

test('letter intent recognizes requests, not historical reports', () => {
  for (const text of [
    'Подготовь письмо для ООО Ромашка',
    'Отправь мне письмо компании Ромашка',
    '/letter Ромашка',
    'Напиши информационное письмо для Ромашка',
  ])
    assert.ok(letterQuery(text));
  for (const text of ['Вчера отправил письмо клиенту', 'Обсудили письмо с директором', '/crm'])
    assert.equal(letterQuery(text), null);
});

test('letter requests accept optional prepositions, infinitives and dictation punctuation', () => {
  for (const prefix of [
    'Подготовь письмо',
    'Подготовьте письмо',
    'Подготовить письмо',
    'Нужно подготовить письмо',
    'Хочу подготовить письмо',
    'Можешь подготовить письмо',
    'Создай письмо',
    'Создать письмо',
    'Сделай письмо',
    'Сделать письмо',
    'Составь письмо',
    'Составить письмо',
    'Сформируй письмо',
    'Сформировать письмо',
    'Сгенерируй письмо',
    'Сгенерировать письмо',
    'Напиши письмо',
    'Написать письмо',
    'Отправь письмо',
    'Отправить письмо',
    'Подготовь мне информационное письмо',
    'Пожалуйста, подготовь письмо',
    'Подготовь, пожалуйста, письмо',
  ]) {
    for (const connector of ['', 'для ', 'для компании ', 'компании ', 'в компанию ', 'на '])
      assert.equal(letterQuery(`${prefix} ${connector}АО «Стройтрансгаз»`), 'АО «Стройтрансгаз»');
    assert.equal(letterQuery(prefix), '', prefix);
    assert.equal(letterQuery(`${prefix} для`), '', prefix);
  }
  for (const text of [
    'Подготовь письмо. АО «Стройтрансгаз».',
    ' Подготовь, письмо: АО «Стройтрансгаз»! ',
    'Подготовь письмо для АО «Стройтрансгаз», пожалуйста.',
    'Подготовь письмо, пожалуйста, для компании АО «Стройтрансгаз»',
  ])
    assert.equal(letterQuery(text), 'АО «Стройтрансгаз»', text);
  for (const text of ['Подготовь письмо для компании.', 'Подготовь письмо, пожалуйста.', '/letter'])
    assert.equal(letterQuery(text), '', text);
  for (const text of [
    'Вчера подготовил письмо для Ромашки',
    'Отправил письмо клиенту',
    'Компания Альфа попросила подготовить письмо',
    'Не отправь письмо клиенту',
    'Подготовь отчёт',
    'Подготовь письмоносцу задачу',
  ])
    assert.equal(letterQuery(text), null, text);
});

test('default signatures, durable letter queue, sources and PDF delivery', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-letter-bot-'));
  const config = makeConfig({ DATA_DIR: dir, BOT_TOKEN: 'test', OPENAI_API_KEY: 'test' });
  const { app, services: s, db } = await createApp(config);
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '12345',
    name: 'Manager',
    role: 'manager',
    active: true,
  };
  const other: Actor = { ...actor, id: randomUUID(), telegramId: '67890' };
  for (const user of [actor, other])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      user.id,
      user.telegramId,
      user.name,
      user.role,
    ]);
  const telegram = new TelegramAdapter(config);
  const bot = new LetterBot(s.crm, s.letters, s.reports, telegram, config);
  const signature = {
    lastName: 'Петров',
    firstName: 'Пётр',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  };
  const sources = ['https://example.com/company'];
  const research = {
    status: 'found',
    company: {
      name: 'ООО Ромашка',
      inn: '7707083893',
      city: 'Москва',
      industry: 'Энергетика — генерация',
      activity: 'Генерация электроэнергии',
    },
    recipient: { name: 'Иванов Иван Иванович', role: 'Генеральный директор' },
    sources,
  };
  const response = (data: unknown) => ({
    status: 'completed',
    output: [
      {
        type: 'web_search_call',
        action: { sources: sources.map((url) => ({ type: 'url', url })) },
      },
      { content: [{ type: 'output_text', text: JSON.stringify(data) }] },
    ],
  });
  try {
    await t.test('default selection is private, unique and survives edit', async () => {
      await assert.rejects(bot.enqueue(actor, 'absent', 'Ромашка'), /создайте подпись/);
      const first = await s.letters.writeSignature(actor, signature);
      const second = await s.letters.writeSignature(actor, { ...signature, firstName: 'Иван' });
      await bot.enqueue(actor, 'missing-default', 'Ромашка');
      const [waiting] = await db.query('SELECT * FROM letter_jobs WHERE source_key=$1', [
        'missing-default',
      ]);
      assert.equal(waiting.status, 'waiting_signature');
      await bot.chooseSignature(actor, waiting.id);
      await db.query('DELETE FROM letter_jobs WHERE id=$1', [waiting.id]);
      await assert.rejects(s.letters.setDefault(other, first.id), /не найдена/);
      await s.letters.setDefault(actor, first.id);
      await s.letters.setDefault(actor, second.id);
      const edited = await s.letters.writeSignature(actor, signature, second.id);
      assert.equal(edited.isDefault, true);
      assert.equal((await s.letters.signatures(actor)).filter((s) => s.isDefault).length, 1);
      await s.letters.deleteSignature(actor, second.id);
      assert.equal((await s.letters.signatures(actor)).filter((s) => s.isDefault).length, 0);
      await s.letters.setDefault(actor, first.id);
    });
    await t.test(
      'webhook plans once and enqueues letter only after individual confirmation',
      async () => {
        const update = {
          update_id: 987654,
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            from: { id: 12345 },
            chat: { id: 12345, type: 'private' },
            text: 'Подготовь письмо для ООО Ромашка',
          },
        };
        await s.bot.handle(update);
        await s.bot.handle(update);
        assert.equal((await db.query('SELECT * FROM letter_jobs')).length, 0);
        assert.equal((await db.query("SELECT * FROM reports WHERE purpose='dialogue'")).length, 1);
        s.letters.ai.request = async () =>
          response({
            mode: 'append',
            discussedCompany: null,
            reply: '',
            actions: [
              {
                kind: 'letter',
                company: { mode: 'named', name: 'ООО Ромашка', inn: '', city: '' },
              },
            ],
          });
        await s.worker.processOne();
        const [action] = await db.query("SELECT * FROM dialogue_actions WHERE status='ready'");
        assert.ok(action);
        assert.equal((await db.query('SELECT * FROM letter_jobs')).length, 0);
        await s.dialogue.callback(actor, action.id, 'confirm', action.preview_version);
        assert.equal((await db.query('SELECT * FROM letter_jobs')).length, 1);
        assert.equal((await db.query("SELECT * FROM reports WHERE purpose='report'")).length, 0);
        await assert.rejects(bot.enqueue(actor, 'another', 'Ромашка'), /ещё обрабатывается/);
      },
    );
    await t.test('ambiguous company makes no CRM records and asks for clarification', async () => {
      s.letters.ai.request = async () =>
        response({ status: 'ambiguous', company: null, recipient: null, sources: [] });
      await bot.tick();
      assert.equal((await db.query('SELECT * FROM companies')).length, 0);
      const [job] = await db.query('SELECT * FROM letter_jobs');
      assert.equal(job.status, 'failed');
      assert.match(job.error, /ИНН или городом/);
    });
    await t.test('unobserved source URLs are rejected', async () => {
      s.letters.ai.request = async () =>
        response({ ...research, sources: ['https://invented.example.com'] });
      await assert.rejects(
        s.letters.structured(recipientResearchSchema, 'search', 'company', true, true),
        /источники/,
      );
    });
    await t.test(
      'equivalent source URLs retain provider URL; query and path changes are rejected',
      async () => {
        s.letters.ai.request = async () =>
          response({ ...research, sources: ['https://EXAMPLE.com:443/company#management'] });
        const verified = await s.letters.structured(
          recipientResearchSchema,
          'search',
          'Стройтрансгаз',
          true,
          true,
        );
        assert.deepEqual(verified.sources, sources);
        for (const url of [
          'https://example.com/other',
          'https://example.com/company?id=2',
          'http://example.com/company',
          'https://example.com/company/',
        ]) {
          s.letters.ai.request = async () => response({ ...research, sources: [url] });
          await assert.rejects(
            s.letters.structured(recipientResearchSchema, 'search', 'Стройтрансгаз', true, true),
            /ИНН.*не обязателен/,
          );
        }
      },
    );
    await t.test(
      'completed page opening and citations are recognized; missing evidence is logged safely',
      async () => {
        const message = {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(research) }],
        };
        s.letters.ai.request = async () => ({
          status: 'completed',
          output: [
            {
              type: 'web_search_call',
              status: 'completed',
              action: { type: 'open_page', url: sources[0] },
            },
            message,
          ],
        });
        assert.deepEqual(
          (await s.letters.structured(recipientResearchSchema, 'search', 'company', true, true))
            .sources,
          sources,
        );
        s.letters.ai.request = async () => ({
          status: 'completed',
          output: [
            {
              content: [
                { ...message.content[0], annotations: [{ type: 'url_citation', url: sources[0] }] },
              ],
            },
          ],
        });
        assert.deepEqual(
          (await s.letters.structured(recipientResearchSchema, 'search', 'company', true, true))
            .sources,
          sources,
        );
        s.letters.ai.request = async () => ({
          status: 'completed',
          output: [
            {
              type: 'web_search_call',
              status: 'failed',
              action: { type: 'open_page', url: sources[0] },
            },
            message,
          ],
        });
        await assert.rejects(
          s.letters.structured(recipientResearchSchema, 'search', 'company', true, true),
          /источники/,
        );
        s.letters.ai.request = async () => response({ ...research, sources: [] });
        await assert.rejects(
          s.letters.structured(recipientResearchSchema, 'search', 'company', true, true),
          /источники/,
        );
        const logs = await db.query(
          "SELECT event,message FROM error_logs WHERE event IN ('letter.sources_missing','letter.sources_mismatch')",
        );
        assert.ok(logs.some((log) => log.event === 'letter.sources_missing'));
        assert.ok(logs.some((log) => log.event === 'letter.sources_mismatch'));
        assert.ok(logs.every((log) => !log.message.includes('https://')));
      },
    );
    await t.test('missing LPR does not create companies or contacts', async () => {
      s.letters.ai.request = async () =>
        response({ status: 'not_found', company: research.company, recipient: null, sources });
      await bot.enqueue(actor, 'no-lpr', 'ООО Ромашка');
      await bot.tick();
      assert.equal((await db.query('SELECT * FROM companies')).length, 0);
      assert.equal((await db.query("SELECT * FROM records WHERE kind='contact'")).length, 0);
      assert.equal(
        (await db.query("SELECT status FROM letter_jobs WHERE source_key='no-lpr'"))[0].status,
        'failed',
      );
    });
    await t.test(
      'company review persists across restart and cancellation creates no CRM records',
      async () => {
        s.letters.ai.request = async () => response(research);
        await bot.enqueue(actor, 'cancel-review', 'Ромашка');
        await bot.tick();
        const [job] = await db.query("SELECT * FROM letter_jobs WHERE source_key='cancel-review'");
        assert.equal(job.status, 'waiting_company');
        const restarted = new LetterBot(s.crm, s.letters, s.reports, telegram, config);
        await restarted.reviewCompany(actor, job.id, 'ln', 1);
        await restarted.reviewCompany(actor, job.id, 'lz', 1);
        await restarted.tick();
        assert.equal(
          (await db.query('SELECT status FROM letter_jobs WHERE id=$1', [job.id]))[0].status,
          'cancelled',
        );
        assert.equal((await db.query('SELECT * FROM companies')).length, 0);
        assert.equal(
          (await db.query("SELECT * FROM records WHERE kind IN ('contact','file')")).length,
          0,
        );
      },
    );
    await t.test(
      'recipient clarification is durable, private, versioned and preserves company',
      async () => {
        const actionCount = (await db.query('SELECT * FROM dialogue_actions')).length;
        s.letters.ai.request = async () => response(research);
        await bot.enqueue(actor, 'recipient-edit', 'Ромашка');
        await bot.tick();
        const [job] = await db.query("SELECT * FROM letter_jobs WHERE source_key='recipient-edit'");
        await assert.rejects(bot.reviewCompany(other, job.id, 'lr', 1), /не найдена/);
        await bot.reviewCompany(actor, job.id, 'ln', 1);
        await bot.reviewCompany(actor, job.id, 'lr', 1);
        const bind = async (key: string, audio = false) => {
          const r = await s.reports.enqueue(actor, {
            sourceKey: key,
            purpose: 'dialogue',
            ...(audio ? { audioFileId: 'voice' } : { text: 'Главному инженеру Сидорову Петру' }),
          });
          const token = randomUUID();
          const [row] = await db.query(
            "UPDATE reports SET status='processing',lease_token=$2 WHERE id=$1 RETURNING *",
            [r.id, token],
          );
          assert.equal(row.recipient_job_id, job.id);
          return { row, token };
        };
        const first = await bind('recipient-text');
        const stale = await bind('recipient-voice', true);
        s.letters.ai.request = async () =>
          response({ name: 'Сидоров Пётр', role: 'Главный инженер' });
        const restarted = new LetterBot(s.crm, s.letters, s.reports, telegram, config);
        await restarted.editRecipient(first.row, first.token, 'Главному инженеру Сидорову Петру');
        const [updated] = await db.query('SELECT * FROM letter_jobs WHERE id=$1', [job.id]);
        assert.deepEqual(updated.research.company, research.company);
        assert.deepEqual(updated.research.recipient, {
          name: 'Сидоров Пётр',
          role: 'Главный инженер',
        });
        assert.equal(updated.status, 'waiting_company');
        assert.equal(updated.recipient_user_provided, true);
        assert.equal(updated.research_version, 2);
        assert.equal(updated.research_confirmed, false);
        assert.equal((await db.query('SELECT * FROM companies')).length, 0);
        assert.equal((await db.query('SELECT * FROM dialogue_actions')).length, actionCount);
        await assert.rejects(bot.reviewCompany(actor, job.id, 'ly', 1), /последнее/);
        s.letters.ai.request = async () => {
          throw new Error('Stale clarification must not call AI');
        };
        await restarted.editRecipient(stale.row, stale.token, 'Другой человек');
        await bot.reviewCompany(actor, job.id, 'ln', 2);
        await bot.reviewCompany(actor, job.id, 'lr', 2);
        const unclear = await bind('recipient-unclear');
        s.letters.ai.request = async () => response({ name: null, role: null });
        await restarted.editRecipient(unclear.row, unclear.token, 'непонятно');
        assert.equal(
          (await db.query('SELECT status FROM letter_jobs WHERE id=$1', [job.id]))[0].status,
          'waiting_recipient',
        );
        const cancelled = await bind('recipient-cancelled');
        s.letters.ai.request = async () => {
          await bot.reviewCompany(actor, job.id, 'lz', 2);
          return response({ name: 'Другой человек', role: 'Директор' });
        };
        await restarted.editRecipient(cancelled.row, cancelled.token, 'Другой человек');
        const [final] = await db.query('SELECT * FROM letter_jobs WHERE id=$1', [job.id]);
        assert.equal(final.status, 'cancelled');
        assert.equal(final.research, null);
      },
    );
    await t.test(
      'PDF is generated before contact save, delivery retries reuse the same file',
      { skip: !process.env.LETTER_PYTHON },
      async () => {
        const fixture = JSON.parse(await readFile('assets/esq/data_example.json', 'utf8'));
        let requests = 0;
        s.letters.ai.request = async (_path, raw) => {
          const body = JSON.parse(raw as string);
          requests++;
          if (body.include) return response(research);
          assert.match(JSON.stringify(body), /Сидоров/);
          assert.equal((await db.query("SELECT * FROM records WHERE kind='contact'")).length, 0);
          return response({
            recipient: {
              position_dative: fixture.recipient_lines[0],
              company_name: fixture.recipient_lines[1],
              full_name_dative: fixture.recipient_lines[2],
            },
            reference_ids: JSON.parse(body.input).referenceCandidates.map((r: any) => r.id),
            sources,
          });
        };
        await bot.enqueue(actor, 'success', 'ООО Ромашка');
        const deliveryOrder: string[] = [];
        telegram.sendProcessing = async () => {
          deliveryOrder.push('status');
          return 91;
        };
        telegram.editProcessing = async () => true;
        telegram.deleteProcessing = async (chatId, id) => {
          assert.equal(chatId, actor.telegramId);
          assert.equal(id, '91');
          deliveryOrder.push('delete');
        };
        await s.reports.processing.deliverOne(telegram);
        await bot.tick();
        const [preview] = await db.query("SELECT * FROM letter_jobs WHERE source_key='success'");
        assert.equal(preview.status, 'waiting_company');
        assert.equal((await db.query('SELECT * FROM companies')).length, 0);
        await assert.rejects(bot.reviewCompany(other, preview.id, 'ly', 1), /не найдена/);
        await bot.reviewCompany(actor, preview.id, 'ln', 1);
        await assert.rejects(bot.reviewCompany(actor, preview.id, 'ly', 1), /Сначала уточните/);
        await bot.reviewCompany(actor, preview.id, 'li', 1);
        assert.equal(await bot.acceptInn(actor, '123'), true);
        assert.equal(await bot.acceptInn(actor, '7707083893'), true);
        await bot.tick();
        await assert.rejects(bot.reviewCompany(actor, preview.id, 'ly', 1), /последнее сообщение/);
        await bot.reviewCompany(actor, preview.id, 'ln', 2);
        await bot.reviewCompany(actor, preview.id, 'lr', 2);
        const clarification = await s.reports.enqueue(actor, {
          sourceKey: 'successful-recipient-edit',
          purpose: 'dialogue',
          text: 'Главному инженеру Сидорову Петру',
        });
        const lease = randomUUID();
        const [editingReport] = await db.query(
          "UPDATE reports SET status='processing',lease_token=$2 WHERE id=$1 RETURNING *",
          [clarification.id, lease],
        );
        const generate = s.letters.ai.request;
        s.letters.ai.request = async () =>
          response({ name: 'Сидоров Пётр', role: 'Главный инженер' });
        await bot.editRecipient(editingReport, lease, 'Главному инженеру Сидорову Петру');
        s.letters.ai.request = generate;
        await bot.reviewCompany(actor, preview.id, 'ly', 3);
        await assert.rejects(bot.reviewCompany(actor, preview.id, 'ly', 3), /последнее сообщение/);
        await bot.tick();
        const [job] = await db.query("SELECT * FROM letter_jobs WHERE source_key='success'");
        assert.equal(job.status, 'ready');
        assert.equal((await db.query("SELECT * FROM records WHERE kind='contact'")).length, 1);
        const [recipientContact] = await db.query("SELECT data FROM records WHERE kind='contact'");
        assert.equal(recipientContact.data.name, 'Сидоров Пётр');
        assert.equal(recipientContact.data.role, 'Главный инженер');
        assert.equal(
          (await db.query("SELECT * FROM audit WHERE action='letter.recipient_user_provided'"))
            .length,
          1,
        );
        const [company] = await db.query('SELECT * FROM companies');
        assert.equal(company.data.industry, 'Энергетика — генерация');
        const warning = 'В базе нет референсов по отрасли тест, нужен ручной подбор';
        await db.query(
          "UPDATE audit SET details=details || $2::jsonb WHERE action='letter.references_selected' AND entity_id=$1",
          [job.file_id, JSON.stringify({ warning })],
        );
        let sends = 0;
        telegram.sendPdf = async (chatId, content, _filename, captionWarning) => {
          deliveryOrder.push('pdf');
          assert.equal(chatId, actor.telegramId);
          if (sends < 2) assert.equal(captionWarning, warning);
          assert.equal(Buffer.from(content).subarray(0, 5).toString(), '%PDF-');
          if (++sends === 1) throw new Error('temporary');
        };
        const removeStatus = telegram.deleteProcessing;
        telegram.deleteProcessing = async () => {
          throw new Error('Temporary cleanup failure');
        };
        for (let attempt = 0; attempt < 6; attempt++) {
          await db.query('UPDATE letter_jobs SET available_at=now() WHERE id=$1', [job.id]);
          await bot.tick();
          const [deferred] = await db.query(
            'SELECT status,attempts,file_id FROM letter_jobs WHERE id=$1',
            [job.id],
          );
          assert.equal(deferred.status, 'ready');
          assert.equal(deferred.attempts, job.attempts);
          assert.equal(deferred.file_id, job.file_id);
        }
        assert.equal(sends, 0, 'cleanup retries must not attempt PDF delivery');
        assert.equal(requests, 3, 'cleanup retries must not regenerate the PDF');
        telegram.deleteProcessing = removeStatus;
        await db.query('UPDATE letter_jobs SET available_at=now() WHERE id=$1', [job.id]);
        await bot.tick();
        assert.deepEqual(deliveryOrder, ['status', 'delete', 'pdf']);
        await db.query('UPDATE letter_jobs SET available_at=now() WHERE id=$1', [job.id]);
        await bot.tick();
        assert.deepEqual(deliveryOrder, ['status', 'delete', 'pdf', 'pdf']);
        assert.equal(requests, 3);
        assert.equal(
          (await db.query('SELECT status FROM letter_jobs WHERE id=$1', [job.id]))[0].status,
          'sent',
        );
        assert.equal((await db.query("SELECT * FROM records WHERE kind='file'")).length, 1);
        // A second request reuses the same company and recipient without duplicate contacts.
        s.letters.ai.request = async (_path, raw) =>
          JSON.parse(raw as string).include
            ? response({
                ...research,
                recipient: { name: 'Сидоров Пётр', role: 'Главный инженер' },
              })
            : response({
                recipient: {
                  position_dative: fixture.recipient_lines[0],
                  company_name: fixture.recipient_lines[1],
                  full_name_dative: fixture.recipient_lines[2],
                },
                reference_ids: JSON.parse(JSON.parse(raw as string).input).referenceCandidates.map(
                  (r: any) => r.id,
                ),
                sources,
              });
        await bot.enqueue(actor, 'repeat-company', 'ООО Ромашка');
        await bot.tick();
        const [repeatPreview] = await db.query(
          "SELECT * FROM letter_jobs WHERE source_key='repeat-company'",
        );
        await bot.reviewCompany(actor, repeatPreview.id, 'ly', 1);
        await bot.tick();
        assert.equal((await db.query('SELECT * FROM companies')).length, 1);
        assert.equal((await db.query("SELECT * FROM records WHERE kind='contact'")).length, 1);
        await s.reports.processing.deliverOne(telegram);
        telegram.deleteProcessing = async () => {
          throw new ProcessingMessageUndeletable();
        };
        await bot.tick();
        assert.equal(
          (await db.query("SELECT status FROM letter_jobs WHERE source_key='repeat-company'"))[0]
            .status,
          'sent',
          'a permanently undeletable status must not suppress the PDF',
        );
        assert.equal(
          (
            await db.query(
              "SELECT * FROM error_logs WHERE event='telegram.processing_delete_forbidden'",
            )
          ).length,
          1,
        );
      },
    );
  } finally {
    await bot.stop();
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('PDF adapter uploads PDF bytes to the employee chat only', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const body = options.body as FormData;
    assert.equal(body.get('chat_id'), '12345');
    assert.equal(body.get('caption'), 'Сохранено в CRM. Из чата удалится через 24 часа');
    const file = body.get('document') as File;
    assert.equal(file.type, 'application/pdf');
    assert.equal(file.name, 'letter.pdf');
    assert.equal(await file.text(), '%PDF-test');
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  const telegram = new TelegramAdapter(makeConfig({ BOT_TOKEN: 'test' }));
  await telegram.sendPdf('12345', Buffer.from('%PDF-test'), 'letter.pdf');
  await assert.rejects(
    telegram.sendPdf('12345', Buffer.from('not pdf'), 'letter.pdf'),
    /Некорректный PDF/,
  );
});
