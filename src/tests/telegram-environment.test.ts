import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeConfig } from '../server/config';
import { TelegramAdapter } from '../server/infra/telegram';

test('Stars checkout requires an absolute HTTPS terms URL without credentials', () => {
  const env = {
    PICO_STARS_ENABLED: 'true',
    PICO_STARS_SUPPORT_USERNAME: 'PicoSupport',
    BOT_TOKEN: 'fixture',
    TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(32),
  };
  assert.equal(makeConfig({}).picoStarsTermsUrl, '');
  for (const value of [
    '',
    '/terms',
    'http://example.test/terms',
    'https:/terms',
    'https://user:pass@example.test/terms',
  ]) {
    assert.throws(
      () => makeConfig({ ...env, PICO_STARS_TERMS_URL: value }),
      /PICO_STARS_TERMS_URL/,
    );
  }
  const terms = 'https://example.test/pico/terms/v1';
  assert.equal(makeConfig({ ...env, PICO_STARS_TERMS_URL: terms }).picoStarsTermsUrl, terms);
});

test('a mistyped environment or a route embedded in the token prevents startup', () => {
  assert.throws(
    () => makeConfig({ TELEGRAM_API_ENVIRONMENT: 'sandbox' }),
    /TELEGRAM_API_ENVIRONMENT/,
  );
  assert.throws(() => makeConfig({ BOT_TOKEN: 'test-only/test' }), /BOT_TOKEN/);
});

for (const environment of ['production', 'test']) {
  test(`all Telegram requests use the selected ${environment} route`, async (t) => {
    const config = makeConfig({
      BOT_TOKEN: 'test-only',
      ...(environment === 'test' && { TELEGRAM_API_ENVIRONMENT: 'test' }),
    });
    const adapter = new TelegramAdapter(config);
    const requests: string[] = [];
    const error = { ok: false, error_code: 403, description: 'fixture' };
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      requests.push(url);
      if (url.endsWith('/getFile'))
        return Response.json({ ok: true, result: { file_size: 3, file_path: 'voice/file.ogg' } });
      if (url.endsWith('.ogg')) return new Response('ogg');
      if (url.endsWith('/answerPreCheckoutQuery')) return Response.json(error, { status: 403 });
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    await adapter.call('getMe', {});
    await adapter.sendDocument('1', 'report', 'report.csv');
    await adapter.sendPdf('1', Buffer.from('%PDF-fixture'), 'report.pdf');
    await adapter.sendImportTemplate('1', Buffer.from('fixture'), 'template');
    assert.equal((await adapter.download('file')).toString(), 'ogg');
    await assert.rejects(adapter.call('answerPreCheckoutQuery', {}), { status: 502 });
    const suffix = environment === 'test' ? 'test/' : '';
    const methodBase = 'https://api.telegram.org/bottest-only/' + suffix;
    assert.equal(config.botToken, 'test-only');
    assert.deepEqual(requests, [
      methodBase + 'getMe',
      methodBase + 'sendDocument',
      methodBase + 'sendDocument',
      methodBase + 'sendDocument',
      methodBase + 'getFile',
      'https://api.telegram.org/file/bottest-only/' + suffix + 'voice/file.ogg',
      methodBase + 'answerPreCheckoutQuery',
    ]);
  });
}
