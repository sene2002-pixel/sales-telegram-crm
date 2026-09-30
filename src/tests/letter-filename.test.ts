import test from 'node:test';
import assert from 'node:assert/strict';
import { letterFilename } from '../server/services/letters';

test('letter filename includes company and document date without outgoing number', () => {
  assert.equal(
    letterFilename('ООО «НПТ Климатика»', '2026-09-30'),
    'Информационное письмо — ООО «НПТ Климатика» — 30.09.2026.pdf',
  );
  assert.equal(
    letterFilename('Альфа/Бета\nСервис', '2026-01-02'),
    'Информационное письмо — Альфа Бета Сервис — 02.01.2026.pdf',
  );
  assert.ok(Buffer.byteLength(letterFilename('Я'.repeat(300), '2026-09-30')) < 255);
});
