import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Config } from '../config';
import { DomainError } from '../domain/errors';
import { Sql } from './database';

export interface DiagnosticContext {
  traceId: string;
  actorId?: string;
  entityId?: string;
  attempt?: number;
}

// DB-only, opt-in, deadline-bound tracing. Never dump provider bodies or credentials.
export class DiagnosticLog {
  private storage = new AsyncLocalStorage<DiagnosticContext>();
  constructor(
    private db: Sql,
    private config: Config,
  ) {}
  get enabled() {
    return Date.now() < this.config.diagnosticUntil;
  }
  get context() {
    return this.storage.getStore();
  }
  run<T>(context: DiagnosticContext, fn: () => Promise<T>): Promise<T> {
    return this.storage.run({ ...this.context, ...context }, fn);
  }
  private cleanString(value: string): string {
    let clean = value;
    for (const secret of [
      this.config.apiKey,
      this.config.botToken,
      this.config.webhookSecret,
      this.config.sessionSecret,
      this.config.databaseUrl,
    ])
      if (secret && secret.length >= 6) clean = clean.split(secret).join('[REDACTED]');
    const redactText = (text: string) =>
      text
        .replace(/Bearer\s+\S+|\bsk-[\w-]+|\b\d{6,}:[\w-]{20,}/gi, '[REDACTED]')
        .replace(
          /((?:api[_ -]?key|token|password|secret|пароль|токен|ключ)\s*[:=]\s*)\S+/gi,
          '$1[REDACTED]',
        )
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[EMAIL]')
        .replace(/\+\d[\d ()-]{8,}\d/g, '[PHONE]');
    const digest = (text: string) =>
      `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
    // Handle URLs separately so generic token/email masking cannot break parsing
    // or erase equality evidence for query parameters named token/password.
    clean = clean
      .split(/(https?:\/\/[^\s<>"']+)/gi)
      .map((part) => {
        if (!/^https?:\/\//i.test(part)) return redactText(part);
        try {
          const url = new URL(part);
          url.username = '';
          url.password = '';
          url.pathname = redactText(url.pathname);
          url.search = new URLSearchParams(
            [...url.searchParams].map(([key, val]) => [key, digest(val)]),
          ).toString();
          url.hash = url.hash ? digest(url.hash) : '';
          return url.href;
        } catch {
          return '[INVALID_URL]';
        }
      })
      .join('');
    return clean.slice(0, 4000);
  }
  private sanitize(value: unknown, depth = 0): unknown {
    if (depth > 6) return '[TRUNCATED]';
    if (typeof value === 'string') return this.cleanString(value);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.slice(0, 60).map((v) => this.sanitize(v, depth + 1));
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value).slice(0, 60)) {
        result[key.slice(0, 80)] =
          /token|password|secret|authorization|cookie|api.?key|raw.?body|signature.?lines|headers/i.test(
            key,
          )
            ? '[REDACTED]'
            : this.sanitize(val, depth + 1);
      }
      return result;
    }
    return undefined;
  }
  async record(event: string, details: Record<string, unknown> = {}, tx?: Sql) {
    if (!this.enabled) return;
    const context = this.context;
    const target = tx || this.db;
    const savepoint = `diag_${randomUUID().replace(/-/g, '')}`;
    let opened = false;
    try {
      let encoded = JSON.stringify(this.sanitize(details));
      if (Buffer.byteLength(encoded, 'utf8') > 32_000) {
        let preview = encoded.slice(0, 28_000);
        // Re-encoding the preview escapes quotes/backslashes again. Bound the
        // final UTF-8 payload, not only the number of input characters.
        do {
          encoded = JSON.stringify({ truncated: true, preview });
          preview = preview.slice(0, Math.floor(preview.length / 2));
        } while (Buffer.byteLength(encoded, 'utf8') > 32_000);
      }
      if (tx) {
        await tx.query(`SAVEPOINT ${savepoint}`);
        opened = true;
      }
      await target.query(
        'INSERT INTO diagnostic_logs(trace_id,actor_id,entity_id,attempt,event,details) VALUES($1,$2,$3,$4,$5,$6)',
        [
          this.cleanString(context?.traceId || 'system'),
          context?.actorId || null,
          context?.entityId ? this.cleanString(context.entityId) : null,
          context?.attempt ?? null,
          event.slice(0, 120),
          encoded,
        ],
      );
      if (opened) await tx!.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // Diagnostics must not abort business transactions, recurse, or spill into stdout.
      if (opened) {
        try {
          await tx!.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await tx!.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {}
      }
    }
  }
  async span<T>(event: string, details: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    await this.record(`${event}.started`, details);
    try {
      const result = await fn();
      await this.record(`${event}.completed`, { durationMs: Date.now() - started });
      return result;
    } catch (error) {
      await this.record(`${event}.failed`, {
        durationMs: Date.now() - started,
        errorType: error instanceof Error ? error.constructor.name : 'Unknown',
        status: error instanceof DomainError ? error.status : undefined,
        message: error instanceof DomainError ? error.message : undefined,
      });
      throw error;
    }
  }
}
