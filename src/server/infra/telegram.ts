import { Config } from '../config';
import { requireCondition } from '../domain/errors';
export interface Messenger {
  send(chatId: string, payload: any): Promise<void>;
  download(fileId: string): Promise<Uint8Array>;
}
export class TelegramAdapter implements Messenger {
  constructor(private config: Config) {}
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
    await this.call('sendMessage', { chat_id: chatId, ...payload });
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
