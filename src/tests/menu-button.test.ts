import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAdapter } from '../server/infra/telegram';
import { makeConfig } from '../server/config';

test('CRM inline button uses current per-chat menu, including subsequent URL changes', async () => {
  const adapter = new TelegramAdapter(makeConfig({ PUBLIC_URL: 'https://old.example' }));
  let current = 'https://current.example',
    sent: any;
  adapter.call = async (method, payload: any) => {
    if (method === 'getChatMenuButton') {
      assert.equal(payload.chat_id, '123');
      return { type: 'web_app', web_app: { url: current } };
    }
    assert.equal(method, 'sendMessage');
    sent = payload;
  };
  const payload = { text: 'CRM', reply_markup: adapter.appButton() };
  await adapter.send('123', payload);
  assert.equal(sent.reply_markup.inline_keyboard[0][0].web_app.url, current);
  current = 'https://new.example';
  await adapter.send('123', payload);
  assert.equal(sent.reply_markup.inline_keyboard[0][0].web_app.url, current);
  assert.equal(payload.reply_markup.inline_keyboard[0]![0]!.web_app.url, 'https://old.example');
});
test('CRM menu default resolves global menu; failures do not publish stale links', async () => {
  const adapter = new TelegramAdapter(makeConfig({ PUBLIC_URL: 'https://old.example' }));
  let sent: any;
  adapter.call = async (method, payload: any) => {
    if (method === 'getChatMenuButton')
      return payload.chat_id
        ? { type: 'default' }
        : { type: 'web_app', web_app: { url: 'https://global.example' } };
    sent = payload;
  };
  await adapter.send('123', { text: 'CRM', reply_markup: adapter.appButton() });
  assert.equal(sent.reply_markup.inline_keyboard[0][0].web_app.url, 'https://global.example');
  adapter.call = async (method, payload) => {
    if (method === 'getChatMenuButton') throw Error('unavailable');
    sent = payload;
  };
  await adapter.send('123', { text: 'CRM', reply_markup: adapter.appButton() });
  assert.deepEqual(sent.reply_markup.inline_keyboard, []);
  assert.match(sent.text, /кнопкой меню/);
  await adapter.send('123', { text: 'Plain message' });
  assert.equal(sent.text, 'Plain message');
});
