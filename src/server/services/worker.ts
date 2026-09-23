import { randomUUID } from 'node:crypto';
import { Database } from '../infra/database';
import { ErrorLog } from '../infra/error-log';
import { SpeechToText, ReportExtractor } from '../infra/ai';
import { Messenger } from '../infra/telegram';
import { ReportService } from './reports';
import { Config } from '../config';
import { DomainError } from '../domain/errors';
import { extractionSchema } from '../../shared/contracts';
import { VoiceSignatures, signatureOperation } from './voice-signatures';
import { LetterBot } from './letter-bot';
import { looksLikeCommand, unknownCommand } from './command-intent';
import { DiagnosticLog } from '../infra/diagnostic-log';
import { VoiceContacts } from './voice-contacts';
import { isContactCreateRequest, looksLikeContactCommand } from './contact-intent';

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
    private letterBot?: LetterBot,
    private diagnostics?: DiagnosticLog,
    private voiceContacts?: VoiceContacts,
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
        const notify = async () => {
          await this.diagnostics?.record(
            'report.attempts_exhausted',
            { previousStatus: r.status },
            tx,
          );
          if (r.chat_id)
            await this.reports.notify(tx, r.chat_id, {
              text:
                r.purpose === 'contact'
                  ? 'Подготовка контакта прерывалась трижды. Контакт не создан. Повторите голосовую команду.'
                  : 'Обработка отчёта прерывалась трижды. Откройте CRM для повторной попытки.',
            });
        };
        if (this.diagnostics)
          await this.diagnostics.run(
            { traceId: r.source_key, actorId: r.author_id, entityId: r.id, attempt: r.attempts },
            notify,
          );
        else await notify();
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
    const process = async () => {
      let contact = report.purpose === 'contact';
      await this.diagnostics?.record('report.claimed', {
        kind: report.audio_file_id ? 'voice' : 'text',
        resumed: !!report.transcript,
      });
      try {
        const [author] = await this.db.query('SELECT active FROM users WHERE id=$1', [
          report.author_id,
        ]);
        if (!author?.active) throw new DomainError(403, 'Автор отчёта заблокирован');
        let transcript: string = report.transcript;
        if (!transcript) {
          const download = () => this.telegram.download(report.audio_file_id);
          const audio = await (this.diagnostics
            ? this.diagnostics.span('voice.download', {}, download)
            : download());
          const transcribe = () => this.speech.transcribe(audio);
          transcript = await (this.diagnostics
            ? this.diagnostics.span('voice.transcribe', { bytes: audio.length }, transcribe)
            : transcribe());
        }
        const signature = signatureOperation(transcript);
        contact = isContactCreateRequest(transcript);
        await this.diagnostics?.record(
          'voice.transcript',
          signature
            ? { redacted: 'signature', operation: signature, characters: transcript.length }
            : looksLikeContactCommand(transcript)
              ? { redacted: 'contact', characters: transcript.length }
              : { text: transcript },
        );
        await this.db.query('UPDATE reports SET transcript=$1 WHERE id=$2 AND lease_token=$3', [
          transcript,
          report.id,
          token,
        ]);
        if (signature)
          await this.diagnostics?.record('signature.processing.started', { operation: signature });
        if (await this.voiceSignatures?.process(report, token, transcript)) {
          await this.diagnostics?.record('command.routed', {
            route: 'signature',
            operation: signature,
          });
          return true;
        }
        if (contact) await this.diagnostics?.record('contact.processing.started');
        if (await this.voiceContacts?.process(report, token, transcript)) {
          await this.diagnostics?.record('command.routed', { route: 'contact' });
          return true;
        }
        if (await this.letterBot?.processVoice(report, token, transcript)) {
          await this.diagnostics?.record('command.routed', { route: 'letter' });
          return true;
        }
        if (looksLikeCommand(transcript)) {
          await this.diagnostics?.record('command.routed', { route: 'unknown' });
          await this.db.transaction(async (tx) => {
            const rows = await tx.query(
              "UPDATE reports SET purpose='command',status='cancelled',transcript=NULL,audio_file_id=NULL,draft=NULL,error=NULL,lease_until=NULL,lease_token=NULL,version=version+1 WHERE id=$1 AND lease_token=$2 RETURNING id",
              [report.id, token],
            );
            if (rows.length && report.chat_id)
              await this.reports.notify(tx, report.chat_id, { text: unknownCommand });
          });
          return true;
        }
        await this.diagnostics?.record('command.routed', { route: 'report' });
        await this.diagnostics?.record('report.extraction.started');
        const draft = extractionSchema.parse(
          await this.extractor.extract(transcript, new Date(report.created_at).toISOString()),
        );
        await this.diagnostics?.record('report.extraction.completed', {
          blocks: draft.blocks.length,
          warnings: draft.warnings.length,
        });
        await this.db.transaction(async (tx) => {
          const rows = await tx.query(
            `UPDATE reports SET status='review',draft=$1,version=version+1,lease_until=NULL,lease_token=NULL,error=NULL WHERE id=$2 AND lease_token=$3 RETURNING id`,
            [JSON.stringify(draft), report.id, token],
          );
          await this.diagnostics?.record(
            rows.length ? 'report.review_saved' : 'report.stale_result_ignored',
            {},
            tx,
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
        await this.diagnostics?.record('report.processing_failed', {
          errorType: error instanceof Error ? error.constructor.name : 'Unknown',
          status: error instanceof DomainError ? error.status : undefined,
          terminal: failed,
        });
        await this.db.transaction(async (tx) => {
          const rows = await tx.query(
            `UPDATE reports SET status=$1,error=$2,lease_until=NULL,lease_token=NULL,available_at=now()+interval '30 seconds',version=version+1 WHERE id=$3 AND lease_token=$4 RETURNING id`,
            [failed ? 'failed' : 'queued', message, report.id, token],
          );
          if (rows.length && failed && report.chat_id)
            await this.reports.notify(tx, report.chat_id, {
              text: contact
                ? `Не удалось подготовить контакт: ${message}. Контакт не создан. Повторите голосовую команду.`
                : `Не удалось обработать отчёт: ${message}. Откройте CRM для повторной попытки.`,
            });
        });
      }
      return true;
    };
    return this.diagnostics
      ? this.diagnostics.run(
          {
            traceId: report.source_key,
            actorId: report.author_id,
            entityId: report.id,
            attempt: report.attempts,
          },
          process,
        )
      : process();
  }
  async deliverOne() {
    if (!this.config.botToken) return;
    const failure = await this.db.transaction(async (tx) => {
      const [message] = await tx.query(
        'SELECT * FROM outbox WHERE NOT sent AND attempts<5 AND available_at<=now() ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1',
      );
      if (!message) return;
      const deliver = async () => {
        const started = Date.now();
        await this.diagnostics?.record(
          'notification.delivery.started',
          { outboxId: message.id },
          tx,
        );
        try {
          await this.telegram.send(message.chat_id, message.payload);
          await tx.query('UPDATE outbox SET sent=true WHERE id=$1', [message.id]);
          await this.diagnostics?.record(
            'notification.delivery.completed',
            { outboxId: message.id, durationMs: Date.now() - started },
            tx,
          );
        } catch (error) {
          await this.diagnostics?.record(
            'notification.delivery.failed',
            {
              outboxId: message.id,
              durationMs: Date.now() - started,
              errorType: error instanceof Error ? error.constructor.name : 'Unknown',
              terminal: message.attempts + 1 >= 5,
            },
            tx,
          );
          await tx.query(
            `UPDATE outbox SET attempts=attempts+1,available_at=now()+interval '30 seconds' WHERE id=$1`,
            [message.id],
          );
          return { error, entityId: message.id, attempt: message.attempts + 1 };
        }
      };
      return this.diagnostics
        ? this.diagnostics.run(
            {
              traceId: message.trace_id || `outbox:${message.id}`,
              actorId: message.actor_id || undefined,
              entityId: message.id,
              attempt: message.attempts + 1,
            },
            deliver,
          )
        : deliver();
    });
    if (failure)
      await new ErrorLog(this.db).record(failure.error, {
        event: 'telegram.delivery_failed',
        entityId: failure.entityId,
        attempt: failure.attempt,
      });
  }
}
