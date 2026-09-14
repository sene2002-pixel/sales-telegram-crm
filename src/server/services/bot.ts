import { timingSafeEqual } from 'node:crypto';
import { Config } from '../config';
import { AuthService } from './auth';
import { ReportService } from './reports';
import { CrmService } from './crm';
import { TelegramAdapter } from '../infra/telegram';
import { DomainError, requireCondition } from '../domain/errors';
import { z } from 'zod';
const sender = z.object({
  id: z.number().int().positive().safe(),
  first_name: z.string().optional(),
});
const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int(),
      from: sender,
      chat: z.object({ id: z.number().int().safe(), type: z.string() }),
      text: z.string().max(20_000).optional(),
      voice: z
        .object({ file_id: z.string(), duration: z.number(), file_size: z.number().optional() })
        .optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: sender,
      data: z.string().optional(),
      message: z
        .object({ chat: z.object({ id: z.number().int().safe(), type: z.string() }) })
        .optional(),
    })
    .optional(),
});
export class BotService {
  constructor(
    private config: Config,
    private auth: AuthService,
    private reports: ReportService,
    private crm: CrmService,
    private telegram: TelegramAdapter,
  ) {}
  verify(secret: string) {
    const a = Buffer.from(secret),
      b = Buffer.from(this.config.webhookSecret);
    requireCondition(
      b.length > 0 && a.length === b.length && timingSafeEqual(a, b),
      401,
      'Неверный секрет webhook',
    );
  }
  async handle(raw: unknown) {
    const update = updateSchema.parse(raw);
    const callback = update.callback_query;
    const msg = update.message;
    const chat = callback?.message?.chat || msg?.chat;
    const from = callback?.from || msg?.from;
    if (!chat || !from || chat.type !== 'private' || chat.id !== from.id) return { ok: true };
    const chatId = String(chat.id);
    try {
      const actor = await this.auth.byTelegram(String(from.id), from.first_name);
      if (callback) {
        const [action, id, version] = (callback.data || '').split(':');
        if (action === 'save' && id) await this.reports.confirmCurrent(actor, id, Number(version));
        if (action === 'cancel' && id) await this.reports.transition(actor, id, 'cancel');
        await this.telegram.call('answerCallbackQuery', {
          callback_query_id: callback.id,
          text: 'Готово',
        });
        return { ok: true };
      }
      const command = msg?.text?.split(/\s/)[0]?.split('@')[0];
      if (command === '/crm')
        await this.telegram.send(chatId, {
          text: 'Ваши компании, задачи и отчёты',
          reply_markup: this.telegram.appButton(),
        });
      else if (command === '/start' || command === '/help')
        await this.telegram.send(chatId, {
          text: 'Отправьте голосовое или текст: компания, с кем общались, результат и следующий шаг со сроком. Я подготовлю черновик, вы проверите и сохраните. /crm — база, /tasks — открытые задачи. Аудио передаётся сервису распознавания; не отправляйте лишние персональные данные.',
          reply_markup: this.telegram.appButton(),
        });
      else if (command === '/tasks') {
        const tasks = (await this.crm.records(actor, 'task'))
          .filter((t) => !t.data.done)
          .slice(0, 15);
        await this.telegram.send(chatId, {
          text: tasks.length
            ? tasks
                .map(
                  (t) =>
                    `${t.companyName}: ${t.data.text}${t.data.due ? ' · до ' + t.data.due : ''}`,
                )
                .join('\n')
                .slice(0, 3900)
            : 'Открытых задач нет.',
          reply_markup: this.telegram.appButton(),
        });
      } else if (msg?.voice || msg?.text) {
        requireCondition(
          !msg.voice ||
            (msg.voice.duration <= this.config.maxVoiceSeconds &&
              (msg.voice.file_size || 0) <= this.config.maxVoiceBytes),
          413,
          'Голосовое слишком длинное или большое',
        );
        await this.reports.enqueue(actor, {
          sourceKey: `telegram:${update.update_id}`,
          chatId,
          audioFileId: msg.voice?.file_id,
          text: msg.text,
          sentAt: new Date(msg.date * 1000).toISOString(),
        });
      } else
        await this.telegram.send(chatId, {
          text: 'Отправьте голосовое сообщение или текстовый отчёт.',
        });
    } catch (error) {
      if (error instanceof DomainError && error.status < 500) {
        if (callback)
          await this.telegram.call('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: error.message.slice(0, 180),
            show_alert: true,
          });
        else await this.telegram.send(chatId, { text: error.message });
      } else throw error;
    }
    return { ok: true };
  }
}
