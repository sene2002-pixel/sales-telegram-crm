import { AsyncLocalStorage } from 'node:async_hooks';
import { Database, Sql } from './database';
import { Messenger, ProcessingMessageUndeletable } from './telegram';
import { ErrorLog } from './error-log';

// Context only propagates the durable key; message IDs and delivery state live in SQL.
export class ProcessingStatus {
  private context = new AsyncLocalStorage<string>();
  constructor(private db: Database) {}
  get key() {
    return this.context.getStore();
  }
  run<T>(key: string, fn: () => Promise<T>) {
    return this.context.run(key, fn);
  }
  async begin(tx: Sql, key: string, chatId: string, text: string) {
    await tx.query(
      `INSERT INTO processing_messages(source_key,chat_id,text) VALUES($1,$2,$3)
       ON CONFLICT(source_key) DO UPDATE SET active=true,text=$3,available_at=now(),updated_at=now(),
       generation=processing_messages.generation + CASE WHEN processing_messages.active THEN 0 ELSE 1 END`,
      [key, chatId, text],
    );
  }
  async stage(key: string, text: string, tx: Sql = this.db) {
    // A cancelled/completed job must not be resurrected by a slow previous attempt.
    await tx.query(
      'UPDATE processing_messages SET text=$2,available_at=now(),updated_at=now() WHERE source_key=$1 AND active',
      [key, text],
    );
  }
  async finish(tx: Sql, key: string) {
    const [row] = await tx.query(
      'UPDATE processing_messages SET active=false,available_at=now(),updated_at=now() WHERE source_key=$1 RETURNING generation',
      [key],
    );
    return row?.generation as number | undefined;
  }
  async clear(tx: Sql, key: string, telegram: Messenger, generation?: number) {
    const [row] = await tx.query(
      'SELECT * FROM processing_messages WHERE source_key=$1 FOR UPDATE',
      [key],
    );
    if (row && generation !== undefined && generation !== row.generation) return false;
    if (row?.message_id) {
      if (!telegram.deleteProcessing) throw new Error('Messenger cannot remove processing status');
      try {
        await telegram.deleteProcessing(row.chat_id, row.message_id);
      } catch (error) {
        if (!(error instanceof ProcessingMessageUndeletable)) throw error;
        // Telegram can permanently forbid deletion (e.g. old messages). Keep
        // an explicit diagnostic instead of silently claiming successful removal,
        // but do not suppress the actual result forever for a cosmetic cleanup.
        await new ErrorLog(tx).record(error, {
          event: 'telegram.processing_delete_forbidden',
          entityId: `${key}:${row.message_id}`,
        });
      }
      await tx.query(
        'UPDATE processing_messages SET message_id=NULL,sent_text=NULL WHERE source_key=$1',
        [key],
      );
    }
    return true;
  }
  async deliverOne(telegram: Messenger) {
    if (!telegram.sendProcessing || !telegram.editProcessing || !telegram.deleteProcessing) return;
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        `SELECT * FROM processing_messages WHERE available_at<=now() AND
         ((active AND (message_id IS NULL OR text IS DISTINCT FROM sent_text)) OR
          (NOT active AND message_id IS NOT NULL))
         ORDER BY active,updated_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!row) return;
      try {
        if (!row.active) {
          await this.clear(tx, row.source_key, telegram);
        } else if (!row.message_id) {
          const id = await telegram.sendProcessing!(row.chat_id, row.text);
          await tx.query(
            'UPDATE processing_messages SET message_id=$2,sent_text=$3 WHERE source_key=$1',
            [row.source_key, String(id), row.text],
          );
        } else {
          const exists = await telegram.editProcessing!(row.chat_id, row.message_id, row.text);
          await tx.query(
            'UPDATE processing_messages SET message_id=$2,sent_text=$3 WHERE source_key=$1',
            [row.source_key, exists ? row.message_id : null, exists ? row.text : null],
          );
        }
      } catch (error) {
        // Status failures never consume the report/letter retry budget. Retain IDs for cleanup.
        await tx.query(
          "UPDATE processing_messages SET available_at=now()+interval '30 seconds' WHERE source_key=$1",
          [row.source_key],
        );
        return { error, key: row.source_key };
      }
    });
  }
}
