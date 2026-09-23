import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCommand } from '../server/services/command-intent';

test('unsupported command guard does not capture historical meeting reports', () => {
  for (const text of [
    '/unknown',
    'Отправь, письмо',
    'Удали подпись Иванова',
    'Удалить все подписи',
    'Нужно убрать подпись из документа',
    'Пожалуйста, можете удалить все подписи',
    'Отредактировать.',
    'Изменить настройки',
    'Нужно обновить подпись',
    'Пожалуйста, покажи погоду',
    '...',
  ])
    assert.equal(looksLikeCommand(text), true, text);
  for (const text of [
    'Отправил письмо клиенту',
    'Компания Альфа: отправь предложение до пятницы',
    'Поговорил с директором',
    'Нужно отправить КП после встречи',
    'Вчера удалил подпись',
    'Обновил подпись в договоре',
    'Не удаляй подпись',
  ])
    assert.equal(looksLikeCommand(text), false, text);
});
