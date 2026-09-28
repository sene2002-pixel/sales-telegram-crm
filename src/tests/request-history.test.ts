import test from 'node:test';
import assert from 'node:assert/strict';
import { requestsConflict } from '../server/services/request-history';

test('request dependencies serialize chains and shared resources, not independent companies', () => {
  const action = (report: string, kind: string, name?: string) => ({
    report_id: report,
    payload: { kind },
    company: name ? { name } : null,
  });
  const a = action('a', 'contact_create', 'ООО «Альфа»');
  assert.equal(requestsConflict(a, action('a', 'task_create', 'Бета')), true);
  assert.equal(requestsConflict(a, action('b', 'letter', 'Альфа')), true);
  assert.equal(requestsConflict(a, action('b', 'letter', 'Бета')), false);
  assert.equal(requestsConflict(a, action('b', 'letter')), true);
  const signature = action('s', 'signature_create');
  assert.equal(requestsConflict(signature, action('b', 'letter', 'Бета')), true);
  assert.equal(requestsConflict(signature, action('b', 'signature_update')), true);
  assert.equal(requestsConflict(signature, a), false);
});
