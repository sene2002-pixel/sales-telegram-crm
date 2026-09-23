import { timingSafeEqual } from 'node:crypto';
import { Config } from '../config';
import { AuthService } from './auth';
import { ReportService } from './reports';
import { CrmService } from './crm';
import { TelegramAdapter } from '../infra/telegram';
import { DomainError, requireCondition } from '../domain/errors';
import { ErrorLog } from '../infra/error-log';
import { LetterBot, letterQuery } from './letter-bot';
import { voiceHelp } from './voice-help';
import { looksLikeCommand, unknownCommand } from './command-intent';
import { VoiceSignatures, signatureOperation } from './voice-signatures';
import { DiagnosticLog } from '../infra/diagnostic-log';
import { z } from 'zod';
import { VoiceContacts } from './voice-contacts';
import { isContactCreateRequest, looksLikeContactCommand } from './contact-intent';
import { securityIntent, securityReply } from './pico-security';
import { picoGreeting } from './pico-greeting';
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
    private letters?: LetterBot,
    private voiceSignatures?: VoiceSignatures,
    private diagnostics?: DiagnosticLog,
    private voiceContacts?: VoiceContacts,
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
    return this.diagnostics
      ? this.diagnostics.run({ traceId: `telegram:${update.update_id}` }, () =>
          this.handleUpdate(update),
        )
      : this.handleUpdate(update);
  }
  private async handleUpdate(update: z.infer<typeof updateSchema>) {
    const callback = update.callback_query;
    const msg = update.message;
    const chat = callback?.message?.chat || msg?.chat;
    const from = callback?.from || msg?.from;
    if (!chat || !from || chat.type !== 'private' || chat.id !== from.id) {
      await this.diagnostics?.record('telegram.update_ignored', {
        reason: 'not_private_or_mismatched_sender',
      });
      return { ok: true };
    }
    const blocked = msg?.text ? securityIntent(msg.text) : null;
    await this.diagnostics?.record('telegram.received', {
      updateId: update.update_id,
      telegramUserId: from.id,
      messageId: msg?.message_id,
      sentAt: msg?.date,
      kind: callback ? 'callback' : msg?.voice ? 'voice' : 'text',
      text: blocked
        ? '[SECURITY_REQUEST]'
        : msg?.text && signatureOperation(msg.text)
          ? '[SIGNATURE]'
          : msg?.text && looksLikeContactCommand(msg.text)
            ? '[CONTACT]'
            : msg?.text,
      duration: msg?.voice?.duration,
      size: msg?.voice?.file_size,
    });
    const chatId = String(chat.id);
    try {
      const command = msg?.text?.split(/\s/)[0]?.split('@')[0];
      // Public self-identification only: no user provisioning or CRM access.
      if (!callback && command === '/myid') {
        await this.telegram.send(chatId, {
          text: `Ваш Telegram ID: ${from.id}\nПередайте его администратору CRM для выдачи доступа. Эта команда сама по себе не предоставляет доступ к CRM.`,
        });
        return { ok: true };
      }
      const actor = await this.auth.byTelegram(String(from.id), from.first_name);
      if (this.diagnostics?.context) this.diagnostics.context.actorId = actor.id;
      await this.diagnostics?.record('telegram.authorized', {
        actorName: actor.name,
        role: actor.role,
      });
      if (!callback && blocked) {
        const text = await this.crm.db.transaction((tx) =>
          securityReply(tx, actor.id, blocked, 'text', `telegram:${update.update_id}`),
        );
        await this.diagnostics?.record('security.request_blocked', {
          intent: blocked,
          kind: 'text',
          characters: msg?.text?.length,
        });
        await this.telegram.send(chatId, { text });
        return { ok: true };
      }
      if (callback) {
        const [action, id, version] = (callback.data || '').split(':');
        await this.diagnostics?.record('telegram.callback.started', {
          action,
          entityId: id,
          version,
        });
        if (action === 'save' && id) await this.reports.confirmCurrent(actor, id, Number(version));
        if (action === 'cancel' && id) await this.reports.transition(actor, id, 'cancel');
        if (action === 'sc' && id) await this.voiceSignatures?.confirm(actor, id);
        if (action === 'sx' && id) await this.voiceSignatures?.discard(actor, id);
        if (action === 'sp' && id) await this.voiceSignatures?.choose(actor, id, Number(version));
        if (action === 'cc' && id) await this.voiceContacts?.confirm(actor, id);
        if (action === 'cx' && id) await this.voiceContacts?.discard(actor, id);
        if (action === 'cp' && id) await this.voiceContacts?.choose(actor, id, Number(version));
        if (action === 'lp' && id) await this.letters?.chooseSignature(actor, id, Number(version));
        if (action === 'lc' && id) await this.letters?.chooseSignature(actor, id);
        await this.telegram.call('answerCallbackQuery', {
          callback_query_id: callback.id,
          text:
            action === 'cancel'
              ? 'Отчёт отменён'
              : action === 'cx'
                ? 'Создание контакта отменено'
                : 'Готово',
        });
        await this.diagnostics?.record('telegram.callback.completed', { action, entityId: id });
        return { ok: true };
      }
      const query = msg?.text ? letterQuery(msg.text) : null;
      if (query !== null && this.letters) {
        await this.diagnostics?.record('command.routed', { route: 'letter', query });
        await this.letters.enqueue(actor, `telegram:${update.update_id}`, query);
        return { ok: true };
      }
      if (command === '/crm')
        await this.telegram.send(chatId, {
          text: 'Ваши компании, задачи и отчёты',
          reply_markup: this.telegram.appButton(),
        });
      else if (command === '/voice')
        await this.telegram.send(chatId, {
          text: voiceHelp(this.config),
          reply_markup: this.telegram.appButton(),
        });
      else if (command === '/start')
        await this.telegram.send(chatId, {
          text: picoGreeting,
          reply_markup: this.telegram.appButton(),
        });
      else if (command === '/help')
        await this.telegram.send(chatId, {
          text: 'Отправьте голосовое или текст: компания, с кем общались, результат и следующий шаг со сроком. Я подготовлю черновик, вы проверите и сохраните. /voice — все голосовые возможности с примерами, /crm — база, /tasks — открытые задачи, /myid — ваш Telegram ID. Аудио передаётся сервису распознавания; не отправляйте лишние персональные данные.',
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
      } else if (msg?.text && isContactCreateRequest(msg.text)) {
        await this.diagnostics?.record('command.routed', { route: 'contact_voice_only' });
        await this.telegram.send(chatId, {
          text: 'Для создания контакта отправьте голосовое: «Создай контакт для ООО Рога и копыта. Иванов Иван, директор, телефон …, email …». Перед сохранением покажу данные для проверки.',
        });
      } else if (msg?.text && looksLikeCommand(msg.text)) {
        await this.diagnostics?.record('command.routed', { route: 'unknown' });
        await this.telegram.send(chatId, { text: unknownCommand });
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
      await this.diagnostics?.record('telegram.handle_failed', {
        errorType: error instanceof Error ? error.constructor.name : 'Unknown',
        status: error instanceof DomainError ? error.status : undefined,
        message: error instanceof DomainError ? error.message : undefined,
      });
      if (error instanceof DomainError && error.status < 500) {
        await new ErrorLog(this.crm.db).record(error, { event: 'telegram.command_failed' });
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
