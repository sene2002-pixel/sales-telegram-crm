import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeConfig } from '../server/config';
import { redactSystemPayload, confidentialValues } from '../server/infra/system-confidentiality';
import { OpenAiAdapter } from '../server/infra/ai';
import { TelegramAdapter } from '../server/infra/telegram';
import { createApp } from '../server/http/app';

const secrets = {
  OPENAI_API_KEY: 'synthetic-openai-confidential-canary',
  BOT_TOKEN: 'synthetic-telegram-confidential-canary',
  SESSION_SECRET: 'synthetic-session-confidential-canary',
  TELEGRAM_WEBHOOK_SECRET: 'synthetic-webhook-confidential-canary',
};

test('public wire projection removes file storage fields without mutating storage or deal keys', () => {
  const config = makeConfig({
    ...secrets,
    DATABASE_URL: 'postgresql://user:synthetic-database-password@localhost/db',
  });
  const source = {
    file: {
      name: secrets.BOT_TOKEN,
      category: 'docs',
      size: 42,
      key: 'storage-id',
      privatePath: '/private/storage',
    },
    audit: {
      recordAfter: { data: { name: 'file', category: 'ref', size: 5, key: 'hidden-audit-key' } },
    },
    deal: { key: 'required-business-key', amount: 10 },
    date: new Date('2026-10-15T00:00:00Z'),
    nested: [null, true, { text: confidentialValues(config).join(' ') }],
  };
  const result = redactSystemPayload(source, config, true);
  assert.deepEqual(result.file, { name: '[REDACTED]', category: 'docs', size: 42 });
  assert.equal(result.audit.recordAfter.data.key, undefined);
  assert.equal(result.deal.key, source.deal.key);
  assert.equal(result.date, '2026-10-15T00:00:00.000Z');
  assert.equal(result.nested[0], null);
  for (const secret of confidentialValues(config))
    assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(source.file.key, 'storage-id');
  assert.equal(source.file.name, secrets.BOT_TOKEN);
});

test('real API JSON, audit, CSV and download filenames omit configured secrets and storage keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-confidentiality-'));
  const config = makeConfig({
    ...secrets,
    DATA_DIR: dir,
    DEV_AUTH: 'true',
    WORKER_ENABLED: 'false',
  });
  const { app, services, db } = await createApp(config);
  try {
    const login = await request(app.getHttpServer())
      .post('/api/auth/dev')
      .send({ role: 'admin' })
      .expect(201);
    const auth = `Bearer ${login.body.token}`;
    const company = await request(app.getHttpServer())
      .post('/api/companies')
      .set('Authorization', auth)
      .send({ name: secrets.OPENAI_API_KEY })
      .expect(201);
    assert.equal(company.body.name, '[REDACTED]');
    const file = await request(app.getHttpServer())
      .post(`/api/companies/${company.body.id}/files`)
      .set('Authorization', auth)
      .attach('file', Buffer.from('safe-file-content'), `${secrets.BOT_TOKEN}.txt`)
      .expect(201);
    assert.equal(file.body.data.key, undefined);
    const [stored] = await db.query('SELECT data FROM records WHERE id=$1', [file.body.id]);
    assert.equal(typeof stored.data.key, 'string');
    const detail = await request(app.getHttpServer())
      .get(`/api/companies/${company.body.id}`)
      .set('Authorization', auth)
      .expect(200);
    assert.ok(!JSON.stringify(detail.body).includes(stored.data.key));
    assert.ok(!JSON.stringify(detail.body).includes(secrets.OPENAI_API_KEY));
    assert.ok(detail.body.audit.some((event: any) => event.action === 'file.created'));
    const files = await request(app.getHttpServer())
      .get('/api/records/file')
      .set('Authorization', auth)
      .expect(200);
    assert.equal(files.body[0].data.key, undefined);
    const bytes = await request(app.getHttpServer())
      .get(`/api/files/${file.body.id}`)
      .set('Authorization', auth)
      .expect(200);
    assert.equal(bytes.body.toString(), 'safe-file-content');
    const filenameHeader = bytes.headers['content-disposition'];
    assert.ok(filenameHeader);
    assert.ok(!filenameHeader.includes(secrets.BOT_TOKEN));
    const link = await request(app.getHttpServer())
      .post(`/api/files/${file.body.id}/download-link`)
      .set('Authorization', auth)
      .expect(201);
    const capability = await request(app.getHttpServer()).get(link.body.path).expect(200);
    const capabilityHeader = capability.headers['content-disposition'];
    assert.ok(capabilityHeader);
    assert.ok(!capabilityHeader.includes(secrets.BOT_TOKEN));
    const csv = await request(app.getHttpServer())
      .get('/api/dashboard/export?from=2026-10-01&to=2026-10-31')
      .set('Authorization', auth)
      .expect(200);
    assert.ok(!csv.text.includes(secrets.OPENAI_API_KEY));
    await request(app.getHttpServer()).get(`/api/files/${file.body.id}`).expect(401);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('OpenAI and Telegram redact known credentials in payloads, preserving required transport credentials', async (t) => {
  const config = makeConfig(secrets);
  const captured: Array<{ url: string; options: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    captured.push({ url, options });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 }, status: 'completed' }),
      { status: 200 },
    );
  });
  const text = confidentialValues(config).join(' ');
  await new OpenAiAdapter(config).request(
    'responses',
    JSON.stringify({ input: { text }, store: false }),
  );
  const ai = captured.at(-1)!;
  assert.equal((ai.options.headers as any).Authorization, `Bearer ${config.apiKey}`);
  for (const secret of confidentialValues(config))
    assert.ok(!String(ai.options.body).includes(secret));
  const telegram = new TelegramAdapter(config);
  await telegram.call('setWebhook', {
    url: 'https://example.com/api/telegram/webhook',
    secret_token: config.webhookSecret,
    extra: text,
  });
  const webhook = JSON.parse(captured.at(-1)!.options.body as string);
  assert.equal(webhook.secret_token, config.webhookSecret);
  for (const secret of confidentialValues(config)) assert.ok(!webhook.extra.includes(secret));
  await telegram.call('sendMessage', { secret_token: config.webhookSecret });
  assert.equal(JSON.parse(captured.at(-1)!.options.body as string).secret_token, '[REDACTED]');
  await telegram.call('sendMessage', {
    chat_id: '123456',
    text,
    reply_markup: { inline_keyboard: [[{ text: 'ok', callback_data: 'safe-callback' }]] },
  });
  const message = captured.at(-1)!;
  assert.ok(message.url.includes(config.botToken));
  assert.equal(JSON.parse(message.options.body as string).chat_id, '123456');
  assert.equal(
    JSON.parse(message.options.body as string).reply_markup.inline_keyboard[0][0].callback_data,
    'safe-callback',
  );
  for (const secret of confidentialValues(config))
    assert.ok(!String(message.options.body).includes(secret));
  await telegram.sendDocument('123456', text, `${config.apiKey}.csv`);
  const csv = captured.at(-1)!.options.body as FormData;
  assert.equal((csv.get('document') as File).name, '[REDACTED].csv');
  assert.ok(!(await (csv.get('document') as Blob).text()).includes(config.apiKey));
  await telegram.sendPdf(
    '123456',
    Buffer.from('%PDF-synthetic'),
    `${config.apiKey}.pdf`,
    undefined,
    text,
  );
  const pdf = captured.at(-1)!.options.body as FormData;
  assert.equal((pdf.get('document') as File).name, '[REDACTED].pdf');
  for (const secret of confidentialValues(config))
    assert.ok(!String(pdf.get('caption')).includes(secret));
  assert.equal(await (pdf.get('document') as Blob).text(), '%PDF-synthetic');
  const shortSecretConfig = makeConfig({
    ...secrets,
    DATABASE_URL: 'postgresql://user:passw0rd@localhost/db',
  });
  await new TelegramAdapter(shortSecretConfig).sendPdf(
    '123456',
    Buffer.from('%PDF-synthetic'),
    'bounded.pdf',
    undefined,
    'passw0rd'.repeat(128),
  );
  const boundedCaption = String((captured.at(-1)!.options.body as FormData).get('caption'));
  assert.ok(boundedCaption.length <= 1024);
  assert.ok(!boundedCaption.includes('passw0rd'));
});

test('AI masking preserves typed binary image data while masking adjacent text and public data URLs', async (t) => {
  const config = makeConfig({
    ...secrets,
    DATABASE_URL: 'postgresql://user:AAAAEAAA@localhost/db',
  });
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHuUAAAAASUVORK5CYII=';
  assert.ok(image.includes('AAAAEAAA'));
  let captured: any;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    captured = JSON.parse(options.body as string);
    return new Response(JSON.stringify({ status: 'completed' }), { status: 200 });
  });
  await new OpenAiAdapter(config).request(
    'responses',
    JSON.stringify({
      input: [
        { type: 'input_text', text: 'AAAAEAAA' },
        { type: 'input_image', image_url: image },
      ],
    }),
  );
  assert.equal(captured.input[0].text, '[REDACTED]');
  assert.equal(captured.input[1].image_url, image);
  assert.ok(
    !redactSystemPayload(
      { type: 'input_image', image_url: image },
      config,
      true,
    ).image_url.includes('AAAAEAAA'),
  );
  assert.equal(
    redactSystemPayload(
      { type: 'input_image', image_url: 'https://example.com/AAAAEAAA' },
      config,
      false,
      true,
    ).image_url,
    'https://example.com/[REDACTED]',
  );
});
