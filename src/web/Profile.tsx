import { useEffect, useState } from 'react';
import { Signature } from '../shared/letters';
import { api } from './api';
import { Field } from './forms';
const empty: Signature = {
  lastName: '',
  firstName: '',
  patronymic: '',
  workPhone: '',
  mobilePhone: '',
  email: '',
};
const labels: Record<keyof Signature, string> = {
  lastName: 'Фамилия',
  firstName: 'Имя',
  patronymic: 'Отчество',
  workPhone: 'Рабочий телефон и добавочный',
  mobilePhone: 'Мобильный телефон',
  email: 'Email',
};
export function Profile() {
  const [signature, setSignature] = useState<Signature>(empty);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    api<{ signature: Signature | null }>('/me/letter-signature')
      .then((r) => {
        if (active) setSignature(r.signature || empty);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h1>Мой профиль</h1>
      <h2>Подпись для писем</h2>
      <p>Эта подпись используется в ваших письмах для всех компаний.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p>Загрузка…</p>
      ) : (
        <form
          className="inset form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setSignature(await api('/me/letter-signature', 'POST', signature));
              setSaved(true);
            });
          }}
        >
          <Field label="Фото визитки · JPEG или PNG, до 10 МБ">
            <input
              type="file"
              accept="image/jpeg,image/png"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > 10 * 1024 * 1024) {
                  setError('Загрузите фото до 10 МБ');
                  return;
                }
                void run(async () => {
                  const body = new FormData();
                  body.append('file', file);
                  setSignature(await api('/me/letter-signature/recognize', 'POST', body));
                });
              }}
            />
          </Field>
          <p>
            Проверьте данные после распознавания. Изменения сохраняются только по кнопке ниже.
            Необязательные поля можно оставить пустыми.
          </p>
          {Object.entries(labels).map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                required={key === 'lastName' || key === 'firstName'}
                disabled={busy}
                maxLength={120}
                type={key === 'email' ? 'email' : 'text'}
                value={signature[key as keyof Signature]}
                onChange={(e) => {
                  setSignature({ ...signature, [key]: e.target.value });
                  setSaved(false);
                }}
              />
            </Field>
          ))}
          <button
            className="primary"
            disabled={busy || !signature.lastName.trim() || !signature.firstName.trim()}
            type="submit"
          >
            {busy ? 'Обработка…' : 'Сохранить изменения'}
          </button>
          {saved && <p role="status">Подпись сохранена.</p>}
        </form>
      )}
    </section>
  );
}
