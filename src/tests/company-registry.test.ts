import test from 'node:test';
import assert from 'node:assert/strict';
import { SabyRegistry, cachedRegistry } from '../server/services/company-registry';
const inn = '7707083893';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const record = {
  inn,
  company_short_name: 'ООО «Пример»',
  company_name: 'Пример, ООО',
  main_okved: '62.01',
  address_legal: '123456, г. Москва, ул. Примерная, д. 1',
  director_name: 'PERSONAL-DO-NOT-RETURN',
  director_inn: 'PERSONAL-DO-NOT-RETURN',
};

test('Saby projects only documented business fields and binds exact INN', async () => {
  const calls: [string, RequestInit][] = [];
  const registry = new SabyRegistry({
    accessToken: 'synthetic-test-token',
    fetch: (async (url, init) => {
      calls.push([String(url), init!]);
      return json([record]);
    }) as typeof fetch,
  });
  assert.deepEqual(await registry.lookup(inn), {
    name: 'ООО «Пример»',
    registrationCity: 'Москва',
    okved: '62.01',
    legalForm: 'ООО',
  });
  assert.equal(calls[0]![0], `https://api.sbis.ru/vok/req?inn=${inn}`);
  assert.equal(
    (calls[0]![1].headers as Record<string, string>)['X-SBISAccessToken'],
    'synthetic-test-token',
  );
  assert.equal(calls[0]![1].redirect, 'error');
  assert.ok(calls[0]![1].signal instanceof AbortSignal);
  const different = new SabyRegistry({
    accessToken: 'test',
    fetch: (async () => json([{ ...record, inn: 'wrong' }])) as typeof fetch,
  });
  assert.equal(await different.lookup(inn), null);
});

test('Saby service authorization uses documented credentials and token response', async () => {
  const calls: [string, RequestInit][] = [];
  const registry = new SabyRegistry({
    clientId: 'client',
    clientSecret: 'secret',
    serviceKey: 'service',
    fetch: (async (url, init) => {
      calls.push([String(url), init!]);
      return calls.length === 1 ? json({ token: 'synthetic-token' }) : json([record]);
    }) as typeof fetch,
  });
  assert.ok(await registry.lookup(inn));
  assert.equal(calls[0]![0], 'https://online.sbis.ru/oauth/service/');
  assert.deepEqual(JSON.parse(calls[0]![1].body as string), {
    app_client_id: 'client',
    app_secret: 'secret',
    secret_key: 'service',
  });
  assert.equal(
    (calls[1]![1].headers as Record<string, string>)['X-SBISAccessToken'],
    'synthetic-token',
  );
});

test('disabled and invalid INNs make no request; 4xx are not retried; transient failures retry once', async () => {
  let calls = 0;
  const http = (async () => {
    calls++;
    return json(null, 401);
  }) as typeof fetch;
  assert.equal(await new SabyRegistry({ fetch: http }).lookup(inn), null);
  assert.equal(await new SabyRegistry({ accessToken: 'test', fetch: http }).lookup('bad'), null);
  assert.equal(calls, 0);
  assert.equal(await new SabyRegistry({ accessToken: 'test', fetch: http }).lookup(inn), null);
  assert.equal(calls, 1);
  calls = 0;
  const retry = new SabyRegistry({
    accessToken: 'test',
    fetch: (async () => {
      calls++;
      if (calls === 1) throw new Error('network');
      return json([record]);
    }) as typeof fetch,
  });
  assert.ok(await retry.lookup(inn));
  assert.equal(calls, 2);
  calls = 0;
  assert.equal(
    await new SabyRegistry({
      accessToken: 'test',
      fetch: (async () => {
        calls++;
        return json(null, 503);
      }) as typeof fetch,
    }).lookup(inn),
    null,
  );
  assert.equal(calls, 2);
});

test('oversized, malformed and ambiguous replies fail safely without body persistence', async () => {
  const bodies = [
    () => new Response('x', { headers: { 'Content-Length': String(1024 * 1024 + 1) } }),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => new Response('not-json'),
    () => json([record, record]),
    () => json({ error: 'PRIVATE-PROVIDER-ERROR' }),
  ];
  for (const body of bodies) {
    let count = 0;
    const result = await new SabyRegistry({
      accessToken: 'test',
      fetch: (async () => {
        count++;
        return body();
      }) as typeof fetch,
    }).lookup(inn);
    assert.equal(result, null);
    assert.equal(count, 1);
  }
});

test('official parsed-address string supports federal city but never guesses from arbitrary region', async () => {
  const response = {
    ...record,
    address_legal: undefined,
    parsed_address: JSON.stringify({ RegionName: 'Г.МОСКВА', StreetName: 'PRIVATE' }),
  };
  const registry = new SabyRegistry({
    accessToken: 'test',
    fetch: (async () => json([response])) as typeof fetch,
  });
  assert.equal((await registry.lookup(inn))?.registrationCity, 'МОСКВА');
  response.parsed_address = JSON.stringify({ RegionName: 'Московская область' });
  assert.equal((await registry.lookup(inn))?.registrationCity, undefined);
});

test('per-import cache shares one in-flight lookup and returns isolated minimal copies', async () => {
  let count = 0;
  const cache = cachedRegistry({
    lookup: async () => {
      count++;
      return { name: 'Company' };
    },
  });
  const [a, b] = await Promise.all([cache.lookup(inn), cache.lookup(inn)]);
  assert.equal(count, 1);
  a!.name = 'changed';
  assert.equal(b!.name, 'Company');
});

test('one short authentication cache shares pending login across rows and later lookups', async () => {
  let logins = 0,
    requests = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = new SabyRegistry({
    clientId: 'client',
    clientSecret: 'secret',
    serviceKey: 'service',
    fetch: (async (url) => {
      if (String(url).includes('/oauth/')) {
        logins++;
        await waiting;
        return json({ token: 'cached-auth' });
      }
      requests++;
      return json([{ ...record, inn: new URL(String(url)).searchParams.get('inn') }]);
    }) as typeof fetch,
  });
  const first = registry.lookup(inn),
    second = registry.lookup('7712040126');
  release();
  assert.ok(await first);
  assert.ok(await second);
  assert.ok(await registry.lookup(inn));
  assert.equal(logins, 1);
  assert.equal(requests, 3);
});

test('caller budget aborts auth and body reads and prevents retries or subsequent lookup', async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  const disabled = new SabyRegistry({
    accessToken: 'test',
    fetch: (async () => {
      calls++;
      return json([record]);
    }) as typeof fetch,
  });
  assert.equal(await disabled.lookup(inn, before.signal), null);
  assert.equal(calls, 0);
  const authBudget = new AbortController();
  const auth = new SabyRegistry({
    clientId: 'client',
    clientSecret: 'secret',
    serviceKey: 'service',
    fetch: (async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        queueMicrotask(() => authBudget.abort());
      });
    }) as typeof fetch,
  });
  assert.equal(await auth.lookup(inn, authBudget.signal), null);
  assert.equal(calls, 1);
  const bodyBudget = new AbortController();
  calls = 0;
  const body = new SabyRegistry({
    accessToken: 'test',
    fetch: (async (_url, init) => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), {
              once: true,
            });
            queueMicrotask(() => bodyBudget.abort());
          },
        }),
      );
    }) as typeof fetch,
  });
  assert.equal(await body.lookup(inn, bodyBudget.signal), null);
  assert.equal(calls, 1);
});
