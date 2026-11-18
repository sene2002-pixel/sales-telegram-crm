import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactPhone } from '../shared/contact-phone';

test('business numbers display a Russian grouping and retain their separate extension', () => {
  assert.equal(contactPhone('+74951234567', '002'), '+7 495 123-45-67 доб. 002');
  assert.equal(contactPhone('+78001234567'), '+7 800 123-45-67');
  assert.equal(contactPhone('+49 (30) 123', '8'), '+49 (30) 123 доб. 8');
  assert.equal(contactPhone('123-45'), '123-45');
  assert.equal(contactPhone(''), '');
});
