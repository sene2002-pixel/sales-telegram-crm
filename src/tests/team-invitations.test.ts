import { BotService } from '../server/services/bot';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig } from '../server/config';
import { Database } from '../server/infra/database';
import { AuthService } from '../server/services/auth';
import { TeamInvitations } from '../server/services/team-invitations';

test('team invitations preserve scoped roles, hash tokens, atomically redeem and revoke', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'team-invite-'));
  const config = makeConfig({
    NODE_ENV: 'test',
    DEV_AUTH: 'true',
    DATA_DIR: dir,
    DATABASE_URL: '',
    BOT_TOKEN: '',
    OPENAI_API_KEY: '',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  });
  const db = new Database(config);
  await db.init();
  try {
    const auth = new AuthService(db, config),
      svc = new TeamInvitations(db);
    const admin = (await auth.dev('admin', '127.0.0.1')).user;
    const leader = (await auth.dev('supervisor', '127.0.0.1')).user;
    const manager = (await auth.dev('manager', '127.0.0.1')).user;
    await assert.rejects(svc.create(manager, {}, 'PicoSalesBot'), /Приглашать/);
    await assert.rejects(svc.create(admin, {}, 'PicoSalesBot'), /руководителя/);
    await assert.rejects(svc.create(leader, { supervisorId: admin.id }, 'PicoSalesBot'), /свою/);
    const invitation = await svc.create(leader, {}, 'PicoSalesBot');
    const token = new URL(invitation.url).searchParams.get('start')!.slice(7);
    const rows = await svc.list(leader);
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(token));
    const [stored] = await db.query('SELECT * FROM team_invitations WHERE id=$1', [invitation.id]);
    assert.notEqual(stored.token_hash, token);
    const results = await Promise.allSettled([
      svc.redeem(token, '991001', 'First'),
      svc.redeem(token, '991002', 'Second'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const [user] = await db.query("SELECT * FROM users WHERE telegram_id IN ('991001','991002')");
    assert.equal(user.role, 'manager');
    assert.equal(user.supervisor_id, leader.id);
    assert.equal((await svc.redeem(token, user.telegram_id, 'Ignored')).alreadyJoined, true);
    const other = await svc.create(admin, { supervisorId: leader.id }, 'PicoSalesBot');
    await assert.rejects(svc.revoke(leader, other.id), /не найдено/);
    await svc.revoke(admin, other.id);
    await assert.rejects(
      svc.redeem(new URL(other.url).searchParams.get('start')!.slice(7), '991003', 'Third'),
      /истекло/,
    );
    const existing = await svc.create(leader, {}, 'PicoSalesBot');
    const existingToken = new URL(existing.url).searchParams.get('start')!.slice(7);
    await assert.rejects(svc.redeem(existingToken, user.telegram_id, 'Changed'), /уже добавлены/);
    const [unchanged] = await db.query('SELECT name,supervisor_id FROM users WHERE id=$1', [
      user.id,
    ]);
    assert.equal(unchanged.name, user.name);
    assert.equal(unchanged.supervisor_id, leader.id);
    await db.query('UPDATE users SET active=false WHERE id=$1', [user.id]);
    await assert.rejects(svc.redeem(existingToken, user.telegram_id, 'Blocked'), /уже добавлены/);
    const [blocked] = await db.query('SELECT active,supervisor_id FROM users WHERE id=$1', [
      user.id,
    ]);
    assert.equal(blocked.active, false);
    assert.equal(blocked.supervisor_id, leader.id);
    const downgraded = await svc.create(admin, { supervisorId: leader.id }, 'PicoSalesBot');
    await db.query("UPDATE users SET role='manager' WHERE id=$1", [admin.id]);
    await assert.rejects(
      svc.redeem(new URL(downgraded.url).searchParams.get('start')!.slice(7), '991006', 'No'),
      /не действует/,
    );
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
    const auditRows = await db.query('SELECT * FROM audit');
    assert.ok(!JSON.stringify(auditRows).includes(token));
    assert.ok(!JSON.stringify(await db.query('SELECT * FROM team_invitations')).includes(token));
    const rollbackInvite = await svc.create(leader, {}, 'PicoSalesBot');
    const rollbackToken = new URL(rollbackInvite.url).searchParams.get('start')!.slice(7);
    const faultDb = {
      transaction: (fn: any) =>
        db.transaction((tx) =>
          fn({
            query: (sql: string, args: any[]) => {
              if (sql.startsWith('UPDATE team_invitations SET used_at'))
                throw new Error('injected consume failure');
              return tx.query(sql, args);
            },
          }),
        ),
    };
    await assert.rejects(
      new TeamInvitations(faultDb as any).redeem(rollbackToken, '991007', 'Retry'),
      /injected/,
    );
    assert.equal((await db.query("SELECT id FROM users WHERE telegram_id='991007'")).length, 0);
    assert.equal(
      (await db.query('SELECT used_at FROM team_invitations WHERE id=$1', [rollbackInvite.id]))[0]
        .used_at,
      null,
    );
    assert.equal((await svc.redeem(rollbackToken, '991007', 'Retry')).alreadyJoined, false);
    const limited = await svc.create(leader, {}, 'PicoSalesBot');
    await db.query("UPDATE team_invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [
      limited.id,
    ]);
    await assert.rejects(
      svc.redeem(new URL(limited.url).searchParams.get('start')!.slice(7), '991005', 'Expired'),
      /истекло/,
    );
    for (let i = 0; i < 19; i++) {
      try {
        await svc.create(leader, {}, 'PicoSalesBot');
      } catch (error) {
        assert.match(String(error), /лимит/);
      }
    }
    await assert.rejects(svc.create(leader, {}, 'PicoSalesBot'), /лимит/);
    assert.ok((await svc.list(admin)).some((row: any) => row.id === invitation.id));
    await db.query('UPDATE users SET active=false WHERE id=$1', [leader.id]);
    await assert.rejects(svc.redeem(existingToken, '991004', 'Fourth'), /не действует/);
    await assert.rejects(svc.list(leader), /Приглашать/);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('invitation start authorizes unknown private sender without leaking payload or invoking AI', async () => {
  const events: any[] = [];
  const sends: any[] = [];
  const redeemed: any[] = [];
  const diagnostics = {
    record: async (event: string, details: unknown) => events.push({ event, details }),
    run: async (_context: unknown, fn: () => unknown) => fn(),
  };
  const telegram = {
    send: async (_id: string, payload: unknown) => sends.push(payload),
    appButton: () => ({ inline_keyboard: [] }),
  };
  const invitations = {
    redeem: async (...args: unknown[]) => {
      redeemed.push(args);
      return { alreadyJoined: false };
    },
  };
  const auth = {
    byTelegram: () => {
      throw new Error('ordinary auth must not run before invitation');
    },
  };
  const bot = new BotService(
    makeConfig({}),
    auth as any,
    {} as any,
    {} as any,
    telegram as any,
    undefined,
    undefined,
    diagnostics as any,
    undefined,
    undefined,
    undefined,
    invitations as any,
  );
  const token = 'a'.repeat(43);
  const update = (type: string, id = 1) => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      from: { id: 1, first_name: 'New' },
      chat: { id, type },
      text: '/start invite_' + token,
    },
  });
  await bot.handle(update('group'));
  await bot.handle(update('private', 2));
  assert.equal(redeemed.length, 0);
  await bot.handle(update('private'));
  assert.deepEqual(redeemed, [[token, '1', 'New']]);
  assert.equal(sends.length, 1);
  assert.ok(!JSON.stringify(events).includes(token));
});
