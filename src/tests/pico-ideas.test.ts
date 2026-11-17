import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { makeConfig } from '../server/config';
import { createApp } from '../server/http/app';

test('Pico feedback stores one idea and protects screenshot and both Telegram notifications', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-ideas-test-'));
  const { app, db, services } = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      DEV_AUTH: 'true',
      WORKER_ENABLED: 'false',
    }),
  );
  try {
    await db.migrate();
    const admin = (await services.auth.dev('admin', '127.0.0.1')).user;
    const manager = (await services.auth.dev('manager', '127.0.0.1')).user;
    await db.query('UPDATE users SET telegram_id=$2 WHERE id=$1', [manager.id, '71001811']);
    const access = services.auth.issue({ ...manager, telegramId: '71001811' });
    const adminAccess = services.auth.issue(admin);
    const http = request(app.getHttpServer());
    const submit = (id: string, text: string) =>
      http
        .post('/api/pico-ideas')
        .auth(access, { type: 'bearer' })
        .field('submissionId', id)
        .field('text', text)
        .field('topic', 'Главная');
    const idempotencyKey = randomUUID();
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mKUAAAAASUVORK5CYII=',
      'base64',
    );
    await submit(randomUUID(), '  ').expect(400);
    await submit(randomUUID(), 'Скриншот')
      .attach('screenshot', Buffer.from('invalid'), {
        filename: 'fake.png',
        contentType: 'image/png',
      })
      .expect(400);
    const idea = await submit(idempotencyKey, 'Быстрый переход')
      .attach('screenshot', image, { filename: 'capture.png', contentType: 'image/png' })
      .expect(201);
    await submit(idempotencyKey, 'Быстрый переход')
      .attach('screenshot', image, { filename: 'capture.png', contentType: 'image/png' })
      .expect(201, idea.body);
    await submit(idempotencyKey, 'Другой текст').expect(409);
    const path = `/api/pico-ideas/${idea.body.id}`;
    await http.get('/api/pico-ideas').expect(401);
    await http.get('/api/pico-ideas').auth(access, { type: 'bearer' }).expect(403);
    await http
      .get(path + '/screenshot')
      .auth(access, { type: 'bearer' })
      .expect(403);
    await http
      .post(path + '/implemented')
      .auth(access, { type: 'bearer' })
      .expect(403);
    const listing = await http
      .get('/api/pico-ideas')
      .auth(adminAccess, { type: 'bearer' })
      .expect(200);
    assert.equal(listing.body.length, 1);
    assert.equal(listing.body[0].text, 'Быстрый переход');
    assert.equal(listing.body[0].screenshotMime, 'image/png');
    const screenshot = await http
      .get(path + '/screenshot')
      .auth(adminAccess, { type: 'bearer' })
      .expect('Cache-Control', 'no-store')
      .expect(200);
    assert.deepEqual(screenshot.body, image);
    await http
      .post(path + '/implemented')
      .auth(adminAccess, { type: 'bearer' })
      .expect(201);
    await http
      .post(path + '/implemented')
      .auth(adminAccess, { type: 'bearer' })
      .expect(201);
    const queued = await db.query(
      'SELECT chat_id,payload FROM outbox WHERE actor_id=$1 ORDER BY available_at',
      [manager.id],
    );
    assert.deepEqual(
      queued.map((row) => [row.chat_id, row.payload.text]),
      [
        ['71001811', 'Спасибо за идею! Мы прочитаем её и ответим вам в боте.'],
        ['71001811', 'Ваша идея теперь в Pico'],
      ],
    );
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
