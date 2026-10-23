import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TelegramAdapter } from '../server/infra/telegram';
import { makeConfig } from '../server/config';
import { importTemplateCaption } from '../server/services/import-onboarding';

test('Template multipart upload preserves all XLSX bytes, fixed filename and caption, and handles provider errors', async (t) => {
  const bytes = await readFile('assets/import/Pico-import.xlsx');
  const adapter = new TelegramAdapter(
    makeConfig({ NODE_ENV: 'test', BOT_TOKEN: 'synthetic-template-only' }),
  );
  let response = new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.match(url, /\/sendDocument$/);
    assert.equal(options.method, 'POST');
    assert.ok(options.signal);
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('chat_id'), '997001');
    const file = options.body.get('document') as File;
    assert.equal(file.name, 'Pico-import.xlsx');
    assert.equal(file.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    assert.equal(options.body.get('caption'), importTemplateCaption);
    return response;
  });
  assert.equal(await adapter.sendImportTemplate('997001', bytes, importTemplateCaption), 42);
  response = new Response('{}', { status: 503 });
  await assert.rejects(adapter.sendImportTemplate('997001', bytes, importTemplateCaption), {
    status: 502,
  });
  response = new Response(JSON.stringify({ ok: false }));
  await assert.rejects(adapter.sendImportTemplate('997001', bytes, importTemplateCaption), {
    status: 502,
  });
  response = new Response('invalid json');
  await assert.rejects(adapter.sendImportTemplate('997001', bytes, importTemplateCaption), {
    status: 502,
  });
});
