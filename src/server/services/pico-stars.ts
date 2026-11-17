import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Actor, idSchema } from '../../shared/contracts';
import {
  PicoStarInvoice,
  PicoStarInvoiceStatus,
  picoStarsMaximum,
  picoStarsMinimum,
} from '../../shared/pico-stars';
import { Config } from '../config';
import { requireCondition } from '../domain/errors';
import { Database } from '../infra/database';
import { RateLimits } from '../infra/rate-limit';
import { TelegramAdapter } from '../infra/telegram';

const invoicePrefix = 'pico_stars_';
export const picoStarInvoiceInput = z
  .object({ amount: z.number().int().min(picoStarsMinimum).max(picoStarsMaximum) })
  .strict();

export const telegramPaymentFields = z.object({
  currency: z.string().length(3),
  total_amount: z.number().int().positive(),
  invoice_payload: z.string().min(1).max(128),
});
export const telegramStarReceipt = telegramPaymentFields.extend({
  telegram_payment_charge_id: z.string().min(1).max(256),
});
export const telegramPreCheckout = telegramPaymentFields.extend({
  id: z.string().min(1).max(256),
  from: z.object({ id: z.number().int().positive().safe() }),
});

function picoInvoiceId(payment: z.infer<typeof telegramPaymentFields>) {
  if (payment.currency !== 'XTR' || !payment.invoice_payload.startsWith(invoicePrefix)) return;
  const parsed = idSchema.safeParse(payment.invoice_payload.slice(invoicePrefix.length));
  if (parsed.success) return parsed.data;
}

export class PicoStars {
  private readonly invoiceRequests = new RateLimits();

  constructor(
    private db: Database,
    private telegram: Pick<TelegramAdapter, 'call' | 'send'>,
    private config: Config,
  ) {}

  async create(actor: Actor, input: unknown): Promise<PicoStarInvoice> {
    const { amount } = picoStarInvoiceInput.parse(input);
    requireCondition(this.config.picoStarsEnabled, 503, 'Оплата звёздами пока недоступна.');
    requireCondition(
      /^[1-9]\d*$/.test(actor.telegramId),
      403,
      'Для оплаты откройте Pico в Telegram.',
    );
    const wait = this.invoiceRequests.consume(actor.id, 6);
    requireCondition(!wait, 429, `Слишком много счетов. Повторите через ${wait} сек.`);
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor.id]);
      const pending = await tx.query(
        `SELECT id FROM pico_star_invoices WHERE actor_id=$1 AND paid_at IS NULL
         AND (pre_checkout_id IS NOT NULL OR expires_at > now()) LIMIT 1`,
        [actor.id],
      );
      requireCondition(
        !pending.length,
        409,
        'У вас уже есть счёт с неподтверждённой оплатой. Проверьте его статус.',
      );
      await tx.query(
        'INSERT INTO pico_star_invoices (id, actor_id, telegram_user_id, amount) VALUES ($1,$2,$3,$4)',
        [id, actor.id, actor.telegramId, amount],
      );
    });
    try {
      const url: unknown = await this.telegram.call(
        'createInvoiceLink',
        {
          title: 'Поддержка Pico',
          description: 'Звёзды пойдут на развитие Pico и новые функции.',
          payload: invoicePrefix + id,
          currency: 'XTR',
          provider_token: '',
          prices: [{ label: 'Поддержка Pico', amount }],
        },
        8_000,
      );
      requireCondition(
        typeof url === 'string' && /^https:\/\/t\.me\/(?:\$|invoice\/)[A-Za-z0-9_-]+$/.test(url),
        502,
        'Telegram не вернул ссылку на оплату.',
      );
      return { id, url };
    } catch (cause) {
      // No link was returned to the client. Never clear a checkout reservation.
      await this.cancel(actor, id);
      throw cause;
    }
  }

  async active(actor: Actor): Promise<{ id: string | null }> {
    const [invoice] = await this.db.query<{ id: string }>(
      `SELECT id FROM pico_star_invoices WHERE actor_id=$1 AND telegram_user_id=$2
       AND paid_at IS NULL AND (pre_checkout_id IS NOT NULL OR expires_at > now())
       ORDER BY created_at DESC LIMIT 1`,
      [actor.id, actor.telegramId],
    );
    return { id: invoice?.id ?? null };
  }

  async cancel(actor: Actor, input: string): Promise<{ cancelled: boolean }> {
    const id = idSchema.parse(input);
    const rows = await this.db.query(
      `UPDATE pico_star_invoices SET expires_at=now() WHERE id=$1 AND actor_id=$2
       AND telegram_user_id=$3 AND pre_checkout_id IS NULL AND paid_at IS NULL RETURNING id`,
      [id, actor.id, actor.telegramId],
    );
    return { cancelled: rows.length > 0 };
  }

  async status(actor: Actor, input: string): Promise<PicoStarInvoiceStatus> {
    const id = idSchema.parse(input);
    const [invoice] = await this.db.query<PicoStarInvoiceStatus>(
      `SELECT amount, CASE
        WHEN refunded_at IS NOT NULL THEN 'refunded'
        WHEN paid_at IS NOT NULL THEN 'paid'
        WHEN pre_checkout_id IS NULL AND expires_at <= now() THEN 'expired'
        ELSE 'pending' END AS status
       FROM pico_star_invoices WHERE id=$1 AND actor_id=$2 AND telegram_user_id=$3`,
      [id, actor.id, actor.telegramId],
    );
    requireCondition(invoice, 404, 'Счёт не найден.');
    return invoice;
  }

  async preCheckout(payment: z.infer<typeof telegramPreCheckout>) {
    const id = picoInvoiceId(payment);
    // A Telegram invoice link can be shared. Reserve it for one query and the original payer.
    const invoice =
      this.config.picoStarsEnabled &&
      id &&
      (
        await this.db.query<{ id: string }>(
          `UPDATE pico_star_invoices AS i SET pre_checkout_id=$4
           WHERE i.id=$1 AND i.telegram_user_id=$2 AND i.amount=$3
             AND i.expires_at > now() AND i.paid_at IS NULL
             AND (i.pre_checkout_id IS NULL OR i.pre_checkout_id=$4)
             AND EXISTS (SELECT 1 FROM users u WHERE u.id=i.actor_id AND u.active)
           RETURNING i.id`,
          [id, String(payment.from.id), payment.total_amount, payment.id],
        )
      )[0];
    await this.telegram.call(
      'answerPreCheckoutQuery',
      {
        pre_checkout_query_id: payment.id,
        ok: Boolean(invoice),
        ...(!invoice ? { error_message: 'Счёт недействителен. Создайте новый счёт в Pico.' } : {}),
      },
      5_000,
    );
  }

  async recordReceipt(
    payer: number,
    payment: z.infer<typeof telegramStarReceipt>,
    refunded = false,
  ) {
    const id = picoInvoiceId(payment);
    if (!id) return;
    const fields = [id, String(payer), payment.total_amount, payment.telegram_payment_charge_id];
    // Verified receipts can arrive after expiry or after new invoices have been disabled.
    const statement = refunded
      ? `UPDATE pico_star_invoices SET
           telegram_payment_charge_id=$4, paid_at=COALESCE(paid_at, now()), refunded_at=now()
         WHERE id=$1 AND telegram_user_id=$2 AND amount=$3
           AND pre_checkout_id IS NOT NULL AND refunded_at IS NULL
           AND (telegram_payment_charge_id IS NULL OR telegram_payment_charge_id=$4)`
      : `UPDATE pico_star_invoices SET telegram_payment_charge_id=$4, paid_at=now()
         WHERE id=$1 AND telegram_user_id=$2 AND amount=$3
           AND pre_checkout_id IS NOT NULL AND paid_at IS NULL`;
    try {
      await this.db.query(statement, fields);
    } catch (cause) {
      // A charge already recorded on another invoice cannot be applied a second time.
      if (
        (cause as { constraint?: string } | null)?.constraint !==
        'pico_star_invoices_telegram_payment_charge_id_key'
      ) {
        throw cause;
      }
    }
  }

  async paymentSupport(chatId: string) {
    const contact = this.config.picoStarsSupportUsername;
    await this.telegram.send(chatId, {
      text: contact
        ? 'По вопросам платежей в Pico напишите в поддержку. Укажите дату, сумму в звёздах и приложите чек Telegram.'
        : 'Поддержка платежей Pico пока недоступна.',
      ...(contact
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: 'Написать в поддержку', url: `https://t.me/${contact}` }]],
            },
          }
        : {}),
    });
  }
}
