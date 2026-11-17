import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeConfig } from '../server/config';
import { Database } from '../server/infra/database';
import { reconcileInvoice } from '../server/reconcile-stars';
import { PicoStars } from '../server/services/pico-stars';

test('ledger reconciliation requires matching Telegram evidence and keeps repeat runs idempotent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-stars-ledger-'));
  const config = makeConfig({ DATA_DIR: dir });
  const db = new Database(config);
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  await db.init();
  const user = randomUUID(),
    invoice = randomUUID();
  const telegramId = 90000001;
  await db.query("INSERT INTO users (id,telegram_id,name,role) VALUES ($1,$2,'Test','manager')", [
    user,
    String(telegramId),
  ]);
  await db.query(
    "INSERT INTO pico_star_invoices (id,actor_id,telegram_user_id,amount,pre_checkout_id) VALUES ($1,$2,$3,75,'reservation')",
    [invoice, user, String(telegramId)],
  );
  const source = {
    type: 'user',
    transaction_type: 'invoice_payment',
    user: { id: telegramId },
    invoice_payload: 'pico_stars_' + invoice,
  };
  const payment = { id: 'test-charge', amount: 75, source };
  const receiver = { ...source, invoice_payload: undefined };
  const refund = { id: payment.id, amount: 75, receiver };
  let history: unknown[] = [];
  const bot = {
    async call(method: string, args: unknown) {
      assert.equal(method, 'getStarTransactions');
      const { offset, limit } = args as { offset: number; limit: number };
      return { transactions: history.slice(offset, offset + limit) };
    },
    async send() {
      throw new Error('unexpected send');
    },
  };
  const service = new PicoStars(db, bot, config);
  const reconcile = (apply = true) => reconcileInvoice(db, bot, service, invoice, apply);
  async function state() {
    const [row] = await db.query(
      'SELECT telegram_payment_charge_id AS charge,paid_at IS NOT NULL AS paid, refunded_at IS NOT NULL AS refunded FROM pico_star_invoices WHERE id=$1',
      [invoice],
    );
    return row;
  }
  history = [
    { ...payment, source: { ...source, user: { id: telegramId + 1 } } },
    { ...payment, source: { ...source, invoice_payload: 'unrelated' } },
    { ...payment, source: { ...source, transaction_type: 'gift_purchase' } },
    { ...payment, amount: 74 },
    { ...payment, nanostar_amount: 1 },
    refund,
  ];
  await reconcile();
  assert.deepEqual(await state(), { charge: null, paid: false, refunded: false });
  history = [payment, { ...payment, id: 'conflicting-charge' }];
  assert.match(await reconcile(), /расходятся/);
  assert.deepEqual(await state(), { charge: null, paid: false, refunded: false });
  history = [...Array.from({ length: 100 }, () => ({ id: 'other', amount: 1 })), payment];
  assert.match(await reconcileInvoice(db, bot, service, invoice, true, 1), /--max-pages/);
  assert.match(await reconcile(false), /--apply/);
  assert.deepEqual(await state(), { charge: null, paid: false, refunded: false });
  await reconcile();
  await reconcile();
  assert.deepEqual(await state(), { charge: payment.id, paid: true, refunded: false });
  history = [
    { ...refund, id: 'another-charge' },
    { ...refund, amount: -75 },
  ];
  await reconcile();
  assert.deepEqual(await state(), { charge: payment.id, paid: true, refunded: false });
  history = [refund];
  await reconcile();
  await reconcile();
  history = [payment];
  await reconcile();
  assert.deepEqual(await state(), { charge: payment.id, paid: true, refunded: true });
});
