import { Config } from '../config';
import { ErrorLog } from './error-log';
import { requireCondition } from '../domain/errors';
export interface Messenger {
  send(chatId: string, payload: any): Promise<void>;
  download(fileId: string): Promise<Uint8Array>;
}
export class TelegramAdapter implements Messenger {
  constructor(
    private config: Config,
    private errors?: ErrorLog,
  ) {}
  async call(method: string, payload: unknown): Promise<any> {
    requireCondition(this.config.botToken, 503, 'Бот не настроен');
    const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25_000),
    });
    requireCondition(response.ok, 502, `Telegram недоступен (HTTP ${response.status})`);
    const result: any = await response.json();
    requireCondition(result.ok, 502, 'Telegram отклонил запрос');
    return result.result;
  }
  async send(chatId: string, payload: any) {
    // The menu can be updated independently (e.g. by a dynamic tunnel sync).
    // Resolve the plain CRM button when sending, not from a stale PUBLIC_URL.
    const keyboard = payload.reply_markup?.inline_keyboard;
    const isCrmButton = (button: any) =>
      button.text === 'Открыть CRM' && button.web_app?.url === this.config.publicUrl;
    if (keyboard?.some((row: any[]) => row.some(isCrmButton))) {
      let url: string | undefined;
      try {
        let menu = await this.call('getChatMenuButton', { chat_id: chatId });
        if (menu?.type === 'default') menu = await this.call('getChatMenuButton', {});
        if (menu?.type === 'web_app') {
          const parsed = new URL(menu.web_app.url);
          if (parsed.protocol === 'https:' && !parsed.username && !parsed.password)
            url = menu.web_app.url;
        }
      } catch (error) {
        // Sending may hold an outbox transaction; do not wait on a second DB connection.
        void this.errors?.record(error, { event: 'telegram.menu_lookup_failed' });
        // Do not send a known potentially outdated address when lookup fails.
      }
      payload = {
        ...payload,
        ...(!url
          ? { text: `${payload.text}\nОткройте CRM кнопкой меню рядом с полем сообщения.` }
          : {}),
        reply_markup: {
          ...payload.reply_markup,
          inline_keyboard: keyboard
            .map((row: any[]) =>
              row.flatMap((button) =>
                isCrmButton(button)
                  ? url
                    ? [{ ...button, web_app: { ...button.web_app, url } }]
                    : []
                  : [button],
              ),
            )
            .filter((row: any[]) => row.length),
        },
      };
    }
    await this.call('sendMessage', { chat_id: chatId, ...payload });
  }
  async sendDocument(chatId: string, content: string, filename: string) {
    requireCondition(this.config.botToken, 503, 'Бот не настроен');
    const body = new FormData();
    body.append('chat_id', chatId);
    body.append('document', new Blob([content], { type: 'text/csv;charset=utf-8' }), filename);
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/sendDocument`,
      {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(25_000),
      },
    );
    requireCondition(
      response.ok,
      502,
      'Не удалось отправить CSV. Откройте личный чат бота и попробуйте снова.',
    );
    const result = (await response.json()) as any;
    requireCondition(result.ok, 502, 'Telegram отклонил отправку файла');
  }
  async download(fileId: string) {
    const file = await this.call('getFile', { file_id: fileId });
    requireCondition(
      file.file_size <= this.config.maxVoiceBytes &&
        typeof file.file_path === 'string' &&
        !file.file_path.includes('..'),
      413,
      'Слишком большой аудиофайл',
    );
    const response = await fetch(
      `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    requireCondition(response.ok && response.body, 502, 'Не удалось скачать аудио');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as any) {
      size += chunk.length;
      if (size > this.config.maxVoiceBytes) {
        throw new Error('Audio size limit exceeded');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  appButton(label = 'Открыть CRM', reportId?: string) {
    return {
      inline_keyboard: [
        [
          {
            text: label,
            web_app: { url: this.config.publicUrl + (reportId ? `/?report=${reportId}` : '') },
          },
        ],
      ],
    };
  }
}
