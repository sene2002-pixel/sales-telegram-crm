import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Actor, idSchema } from '../../shared/contracts';
import {
  PicoStarInvoice,
  PicoStarInvoiceStatus,
  PicoStarInvoiceOverview,
  picoStarsMaximum,
  picoStarsMinimum,
} from '../../shared/pico-stars';
import { Config } from '../config';
import { requireCondition } from '../domain/errors';
import { Database } from '../infra/database';
import { RateLimits } from '../infra/rate-limit';
import { TelegramAdapter } from '../infra/telegram';

const invoicePrefix = 'pico_stars_';
const openInvoice = `paid_at IS NULL AND cancelled_at IS NULL
  AND (pre_checkout_id IS NOT NULL OR expires_at > clock_timestamp())`;
export const picoStarInvoiceInput = z
  .object({
    amount: z.number().int().min(picoStarsMinimum).max(picoStarsMaximum),
    acceptedTermsUrl: z.string().url().max(2048),
  })
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
    const { amount, acceptedTermsUrl } = picoStarInvoiceInput.parse(input);
    requireCondition(this.config.picoStarsEnabled, 503, 'Оплата звёздами пока недоступна.');
    requireCondition(
      /^[1-9]\d*$/.test(actor.telegramId),
      403,
      'Для оплаты откройте Pico в Telegram.',
    );
    requireCondition(
      acceptedTermsUrl === this.config.picoStarsTermsUrl,
      412,
      'Условия поддержки изменились. Ознакомьтесь с ними перед оплатой.',
    );
    const wait = this.invoiceRequests.consume(actor.id, 6);
    requireCondition(!wait, 429, `Слишком много счетов. Повторите через ${wait} сек.`);
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor.id]);
      const pending = await tx.query(
        `SELECT id FROM pico_star_invoices WHERE actor_id=$1 AND ${openInvoice} LIMIT 1`,
        [actor.id],
      );
      requireCondition(
        !pending.length,
        409,
        'У вас уже есть счёт с неподтверждённой оплатой. Проверьте его статус.',
      );
      await tx.query(
        `INSERT INTO pico_star_invoices (id, actor_id, telegram_user_id, amount, accepted_terms_url, accepted_terms_at)
         VALUES ($1,$2,$3,$4,$5,now())`,
        [id, actor.id, actor.telegramId, amount, acceptedTermsUrl],
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

  async active(actor: Actor): Promise<PicoStarInvoiceOverview> {
    const [overview] = await this.db.query<Pick<PicoStarInvoiceOverview, 'id' | 'lastPayment'>>(
      `SELECT
        (SELECT id FROM pico_star_invoices WHERE actor_id=$1 AND telegram_user_id=$2 AND ${openInvoice}
         ORDER BY (pre_checkout_id IS NOT NULL) DESC, created_at DESC, id LIMIT 1) AS id,
        (SELECT jsonb_build_object('id', id, 'amount', amount, 'status',
             CASE WHEN refunded_at IS NULL THEN 'paid' ELSE 'refunded' END)
         FROM pico_star_invoices WHERE actor_id=$1 AND telegram_user_id=$2 AND paid_at IS NOT NULL
         ORDER BY COALESCE(refunded_at, paid_at) DESC, id LIMIT 1) AS "lastPayment"`,
      [actor.id, actor.telegramId],
    );
    return {
      ...overview!,
      enabled: this.config.picoStarsEnabled,
      termsUrl: this.config.picoStarsTermsUrl || null,
    };
  }

  async cancel(actor: Actor, input: string): Promise<{ cancelled: boolean }> {
    const id = idSchema.parse(input);
    const rows = await this.db.query(
      `UPDATE pico_star_invoices SET cancelled_at=COALESCE(cancelled_at,clock_timestamp()),
         expires_at='-infinity' WHERE id=$1 AND actor_id=$2
       AND telegram_user_id=$3 AND pre_checkout_id IS NULL AND paid_at IS NULL RETURNING id`,
      [id, actor.id, actor.telegramId],
    );
    return { cancelled: rows.length > 0 };
  }

  async status(actor: Actor, input: string): Promise<PicoStarInvoiceStatus> {
    const id = idSchema.parse(input);
    const [invoice] = await this.db.query<PicoStarInvoiceStatus>(
      `SELECT amount,
        (paid_at IS NULL AND cancelled_at IS NULL AND pre_checkout_id IS NULL AND expires_at > now()) AS "canCancel",
        CASE
        WHEN refunded_at IS NOT NULL THEN 'refunded'
        WHEN paid_at IS NOT NULL THEN 'paid'
        WHEN cancelled_at IS NOT NULL OR (pre_checkout_id IS NULL AND expires_at <= now()) THEN 'expired'
        ELSE 'pending' END AS status
       FROM pico_star_invoices WHERE id=$1 AND actor_id=$2 AND telegram_user_id=$3`,
      [id, actor.id, actor.telegramId],
    );
    requireCondition(invoice, 404, 'Счёт не найден.');
    return invoice;
  }

  async preCheckout(payment: z.infer<typeof telegramPreCheckout>) {
    const id = picoInvoiceId(payment);
    const invoice =
      id &&
      (await this.db.transaction(async (tx) => {
        const [owner] = await tx.query<{ id: string }>(
          `SELECT u.id FROM users u JOIN pico_star_invoices i ON i.actor_id=u.id
         WHERE i.id=$1 AND i.telegram_user_id=$2 AND u.telegram_id=$2 AND u.active FOR UPDATE OF u`,
          [id, String(payment.from.id)],
        );
        if (!owner) return;
        // All new reservations for this actor use the same lock as invoice creation.
        // Already approved queries may be redelivered even if terms or settings changed.
        const [reserved] = await tx.query<{ id: string }>(
          `UPDATE pico_star_invoices i SET pre_checkout_id=$3
         WHERE i.id=$1 AND i.amount=$2 AND i.cancelled_at IS NULL AND i.paid_at IS NULL
           AND (i.pre_checkout_id=$3 OR (
             $4 AND i.pre_checkout_id IS NULL AND i.expires_at > clock_timestamp()
             AND i.accepted_terms_at IS NOT NULL AND i.accepted_terms_url=$5
             AND NOT EXISTS (SELECT 1 FROM pico_star_invoices other
               WHERE other.actor_id=i.actor_id AND other.pre_checkout_id IS NOT NULL AND other.paid_at IS NULL)
           )) RETURNING i.id`,
          [
            id,
            payment.total_amount,
            payment.id,
            this.config.picoStarsEnabled,
            this.config.picoStarsTermsUrl,
          ],
        );
        return reserved;
      }));
    await this.telegram.call(
      'answerPreCheckoutQuery',
      {
        pre_checkout_query_id: payment.id,
        ok: Boolean(invoice),
        ...(!invoice
          ? {
              error_message:
                'Оплата по этой ссылке недоступна. Проверьте счёт в Pico или напишите /paysupport.',
            }
          : {}),
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
    const [pending] = contact
      ? await this.db.query<{ id: string }>(
          `SELECT id FROM pico_star_invoices WHERE telegram_user_id=$1 AND ${openInvoice}
       ORDER BY (pre_checkout_id IS NOT NULL) DESC, created_at DESC, id LIMIT 1`,
          [chatId],
        )
      : [];
    await this.telegram.send(chatId, {
      text: contact
        ? 'По вопросам платежей напишите в поддержку Pico. Укажите дату и сумму. Чек Telegram можно приложить, если он есть.' +
          (pending ? ` Номер вашего незавершённого счёта: ${pending.id}.` : '')
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
