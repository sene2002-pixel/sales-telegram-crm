import { AsyncLocalStorage } from 'node:async_hooks';
import { Database, Sql } from '../infra/database';
import { Messenger, ProcessingMessageUndeletable } from '../infra/telegram';

export function callbackTask(data: string): string | undefined {
  const [action, id] = data.split(':');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
  if (['da', 'dx', 'dr', 'dt', 'de', 'dp'].includes(action!)) return `dialogue:${id}`;
  if (['lp', 'lc', 'ly', 'ln', 'li', 'lz'].includes(action!)) return `letter:${id}`;
  if (['save', 'cancel'].includes(action!)) return `report:${id}`;
  if (['sc', 'sx', 'sp'].includes(action!)) return `signature:${id}`;
  if (['cc', 'cx', 'cp'].includes(action!)) return `report:${id}`;
}

export class TaskMessages {
  private context = new AsyncLocalStorage<string>();
  constructor(private db: Database) {}
  run<T>(key: string, fn: () => T): T {
    return this.context.run(key, fn);
  }
  keys(payload: any, source?: string) {
    const buttons = (payload?.reply_markup?.inline_keyboard || []).flat();
    const explicit = buttons.map((b: any) => callbackTask(b.callback_data || '')).filter(Boolean);
    return [
      ...new Set<string>(
        explicit.length
          ? explicit
          : this.context.getStore()
            ? [this.context.getStore()!]
            : source
              ? [`source:${source}`]
              : [],
      ),
    ];
  }
  async remember(
    tx: Sql,
    chatId: string,
    messageId: number | void,
    keys: string[],
    retainHours = 0,
  ) {
    if (!Number.isSafeInteger(messageId) || !messageId || !keys.length) return;
    await tx.query(
      "INSERT INTO task_messages(chat_id,message_id,task_keys,available_at) VALUES($1,$2,$3,now()+$4*interval '1 hour') ON CONFLICT DO NOTHING",
      [chatId, String(messageId), JSON.stringify(keys), retainHours],
    );
  }
  private async unfinished(tx: Sql, key: string): Promise<boolean> {
    const split = key.indexOf(':');
    const type = key.slice(0, split),
      id = key.slice(split + 1);
    if (type === 'source') {
      const jobs = await tx.query('SELECT id FROM letter_jobs WHERE source_key=$1', [id]);
      if (jobs.length) return this.unfinished(tx, `letter:${jobs[0].id}`);
      const reports = await tx.query('SELECT id FROM reports WHERE source_key=$1', [id]);
      if (reports.length) return this.unfinished(tx, `report:${reports[0].id}`);
      return true; // Unknown association is never a reason to delete.
    }
    if (type === 'report') {
      const signatures = await tx.query('SELECT status FROM signature_drafts WHERE report_id=$1', [
        id,
      ]);
      if (signatures.length)
        return signatures.some((s) => !['saved', 'cancelled'].includes(s.status));
      const actions = await tx.query('SELECT status FROM dialogue_actions WHERE report_id=$1', [
        id,
      ]);
      if (actions.length) return actions.some((a) => !['done', 'cancelled'].includes(a.status));
      const [report] = await tx.query('SELECT * FROM reports WHERE id=$1', [id]);
      if (report?.edit_action_id) return this.unfinished(tx, `dialogue:${report.edit_action_id}`);
      if (report?.status === 'failed') return !(await this.replacedBySuccess(tx, report));
      return !report || !['saved', 'cancelled'].includes(report.status);
    }
    const tables: Record<string, string> = {
      dialogue: 'dialogue_actions',
      letter: 'letter_jobs',
      signature: 'signature_drafts',
    };
    if (!tables[type]) return true;
    const [row] = await tx.query(`SELECT status FROM ${tables[type]} WHERE id=$1`, [id]);
    return (
      !row || !['done', 'cancelled', 'sent', 'saved', 'confirmed', 'discarded'].includes(row.status)
    );
  }
  /** A later successful original request retires all earlier terminal failures. */
  private async replacedBySuccess(tx: Sql, failed: any): Promise<boolean> {
    const candidates = await tx.query(
      `SELECT * FROM reports WHERE author_id=$1 AND chat_id=$2 AND received_seq>$3
       AND edit_action_id IS NULL AND status IN ('saved','cancelled') ORDER BY received_seq`,
      [failed.author_id, failed.chat_id, failed.received_seq],
    );
    for (const next of candidates) if (await this.successfulRequest(tx, next)) return true;
    return false;
  }
  private async successfulRequest(tx: Sql, next: any): Promise<boolean> {
    const actions = await tx.query('SELECT status FROM dialogue_actions WHERE report_id=$1', [
      next.id,
    ]);
    if (actions.length) return actions.every((a) => a.status === 'done');
    const signatures = await tx.query('SELECT status FROM signature_drafts WHERE report_id=$1', [
      next.id,
    ]);
    if (signatures.length) return signatures.every((s) => s.status === 'saved');
    const jobs = await tx.query('SELECT status FROM letter_jobs WHERE source_key=$1', [
      next.source_key,
    ]);
    if (jobs.length) return jobs.every((j) => j.status === 'sent');
    return next.status === 'saved';
  }
  async cleanup(messenger: Messenger) {
    if (!messenger.deleteProcessing) return;
    await this.db.transaction(async (tx) => {
      const rows = await tx.query(
        "SELECT * FROM task_messages WHERE state='pending' AND available_at<=now() ORDER BY available_at LIMIT 30 FOR UPDATE SKIP LOCKED",
      );
      for (const row of rows) {
        let active = false;
        for (const key of row.task_keys)
          if (await this.unfinished(tx, key)) {
            active = true;
            break;
          }
        if (active) {
          await tx.query(
            "UPDATE task_messages SET available_at=now()+interval '5 seconds' WHERE chat_id=$1 AND message_id=$2",
            [row.chat_id, row.message_id],
          );
          continue;
        }
        try {
          await messenger.deleteProcessing!(row.chat_id, row.message_id);
          await tx.query('DELETE FROM task_messages WHERE chat_id=$1 AND message_id=$2', [
            row.chat_id,
            row.message_id,
          ]);
        } catch (error) {
          await tx.query(
            "UPDATE task_messages SET state=$3,attempts=attempts+1,available_at=now()+interval '30 seconds' WHERE chat_id=$1 AND message_id=$2",
            [
              row.chat_id,
              row.message_id,
              error instanceof ProcessingMessageUndeletable ? 'undeletable' : 'pending',
            ],
          );
          if (!(error instanceof ProcessingMessageUndeletable)) break;
        }
      }
    });
  }
}
