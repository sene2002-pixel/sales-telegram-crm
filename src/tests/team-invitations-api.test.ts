import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp, Services } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor } from '../shared/contracts';
let app: any, db: any, services: Services, dir: string;
let admin: Actor, supervisor: Actor, manager: Actor, other: Actor;
let calls = 0;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pico-invite-api-'));
  const built = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      WORKER_ENABLED: 'false',
      DATA_DIR: dir,
      DATABASE_URL: '',
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
      SESSION_SECRET: 'test-invitations-session-secret-at-least32',
    }),
  );
  ({ app, db } = built);
  services = built.services;
  admin = (await services.auth.dev('admin', '127.0.0.1')).user;
  supervisor = (await services.auth.dev('supervisor', '127.0.0.1')).user;
  manager = (await services.auth.dev('manager', '127.0.0.1')).user;
  other = { ...supervisor, id: randomUUID(), telegramId: '770099001', name: 'Другая команда' };
  await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
    other.id,
    other.telegramId,
    other.name,
    other.role,
  ]);
  services.telegram.call = async (method: string) => {
    assert.equal(method, 'getMe');
    calls++;
    return { username: 'PicoSalesBot' };
  };
});
after(async () => {
  await app?.close();
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
function api(actor: Actor, method: 'get' | 'post', path: string, body?: object) {
  const req = request(app.getHttpServer())
    [method]('/api' + path)
    .set('Authorization', 'Bearer ' + services.auth.issue(actor));
  return body === undefined ? req : req.send(body);
}
test('HTTP ACL rejects managers before Telegram call and unauthenticated invitations', async () => {
  const before = calls;
  await api(manager, 'post', '/team-invitations', {}).expect(403);
  await api(manager, 'get', '/team-invitations').expect(403);
  await api(manager, 'post', `/team-invitations/${randomUUID()}/revoke`, {}).expect(403);
  await request(app.getHttpServer()).post('/api/team-invitations').send({}).expect(401);
  assert.equal(calls, before);
});
test('HTTP creation resolves current bot; teams are scoped and metadata never returns bearer link', async () => {
  const made = await api(supervisor, 'post', '/team-invitations', {}).expect(201);
  assert.match(made.body.url, /^https:\/\/t.me\/PicoSalesBot\?start=invite_[A-Za-z0-9_-]{43}$/);
  const own = await api(supervisor, 'get', '/team-invitations').expect(200);
  assert.ok(own.body.some((r: any) => r.id === made.body.id));
  assert.ok(!JSON.stringify(own.body).includes('invite_'));
  assert.ok(!JSON.stringify(own.body).includes('token_hash'));
  const foreign = await api(other, 'get', '/team-invitations').expect(200);
  assert.ok(!foreign.body.some((r: any) => r.id === made.body.id));
  await api(other, 'post', `/team-invitations/${made.body.id}/revoke`, {}).expect(404);
  await api(supervisor, 'post', '/team-invitations', { supervisorId: other.id }).expect(403);
  await api(supervisor, 'post', '/team-invitations', { role: 'admin' }).expect(400);
  await api(admin, 'post', `/team-invitations/${made.body.id}/revoke`, {}).expect(201);
});
test('admin chooses active supervisor, no default team and no arbitrary role', async () => {
  await api(admin, 'post', '/team-invitations', {}).expect(400);
  const made = await api(admin, 'post', '/team-invitations', { supervisorId: other.id }).expect(
    201,
  );
  assert.equal(made.body.supervisorId, other.id);
  const rows = await api(admin, 'get', '/team-invitations').expect(200);
  assert.ok(rows.body.some((r: any) => r.id === made.body.id));
  await api(admin, 'post', '/team-invitations', { supervisorId: manager.id }).expect(400);
});
