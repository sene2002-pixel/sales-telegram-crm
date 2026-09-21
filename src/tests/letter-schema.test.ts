import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { letterSchema } from '../server/services/letters';
import { OpenAiAdapter } from '../server/infra/ai';
import { makeConfig } from '../server/config';
test('letter source schema omits unsupported uri format but validates URLs locally', () => {
  const schema = z.toJSONSchema(letterSchema, { target: 'draft-7' }) as any;
  assert.equal(schema.properties.sources.items.type, 'string');
  assert.equal(schema.properties.sources.items.format, undefined);
  assert.equal(schema.properties.sources.items.pattern, '^https?:\\/\\/[^\\s]+$');
  const data = {
    recipient_lines: ['Директору', 'ООО Тест'],
    references_paragraph: 'а'.repeat(330),
    sources: ['https://example.com'],
  };
  assert.ok(letterSchema.safeParse(data).success);
  for (const source of [
    'not a url',
    'javascript:alert(1)',
    'example.com',
    '[Сайт](https://example.com)',
    'turn0search0',
  ])
    assert.equal(letterSchema.safeParse({ ...data, sources: [source] }).success, false);
});
test('AI invalid schema errors are actionable and do not disclose provider messages', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_json_schema',
            param: 'text.format.schema',
            message: 'sensitive request data',
          },
        }),
        { status: 400 },
      ),
  );
  const ai = new OpenAiAdapter(makeConfig({ OPENAI_API_KEY: 'test' }));
  await assert.rejects(ai.request('responses', '{}'), (error: any) => {
    assert.match(error.message, /отклонил формат/);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});
