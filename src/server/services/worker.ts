import { randomUUID } from 'node:crypto';
import { Database } from '../infra/database';
import { ErrorLog } from '../infra/error-log';
import { SpeechToText, ReportExtractor } from '../infra/ai';
import { Messenger } from '../infra/telegram';
import { ReportService } from './reports';
import { Config } from '../config';
import { DomainError } from '../domain/errors';
import { extractionSchema } from '../../shared/contracts';
import { VoiceSignatures } from './voice-signatures';

export class ReportWorker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private db: Database,
    private reports: ReportService,
    private speech: SpeechToText,
    private extractor: ReportExtractor,
    private telegram: Messenger,
    private config: Config,
    private voiceSignatures?: VoiceSignatures,
  ) {}
  start() {
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = this.tick()
          .catch((error) => new ErrorLog(this.db).record(error, { event: 'worker.error' }))
          .finally(() => {
            this.running = undefined;
          });
    }, 1500);
  }
  async stop() {
    clearInterval(this.timer);
    await this.running;
  }
  async tick() {
    await this.processOne();
    await this.deliverOne();
  }
  async processOne() {
    const token = randomUUID();
    const report = await this.db.transaction(async (tx) => {
      const [r] = await tx.query(
        `SELECT * FROM reports WHERE (status='queued' AND available_at<=now()) OR (status='processing' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!r) return null;
      if (r.attempts >= 3) {
        await tx.query(
          `UPDATE reports SET status='failed',lease_until=NULL,lease_token=NULL,error='Обработка прерывалась трижды. Повторите вручную',version=version+1 WHERE id=$1`,
          [r.id],
        );
        if (r.chat_id)
          await this.reports.notify(tx, r.chat_id, {
            text: 'Обработка отчёта прерывалась трижды. Откройте CRM для повторной попытки.',
          });
        return null;
      }
      // Four minute lease exceeds the combined download + transcription + extraction deadlines.
      await tx.query(
        `UPDATE reports SET status='processing',lease_until=now()+interval '4 minutes',lease_token=$1,attempts=attempts+1 WHERE id=$2`,
        [token, r.id],
      );
      return { ...r, attempts: r.attempts + 1 };
    });
    if (!report) return false;
    try {
      const [author] = await this.db.query('SELECT active FROM users WHERE id=$1', [
        report.author_id,
      ]);
      if (!author?.active) throw new DomainError(403, 'Автор отчёта заблокирован');
      const transcript =
        report.transcript ||
        (await this.speech.transcribe(await this.telegram.download(report.audio_file_id)));
      await this.db.query('UPDATE reports SET transcript=$1 WHERE id=$2 AND lease_token=$3', [
        transcript,
        report.id,
        token,
      ]);
      if (await this.voiceSignatures?.process(report, token, transcript)) return true;
      const draft = extractionSchema.parse(
        await this.extractor.extract(transcript, new Date(report.created_at).toISOString()),
      );
      await this.db.transaction(async (tx) => {
        const rows = await tx.query(
          `UPDATE reports SET status='review',draft=$1,version=version+1,lease_until=NULL,lease_token=NULL,error=NULL WHERE id=$2 AND lease_token=$3 RETURNING id`,
          [JSON.stringify(draft), report.id, token],
        );
        if (rows.length && report.chat_id) {
          const summary = draft.blocks
            .map(
              (b) =>
                `${b.companyName}\n${b.summary}\nЗадач: ${b.tasks.length} · Контактов: ${b.contacts.length}`,
            )
            .join('\n\n');
          await this.reports.notify(tx, report.chat_id, {
            text: `Проверьте черновик:\n\n${summary.slice(0, 2900)}${draft.warnings.length ? '\n\n⚠ ' + draft.warnings.join('; ').slice(0, 500) : ''}`,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Сохранить', callback_data: `save:${report.id}:${report.version + 1}` },
                  { text: 'Отменить', callback_data: `cancel:${report.id}` },
                ],
                [
                  {
                    text: 'Проверить / исправить в CRM',
                    web_app: { url: `${this.config.publicUrl}/?report=${report.id}` },
                  },
                ],
              ],
            },
          });
        }
      });
    } catch (error) {
      await new ErrorLog(this.db).record(error, {
        event: 'report.processing_failed',
        actorId: report.author_id,
        entityId: report.id,
        attempt: report.attempts,
      });
      const message =
        error instanceof DomainError
          ? error.message
          : 'Ошибка обработки. Повторите позже или исправьте текст отчёта';
      const failed =
        report.attempts >= 3 ||
        (error instanceof DomainError && [403, 413, 422, 503].includes(error.status));
      await this.db.transaction(async (tx) => {
        const rows = await tx.query(
          `UPDATE reports SET status=$1,error=$2,lease_until=NULL,lease_token=NULL,available_at=now()+interval '30 seconds',version=version+1 WHERE id=$3 AND lease_token=$4 RETURNING id`,
          [failed ? 'failed' : 'queued', message, report.id, token],
        );
        if (rows.length && failed && report.chat_id)
          await this.reports.notify(tx, report.chat_id, {
            text: `Не удалось обработать отчёт: ${message}. Откройте CRM для повторной попытки.`,
          });
      });
    }
    return true;
  }
  async deliverOne() {
    if (!this.config.botToken) return;
    const failure = await this.db.transaction(async (tx) => {
      const [message] = await tx.query(
        'SELECT * FROM outbox WHERE NOT sent AND attempts<5 AND available_at<=now() ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1',
      );
      if (!message) return;
      try {
        await this.telegram.send(message.chat_id, message.payload);
        await tx.query('UPDATE outbox SET sent=true WHERE id=$1', [message.id]);
      } catch (error) {
        await tx.query(
          `UPDATE outbox SET attempts=attempts+1,available_at=now()+interval '30 seconds' WHERE id=$1`,
          [message.id],
        );
        return { error, entityId: message.id, attempt: message.attempts + 1 };
      }
    });
    if (failure)
      await new ErrorLog(this.db).record(failure.error, {
        event: 'telegram.delivery_failed',
        entityId: failure.entityId,
        attempt: failure.attempt,
      });
  }
}
