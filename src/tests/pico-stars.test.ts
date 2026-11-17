import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import { makeConfig } from '../server/config';
import { createApp } from '../server/http/app';
import { Actor } from '../shared/contracts';

const webhookSecret = 'synthetic-payment-webhook-secret-00000';
const invoiceUrl = 'https://t.me/$synthetic_invoice_link';
const route = '/api/me/pico-stars/invoices';
const payerId = 720_000_051;
let running: Awaited<ReturnType<typeof createApp>>;
let dir: string;
let payer: Actor;
let other: Actor;
let id: string;
let invoiceInput: Record<string, unknown> | undefined;
let badInvoiceLink = false;
const answers: { pre_checkout_query_id: string; ok: boolean; error_message?: string }[] = [];
const telegramMessages: { chat_id: string; text: string; reply_markup?: object }[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pico-stars-'));
  running = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      DATA_DIR: dir,
      WORKER_ENABLED: 'false',
      BOT_TOKEN: 'synthetic-payment-bot-token',
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      PICO_STARS_ENABLED: 'true',
      PICO_STARS_SUPPORT_USERNAME: 'PicoTestSupport',
    }),
  );
  await running.app.listen(0, '127.0.0.1');
  for (const [telegramId, name] of [
    [payerId, 'Плательщик'],
    [payerId + 1, 'Другой пользователь'],
  ] as const) {
    await running.db.query(
      "INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,'manager')",
      [randomUUID(), String(telegramId), name],
    );
  }
  payer = await running.services.auth.byTelegram(String(payerId));
  other = await running.services.auth.byTelegram(String(payerId + 1));
  running.services.telegram.call = async (method, payload, timeoutMs) => {
    if (method === 'createInvoiceLink') {
      assert.equal(timeoutMs, 8_000);
      invoiceInput = payload as typeof invoiceInput;
      return badInvoiceLink ? 'https://invalid.example/invoice' : invoiceUrl;
    }
    if (method === 'answerPreCheckoutQuery') {
      assert.equal(timeoutMs, 5_000);
      answers.push(payload as (typeof answers)[number]);
      return true;
    }
    if (method === 'sendMessage') {
      telegramMessages.push(payload as (typeof telegramMessages)[number]);
      return { message_id: 1 };
    }
    throw new Error('Unexpected Telegram method');
  };
});

after(async () => {
  await running?.app.close();
  await running?.db.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function api(method: 'get' | 'post', suffix = '', actor = payer) {
  return request(running.app.getHttpServer())
    [method](route + suffix)
    .set('Authorization', 'Bearer ' + running.services.auth.issue(actor));
}

function webhook(update: object, secret = webhookSecret) {
  return request(running.app.getHttpServer())
    .post('/api/telegram/webhook')
    .set('X-Telegram-Bot-Api-Secret-Token', secret)
    .send({ update_id: 1, ...update });
}

function preCheckout(invoiceId: string, fields = {}) {
  return {
    pre_checkout_query: {
      id: 'checkout-1',
      currency: 'XTR',
      total_amount: 100,
      invoice_payload: 'pico_stars_' + invoiceId,
      from: { id: payerId },
      ...fields,
    },
  };
}

function receipt(invoiceId: string, fields = {}, sender = payerId, kind = 'successful_payment') {
  return {
    message: {
      message_id: 1,
      date: 1_700_000_000,
      from: { id: sender },
      chat: { type: 'private', id: sender },
      [kind]: {
        currency: 'XTR',
        total_amount: 100,
        invoice_payload: 'pico_stars_' + invoiceId,
        telegram_payment_charge_id: 'synthetic-charge-1',
        ...fields,
      },
    },
  };
}

test('Stars default off and enabled configuration requires a support contact', () => {
  assert.equal(makeConfig({}).picoStarsEnabled, false);
  assert.throws(() => makeConfig({ PICO_STARS_ENABLED: 'true' }), /PICO_STARS_SUPPORT_USERNAME/);
});

test('invoices require an authenticated Telegram actor and a whole number of Stars in range', async () => {
  await request(running.app.getHttpServer()).post(route).send({ amount: 100 }).expect(401);
  const { user: demo } = await running.services.auth.dev('manager', '127.0.0.1');
  await api('post', '', demo).send({ amount: 100 }).expect(403);
  for (const amount of [0, -1, 10_001, 0.5, '100', null]) {
    await api('post').send({ amount }).expect(400);
  }
  await api('post').send({ amount: 100, telegramUserId: other.telegramId }).expect(400);
  assert.equal(invoiceInput, undefined);
  badInvoiceLink = true;
  await api('post').send({ amount: 1 }).expect(502);
  badInvoiceLink = false;
  await api('post').send({ amount: 10_000 }).expect(201);
});

test('invoice is created with XTR, no provider, and only its owner can read the pending status', async () => {
  const created = await api('post').send({ amount: 100 }).expect(201);
  id = created.body.id;
  assert.deepEqual(created.body, { id, url: invoiceUrl });
  assert.deepEqual(invoiceInput, {
    title: 'Поддержка Pico',
    description: 'Звёзды пойдут на развитие Pico и новые функции.',
    payload: 'pico_stars_' + id,
    currency: 'XTR',
    provider_token: '',
    prices: [{ label: 'Поддержка Pico', amount: 100 }],
  });
  await api('get', '/' + id).expect(200, { amount: 100, status: 'pending' });
  await api('get', '/' + id, other).expect(404);
});

test('webhook rejects wrong payer, amount, currency, stale invoice, and parallel checkout', async () => {
  await webhook(preCheckout(id), 'invalid').expect(401);
  assert.equal(answers.length, 0);
  for (const fields of [
    { from: { id: payerId + 1 } },
    { total_amount: 99 },
    { currency: 'RUB' },
    { invoice_payload: 'another_product' },
  ]) {
    await webhook(preCheckout(id, fields)).expect(201);
    assert.equal(answers.at(-1)?.ok, false);
    assert.ok(answers.at(-1)?.error_message);
  }
  const expired = (await api('post').send({ amount: 100 }).expect(201)).body.id;
  await running.db.query(
    "UPDATE pico_star_invoices SET expires_at=now() - interval '1 minute' WHERE id=$1",
    [expired],
  );
  await webhook(preCheckout(expired)).expect(201);
  assert.equal(answers.at(-1)?.ok, false);
  await api('get', '/' + expired).expect(200, { amount: 100, status: 'expired' });

  const start = answers.length;
  await Promise.all([
    webhook(preCheckout(id)).expect(201),
    webhook(preCheckout(id, { id: 'checkout-2' })).expect(201),
  ]);
  const approved = answers.slice(start).filter((answer) => answer.ok);
  assert.equal(approved.length, 1);
  await webhook(preCheckout(id, { id: approved[0]!.pre_checkout_query_id })).expect(201);
  assert.equal(answers.at(-1)?.ok, true);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'pending' });
});

test('only a verified receipt with the matching payer and amount marks a reservation paid', async () => {
  await webhook(receipt(id), 'invalid').expect(401);
  await webhook(receipt(id, { total_amount: 50 })).expect(201);
  await webhook(receipt(id, { currency: 'USD' })).expect(201);
  await webhook(receipt(id, {}, payerId + 1)).expect(201);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'pending' });

  const notApproved = (await api('post').send({ amount: 100 }).expect(201)).body.id;
  await webhook(receipt(notApproved)).expect(201);
  await api('get', '/' + notApproved).expect(200, { amount: 100, status: 'pending' });
  await webhook(preCheckout(notApproved, { id: 'duplicate-charge-attempt' })).expect(201);
  assert.equal(answers.at(-1)?.ok, true);

  await running.db.query('UPDATE pico_star_invoices SET expires_at=now() WHERE id=$1', [id]);
  running.services.config.picoStarsEnabled = false;
  await api('post').send({ amount: 100 }).expect(503);
  await webhook(receipt(id)).expect(201);
  await webhook(receipt(id)).expect(201);
  await webhook(receipt(id, { telegram_payment_charge_id: 'another-charge' })).expect(201);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'paid' });
  await webhook(receipt(notApproved)).expect(201);
  await api('get', '/' + notApproved).expect(200, { amount: 100, status: 'pending' });
  const rows = await running.db.query(
    'SELECT telegram_payment_charge_id FROM pico_star_invoices WHERE paid_at IS NOT NULL',
  );
  assert.deepEqual(rows, [{ telegram_payment_charge_id: 'synthetic-charge-1' }]);
  await webhook(
    receipt(id, { telegram_payment_charge_id: 'another-charge' }, payerId, 'refunded_payment'),
  ).expect(201);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'paid' });
  await webhook(receipt(id, {}, payerId, 'refunded_payment')).expect(201);
  await webhook(receipt(id)).expect(201);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'refunded' });
  running.services.config.picoStarsEnabled = true;
});

test('Stars limits invoice requests per account before calling Telegram', async () => {
  for (let i = 0; i < 6; i++) await api('post', '', other).send({ amount: 1 }).expect(201);
  invoiceInput = undefined;
  await api('post', '', other).send({ amount: 1 }).expect(429);
  assert.equal(invoiceInput, undefined);
});

test('/paysupport works in the private bot chat without CRM access', async () => {
  const sender = payerId + 10;
  const message = {
    message_id: 1,
    date: 1_700_000_000,
    from: { id: sender },
    chat: { id: sender, type: 'private' },
    text: '/paysupport@PicoTestBot',
  };
  await webhook({ message }).expect(201);
  assert.equal(telegramMessages.length, 1);
  assert.deepEqual(telegramMessages[0]?.reply_markup, {
    inline_keyboard: [[{ text: 'Написать в поддержку', url: 'https://t.me/PicoTestSupport' }]],
  });
  await webhook({ message: { ...message, chat: { id: -sender, type: 'group' } } }).expect(201);
  assert.equal(telegramMessages.length, 1);
});
