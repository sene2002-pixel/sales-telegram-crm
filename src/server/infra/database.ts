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
