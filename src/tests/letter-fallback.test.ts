import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor } from '../shared/contracts';
import { LetterBot, recipientResearchSchema } from '../server/services/letter-bot';
import { recipientLines, recipientSchema } from '../server/services/letters';
import { buildLetterPdfCaption, TelegramAdapter } from '../server/infra/telegram';

const company = {
  name: 'ООО Альфа',
  inn: '7707083893',
  city: 'Москва',
  industry: 'Энергетика — генерация',
  activity: 'Генерация электроэнергии',
};
const sources = ['https://example.test/company'];
const research = { status: 'found', company, recipient: null, sources };
const signature = {
  lastName: 'Петров',
  firstName: 'Пётр',
  patronymic: 'Петрович',
  workPhone: '+79990000000',
  mobilePhone: '',
  email: 'private@example.test',
};
const response = (data: unknown) => ({
  status: 'completed',
  output: [
    { type: 'web_search_call', action: { sources: sources.map((url) => ({ type: 'url', url })) } },
    { content: [{ type: 'output_text', text: JSON.stringify(data) }] },
  ],
});
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'pico-letter-fallback-')),
    config = makeConfig({
      DATA_DIR: dir,
      BOT_TOKEN: 'test-only',
      WORKER_ENABLED: 'false',
      DATABASE_URL: '',
    });
  const { app, services: s, db } = await createApp(config);
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const actor: Actor = {
      id: randomUUID(),
      telegramId: '123450001',
      name: 'Автор',
      role: 'manager',
      active: true,
    },
    other: Actor = { ...actor, id: randomUUID(), telegramId: '123450002' };
  for (const a of [actor, other])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      a.id,
      a.telegramId,
      a.name,
      a.role,
    ]);
  const saved = await s.letters.writeSignature(actor, signature);
  await s.letters.setDefault(actor, saved.id);
  const telegram = new TelegramAdapter(config);
  telegram.sendProcessing = async () => 91;
  telegram.editProcessing = async () => true;
  telegram.deleteProcessing = async () => {};
  const bot = new LetterBot(s.crm, s.letters, s.reports, telegram, config);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Live network prohibited in fallback tests');
  });
  return { dir, s, db, actor, other, saved, telegram, bot };
}

test('role-only header and bounded plain-text metadata do not invent a person or disclose signature contacts', async (t) => {
  assert.deepEqual(
    recipientLines(
      recipientSchema.parse({
        position_dative: 'Главному энергетику',
        company_name: company.name,
        full_name_dative: null,
      }),
    ),
    ['Главному энергетику', company.name],
  );
  assert.equal(
    recipientResearchSchema.safeParse({
      ...research,
      recipient: { name: '', role: 'Главный энергетик' },
    }).success,
    false,
  );
  const caption = buildLetterPdfCaption({
    recipient: ['Главному энергетику', company.name],
    source: 'ФИО не найдено; адресование должности подтверждено',
    industry: company.industry,
    references: ['Подстанция Альфа'],
    number: '1234',
    date: '15.10.2026',
    signature: 'Петров Пётр',
    warning: 'Недостаточно основных референсов',
  });
  assert.equal(caption.split('\n').length, 4);
  assert.match(caption, /ФИО не найдено/);
  assert.match(caption, /1234.*15\.10\.2026/);
  assert.match(caption, /Петров Пётр/);
  assert.match(caption, /24 часа/);
  assert.match(caption, /Недостаточно/);
  assert.doesNotMatch(caption, /private@example|79990000000/);
  const long = buildLetterPdfCaption({
    recipient: ['<script>\n' + '😀'.repeat(500)],
    source: 'x'.repeat(500),
    industry: 'x'.repeat(500),
    references: Array(40).fill('x'.repeat(500)),
    number: '1234',
    date: '15.10.2026',
    signature: 'y\nz'.repeat(500),
    warning: 'w\nr'.repeat(500),
  });
  assert.ok(long.length <= 1024);
  assert.equal(long.split('\n').length, 4);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const body = options.body as FormData;
    assert.equal(body.get('caption'), caption);
    assert.equal(body.get('parse_mode'), null);
    assert.equal(body.get('chat_id'), '123450001');
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
  });
  await new TelegramAdapter(makeConfig({ BOT_TOKEN: 'test' })).sendPdf(
    '123450001',
    Buffer.from('%PDF-test'),
    'letter.pdf',
    'warning',
    caption,
  );
});

test('verified company without named recipient requires explicit preview and owned current confirmation', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.s.letters.ai.request = async () => {
    calls++;
    return response(research);
  };
  await f.bot.enqueue(f.actor, 'role-only-preview', 'Альфа');
  await f.bot.tick();
  const [job] = await f.db.query('SELECT * FROM letter_jobs WHERE source_key=$1', [
    'role-only-preview',
  ]);
  assert.equal(job.status, 'waiting_company');
  assert.equal(job.research_confirmed, false);
  assert.equal(job.research.recipientMode, 'role_only');
  assert.deepEqual(job.research.recipient, { name: '', role: 'Главный энергетик' });
  const messages = await f.db.query('SELECT payload FROM outbox');
  assert.ok(messages.some((row) => row.payload.text?.includes('ФИО не найдено')));
  assert.equal((await f.db.query('SELECT * FROM companies')).length, 0);
  assert.equal((await f.db.query("SELECT * FROM records WHERE kind='contact'")).length, 0);
  await assert.rejects(
    f.bot.reviewCompany(f.other, job.id, 'ly', job.research_version),
    /не найдена/,
  );
  await assert.rejects(
    f.bot.reviewCompany(f.actor, job.id, 'ly', job.research_version + 1),
    /последнее/,
  );
  const c = await f.s.crm.create(f.actor, { name: company.name, inn: company.inn });
  const raw = {
    contactId: randomUUID(),
    signatureId: f.saved.id,
    confirmedIndustry: company.industry,
  };
  const discovered = {
    name: '',
    role: 'Главный энергетик',
    sources,
    jobId: job.id,
    leaseToken: randomUUID(),
    confirmedCompany: company,
    roleOnlyFallback: true,
  };
  await assert.rejects(
    f.s.letters.create(f.actor, c.id, raw, discovered),
    /Подтвердите актуального получателя/,
  );
  assert.equal(calls, 1);
  await f.db.query(
    "UPDATE letter_jobs SET status='processing',research_confirmed=true,lease_token=$2 WHERE id=$1",
    [job.id, discovered.leaseToken],
  );
  await assert.rejects(
    f.s.letters.create(f.actor, c.id, raw, { ...discovered, name: 'Выдуманный человек' }),
    /Подтвердите актуального получателя/,
  );
  await assert.rejects(
    f.s.letters.create(f.actor, c.id, raw, { ...discovered, jobId: randomUUID() }),
    /Подтвердите актуального получателя/,
  );
  await assert.rejects(
    f.s.letters.create(f.actor, c.id, raw, { ...discovered, confirmedCompany: undefined }),
    /Подтвердите актуального получателя/,
  );
  await assert.rejects(
    f.s.letters.create(f.actor, c.id, raw, { ...discovered, sources: ['https://forged.test'] }),
    /Подтвердите актуального получателя/,
  );
  assert.equal(calls, 1);
  await f.db.query('UPDATE users SET active=false WHERE id=$1', [f.actor.id]);
  await assert.rejects(f.s.letters.create(f.actor, c.id, raw, discovered), /Доступ.*отозван/);
  assert.equal(calls, 1);
});

test('missing or ambiguous company cannot become a role-only fallback', async (t) => {
  const f = await fixture(t);
  for (const [index, status] of ['not_found', 'ambiguous'].entries()) {
    f.s.letters.ai.request = async () =>
      response({ ...research, status, company: status === 'not_found' ? null : company });
    await f.bot.enqueue(f.actor, 'no-fallback-' + index, 'Альфа');
    await f.bot.tick();
    const [job] = await f.db.query('SELECT * FROM letter_jobs WHERE source_key=$1', [
      'no-fallback-' + index,
    ]);
    assert.notEqual(job.status, 'waiting_company');
    assert.equal(job.research, null);
  }
  assert.equal((await f.db.query('SELECT * FROM companies')).length, 0);
});

test(
  'confirmed fallback renders real two-line PDF without creating contact and retries identical metadata',
  { skip: !process.env.LETTER_PYTHON },
  async (t) => {
    const f = await fixture(t);
    let aiCalls = 0;
    f.s.letters.ai.request = async (_path, raw) => {
      aiCalls++;
      const body = JSON.parse(raw as string);
      if (body.include) return response(research);
      const input = JSON.parse(body.input);
      assert.equal(input.contact.name, '');
      assert.equal(input.contact.role, 'Главный энергетик');
      return response({
        recipient: {
          position_dative: 'Главному энергетику',
          company_name: company.name,
          full_name_dative: null,
        },
        reference_ids: input.referenceCandidates.map((r: any) => r.id),
        sources,
      });
    };
    await f.bot.enqueue(f.actor, 'render-role-only', 'Альфа');
    await f.bot.tick();
    let [job] = await f.db.query('SELECT * FROM letter_jobs WHERE source_key=$1', [
      'render-role-only',
    ]);
    await f.bot.reviewCompany(f.actor, job.id, 'ly', job.research_version);
    await f.bot.tick();
    [job] = await f.db.query('SELECT * FROM letter_jobs WHERE id=$1', [job.id]);
    assert.equal(job.status, 'ready');
    assert.ok(job.file_id);
    assert.equal((await f.db.query("SELECT * FROM records WHERE kind='contact'")).length, 0);
    const [metadata] = await f.db.query(
      "SELECT details FROM audit WHERE entity_id=$1 AND action='letter.delivery_metadata'",
      [job.file_id],
    );
    const caption = metadata.details.caption;
    assert.match(caption, /Главному энергетику/);
    assert.match(caption, /ФИО не найдено/);
    assert.match(caption, /Отрасль:/);
    assert.match(caption, /референсы:/);
    assert.match(caption, /Исх\. № \d{4}/);
    assert.match(caption, /Петров Пётр Петрович/);
    assert.equal(caption.split('\n').length, 4);
    assert.doesNotMatch(caption, /private@example|79990000000/);
    const sent: string[] = [];
    f.telegram.sendPdf = async (chat, content, _filename, _warning, metadataCaption) => {
      assert.equal(chat, f.actor.telegramId);
      assert.equal(Buffer.from(content).subarray(0, 5).toString(), '%PDF-');
      sent.push(metadataCaption!);
      if (sent.length === 1) throw new Error('Synthetic delivery failure');
      return 77;
    };
    const before = aiCalls;
    await f.bot.tick();
    await f.db.query('UPDATE letter_jobs SET available_at=now() WHERE id=$1', [job.id]);
    await f.bot.tick();
    assert.deepEqual(sent, [caption, caption]);
    assert.equal(aiCalls, before);
    const [final] = await f.db.query('SELECT * FROM letter_jobs WHERE id=$1', [job.id]);
    assert.equal(final.status, 'sent');
    assert.equal(final.file_id, job.file_id);
  },
);

test('a role-only recipient cannot change to another role without a name and explicit named edit resets confirmation', async (t) => {
  const f = await fixture(t);
  f.s.letters.ai.request = async () => response(research);
  await f.bot.enqueue(f.actor, 'edit-fallback', 'Альфа');
  await f.bot.tick();
  const [job] = await f.db.query('SELECT * FROM letter_jobs WHERE source_key=$1', [
    'edit-fallback',
  ]);
  await f.bot.reviewCompany(f.actor, job.id, 'ln', job.research_version);
  await f.bot.reviewCompany(f.actor, job.id, 'lr', job.research_version);
  async function edit(key: string, patch: { name: string | null; role: string | null }) {
    const { id } = await f.s.reports.enqueue(f.actor, {
      sourceKey: key,
      text: 'Изменить получателя',
      purpose: 'dialogue',
    });
    const token = randomUUID();
    await f.db.query("UPDATE reports SET status='processing',lease_token=$2 WHERE id=$1", [
      id,
      token,
    ]);
    const [report] = await f.db.query('SELECT * FROM reports WHERE id=$1', [id]);
    f.s.letters.ai.request = async () => response(patch);
    await f.bot.editRecipient(report, token, 'Изменить получателя');
    return id;
  }
  const rejected = await edit('edit-only-role', { name: null, role: 'Директор' });
  let [current] = await f.db.query('SELECT * FROM letter_jobs WHERE id=$1', [job.id]);
  assert.equal(current.status, 'waiting_recipient');
  assert.equal(current.research.recipientMode, 'role_only');
  assert.equal(current.research.recipient.name, '');
  assert.equal(
    (await f.db.query('SELECT status FROM reports WHERE id=$1', [rejected]))[0].status,
    'cancelled',
  );
  await edit('edit-named', { name: 'Сидоров Иван Иванович', role: 'Главный инженер' });
  [current] = await f.db.query('SELECT * FROM letter_jobs WHERE id=$1', [job.id]);
  assert.equal(current.status, 'waiting_company');
  assert.equal(current.research_confirmed, false);
  assert.equal(current.recipient_user_provided, true);
  assert.equal(current.research.recipientMode, 'named');
  assert.deepEqual(current.research.recipient, {
    name: 'Сидоров Иван Иванович',
    role: 'Главный инженер',
  });
  assert.deepEqual(current.research.company, company);
  await assert.rejects(
    f.bot.reviewCompany(f.actor, job.id, 'ly', job.research_version),
    /последнее/,
  );
  assert.equal((await f.db.query("SELECT * FROM records WHERE kind='contact'")).length, 0);
});

test('rendering gates reject invented fallback names and missing names in a selected named CRM contact', async (t) => {
  const f = await fixture(t);
  const c = await f.s.crm.create(f.actor, { name: company.name, inn: company.inn });
  const contact = await f.s.crm.createRecord(f.actor, c.id, 'contact', {
    name: 'Иванов Иван Иванович',
    role: 'Директор',
  });
  const token = randomUUID(),
    id = randomUUID();
  await f.db.query(
    "INSERT INTO letter_jobs(id,user_id,chat_id,source_key,query,status,signature_id,research,research_confirmed,lease_token) VALUES($1,$2,$3,$4,$5,'processing',$6,$7,true,$8)",
    [
      id,
      f.actor.id,
      f.actor.telegramId,
      'forged-name',
      'Альфа',
      f.saved.id,
      JSON.stringify({
        ...research,
        recipient: { name: '', role: 'Главный энергетик' },
        recipientMode: 'role_only',
      }),
      token,
    ],
  );
  const raw = {
    contactId: contact.id,
    signatureId: f.saved.id,
    confirmedIndustry: company.industry,
  };
  f.s.letters.ai.request = async (_path, body) => {
    const input = JSON.parse(JSON.parse(body as string).input);
    return response({
      recipient: {
        position_dative: 'Директору',
        company_name: company.name,
        full_name_dative: 'Выдуманному Получателю',
      },
      reference_ids: input.referenceCandidates.map((r: any) => r.id),
      sources,
    });
  };
  await assert.rejects(
    f.s.letters.create(f.actor, c.id, raw, {
      name: '',
      role: 'Главный энергетик',
      sources,
      jobId: id,
      leaseToken: token,
      confirmedCompany: company,
      roleOnlyFallback: true,
    }),
    /Неверное ФИО/,
  );
  f.s.letters.ai.request = async (_path, body) => {
    const input = JSON.parse(JSON.parse(body as string).input);
    return response({
      recipient: {
        position_dative: 'Директору',
        company_name: company.name,
        full_name_dative: null,
      },
      reference_ids: input.referenceCandidates.map((r: any) => r.id),
      sources,
    });
  };
  await assert.rejects(f.s.letters.create(f.actor, c.id, raw), /Неверное ФИО/);
  assert.equal((await f.db.query("SELECT * FROM records WHERE kind='file'")).length, 0);
  assert.equal((await f.db.query("SELECT * FROM records WHERE kind='contact'")).length, 1);
});

test(
  'fallback refuses company identity and confirmed-source changes during external preparation',
  { skip: !process.env.LETTER_PYTHON },
  async (t) => {
    for (const race of ['inn', 'name', 'sources']) {
      const f = await fixture(t);
      const c = await f.s.crm.create(f.actor, {
        name: 'Торговое имя Альфа',
        inn: race === 'name' ? '' : company.inn,
      });
      const id = randomUUID(),
        token = randomUUID();
      await f.db.query(
        "INSERT INTO letter_jobs(id,user_id,chat_id,source_key,query,status,signature_id,research,research_confirmed,lease_token) VALUES($1,$2,$3,$4,$5,'processing',$6,$7,true,$8)",
        [
          id,
          f.actor.id,
          f.actor.telegramId,
          'identity-' + race,
          'Альфа',
          f.saved.id,
          JSON.stringify({
            ...research,
            recipient: { name: '', role: 'Главный энергетик' },
            recipientMode: 'role_only',
          }),
          token,
        ],
      );
      f.s.letters.ai.request = async (_path, raw) => {
        const input = JSON.parse(JSON.parse(raw as string).input);
        if (race === 'sources')
          await f.db.query(
            "UPDATE letter_jobs SET research=jsonb_set(research,'{sources}',$2::jsonb) WHERE id=$1",
            [id, JSON.stringify(['https://changed.test'])],
          );
        else
          await f.db.query(
            'UPDATE companies SET data=jsonb_set(data,$2::text[],$3::jsonb) WHERE id=$1',
            [c.id, [race], JSON.stringify(race === 'inn' ? '7710140679' : 'Другая компания')],
          );
        return response({
          recipient: {
            position_dative: 'Главному энергетику',
            company_name: company.name,
            full_name_dative: null,
          },
          reference_ids: input.referenceCandidates.map((r: any) => r.id),
          sources,
        });
      };
      await assert.rejects(
        f.s.letters.create(
          f.actor,
          c.id,
          { contactId: randomUUID(), signatureId: f.saved.id, confirmedIndustry: company.industry },
          {
            name: '',
            role: 'Главный энергетик',
            sources,
            jobId: id,
            leaseToken: token,
            confirmedCompany: company,
            roleOnlyFallback: true,
          },
        ),
        /Компания изменена|Получатель изменён/,
      );
      assert.equal((await f.db.query("SELECT * FROM records WHERE kind='file'")).length, 0);
      assert.equal((await f.db.query("SELECT * FROM records WHERE kind='contact'")).length, 0);
      assert.equal(
        (await f.db.query("SELECT * FROM audit WHERE action='letter.delivery_metadata'")).length,
        0,
      );
    }
  },
);
