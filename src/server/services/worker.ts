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
import { securityIntent, securityReply } from './pico-security';
import { DialogueService } from './dialogue';
import { maxPhotoBytes, photoDataUrl } from './photo-input';

export class ReportWorker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private deliveryTimer?: NodeJS.Timeout;
  private delivering?: Promise<void>;
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
    private dialogue?: DialogueService,
  ) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = this.processOne()
          .then(() => {})
          .catch((error) => new ErrorLog(this.db).record(error, { event: 'worker.error' }))
          .finally(() => {
            this.running = undefined;
          });
    }, 1500);
    // Delivery must continue while transcription/search/AI is awaiting a response.
    this.deliveryTimer = setInterval(() => {
      if (!this.delivering)
        this.delivering = this.deliverOne()
          .catch((error) => new ErrorLog(this.db).record(error, { event: 'worker.delivery_error' }))
          .finally(() => {
            this.delivering = undefined;
          });
    }, 1500);
  }
  async stop() {
    clearInterval(this.timer);
    clearInterval(this.deliveryTimer);
    this.timer = undefined;
    this.deliveryTimer = undefined;
    await Promise.all([this.running, this.delivering]);
  }
  async tick() {
    await this.processOne();
    await this.deliverOne();
  }
  async processOne() {
    await this.dialogue?.reconcile();
    const token = randomUUID();
    const report = await this.db.transaction(async (tx) => {
      const [r] = await tx.query(
        `SELECT r.* FROM reports r WHERE ((r.status='queued' AND r.available_at<=now()) OR (r.status='processing' AND r.lease_until<now()))
         AND (r.purpose<>'dialogue' OR NOT EXISTS (
           SELECT 1 FROM reports earlier WHERE earlier.author_id=r.author_id AND earlier.purpose='dialogue'
           AND earlier.status IN ('queued','processing') AND earlier.received_seq<r.received_seq
         )) ORDER BY r.received_seq FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
      );
      if (!r) return null;
      if (r.attempts >= 3) {
        await tx.query(
          `UPDATE reports SET status='failed',lease_until=NULL,lease_token=NULL,error='Обработка прерывалась трижды. Повторите вручную',version=version+1 WHERE id=$1`,
          [r.id],
        );
        await this.reports.processing.finish(tx, r.source_key);
        const notify = async () => {
          await this.diagnostics?.record(
            'report.attempts_exhausted',
            { previousStatus: r.status },
            tx,
          );
          if (r.chat_id)
            await this.reports.processing.run(r.source_key, () =>
              this.reports.notify(tx, r.chat_id, {
                text:
                  r.purpose === 'dialogue'
                    ? 'Не удалось разобрать запрос после трёх попыток. Новые действия не выполнены. Повторите запрос.'
                    : r.purpose === 'contact'
                      ? 'Подготовка контакта прерывалась трижды. Контакт не создан. Повторите голосовую команду.'
                      : 'Обработка отчёта прерывалась трижды. Откройте CRM для повторной попытки.',
              }),
            );
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
      if (r.chat_id)
        await this.reports.processing.begin(
          tx,
          r.source_key,
          r.chat_id,
          r.image_file_id
            ? 'Распознаю данные изображения…'
            : r.transcript
              ? 'Анализирую информацию…'
              : 'Распознаю голосовой запрос…',
        );
      return { ...r, attempts: r.attempts + 1 };
    });
    if (!report) return false;
    const process = async () => {
      let contact = report.purpose === 'contact';
      await this.diagnostics?.record('report.claimed', {
        kind: report.image_file_id ? 'photo' : report.audio_file_id ? 'voice' : 'text',
        resumed: !!report.transcript,
      });
      try {
        const [author] = await this.db.query('SELECT active FROM users WHERE id=$1', [
          report.author_id,
        ]);
        if (!author?.active) throw new DomainError(403, 'Автор отчёта заблокирован');
        let transcript: string = report.transcript || '';
        let image: string | undefined;
        if (report.image_file_id) {
          await this.reports.processing.stage(report.source_key, 'Распознаю данные изображения…');
          const bytes = await this.telegram.download(report.image_file_id, maxPhotoBytes);
          image = photoDataUrl(bytes);
          await this.diagnostics?.record('photo.downloaded', { bytes: bytes.length });
        }
        if (!transcript && !image) {
          const download = () => this.telegram.download(report.audio_file_id);
          const audio = await (this.diagnostics
            ? this.diagnostics.span('voice.download', {}, download)
            : download());
          const transcribe = () => this.speech.transcribe(audio);
          transcript = await (this.diagnostics
            ? this.diagnostics.span('voice.transcribe', { bytes: audio.length }, transcribe)
            : transcribe());
        }
        const restricted = securityIntent(transcript);
        if (restricted) {
          await this.db.transaction(async (tx) => {
            const rows = await tx.query(
              `UPDATE reports SET purpose='command',status='cancelled',transcript=NULL,audio_file_id=NULL,image_file_id=NULL,
               draft=NULL,error=NULL,lease_until=NULL,lease_token=NULL,version=version+1
               WHERE id=$1 AND lease_token=$2 RETURNING id`,
              [report.id, token],
            );
            if (!rows.length) return;
            const kind = report.audio_file_id ? 'voice' : 'text';
            const text = await securityReply(
              tx,
              report.author_id,
              restricted,
              kind,
              report.source_key,
            );
            if (report.chat_id) await this.reports.notify(tx, report.chat_id, { text });
            await this.diagnostics?.record(
              'security.request_blocked',
              {
                intent: restricted,
                kind,
                characters: transcript.length,
              },
              tx,
            );
          });
          return true;
        }
        if (report.purpose === 'dialogue' && this.dialogue) {
          await this.db.query('UPDATE reports SET transcript=$1 WHERE id=$2 AND lease_token=$3', [
            transcript,
            report.id,
            token,
          ]);
          await this.reports.processing.stage(report.source_key, 'Разбираю запрос и контекст…');
          await this.dialogue.process(report, token, transcript, image);
          return true;
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
        await this.reports.processing.stage(
          report.source_key,
          signature
            ? 'Анализирую данные подписи…'
            : contact
              ? 'Собираю данные контакта…'
              : 'Анализирую запрос…',
        );
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
        await this.reports.processing.stage(report.source_key, 'Подготавливаю черновик…');
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
          (error instanceof DomainError && [400, 403, 413, 422, 503].includes(error.status));
        await this.diagnostics?.record('report.processing_failed', {
          errorType: error instanceof Error ? error.constructor.name : 'Unknown',
          status: error instanceof DomainError ? error.status : undefined,
          terminal: failed,
        });
        await this.db.transaction(async (tx) => {
          const rows = await tx.query(
            `UPDATE reports SET status=$1,error=$2,image_file_id=CASE WHEN $1='failed' THEN NULL ELSE image_file_id END,lease_until=NULL,lease_token=NULL,available_at=now()+interval '30 seconds',version=version+1 WHERE id=$3 AND lease_token=$4 RETURNING id`,
            [failed ? 'failed' : 'queued', message, report.id, token],
          );
          if (rows.length && failed && report.chat_id)
            await this.reports.notify(tx, report.chat_id, {
              text: contact
                ? `Не удалось подготовить контакт: ${message}. Контакт не создан. Повторите голосовую команду.`
                : report.purpose === 'dialogue'
                  ? `Не удалось разобрать запрос: ${message}. Новые действия не выполнены. Повторите запрос.`
                  : `Не удалось обработать отчёт: ${message}. Откройте CRM для повторной попытки.`,
            });
          else if (rows.length && !failed)
            await this.reports.processing.stage(
              report.source_key,
              'Повторю обработку через несколько секунд…',
              tx,
            );
        });
      } finally {
        // Covers cancellation, revoked access and commands that do not enqueue a reply.
        // A routed letter keeps the same source key until its own result is ready.
        await this.db.transaction(async (tx) => {
          const [active] = await tx.query(
            `SELECT id FROM reports WHERE source_key=$1 AND status IN ('queued','processing')
             UNION ALL SELECT id FROM letter_jobs WHERE source_key=$1 AND status IN ('queued','processing','ready','sending')`,
            [report.source_key],
          );
          if (!active) await this.reports.processing.finish(tx, report.source_key);
        });
      }
      return true;
    };
    return this.reports.processing.run(report.source_key, () =>
      this.diagnostics
        ? this.diagnostics.run(
            {
              traceId: report.source_key,
              actorId: report.author_id,
              entityId: report.id,
              attempt: report.attempts,
            },
            process,
          )
        : process(),
    );
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
        let cleaning = !!message.processing_key;
        await this.diagnostics?.record(
          'notification.delivery.started',
          { outboxId: message.id },
          tx,
        );
        try {
          const current =
            !message.processing_key ||
            (await this.reports.processing.clear(
              tx,
              message.processing_key,
              this.telegram,
              message.processing_generation ?? undefined,
            ));
          cleaning = false;
          // A manual retry supersedes a queued failure notification from the prior attempt.
          if (current) await this.telegram.send(message.chat_id, message.payload);
          await tx.query('UPDATE outbox SET sent=true WHERE id=$1', [message.id]);
          await this.diagnostics?.record(
            current ? 'notification.delivery.completed' : 'notification.delivery.superseded',
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
              terminal: !cleaning && message.attempts + 1 >= 5,
              phase: cleaning ? 'processing_cleanup' : 'result',
            },
            tx,
          );
          await tx.query(
            `UPDATE outbox SET attempts=attempts+$2,available_at=now()+interval '30 seconds' WHERE id=$1`,
            [message.id, cleaning ? 0 : 1],
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
    const statusFailure = await this.reports.processing.deliverOne(this.telegram);
    if (statusFailure)
      await new ErrorLog(this.db).record(statusFailure.error, {
        event: 'telegram.processing_status_failed',
        entityId: statusFailure.key,
      });
  }
}
