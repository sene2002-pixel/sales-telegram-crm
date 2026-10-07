import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { makeConfig } from '../server/config';
import { OpenAiAdapter } from '../server/infra/ai';
import { LetterService } from '../server/services/letters';
import { CrmService } from '../server/services/crm';

test('Luna defaults preserve separate speech model and explicit rollback overrides', () => {
  const config = makeConfig({});
  assert.equal(config.extractionModel, 'gpt-6-luna');
  assert.equal(config.letterModel, 'gpt-6-luna');
  assert.equal(config.transcriptionModel, 'gpt-4o-mini-transcribe');
  const old = makeConfig({ EXTRACTION_MODEL: 'gpt-4o-mini', LETTER_MODEL: 'gpt-4.1-mini' });
  assert.equal(old.extractionModel, 'gpt-4o-mini');
  assert.equal(old.letterModel, 'gpt-4.1-mini');
});

test('Luna and legacy requests preserve structured output, vision and search contracts', async () => {
  for (const model of ['gpt-6-luna', 'gpt-4.1-mini']) {
    const config = makeConfig({ EXTRACTION_MODEL: model, LETTER_MODEL: model });
    const ai = new OpenAiAdapter(config);
    const requests: any[] = [];
    ai.request = async (path, body) => {
      assert.equal(path, 'responses');
      requests.push(JSON.parse(String(body)));
      return {
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      };
    };
    // The deliberately minimal response is not a report; capture its outgoing contract.
    await assert.rejects(() => ai.extract('Отчёт', '2026-10-07'));
    const letters = new LetterService({} as CrmService, config, ai);
    const input = [
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,test' }] },
    ];
    assert.deepEqual(
      await letters.structured(z.object({ ok: z.boolean() }), 'Extract', input, true, false, {
        maxOutputTokens: 2000,
        temperature: 0,
      }),
      { ok: true },
    );
    for (const request of requests) {
      assert.equal(request.model, model);
      assert.deepEqual(request.reasoning, model === 'gpt-6-luna' ? { effort: 'none' } : undefined);
      assert.equal(request.store, false);
      assert.equal(request.text.format.strict, true);
    }
    assert.deepEqual(requests[1].input, input);
    assert.deepEqual(requests[1].tools, [{ type: 'web_search' }]);
    assert.equal(requests[1].tool_choice, 'required');
    assert.equal(requests[1].max_output_tokens, 2000);
  }
});
