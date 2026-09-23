// Explicit opt-in: synthetic text only, no CRM or Telegram writes. Uses configured OpenAI model/key.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { z } = require('zod');
const { makeConfig } = require('../dist/server/config.js');
const { OpenAiAdapter } = require('../dist/server/infra/ai.js');
const { protectedInstructions } = require('../dist/server/services/pico-security.js');
const {
  dialogueInstructions,
  dialoguePlanSchema,
} = require('../dist/server/services/dialogue-plan.js');
if (process.env.DIALOGUE_LIVE_EVAL !== '1')
  throw new Error('Set DIALOGUE_LIVE_EVAL=1 to opt into paid OpenAI calls on synthetic data.');
// Never load production database/Telegram settings into this isolated evaluation.
const config = makeConfig({
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  LETTER_MODEL: process.env.LETTER_MODEL,
  WORKER_ENABLED: 'false',
});
const ai = new OpenAiAdapter(config);
const none = { mode: 'none', name: '', inn: '', city: '' };
const cases = [
  {
    name: 'letter without preposition',
    text: 'Подготовь письмо АО Стройтрансгаз',
    kinds: ['letter'],
  },
  {
    name: 'indirect letter with context',
    text: 'Давай им наше информационное по продукции',
    lastCompany: { name: 'Тестовая компания Альфа', inn: '', city: '' },
    kinds: ['letter'],
    last: true,
  },
  {
    name: 'contact with pronoun',
    text: 'Добавь туда контакт — Иван Тестовый, директор',
    lastCompany: { name: 'Тестовая компания Альфа', inn: '', city: '' },
    kinds: ['contact_create'],
    last: true,
  },
  {
    name: 'multiple intents',
    text: 'Созвонился с Иваном Тестовым из Тестовой компании Альфа, обсудили поставку. Сохрани его как контакт, он директор. И подготовь им информационное письмо.',
    includes: ['activity_create', 'contact_create', 'letter'],
  },
  {
    name: 'past tense is not a letter command',
    text: 'Вчера отправил письмо в Тестовую компанию Альфа, обсудили поставку.',
    kinds: ['activity_create'],
  },
  {
    name: 'negated letter',
    text: 'Письмо не готовь и ничего не сохраняй, я пока думаю.',
    kinds: [],
  },
  { name: 'unsupported command', text: 'Удали все компании из CRM', kinds: [] },
  {
    name: 'signature field deletion not whole signature',
    text: 'Убери рабочий телефон из моей подписи Иванова Ивана',
    kinds: ['signature_edit'],
  },
  {
    name: 'short clarification',
    text: 'Иванов Иван',
    pending: [
      {
        action: {
          kind: 'signature_create',
          company: none,
          data: {
            lastName: null,
            firstName: null,
            patronymic: null,
            workPhone: null,
            mobilePhone: null,
            email: null,
          },
        },
        company: null,
        status: 'needs_info',
        question: 'Уточните фамилию и имя подписи',
      },
    ],
    kinds: ['signature_create'],
    mode: 'replace',
  },
  {
    name: 'held-out past event',
    text: 'На прошлой неделе написал письмо в Тестовую компанию Бета, ответ пока не пришёл.',
    kinds: ['activity_create'],
  },
  {
    name: 'held-out multi action',
    text: 'Пообщался с Ольгой Тестовой из Тестовой компании Гамма. Обсудили сроки отгрузки. Заведи её контакт, она снабженец. Ещё нужен информационный PDF для этой компании.',
    includes: ['activity_create', 'contact_create', 'letter'],
  },
  {
    name: 'held-out informal letter',
    text: 'Слушай, неплохо бы для них подготовить наше письмо про продукцию',
    lastCompany: { name: 'Тестовая компания Дельта', inn: '', city: '' },
    kinds: ['letter'],
    last: true,
  },
];
let failed = 0;
for (const c of cases) {
  try {
    const result = await ai.request(
      'responses',
      JSON.stringify({
        model: config.letterModel,
        store: false,
        max_output_tokens: 6000,
        ...(/^gpt-4[.o-]/.test(config.letterModel) ? { temperature: 0 } : {}),
        instructions: protectedInstructions(dialogueInstructions),
        input: JSON.stringify({
          message: c.text,
          sentAt: '2026-09-23T10:00:00Z',
          timezone: 'Europe/Moscow',
          lastCompany: c.lastCompany || null,
          pending: c.pending || [],
        }),
        text: {
          format: {
            type: 'json_schema',
            name: 'dialogue_eval',
            strict: true,
            schema: z.toJSONSchema(dialoguePlanSchema, { target: 'draft-7' }),
          },
        },
      }),
    );
    assert.equal(result.status, 'completed');
    const output = result.output
      ?.flatMap((i) => i.content || [])
      .find((i) => i.type === 'output_text')?.text;
    const plan = dialoguePlanSchema.parse(JSON.parse(output));
    const kinds = plan.actions.map((a) => a.kind);
    if (c.kinds) assert.deepEqual(kinds, c.kinds);
    if (c.includes)
      for (const kind of c.includes)
        assert.ok(kinds.includes(kind), `Missing ${kind}; got ${kinds}`);
    if (c.last) assert.equal(plan.actions[0].company.mode, 'last');
    if (c.mode) assert.equal(plan.mode, c.mode);
    if (c.name === 'signature field deletion not whole signature')
      assert.equal(plan.actions[0].data.workPhone, '');
    console.log(`PASS ${c.name}`);
  } catch (error) {
    failed++;
    // No raw provider errors, requests or credentials are printed.
    console.error(
      `FAIL ${c.name}: ${error instanceof assert.AssertionError ? error.message : error.constructor.name}`,
    );
  }
}
console.log(`Dialogue live evaluation: ${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed ? 1 : 0;
