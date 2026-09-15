import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../server/config';
import { TelegramAdapter } from '../server/infra/telegram';

test('Telegram CSV adapter uploads multipart document, checks HTTP and Telegram errors', async (t) => {
  const adapter = new TelegramAdapter(makeConfig({ NODE_ENV: 'test', BOT_TOKEN: 'test-only' }));
  let response = new Response(JSON.stringify({ ok: true }));
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.match(url, /\/sendDocument$/);
    assert.equal(options.method, 'POST');
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('chat_id'), '123456');
    const file = options.body.get('document') as File;
    assert.equal(file.name, 'report.csv');
    assert.equal(await file.text(), 'Отчёт;1');
    return response;
  });
  await adapter.sendDocument('123456', 'Отчёт;1', 'report.csv');
  response = new Response('{}', { status: 403 });
  await assert.rejects(adapter.sendDocument('123456', 'Отчёт;1', 'report.csv'), { status: 502 });
  response = new Response(JSON.stringify({ ok: false }));
  await assert.rejects(adapter.sendDocument('123456', 'Отчёт;1', 'report.csv'), { status: 502 });
});
