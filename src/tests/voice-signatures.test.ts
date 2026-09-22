import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor } from '../shared/contracts';
import { ReportWorker } from '../server/services/worker';
import { isSignatureRequest } from '../server/services/voice-signatures';

test('voice signature intent does not capture reports about signatures', () => {
  assert.ok(isSignatureRequest('Добавь подпись. Иванов Иван'));
  assert.ok(isSignatureRequest('Создай мне новую подпись: Иванов Иван'));
  assert.equal(isSignatureRequest('Получил подпись директора на договоре'), false);
});

test('voice signature draft: review, ACL, edited save, idempotency, limit and discard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-voice-signature-'));
  const config = makeConfig({ DATA_DIR: dir });
  const { app, services: s, db } = await createApp(config);
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '12345',
    name: 'Test',
    role: 'manager',
    active: true,
  };
  const other: Actor = { ...actor, id: randomUUID(), telegramId: '99999', role: 'admin' };
  for (const u of [actor, other])
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      u.id,
      u.telegramId,
      u.name,
      u.role,
    ]);
  const recognized = {
    lastName: 'Иванов',
    firstName: 'Иван',
    patronymic: '',
    workPhone: '',
    mobilePhone: '',
    email: '',
  };
  let reportExtractions = 0;
  const worker = new ReportWorker(
    db,
    s.reports,
    { transcribe: async () => 'Добавь подпись. Иванов Иван, email неразборчиво' },
    {
      extract: async () => {
        reportExtractions++;
        throw new Error('should not extract report');
      },
    },
    { download: async () => new Uint8Array([1]), send: async () => {} },
    config,
    s.voiceSignatures,
  );
  s.letters.ai.request = async () => ({
    status: 'completed',
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(recognized) }] }],
  });
  const makeDraft = async (sourceKey: string) => {
    await s.reports.enqueue(actor, {
      sourceKey,
      chatId: actor.telegramId,
      audioFileId: 'voice',
      sentAt: new Date().toISOString(),
    });
    await worker.processOne();
    return (await s.voiceSignatures.list(actor))[0];
  };
  try {
    const draft = await makeDraft('voice:1');
    assert.equal(reportExtractions, 0);
    assert.deepEqual(draft.data, recognized);
    assert.equal((await s.letters.signatures(actor)).length, 0);
    assert.equal((await s.reports.list(actor)).length, 0);
    assert.equal((await s.voiceSignatures.list(other)).length, 0);
    const server = app.getHttpServer();
    await request(server).get('/api/me/signature-drafts').expect(401);
    await request(server)
      .post(`/api/me/signature-drafts/${draft.id}/save`)
      .set('Authorization', 'Bearer ' + s.auth.issue(other))
      .send(recognized)
      .expect(404);
    const edited = { ...recognized, email: 'verified@example.com' };
    const saved = await s.voiceSignatures.save(actor, draft.id, edited);
    assert.equal(saved.email, edited.email);
    const repeated = await s.voiceSignatures.save(actor, draft.id, edited);
    assert.equal(saved.id, repeated.id);
    assert.equal((await s.letters.signatures(actor)).length, 1);
    await s.letters.writeSignature(actor, recognized);
    await s.letters.writeSignature(actor, recognized);
    const second = await makeDraft('voice:2');
    await assert.rejects(s.voiceSignatures.save(actor, second.id, edited), /трёх подписей/);
    await assert.rejects(s.voiceSignatures.discard(other, second.id), /не найден/);
    await s.voiceSignatures.discard(actor, second.id);
    assert.equal((await s.voiceSignatures.list(actor)).length, 0);
    await s.reports.enqueue(actor, {
      sourceKey: 'voice:2',
      chatId: actor.telegramId,
      audioFileId: 'voice',
      sentAt: new Date().toISOString(),
    });
    await worker.processOne();
    assert.equal((await db.query('SELECT * FROM signature_drafts')).length, 2);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
