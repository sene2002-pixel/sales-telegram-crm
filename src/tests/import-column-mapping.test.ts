import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCompanyImport, assertImportPrivacy } from '../server/services/company-import-parser';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { docxDocument, docTable, xmlCell, zip } from './helpers/import-fixtures';
import {
  ColumnDescription,
  deduplicatedColumnModel,
  ImportColumnModel,
} from '../server/services/import-column-mapping';

const table = Buffer.from(
  [
    'Наименование контрагента;Классификация;Налоговый номер организации;ФИО;Телефон;Класс Анна Иванова',
    'ООО Синтез;Диалог;7707083893;Анна Иванова;+79991234567;Новый',
    'ООО Север;Новый;7707083893;;;Новый',
    'АО Звезда;Предложение;7707083893;;;Новый',
    'АО Последний;Четвертая секретная строка;123;;;Новый',
  ].join('\n'),
);
const parse = (model?: ImportColumnModel) =>
  parseCompanyImport(table, 'csv', assertImportPrivacy, undefined, model);

test('column mapping sends only a vocabulary header and first three local signatures; all values are normalized locally', async () => {
  let calls = 0;
  const rows = await parse(async (columns) => {
    calls++;
    assert.deepEqual(columns, [
      {
        header: 'классификация',
        samples: [['stage'], ['stage'], ['stage']],
        candidates: ['stage'],
      },
    ]);
    return { columns: [{ id: 0, field: 'stage' }] };
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    rows.map((r) => r.data.stage),
    ['dialogue', 'new', 'proposal', undefined],
  );
  assert.equal(rows[0]!.data.name, 'Синтез');
  assert.equal(rows[0]!.data.inn, '7707083893');
  assert.equal(rows[3]!.data.inn, undefined);
  assert.equal(rows[0]!.contacts![0]!.phone, '+79991234567');
  assert.ok(rows[3]!.warnings.some((message) => message.includes('другой формат')));
});

test('table formats share the same bounded mapping, including DOCX tables, ODS and visible XLSX sheets', async () => {
  const contents = [
    ['Юридическое наименование организации', 'Классификация'],
    ['АО Спектр', 'Новый'],
  ];
  const xlsx = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Клиенты" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      contents
        .map(
          (row, i) =>
            '<row r="' +
            (i + 1) +
            '">' +
            row.map((cell, j) => xmlCell(String.fromCharCode(65 + j) + (i + 1), cell)).join('') +
            '</row>',
        )
        .join('') +
      '</sheetData></worksheet>',
  });
  const ods = zip({
    'content.xml':
      '<document-content><body><spreadsheet><table>' +
      contents
        .map(
          (row) =>
            '<table-row>' +
            row.map((cell) => '<table-cell><p>' + cell + '</p></table-cell>').join('') +
            '</table-row>',
        )
        .join('') +
      '</table></spreadsheet></body></document-content>',
  });
  for (const [bytes, format] of [
    [xlsx, 'xlsx'],
    [ods, 'ods'],
    [docxDocument(docTable(contents)), 'docx'],
  ] as const) {
    let calls = 0;
    const rows = await parseCompanyImport(
      bytes,
      format,
      assertImportPrivacy,
      undefined,
      async (columns) => {
        calls++;
        assert.equal(columns[0]!.header, 'классификация');
        return { columns: [{ id: 0, field: 'stage' }] };
      },
    );
    assert.equal(calls, 1, format);
    assert.deepEqual(rows[0]!.data, { name: 'Спектр', legalForm: 'АО', stage: 'new' });
  }
});

test('data containing company-heading words stays attached to its row across repeated table blocks', async () => {
  const rows = await parseCompanyImport(
    Buffer.from(
      [
        'Компания;Тип записи;Город',
        'Альфа;Юридическое лицо;Москва',
        'Бета;Организация;Екб',
        'Компания;Тип записи;Город',
        'Гамма;Юридическое лицо;Омск',
      ].join('\n'),
    ),
    'csv',
    assertImportPrivacy,
  );
  assert.deepEqual(
    rows.map((r) => [r.data.name, r.data.city]),
    [
      ['Альфа', 'Москва'],
      ['Бета', 'Екатеринбург'],
      ['Гамма', 'Омск'],
    ],
  );
});

test('inferred city supplies the same local contact phone context as an exact city heading', async () => {
  for (const title of ['Город', 'Населенный пункт организации', 'Локация клиента']) {
    const rows = await parseCompanyImport(
      Buffer.from('Компания;' + title + ';ФИО;Телефон\nАльфа;Екб;Иван Петров;363-52-50'),
      'csv',
      assertImportPrivacy,
      undefined,
      async () => ({ columns: [{ id: 0, field: 'city' }] }),
    );
    assert.equal(rows[0]!.data.city, 'Екатеринбург');
    assert.equal(rows[0]!.contacts![0]!.phone, '+73433635250');
  }
});

test('tabular TXT accepts the same headings as CSV and plain lines remain company names', async () => {
  const bytes = Buffer.from(
    'Наименование контрагента;Классификация\nАО Аквамарин;Диалог\nООО Берёза;Новый',
  );
  const model: ImportColumnModel = async () => ({ columns: [{ id: 0, field: 'stage' }] });
  const txt = await parseCompanyImport(bytes, 'txt', assertImportPrivacy, undefined, model);
  const csv = await parseCompanyImport(bytes, 'csv', assertImportPrivacy, undefined, model);
  assert.deepEqual(txt, csv);
  assert.deepEqual(
    txt.map((r) => [r.data.name, r.data.stage]),
    [
      ['Аквамарин', 'dialogue'],
      ['Берёза', 'new'],
    ],
  );
  const plain = await parseCompanyImport(
    Buffer.from('ООО Аквамарин\nАО Вега, филиал'),
    'txt',
    assertImportPrivacy,
  );
  assert.deepEqual(
    plain.map((r) => r.data.name),
    ['Аквамарин', 'Вега, филиал'],
  );
});

test('uncertain, unavailable, repeated or unpermitted mappings preserve the local-only preview', async () => {
  const local = await parse();
  assert.ok(local.every((r) => r.data.stage === undefined));
  for (const response of [
    { columns: [{ id: 0, field: null }] },
    { columns: [{ id: 0, field: 'inn' }] },
    { columns: [{ id: 0, field: 'ownerId' }] },
    { columns: [{ id: 7, field: 'stage' }] },
    {
      columns: [
        { id: 0, field: 'stage' },
        { id: 0, field: 'stage' },
      ],
    },
    { columns: [{ id: 0, field: 'stage', value: 'closed' }] },
  ])
    assert.deepEqual(await parse(async () => response), local);
  assert.deepEqual(
    await parse(async () => {
      throw new Error('provider unavailable');
    }),
    local,
  );
  let paid = false;
  const lostDatabase = deduplicatedColumnModel(
    {
      query: async () => {
        throw new Error('storage unavailable');
      },
    },
    'synthetic',
    'synthetic-source',
    'synthetic-content',
    async () => {
      paid = true;
      return { columns: [] };
    },
  );
  await assert.rejects(parse(lostDatabase), /состояние импорта/);
  assert.equal(paid, false);
  let mixedCalls = 0;
  const mixed = await parseCompanyImport(
    Buffer.from('Компания;Классификация\nА;Новый\nБ;Подрядчик'),
    'csv',
    assertImportPrivacy,
    undefined,
    async () => {
      mixedCalls++;
    },
  );
  assert.equal(mixedCalls, 0);
  assert.equal(mixed[0]!.data.stage, undefined);
  let called = false;
  const known = await parseCompanyImport(
    Buffer.from('Компания;Стадия\nА;Новый'),
    'csv',
    assertImportPrivacy,
    undefined,
    async () => {
      called = true;
      return undefined;
    },
  );
  assert.equal(called, false);
  assert.equal(known[0]!.data.stage, 'new');
});

test('normal CRM bot import uses the existing AI budget, confirms locally and charges once per prepared source', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'crm-mapping-entry-'));
  const {
    app,
    db,
    services: s,
  } = await createApp(
    makeConfig({
      DATA_DIR: dataDir,
      DEV_AUTH: 'true',
      OPENAI_API_KEY: 'synthetic',
      BOT_TOKEN: 'synthetic',
      AI_BUDGET_ENABLED: 'true',
      AI_USER_CALLS_PER_DAY: '1',
    }),
  );
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const admin = (await s.auth.dev('admin', '127.0.0.1')).user;
  const user = await s.auth.saveUser(admin, {
    telegramId: '983001',
    name: 'QA',
    role: 'manager',
    active: true,
  });
  let source = Buffer.from('Компания;Классификация\nТестовый клиент;Диалог');
  t.mock.method(s.telegram, 'download', async () => source);
  const replies: any[] = [];
  t.mock.method(s.telegram, 'call', async (_m: string, p: any) => {
    replies.push(p);
    return { message_id: 4 };
  });
  let calls = 0;
  let started!: () => void;
  let release!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const releaseRequest = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls++;
    started();
    await releaseRequest;
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.ok(!JSON.stringify(body).includes('Тестовый клиент'));
    assert.deepEqual(JSON.parse(body.input), [
      { id: 0, header: 'классификация', samples: [['stage']], candidates: ['stage'] },
    ]);
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          { content: [{ type: 'output_text', text: '{"columns":[{"id":0,"field":"stage"}]}' }] },
        ],
      }),
      { status: 200 },
    );
  });
  const from = { id: Number(user.telegramId), first_name: 'QA' };
  const chat = { id: from.id, type: 'private' };
  const document = (id: number) => ({
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      from,
      chat,
      document: {
        file_id: 'qa',
        file_name: 'companies.csv',
        mime_type: 'text/csv',
        file_size: source.length,
      },
    },
  });
  const first = s.bot.handle(document(801));
  await requestStarted;
  try {
    await s.bot.handle(document(801));
    assert.deepEqual(await db.query('SELECT id FROM company_imports'), []);
  } finally {
    release();
    await first;
  }
  assert.equal(calls, 1);
  assert.deepEqual(await db.query('SELECT id FROM companies'), []);
  const [saved] = await db.query('SELECT id, version, draft FROM company_imports');
  assert.equal(saved.draft.rows[0].data.stage, 'dialogue');
  assert.ok(replies.some((p) => p.reply_markup?.inline_keyboard));
  await s.bot.handle(document(801));
  assert.equal(calls, 1);
  const confirm = replies
    .flatMap((p) => p.reply_markup?.inline_keyboard?.flat() || [])
    .find((v) => v.callback_data?.startsWith('ic:'));
  assert.ok(confirm);
  await s.bot.handle({
    update_id: 802,
    callback_query: { id: 'c-802', from, message: { chat }, data: confirm.callback_data },
  });
  assert.equal((await s.crm.list(user))[0]!.stage, 'dialogue');
  source = Buffer.from('Компания;Классификация\nСледующий тестовый клиент;Диалог');
  await s.bot.handle(document(803));
  const [unmapped] = await db.query("SELECT draft FROM company_imports WHERE status='pending'");
  assert.equal(unmapped.draft.rows[0].data.stage, undefined);
  assert.equal(calls, 1);
  assert.equal(
    (await db.query('SELECT id FROM ai_budget_requests WHERE actor_id=$1', [user.id])).length,
    1,
  );
  const sourceKey = 'test-expired-column-receipt';
  const descriptions: ColumnDescription[] = [
    { header: 'классификация', samples: [['stage']], candidates: ['stage'] },
  ];
  let invocations = 0;
  const reused = deduplicatedColumnModel(db, user.id, sourceKey, 'different-source', async () => {
    invocations++;
    return { columns: [{ id: 0, field: 'stage' }] };
  });
  const choice = await reused(descriptions);
  assert.deepEqual(await reused(descriptions), choice);
  await assert.rejects(
    deduplicatedColumnModel(db, admin.id, sourceKey, 'different-source', reused)(descriptions),
    /недоступен/,
  );
  await assert.rejects(
    deduplicatedColumnModel(db, user.id, sourceKey, 'different-bytes', reused)(descriptions),
    /изменилось/,
  );
  await db.query(
    "UPDATE import_column_requests SET choices=NULL,created_at=now()-interval '3 minutes' WHERE source_key=$1",
    [sourceKey],
  );
  assert.deepEqual(await reused(descriptions), { columns: [] });
  assert.equal(invocations, 1);
});
