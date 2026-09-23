import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { BotService } from '../server/services/bot';
import { TelegramAdapter } from '../server/infra/telegram';
import { picoGreeting } from '../server/services/pico-greeting';

test('Pico greeting introduces implemented features without promising autonomous reminders or client delivery', () => {
  assert.ok(picoGreeting.startsWith('Привет! Я Pico — твой AI-помощник в продажах.'));
  assert.ok(picoGreeting.length < 4096);
  assert.equal((picoGreeting.match(/\p{Extended_Pictographic}/gu) || []).length, 1);
  assert.ok(picoGreeting.split('\n').filter((line) => line.startsWith('- ')).length >= 4);
  assert.ok(!picoGreeting.includes('→'));
  for (const command of ['/tasks', '/voice', '/help', '/crm'])
    assert.ok(picoGreeting.includes(command));
  for (const text of [
    'Перед сохранением ты проверяешь данные',
    'PDF отправлю только тебе в Telegram',
    'Клиенту письмо не отправляю',
    'в существующих компаниях',
    'Аудио передаётся OpenAI',
    'Не отправляй пароли и лишние персональные данные',
  ])
    assert.ok(picoGreeting.includes(text));
  assert.doesNotMatch(
    picoGreeting,
    /напомню|напоминать|отправлю клиенту|создам КП|подготовлю КП|любые вопросы|знаю рынок/i,
  );
});

test('/start has a distinct authorized greeting, current CRM link, and never creates reports or starts AI', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-pico-greeting-'));
  const config = makeConfig({ DATA_DIR: dir, PUBLIC_URL: 'https://old.example.test' });
  const { app, services: s, db } = await createApp(config);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('No external calls in greeting tests');
  });
  const telegramId = 41234123;
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    randomUUID(),
    String(telegramId),
    'Greeting user',
    'manager',
  ]);
  const telegram = new TelegramAdapter(config);
  const sent: any[] = [];
  let menu = 'https://first.example.test';
  telegram.call = async (method, payload) => {
    if (method === 'getChatMenuButton') return { type: 'web_app', web_app: { url: menu } };
    assert.equal(method, 'sendMessage');
    sent.push(payload);
    return { message_id: sent.length };
  };
  s.letters.ai.request = async () => {
    throw new Error('Greeting must not call AI');
  };
  const bot = new BotService(
    config,
    s.auth,
    s.reports,
    s.crm,
    telegram,
    s.letterBot,
    s.voiceSignatures,
    s.diagnostics,
    s.voiceContacts,
  );
  let sequence = 0;
  const send = (text: string, user = telegramId, chatType = 'private') =>
    bot.handle({
      update_id: ++sequence,
      message: {
        message_id: sequence,
        date: Math.floor(Date.now() / 1000),
        from: { id: user },
        chat: { id: user, type: chatType },
        text,
      },
    });
  try {
    await send('/start');
    assert.equal(sent.at(-1).text, picoGreeting);
    assert.equal(sent.at(-1).reply_markup.inline_keyboard[0][0].web_app.url, menu);
    menu = 'https://changed.example.test';
    await send('/start@crm_bot onboarding');
    assert.equal(sent.at(-1).text, picoGreeting);
    assert.equal(sent.at(-1).reply_markup.inline_keyboard[0][0].web_app.url, menu);
    await send('/help');
    assert.notEqual(sent.at(-1).text, picoGreeting);
    assert.ok(sent.at(-1).text.startsWith('Отправьте голосовое или текст:'));
    assert.ok(sent.at(-1).text.includes('/myid'));

    const beforeGroup = sent.length;
    await send('/start', telegramId, 'group');
    assert.equal(sent.length, beforeGroup);
    await send('/start', telegramId + 1);
    assert.match(sent.at(-1).text, /Доступ не выдан/);
    assert.equal(
      (await db.query('SELECT id FROM users WHERE telegram_id=$1', [String(telegramId + 1)]))
        .length,
      0,
    );
    await db.query('UPDATE users SET active=false WHERE telegram_id=$1', [String(telegramId)]);
    await send('/start');
    assert.match(sent.at(-1).text, /Доступ не выдан/);
    for (const table of ['reports', 'companies', 'records', 'letter_jobs', 'signature_drafts'])
      assert.equal((await db.query(`SELECT id FROM ${table}`)).length, 0, table);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
