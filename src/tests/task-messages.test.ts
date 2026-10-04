import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor } from '../shared/contracts';
import { TaskMessages, callbackTask } from '../server/services/task-messages';
import { Messenger, ProcessingMessageUndeletable } from '../server/infra/telegram';

test('failed requests retire only after the next same-user request fully succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-failed-cleanup-'));
  const {
    app,
    services: s,
    db,
  } = await createApp(makeConfig({ DATA_DIR: dir, WORKER_ENABLED: 'false' }));
  try {
    for (const outcome of [
      'none',
      'queued',
      'failed',
      'cancelled',
      'saved',
      'group_pending',
      'group_cancelled',
      'group_done',
    ]) {
      const actor: Actor = {
        id: randomUUID(),
        telegramId: outcome,
        name: 'Test',
        role: 'manager',
        active: true,
      };
      await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
        actor.id,
        actor.telegramId,
        actor.name,
        actor.role,
      ]);
      const failed = await s.reports.enqueue(actor, {
        sourceKey: `failed:${outcome}`,
        chatId: outcome,
        messageId: 1,
        text: 'request',
        purpose: 'dialogue',
      });
      await db.query("UPDATE reports SET status='failed' WHERE id=$1", [failed.id]);
      await s.reports.messages.remember(db, outcome, 2, [`source:failed:${outcome}`]);
      if (outcome !== 'none') {
        const next = await s.reports.enqueue(actor, {
          sourceKey: `next:${outcome}`,
          chatId: outcome,
          text: 'next',
          purpose: 'dialogue',
        });
        await db.query('UPDATE reports SET status=$2 WHERE id=$1', [
          next.id,
          outcome.startsWith('group') ? 'cancelled' : outcome,
        ]);
        if (outcome.startsWith('group'))
          for (const position of [0, 1]) {
            await db.query(
              "INSERT INTO dialogue_actions(id,user_id,report_id,position,payload,status) VALUES($1,$2,$3,$4,'{}',$5)",
              [
                randomUUID(),
                actor.id,
                next.id,
                position,
                position === 0 || outcome === 'group_done'
                  ? 'done'
                  : outcome === 'group_cancelled'
                    ? 'cancelled'
                    : 'ready',
              ],
            );
          }
      }
    }
    const deleted: string[] = [];
    await new TaskMessages(db).cleanup({
      send: async () => {},
      download: async () => new Uint8Array(),
      deleteProcessing: async (chat, id) => {
        deleted.push(`${chat}:${id}`);
      },
    });
    assert.deepEqual(deleted.sort(), ['group_done:1', 'group_done:2', 'saved:1', 'saved:2']);
    assert.equal(
      (await db.query("SELECT status FROM reports WHERE source_key='failed:saved'"))[0].status,
      'failed',
    );
    // Later success clears the entire error chain, not just the immediate predecessor.
    const [user] = await db.query("SELECT id FROM users WHERE telegram_id='failed'");
    const actor: Actor = {
      id: user.id,
      telegramId: 'failed',
      name: 'Test',
      role: 'manager',
      active: true,
    };
    await s.reports.messages.remember(db, 'failed', 3, ['source:next:failed']);
    const success = await s.reports.enqueue(actor, {
      sourceKey: 'chain-success',
      chatId: 'failed',
      messageId: 4,
      text: 'valid request',
    });
    await db.query("UPDATE reports SET status='saved' WHERE id=$1", [success.id]);
    const newer = await s.reports.enqueue(actor, {
      sourceKey: 'newer-failure',
      chatId: 'failed',
      messageId: 5,
      text: 'bad request',
    });
    await db.query("UPDATE reports SET status='failed' WHERE id=$1", [newer.id]);
    await db.query('UPDATE task_messages SET available_at=now()');
    const cleared: string[] = [];
    await new TaskMessages(db).cleanup({
      send: async () => {},
      download: async () => new Uint8Array(),
      deleteProcessing: async (chat, id) => {
        cleared.push(`${chat}:${id}`);
      },
    });
    assert.deepEqual(cleared.sort(), ['failed:1', 'failed:2', 'failed:3', 'failed:4']);
    assert.ok(
      (await db.query("SELECT * FROM task_messages WHERE chat_id='failed' AND message_id='5'"))
        .length,
    );
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('task cleanup preserves unfinished and shared messages, survives restart and retries deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-task-messages-'));
  const {
    app,
    services: s,
    db,
  } = await createApp(makeConfig({ DATA_DIR: dir, WORKER_ENABLED: 'false' }));
  try {
    const actor: Actor = {
      id: randomUUID(),
      telegramId: '123',
      name: 'Test',
      role: 'manager',
      active: true,
    };
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.telegramId,
      actor.name,
      actor.role,
    ]);
    const report = await s.reports.enqueue(actor, {
      sourceKey: 'test-cleanup',
      chatId: '123',
      messageId: 3,
      purpose: 'dialogue',
      text: 'Две задачи',
    });
    const a = randomUUID(),
      b = randomUUID();
    for (const [position, id] of [a, b].entries())
      await db.query(
        "INSERT INTO dialogue_actions(id,user_id,report_id,position,payload,status) VALUES($1,$2,$3,$4,'{}','ready')",
        [id, actor.id, report.id, position],
      );
    const messages = s.reports.messages;
    assert.equal(callbackTask(`da:${a}:1`), `dialogue:${a}`);
    await messages.remember(db, '123', 1, [`dialogue:${a}`]);
    await messages.remember(db, '123', 2, [`dialogue:${b}`]);
    assert.deepEqual(
      (await db.query("SELECT task_keys FROM task_messages WHERE message_id='3'"))[0].task_keys,
      ['source:test-cleanup'],
    );
    const deleted: string[] = [];
    let failure = true;
    const messenger: Messenger = {
      send: async () => {},
      download: async () => new Uint8Array(),
      deleteProcessing: async (_chat, id) => {
        if (id === '1' && failure) throw new Error('network');
        deleted.push(id);
      },
    };
    await db.query("UPDATE dialogue_actions SET status='done' WHERE id=$1", [a]);
    await messages.cleanup(messenger);
    assert.deepEqual(deleted, []);
    assert.equal(
      (await db.query("SELECT attempts FROM task_messages WHERE message_id='1'"))[0].attempts,
      1,
    );
    failure = false;
    await db.query('UPDATE task_messages SET available_at=now()');
    await new TaskMessages(db).cleanup(messenger);
    assert.deepEqual(deleted, ['1']);
    await db.query("UPDATE dialogue_actions SET status='cancelled' WHERE id=$1", [b]);
    await db.query('UPDATE task_messages SET available_at=now()');
    await messages.cleanup(messenger);
    assert.deepEqual(deleted.sort(), ['1', '2', '3']);
    assert.equal((await db.query('SELECT * FROM task_messages')).length, 0);
    const job = randomUUID();
    await db.query(
      "INSERT INTO letter_jobs(id,source_key,user_id,chat_id,query,status) VALUES($1,'pdf-task',$2,'123','test','sent')",
      [job, actor.id],
    );
    await messages.remember(db, '123', 4, [`letter:${job}`], 24);
    const [deadline] = await db.query(
      "SELECT available_at FROM task_messages WHERE message_id='4'",
    );
    assert.ok(Math.abs(new Date(deadline.available_at).getTime() - Date.now() - 86400000) < 5000);
    await new TaskMessages(db).cleanup(messenger);
    assert.ok(!(deleted as string[]).includes('4'));
    await messages.remember(db, '123', 4, [`letter:${job}`], 24);
    assert.equal(
      new Date(
        (await db.query("SELECT available_at FROM task_messages WHERE message_id='4'"))[0]
          .available_at,
      ).getTime(),
      new Date(deadline.available_at).getTime(),
    );
    await db.query(
      "UPDATE task_messages SET available_at=now()-interval '1 second' WHERE message_id='4'",
    );
    await messages.cleanup(messenger);
    assert.ok((deleted as string[]).includes('4'));
    await messages.remember(db, '123', 5, [`dialogue:${a}`]);
    messenger.deleteProcessing = async () => {
      throw new ProcessingMessageUndeletable();
    };
    await messages.cleanup(messenger);
    assert.equal(
      (await db.query("SELECT state FROM task_messages WHERE message_id='5'"))[0].state,
      'undeletable',
    );
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
