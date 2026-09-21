import { randomUUID } from 'node:crypto';
import { Sql } from './database';
import { DomainError } from '../domain/errors';

export interface ErrorContext {
  event: string;
  requestId?: string;
  actorId?: string;
  status?: number;
  route?: string;
  entityId?: string;
  attempt?: number;
}

// Only application-authored DomainError messages are retained. External error
// messages, SQL, request bodies, headers and stack messages can contain secrets.
export class ErrorLog {
  private timer?: NodeJS.Timeout;
  private cleaning?: Promise<void>;
  constructor(private db: Sql) {}
  async record(error: unknown, context: ErrorContext) {
    const entry = {
      ...context,
      errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
      message:
        error instanceof DomainError
          ? error.message.slice(0, 1500)
          : 'Внутренняя ошибка; подробности скрыты для защиты данных',
    };
    try {
      await this.db.query(
        `INSERT INTO error_logs(id,event,request_id,actor_id,status,message,details)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          entry.event,
          entry.requestId || null,
          entry.actorId || null,
          entry.status ?? (error instanceof DomainError ? error.status : null),
          entry.message,
          JSON.stringify({
            errorType: entry.errorType,
            route: entry.route,
            entityId: entry.entityId,
            attempt: entry.attempt,
          }),
        ],
      );
    } catch {
      // Never recurse into the database when logging itself fails.
      console.error(JSON.stringify({ event: 'error_log.write_failed', original: entry }));
    }
  }
  async cleanup() {
    try {
      await this.db.query("DELETE FROM error_logs WHERE created_at < now() - interval '3 months'");
    } catch (error) {
      await this.record(error, { event: 'error_log.cleanup_failed' });
    }
  }
  start() {
    if (this.timer) return;
    const run = () => {
      if (!this.cleaning)
        this.cleaning = this.cleanup().finally(() => {
          this.cleaning = undefined;
        });
    };
    run();
    this.timer = setInterval(run, 60 * 60 * 1000);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.cleaning;
  }
}
