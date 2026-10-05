import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimits } from '../server/infra/rate-limit';
import { makeConfig } from '../server/config';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';

test('rate windows isolate identities, report remaining seconds and reset at the boundary', () => {
  let now = 0;
  const limits = new RateLimits(() => now);
  assert.equal(limits.consume('user:a', 2), 0);
  assert.equal(limits.consume('user:a', 2), 0);
  now = 1500;
  assert.equal(limits.consume('user:a', 2), 59);
  assert.equal(limits.consume('user:b', 2), 0);
  now = 60000;
  assert.equal(limits.consume('user:a', 2), 0);
});
test('rate windows remain bounded without evicting active protection', () => {
  let now = 0;
  const limits = new RateLimits(() => now, 1);
  assert.equal(limits.consume('a', 1), 0);
  assert.equal(limits.consume('b', 1), 60);
  assert.equal(limits.consume('a', 1), 60);
  now = 60000;
  assert.equal(limits.consume('b', 1), 0);
});
test('rate configuration validates explicit limits', () => {
  assert.equal(makeConfig({}).apiUserLimit, 3000);
  assert.equal(makeConfig({}).apiIpLimit, 6000);
  for (const value of ['0', 'NaN', '-1', '1.5', '100001'])
    assert.throws(() => makeConfig({ API_RATE_LIMIT_PER_USER: value }));
});
test('HTTP limits use signed identities, preserve ACL and enforce separate IP and auth protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-limits-'));
  const { app, services, db } = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      WORKER_ENABLED: 'false',
      DATA_DIR: dir,
      API_RATE_LIMIT_PER_USER: '2',
      API_RATE_LIMIT_PER_IP: '10',
    }),
  );
  try {
    const manager = await services.auth.dev('manager', '127.0.0.1');
    const admin = await services.auth.dev('admin', '127.0.0.1');
    const http = request(app.getHttpServer());
    for (let i = 0; i < 2; i++)
      await http.get('/api/me').set('Authorization', `Bearer ${manager.token}`).expect(200);
    const rejected = await http
      .get('/api/me')
      .set('Authorization', `Bearer ${manager.token}`)
      .expect(429);
    assert.ok(Number(rejected.headers['retry-after']) >= 1);
    assert.equal(rejected.body.retryAfter, Number(rejected.headers['retry-after']));
    await http.get('/api/me').set('Authorization', `Bearer ${admin.token}`).expect(200);
    await http.get('/api/me').set('Authorization', `Bearer ${admin.token}forged`).expect(401);
    await db.query('UPDATE users SET active=false WHERE id=$1', [admin.user.id]);
    await http.get('/api/me').set('Authorization', `Bearer ${admin.token}`).expect(403);
    for (let i = 0; i < 4; i++) await http.get('/api/config').expect(200);
    await http.get('/api/config').expect(429);
    // Authentication has its own strict 30/minute budget, independent of API exhaustion.
    for (let i = 0; i < 30; i++)
      await http.post('/api/auth/dev').send({ role: 'invalid' }).expect(400);
    await http.post('/api/auth/dev').send({ role: 'invalid' }).expect(429);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
