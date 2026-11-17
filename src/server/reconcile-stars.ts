import { parseArgs } from 'node:util';
import { z } from 'zod';
import { idSchema } from '../shared/contracts';
import { makeConfig } from './config';
import { Database } from './infra/database';
import { TelegramAdapter } from './infra/telegram';
import { PicoStars, telegramStarReceipt } from './services/pico-stars';

const partner = z.object({
  type: z.string(),
  transaction_type: z.string().optional(),
  user: z.object({ id: z.number().int().positive().safe() }).optional(),
  invoice_payload: z.string().optional(),
});
const ledgerPage = z.object({
  transactions: z
    .array(
      z.object({
        id: z.string().min(1),
        amount: z.number().int(),
        nanostar_amount: z.number().int().optional(),
        source: partner.optional(),
        receiver: partner.optional(),
      }),
    )
    .max(100),
});

type Invoice = {
  id: string;
  telegram_user_id: string;
  amount: number;
  pre_checkout_id: string | null;
  telegram_payment_charge_id: string | null;
  paid_at: Date | null;
  refunded_at: Date | null;
};

async function readInvoice(db: Database, id: string) {
  const [invoice] = await db.query<Invoice>(
    `SELECT id, telegram_user_id, amount, pre_checkout_id, telegram_payment_charge_id,
            paid_at, refunded_at FROM pico_star_invoices WHERE id=$1`,
    [id],
  );
  return invoice;
}

export async function reconcileInvoice(
  db: Database,
  telegram: Pick<TelegramAdapter, 'call'>,
  stars: Pick<PicoStars, 'recordReceipt'>,
  invoiceId: string,
  apply: boolean,
  maxPages = 100,
): Promise<string> {
  const invoice = await readInvoice(db, idSchema.parse(invoiceId));
  if (!invoice) return 'Счёт не найден.';
  if (!invoice.pre_checkout_id) return 'Счёт не получал разрешения на оплату.';

  const payload = 'pico_stars_' + invoice.id;
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  const pageSize = 100;
  for (let page = 0; page < maxPages; page++) {
    const result = ledgerPage.parse(
      await telegram.call(
        'getStarTransactions',
        { offset: page * pageSize, limit: pageSize },
        8_000,
      ),
    );
    for (const tx of result.transactions) {
      if (tx.nanostar_amount || tx.amount !== invoice.amount || !!tx.source === !!tx.receiver)
        continue;
      const user = tx.source ?? tx.receiver;
      if (
        user?.type !== 'user' ||
        user.transaction_type !== 'invoice_payment' ||
        String(user.user?.id) !== invoice.telegram_user_id
      )
        continue;
      if (tx.source && user.invoice_payload === payload) incoming.add(tx.id);
      if (tx.receiver && (user.invoice_payload === undefined || user.invoice_payload === payload))
        outgoing.add(tx.id);
    }
    if (result.transactions.length < pageSize) break;
    if (page === maxPages - 1)
      return 'История превышает лимит одной сверки. Увеличьте --max-pages и повторите. Счёт сохранён без изменений.';
  }

  const stored = invoice.telegram_payment_charge_id;
  if (incoming.size > 1 || (stored && incoming.size && !incoming.has(stored))) {
    return 'Идентификаторы операций расходятся. Требуется ручная сверка.';
  }
  const charge = stored ?? [...incoming][0];
  if (!charge || (!incoming.has(charge) && !outgoing.has(charge))) {
    return 'Совпадающая операция не найдена. Состояние счёта сохранено.';
  }
  // Telegram uses the original charge identifier again for a refund.
  const refunded = outgoing.has(charge);
  const target = refunded ? 'refunded' : 'paid';
  if (invoice.refunded_at || (invoice.paid_at && !refunded)) {
    return 'Подтверждённый статус в CRM: ' + (invoice.refunded_at ? 'refunded' : 'paid') + '.';
  }
  if (!apply)
    return 'В истории Telegram подтверждён статус ' + target + '. Для записи передайте --apply.';

  const receipt = telegramStarReceipt.parse({
    currency: 'XTR',
    total_amount: invoice.amount,
    invoice_payload: payload,
    telegram_payment_charge_id: charge,
  });
  await stars.recordReceipt(Number(invoice.telegram_user_id), receipt, refunded);
  const after = await readInvoice(db, invoice.id);
  if (
    after?.telegram_payment_charge_id !== charge ||
    !after.paid_at ||
    (refunded && !after.refunded_at)
  ) {
    throw new Error('Сверка требует проверки оператором.');
  }
  return 'Подтверждённый статус в CRM: ' + (after.refunded_at ? 'refunded' : 'paid') + '.';
}

async function main(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { apply: { type: 'boolean' }, 'max-pages': { type: 'string', default: '100' } },
    allowPositionals: true,
  });
  const invoiceId = idSchema.parse(positionals[0]);
  const maxPages = z.coerce.number().int().min(1).max(21474836).parse(values['max-pages']);
  if (positionals.length !== 1) throw new Error('Требуется один номер счёта.');
  const config = makeConfig();
  if (!config.databaseUrl || !config.botToken)
    throw new Error('Для сверки требуются PostgreSQL и настроенный бот.');
  const db = new Database(config);
  const telegram = new TelegramAdapter(config);
  try {
    await db.init({ migrate: false });
    return await reconcileInvoice(
      db,
      telegram,
      new PicoStars(db, telegram, config),
      invoiceId,
      values.apply === true,
      maxPages,
    );
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (result) => console.log(result),
    () => {
      console.error(
        'Сверка не завершена. Проверьте настройки, доступность Telegram и аргументы: <invoice-id> [--apply] [--max-pages N].',
      );
      process.exitCode = 1;
    },
  );
}
