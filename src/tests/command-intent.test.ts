import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCommand } from '../server/services/command-intent';

test('unsupported command guard does not capture historical meeting reports', () => {
  for (const text of [
    '/unknown',
    'Отправь, письмо',
    'Удали подпись Иванова',
    'Пожалуйста, покажи погоду',
    '...',
  ])
    assert.equal(looksLikeCommand(text), true, text);
  for (const text of [
    'Отправил письмо клиенту',
    'Компания Альфа: отправь предложение до пятницы',
    'Поговорил с директором',
    'Нужно отправить КП после встречи',
  ])
    assert.equal(looksLikeCommand(text), false, text);
});
