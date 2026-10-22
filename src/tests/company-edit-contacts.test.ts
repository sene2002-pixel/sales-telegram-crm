import test from 'node:test';
import assert from 'node:assert/strict';
import { companyContactChanges } from '../shared/company-edit-contacts';

test('company editor omits unchanged contact collections larger than its change limit', () => {
  const existing = Array.from({ length: 100 }, (_, i) => ({
    id: `contact-${i}`,
    data: { name: `Contact ${i}`, role: '', phone: '', email: '', extension: '123' },
  }));
  const draft = existing.map(({ id, data: { extension: _, ...data } }) => ({
    id,
    version: 2,
    ...data,
  }));
  assert.deepEqual(companyContactChanges(draft, existing), []);
  draft[25]!.phone = '+79991234567';
  assert.deepEqual(companyContactChanges(draft, existing), [
    {
      id: 'contact-25',
      version: 2,
      data: { name: 'Contact 25', role: '', phone: '+79991234567', email: '' },
    },
  ]);
  assert.equal(existing[25]!.data.extension, '123');
});

test('company editor keeps new and missing existing IDs distinct and omission never deletes', () => {
  const data = { name: 'Contact', role: '', phone: '', email: '' };
  assert.deepEqual(companyContactChanges([{ ...data }], []), [{ data }]);
  assert.deepEqual(companyContactChanges([{ id: 'removed', version: 4, ...data }], []), [
    { id: 'removed', version: 4, data },
  ]);
  assert.deepEqual(companyContactChanges([], [{ id: 'omitted', data }]), []);
});
