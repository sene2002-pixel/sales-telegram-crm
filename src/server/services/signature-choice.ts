import { isDeepStrictEqual } from 'node:util';
import { Sql } from '../infra/database';
import { requireCondition } from '../domain/errors';

export type SignatureOption = { id: string; data: Record<string, string> };
export const signatureName = (data: Record<string, string>) =>
  [data.lastName, data.firstName, data.patronymic].filter(Boolean).join(' ');
export function signatureOptionsText(options: SignatureOption[]) {
  return options
    .map(
      (s, i) =>
        `${i + 1}. ${signatureName(s.data)}\nEmail: ${s.data.email || '—'} · Рабочий: ${s.data.workPhone || '—'} · Мобильный: ${s.data.mobilePhone || '—'}`,
    )
    .join('\n\n');
}
export function signatureButtons(options: SignatureOption[], prefix: string) {
  return options.map((s, i) => [
    { text: `${i + 1}. ${signatureName(s.data)}`.slice(0, 100), callback_data: `${prefix}:${i}` },
  ]);
}
export async function checkedSignature(
  tx: Sql,
  userId: string,
  option: SignatureOption | undefined,
) {
  requireCondition(option, 400, 'Выберите подпись из списка');
  const [current] = await tx.query('SELECT * FROM letter_signatures WHERE user_id=$1 AND id=$2', [
    userId,
    option.id,
  ]);
  requireCondition(current, 409, 'Подпись удалена. Повторите голосовой запрос');
  requireCondition(
    isDeepStrictEqual(current.data, option.data),
    409,
    'Подпись изменилась. Повторите запрос, чтобы проверить актуальные данные',
  );
  return current;
}
export async function assignDefault(tx: Sql, userId: string, id: string) {
  await tx.query('UPDATE letter_signatures SET is_default=false WHERE user_id=$1', [userId]);
  await tx.query('UPDATE letter_signatures SET is_default=true WHERE user_id=$1 AND id=$2', [
    userId,
    id,
  ]);
}
