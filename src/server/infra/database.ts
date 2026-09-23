import { PGlite } from '@electric-sql/pglite';
import { Pool, PoolClient } from 'pg';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Config } from '../config';
export interface Sql {
  query<T = any>(sql: string, args?: any[]): Promise<T[]>;
}
export class Database implements Sql {
  private pool?: Pool;
  private embedded?: PGlite;
  constructor(private config: Config) {}
  async init() {
    if (this.config.databaseUrl)
      this.pool = new Pool({ connectionString: this.config.databaseUrl, max: 10 });
    else {
      await mkdir(this.config.dataDir, { recursive: true });
      this.embedded = new PGlite(join(this.config.dataDir, 'postgres'));
      await this.embedded.waitReady;
    }
    await this.migrate();
  }
  async migrate() {
    await this.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142501)');
      await tx.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const applied = await tx.query('SELECT version FROM schema_migrations WHERE version=1');
      if (!applied.length) {
        for (const statement of schema
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean))
          await tx.query(statement);
        await tx.query('INSERT INTO schema_migrations(version) VALUES(1)');
      }
      await tx.query(`CREATE TABLE IF NOT EXISTS csv_downloads (
        token_hash text PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename text NOT NULL,
        content text NOT NULL,
        expires_at timestamptz NOT NULL
      )`);
      await tx.query(`CREATE TABLE IF NOT EXISTS letter_signatures (
        user_id uuid PRIMARY KEY REFERENCES users(id), data jsonb NOT NULL
      )`);
      await tx.query(`CREATE TABLE IF NOT EXISTS letter_numbers (
        user_id uuid REFERENCES users(id), number integer NOT NULL,
        PRIMARY KEY(user_id,number)
      )`);
      const signaturesMigration = await tx.query(
        'SELECT version FROM schema_migrations WHERE version=2',
      );
      if (!signaturesMigration.length) {
        await tx.query('ALTER TABLE letter_signatures ADD COLUMN id uuid');
        await tx.query('UPDATE letter_signatures SET id=user_id');
        await tx.query('ALTER TABLE letter_signatures DROP CONSTRAINT letter_signatures_pkey');
        await tx.query('ALTER TABLE letter_signatures ADD PRIMARY KEY(id)');
        await tx.query('CREATE INDEX letter_signatures_user ON letter_signatures(user_id)');
        await tx.query('INSERT INTO schema_migrations(version) VALUES(2)');
      }
      await tx.query(`CREATE TABLE IF NOT EXISTS error_logs (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
        event text NOT NULL, request_id uuid, actor_id uuid, status integer,
        message text NOT NULL, details jsonb NOT NULL DEFAULT '{}'
      )`);
      await tx.query('CREATE INDEX IF NOT EXISTS error_logs_created_at ON error_logs(created_at)');
      await tx.query(`CREATE TABLE IF NOT EXISTS diagnostic_logs (
        seq bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        trace_id text NOT NULL, actor_id uuid, entity_id text, attempt integer,
        event text NOT NULL, details jsonb NOT NULL DEFAULT '{}'
      )`);
      await tx.query(
        'CREATE INDEX IF NOT EXISTS diagnostic_logs_trace ON diagnostic_logs(trace_id,seq)',
      );
      await tx.query(
        'CREATE INDEX IF NOT EXISTS diagnostic_logs_created ON diagnostic_logs(created_at)',
      );
      await tx.query('ALTER TABLE outbox ADD COLUMN IF NOT EXISTS trace_id text');
      await tx.query('ALTER TABLE outbox ADD COLUMN IF NOT EXISTS actor_id uuid');
      await tx.query('ALTER TABLE outbox ADD COLUMN IF NOT EXISTS processing_key text');
      await tx.query('ALTER TABLE outbox ADD COLUMN IF NOT EXISTS processing_generation integer');
      await tx.query(`CREATE TABLE IF NOT EXISTS processing_messages (
        source_key text PRIMARY KEY, chat_id text NOT NULL, text text NOT NULL,
        active boolean NOT NULL DEFAULT true, generation integer NOT NULL DEFAULT 1, message_id text, sent_text text,
        available_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await tx.query(
        'ALTER TABLE processing_messages ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1',
      );
      await tx.query(
        'CREATE INDEX IF NOT EXISTS processing_messages_pending ON processing_messages(available_at,updated_at) WHERE active OR message_id IS NOT NULL',
      );
      await tx.query(`CREATE TABLE IF NOT EXISTS file_downloads (
        token_hash text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_id uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL
      )`);
      await tx.query(
        'CREATE INDEX IF NOT EXISTS file_downloads_expiry ON file_downloads(expires_at)',
      );
      await tx.query(
        'ALTER TABLE letter_signatures ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false',
      );
      await tx.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS signature_default ON letter_signatures(user_id) WHERE is_default',
      );
      await tx.query(`CREATE TABLE IF NOT EXISTS letter_jobs (
        id uuid PRIMARY KEY, source_key text UNIQUE NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
        chat_id text NOT NULL, query text NOT NULL, signature_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
        lease_until timestamptz, lease_token uuid, available_at timestamptz NOT NULL DEFAULT now(),
        file_id uuid REFERENCES records(id), error text, created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await tx.query(
        'CREATE INDEX IF NOT EXISTS letter_jobs_queue ON letter_jobs(status,available_at)',
      );
      await tx.query(`CREATE TABLE IF NOT EXISTS signature_drafts (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
        report_id uuid UNIQUE NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        data jsonb NOT NULL, transcript text NOT NULL, status text NOT NULL DEFAULT 'pending',
        signature_id uuid, created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await tx.query('ALTER TABLE letter_jobs ALTER COLUMN signature_id DROP NOT NULL');
      await tx.query(
        "ALTER TABLE letter_jobs ADD COLUMN IF NOT EXISTS signature_options jsonb NOT NULL DEFAULT '[]'",
      );
      await tx.query(
        "ALTER TABLE signature_drafts ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'create'",
      );
      await tx.query('ALTER TABLE signature_drafts ADD COLUMN IF NOT EXISTS target_id uuid');
      await tx.query('ALTER TABLE signature_drafts ADD COLUMN IF NOT EXISTS base_data jsonb');
      await tx.query(
        "ALTER TABLE signature_drafts ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '[]'",
      );
      await tx.query(
        "ALTER TABLE reports ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'report'",
      );
      // Telegram dates have only second precision; UUID order must not reorder a dialogue.
      await tx.query('ALTER TABLE reports ADD COLUMN IF NOT EXISTS received_seq bigserial');
      await tx.query(`CREATE TABLE IF NOT EXISTS dialogue_state (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        company jsonb, revision integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await tx.query(`CREATE TABLE IF NOT EXISTS dialogue_actions (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
        report_id uuid NOT NULL REFERENCES reports(id), position integer NOT NULL,
        sequence bigserial UNIQUE, status text NOT NULL DEFAULT 'queued',
        payload jsonb NOT NULL, company jsonb, snapshot jsonb, options jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(report_id,position)
      )`);
      await tx.query(
        'CREATE INDEX IF NOT EXISTS dialogue_actions_user ON dialogue_actions(user_id,sequence)',
      );
      await tx.query(
        'ALTER TABLE dialogue_actions ADD COLUMN IF NOT EXISTS preview_version integer NOT NULL DEFAULT 0',
      );
    });
  }
  async query<T = any>(sql: string, args: any[] = []): Promise<T[]> {
    if (this.pool) return (await this.pool.query(sql, args)).rows;
    return (await this.embedded!.query<T>(sql, args)).rows;
  }
  async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    if (this.pool) {
      const client: PoolClient = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async (s, a) => (await client.query(s, a)).rows });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
    return this.embedded!.transaction(async (tx) =>
      fn({ query: async <R>(s: string, a?: any[]) => (await tx.query<R>(s, a)).rows }),
    );
  }
  async close() {
    await this.pool?.end();
    await this.embedded?.close();
  }
}
const schema = `
CREATE TABLE users (
 id uuid PRIMARY KEY, telegram_id text UNIQUE NOT NULL, name text NOT NULL,
 role text NOT NULL CHECK(role IN ('manager','supervisor','admin')), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE companies (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), data jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_inn ON companies ((data->>'inn')) WHERE data->>'inn' <> '';
CREATE INDEX companies_owner ON companies(owner_id);
CREATE TABLE records (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('contact','project','task','activity','file')),
 company_id uuid NOT NULL REFERENCES companies(id), project_id uuid REFERENCES records(id),
 author_id uuid NOT NULL REFERENCES users(id), assignee_id uuid REFERENCES users(id), data jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX records_company ON records(company_id,kind);
CREATE INDEX records_assignee ON records(assignee_id);
CREATE TABLE reports (
 id uuid PRIMARY KEY, author_id uuid NOT NULL REFERENCES users(id), source_key text UNIQUE NOT NULL,
 chat_id text, audio_file_id text, transcript text, draft jsonb,
 status text NOT NULL CHECK(status IN ('queued','processing','review','saved','cancelled','failed')) DEFAULT 'queued',
 version integer NOT NULL DEFAULT 1, attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token uuid, error text, result jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_queue ON reports(status,available_at);
CREATE TABLE audit (
 id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), company_id uuid REFERENCES companies(id),
 action text NOT NULL, entity_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_company ON audit(company_id,created_at);
CREATE TABLE outbox (
 id uuid PRIMARY KEY, chat_id text NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), sent boolean NOT NULL DEFAULT false
);
`;
