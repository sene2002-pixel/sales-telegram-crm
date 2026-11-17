import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import { Pool } from 'pg';
import { makeConfig } from '../server/config';
import { createApp } from '../server/http/app';
import { Actor } from '../shared/contracts';

const webhookSecret = 'synthetic-payment-webhook-secret-00000';
const invoiceUrl = 'https://t.me/$synthetic_invoice_link';
const terms = 'https://pico.example/terms/v1';
const botId = 720_000_010;
const overview = { enabled: true, termsUrl: terms, lastPayment: null };
const route = '/api/me/pico-stars/invoices';
const payerId = 720_000_051;
let running: Awaited<ReturnType<typeof createApp>>;
let dir: string;
let postgres: Pool | undefined;
const schema = 'stars_' + randomUUID().replaceAll('-', '');
let payer: Actor;
let other: Actor;
let id: string;
let invoiceInput: Record<string, unknown> | undefined;
let badInvoiceLink = false;
const answers: { pre_checkout_query_id: string; ok: boolean; error_message?: string }[] = [];
const telegramMessages: { chat_id: string; text: string; reply_markup?: object }[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pico-stars-'));
  let databaseUrl: string | undefined;
  if (process.env.TEST_DATABASE_URL) {
    postgres = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await postgres.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = url.toString();
  }
  running = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      DATA_DIR: dir,
      WORKER_ENABLED: 'false',
      DATABASE_URL: databaseUrl,
      BOT_TOKEN: botId + ':synthetic-payment-bot-token',
      PICO_STARS_TERMS_URL: terms,
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
  if (postgres) {
    await postgres.query(`DROP SCHEMA ${schema} CASCADE`);
    await postgres.end();
  }
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
  await request(running.app.getHttpServer())
    .post(route)
    .send({ acceptedTermsUrl: terms, amount: 100 })
    .expect(401);
  const { user: demo } = await running.services.auth.dev('manager', '127.0.0.1');
  await api('post', '', demo).send({ acceptedTermsUrl: terms, amount: 100 }).expect(403);
  for (const amount of [0, -1, 10_001, 0.5, '100', null]) {
    await api('post').send({ amount, acceptedTermsUrl: terms }).expect(400);
  }
  await api('post')
    .send({ acceptedTermsUrl: terms, amount: 100, telegramUserId: other.telegramId })
    .expect(400);
  await api('post').send({ amount: 100 }).expect(400);
  await api('post')
    .send({ amount: 100, acceptedTermsUrl: terms + '-old' })
    .expect(412);
  assert.equal(invoiceInput, undefined);
  badInvoiceLink = true;
  await api('post').send({ acceptedTermsUrl: terms, amount: 1 }).expect(502);
  badInvoiceLink = false;
  const valid = await api('post').send({ acceptedTermsUrl: terms, amount: 10_000 }).expect(201);
  await api('post', '/' + valid.body.id + '/cancel').expect(201, { cancelled: true });
});

test('invoice is created with XTR, no provider, and only its owner can read the pending status', async () => {
  const created = await api('post').send({ acceptedTermsUrl: terms, amount: 100 }).expect(201);
  id = created.body.id;
  assert.deepEqual(created.body, { id, url: invoiceUrl });
  const [consent] = await running.db.query(
    'SELECT accepted_terms_url AS url, accepted_terms_at IS NOT NULL AS recorded FROM pico_star_invoices WHERE id=$1',
    [id],
  );
  assert.deepEqual(consent, { url: terms, recorded: true });
  assert.deepEqual(invoiceInput, {
    title: 'Поддержка Pico',
    description: 'Звёзды пойдут на развитие Pico и новые функции.',
    payload: 'pico_stars_' + id,
    currency: 'XTR',
    provider_token: '',
    prices: [{ label: 'Поддержка Pico', amount: 100 }],
  });
  await api('get', '/' + id).expect(200, { amount: 100, status: 'pending', canCancel: true });
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
  const expired = randomUUID();
  await running.db.query(
    'INSERT INTO pico_star_invoices (id, actor_id, telegram_user_id, amount) VALUES ($1,$2,$3,100)',
    [expired, payer.id, payer.telegramId],
  );
  await running.db.query(
    "UPDATE pico_star_invoices SET expires_at=now() - interval '1 minute' WHERE id=$1",
    [expired],
  );
  await webhook(preCheckout(expired)).expect(201);
  assert.equal(answers.at(-1)?.ok, false);
  await api('get', '/' + expired).expect(200, { amount: 100, status: 'expired', canCancel: false });

  const start = answers.length;
  await Promise.all([
    webhook(preCheckout(id)).expect(201),
    webhook(preCheckout(id, { id: 'checkout-2' })).expect(201),
  ]);
  const approved = answers.slice(start).filter((answer) => answer.ok);
  assert.equal(approved.length, 1);
  await webhook(preCheckout(id, { id: approved[0]!.pre_checkout_query_id })).expect(201);
  assert.equal(answers.at(-1)?.ok, true);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'pending', canCancel: false });
});

test('only a verified receipt with the matching payer and amount marks a reservation paid', async () => {
  await webhook(receipt(id), 'invalid').expect(401);
  await webhook(receipt(id, { total_amount: 50 })).expect(201);
  await webhook(receipt(id, { currency: 'USD' })).expect(201);
  await webhook(receipt(id, {}, payerId + 1)).expect(201);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'pending', canCancel: false });

  const notApproved = randomUUID();
  await running.db.query(
    'INSERT INTO pico_star_invoices (id, actor_id, telegram_user_id, amount) VALUES ($1,$2,$3,100)',
    [notApproved, payer.id, payer.telegramId],
  );
  await webhook(receipt(notApproved)).expect(201);
  await api('get', '/' + notApproved).expect(200, {
    amount: 100,
    status: 'pending',
    canCancel: true,
  });
  await webhook(preCheckout(notApproved, { id: 'legacy-query' })).expect(201);
  assert.equal(answers.at(-1)?.ok, false);
  // Simulate a second checkout previously approved by an older release.
  await running.db.query(
    "UPDATE pico_star_invoices SET pre_checkout_id='legacy-query' WHERE id=$1",
    [notApproved],
  );

  await running.db.query('UPDATE pico_star_invoices SET expires_at=now() WHERE id=$1', [id]);
  running.services.config.picoStarsEnabled = false;
  await api('post').send({ acceptedTermsUrl: terms, amount: 100 }).expect(503);
  await webhook(receipt(id)).expect(201);
  await webhook(receipt(id)).expect(201);
  await webhook(receipt(id, { telegram_payment_charge_id: 'another-charge' })).expect(201);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'paid', canCancel: false });
  await webhook(receipt(notApproved)).expect(201);
  await api('get', '/' + notApproved).expect(200, {
    amount: 100,
    status: 'pending',
    canCancel: false,
  });
  const rows = await running.db.query(
    'SELECT telegram_payment_charge_id FROM pico_star_invoices WHERE paid_at IS NOT NULL',
  );
  assert.deepEqual(rows, [{ telegram_payment_charge_id: 'synthetic-charge-1' }]);
  await webhook(
    receipt(id, { telegram_payment_charge_id: 'another-charge' }, payerId, 'refunded_payment'),
  ).expect(201);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'paid', canCancel: false });
  const refundFromBot = receipt(id, {}, payerId, 'refunded_payment');
  const refund = { ...refundFromBot.message, from: { id: botId, is_bot: true } };
  for (const message of [
    { ...refund, chat: { type: 'private', id: payerId + 1 } },
    { ...refund, chat: { type: 'group', id: payerId } },
    { ...refund, from: { id: botId + 1, is_bot: true } },
    { ...refund, from: { id: botId, is_bot: false } },
  ]) {
    await webhook({ message }).expect(201);
    await api('get', '/' + id).expect(200, { amount: 100, status: 'paid', canCancel: false });
  }
  await webhook({ message: refund }).expect(201);
  await webhook({ message: refund }).expect(201);
  await webhook(receipt(id)).expect(201);
  await api('get', '/' + id).expect(200, { amount: 100, status: 'refunded', canCancel: false });
  const { body: afterRefund } = await api('get', '/active');
  assert.deepEqual(afterRefund.lastPayment, { id, amount: 100, status: 'refunded' });
  assert.equal(afterRefund.enabled, false);
  await webhook(
    receipt(notApproved, { telegram_payment_charge_id: 'different-legitimate-charge' }),
  ).expect(201);
  await api('get', '/' + notApproved).expect(200, {
    amount: 100,
    status: 'paid',
    canCancel: false,
  });
  running.services.config.picoStarsEnabled = true;
});

test('Stars limits invoice requests per account before calling Telegram', async () => {
  for (let i = 0; i < 6; i++) {
    const created = await api('post', '', other)
      .send({ acceptedTermsUrl: terms, amount: 1 })
      .expect(201);
    await api('post', '/' + created.body.id + '/cancel', other).expect(201, { cancelled: true });
  }
  invoiceInput = undefined;
  await api('post', '', other).send({ acceptedTermsUrl: terms, amount: 1 }).expect(429);
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
  assert.match(telegramMessages[0]!.text, /если он есть/);
  await webhook({ message: { ...message, chat: { id: -sender, type: 'group' } } }).expect(201);
  assert.equal(telegramMessages.length, 1);
});

test('an uncertain Telegram answer keeps the reservation and rejects a second checkout', async () => {
  const invoiceId = randomUUID();
  await running.db.query(
    'INSERT INTO pico_star_invoices (id, actor_id, telegram_user_id, amount, accepted_terms_url, accepted_terms_at) VALUES ($1,$2,$3,$4,$5,now())',
    [invoiceId, payer.id, payer.telegramId, 100, terms],
  );
  const originalCall = running.services.telegram.call;
  running.services.telegram.call = async (method, payload, timeoutMs) => {
    if (method === 'answerPreCheckoutQuery') throw new Error('simulated connection timeout');
    return originalCall(method, payload, timeoutMs);
  };
  try {
    await assert.rejects(
      running.services.stars.preCheckout(preCheckout(invoiceId).pre_checkout_query),
      /simulated connection timeout/,
    );
  } finally {
    running.services.telegram.call = originalCall;
  }
  await webhook(preCheckout(invoiceId, { id: 'different-checkout' })).expect(201);
  assert.equal(answers.at(-1)?.ok, false);
  await webhook(preCheckout(invoiceId)).expect(201);
  assert.equal(answers.at(-1)?.ok, true);
  await webhook(receipt(invoiceId, { telegram_payment_charge_id: 'delayed-charge' })).expect(201);
  await api('get', '/' + invoiceId).expect(200, { amount: 100, status: 'paid', canCancel: false });
});

test('only one active invoice per payer is created across devices; cancellation is atomic', async () => {
  const telegramId = String(payerId + 100);
  await running.db.query("INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,'manager')", [
    randomUUID(),
    telegramId,
    'Другой плательщик',
  ]);
  const actor = await running.services.auth.byTelegram(telegramId);
  const responses = await Promise.all([
    api('post', '', actor).send({ acceptedTermsUrl: terms, amount: 100 }),
    api('post', '', actor).send({ acceptedTermsUrl: terms, amount: 100 }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const activeId = responses.find((response) => response.status === 201)!.body.id;
  await api('get', '/active', actor).expect(200, { ...overview, id: activeId });
  await api('get', '/active', other).expect(200, { ...overview, id: null });
  await api('post', '/' + activeId + '/cancel', other).expect(201, { cancelled: false });
  await api('post', '/' + activeId + '/cancel', actor).expect(201, { cancelled: true });
  await api('get', '/active', actor).expect(200, { ...overview, id: null });
  await webhook(preCheckout(activeId, { from: { id: Number(telegramId) } })).expect(201);
  assert.equal(answers.at(-1)?.ok, false);
  const second = await api('post', '', actor)
    .send({ acceptedTermsUrl: terms, amount: 100 })
    .expect(201);
  await webhook(preCheckout(second.body.id, { from: { id: Number(telegramId) } })).expect(201);
  assert.equal(answers.at(-1)?.ok, true);
  await api('post', '/' + second.body.id + '/cancel', actor).expect(201, { cancelled: false });
  await running.db.query(
    "UPDATE pico_star_invoices SET expires_at=now() - interval '2 days' WHERE id=$1",
    [second.body.id],
  );
  await api('get', '/active', actor).expect(200, { ...overview, id: second.body.id });
  await api('get', '/' + second.body.id, actor).expect(200, {
    amount: 100,
    status: 'pending',
    canCancel: false,
  });
  await api('post', '', actor).send({ acceptedTermsUrl: terms, amount: 100 }).expect(409);
});

test('migration retires untouched legacy links while preserving approved reservations and late receipts', async () => {
  const legacy = [randomUUID(), randomUUID()];
  for (const invoiceId of legacy) {
    await running.db.query(
      'INSERT INTO pico_star_invoices (id,actor_id,telegram_user_id,amount) VALUES ($1,$2,$3,100)',
      [invoiceId, payer.id, payer.telegramId],
    );
  }
  const reserved = randomUUID();
  await running.db.query(
    "INSERT INTO pico_star_invoices (id,actor_id,telegram_user_id,amount,pre_checkout_id) VALUES ($1,$2,$3,100,'historical-approval')",
    [reserved, payer.id, payer.telegramId],
  );
  await running.db.migrate();
  await running.db.migrate();
  for (const invoiceId of legacy) {
    await webhook(preCheckout(invoiceId)).expect(201);
    assert.equal(answers.at(-1)?.ok, false);
    await api('get', '/' + invoiceId).expect(200, {
      amount: 100,
      status: 'expired',
      canCancel: false,
    });
  }
  await webhook(preCheckout(reserved, { id: 'historical-approval' })).expect(201);
  assert.equal(answers.at(-1)?.ok, true);
  await webhook({
    message: {
      message_id: 9,
      date: 1700000000,
      from: { id: payerId },
      chat: { id: payerId, type: 'private' },
      text: '/paysupport',
    },
  }).expect(201);
  assert.ok(telegramMessages.at(-1)?.text.includes(reserved));
  await webhook(receipt(reserved, { telegram_payment_charge_id: 'settled-legacy' })).expect(201);
  const { body } = await api('get', '/active').expect(200);
  assert.deepEqual(body.lastPayment, { id: reserved, amount: 100, status: 'paid' });
});

test('a payer lock serializes reservations on different eligible links, including a retry of the winner', async () => {
  const ids = [randomUUID(), randomUUID()];
  for (const invoiceId of ids) {
    await running.db.query(
      'INSERT INTO pico_star_invoices (id,actor_id,telegram_user_id,amount,accepted_terms_url,accepted_terms_at) VALUES ($1,$2,$3,100,$4,now())',
      [invoiceId, payer.id, payer.telegramId, terms],
    );
  }
  const start = answers.length;
  await Promise.all(
    ids.map((invoiceId) => webhook(preCheckout(invoiceId, { id: invoiceId })).expect(201)),
  );
  const approvals = answers.slice(start).filter((answer) => answer.ok);
  assert.equal(approvals.length, 1);
  const winner = approvals[0]!.pre_checkout_query_id;
  await webhook(preCheckout(winner, { id: winner })).expect(201);
  assert.equal(answers.at(-1)?.ok, true);
  await webhook(receipt(winner, { telegram_payment_charge_id: 'winner-charge' })).expect(201);
  await api('post', '/' + ids.find((id) => id !== winner) + '/cancel').expect(201, {
    cancelled: true,
  });
});

test('concurrent cancellation and approval never report two successful outcomes', async () => {
  // CI also runs this suite against a native PostgreSQL connection pool.
  for (let i = 0; i < 12; i++) {
    const invoiceId = randomUUID();
    await running.db.query(
      'INSERT INTO pico_star_invoices (id,actor_id,telegram_user_id,amount,accepted_terms_url,accepted_terms_at) VALUES ($1,$2,$3,100,$4,now())',
      [invoiceId, payer.id, payer.telegramId, terms],
    );
    const cancel = () => running.services.stars.cancel(payer, invoiceId);
    const approve = () =>
      running.services.stars.preCheckout(
        preCheckout(invoiceId, { id: invoiceId }).pre_checkout_query,
      );
    const result =
      i % 2
        ? (await Promise.all([approve(), cancel()]))[1]
        : (await Promise.all([cancel(), approve()]))[0];
    const accepted = answers.at(-1)?.ok;
    assert.notEqual(result.cancelled, accepted);
    if (accepted)
      await webhook(receipt(invoiceId, { telegram_payment_charge_id: 'race-' + invoiceId })).expect(
        201,
      );
    else {
      await webhook(preCheckout(invoiceId, { id: invoiceId })).expect(201);
      assert.equal(answers.at(-1)?.ok, false);
    }
  }
});
