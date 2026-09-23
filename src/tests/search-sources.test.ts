import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observedSources, sourceKey } from '../server/services/search-sources';

test('URL identity normalizes host, default port, root slash and fragments only', () => {
  assert.equal(sourceKey('https://EXAMPLE.com:443#contacts'), sourceKey('https://example.com/'));
  for (const url of [
    'https://example.com/Company',
    'https://example.com/company/',
    'http://example.com/company',
    'https://www.example.com/company',
    'https://example.com/company?id=1',
    'https://example.com/company#/other',
  ])
    assert.notEqual(sourceKey(url), sourceKey('https://example.com/company'));
  for (const url of ['javascript:alert(1)', 'https://user:pass@example.com', 'invalid', null])
    assert.equal(sourceKey(url), null);
  assert.equal(
    observedSources([{ type: 'other', action: { sources: [{ url: 'https://fake.example' }] } }])
      .size,
    0,
  );
});
