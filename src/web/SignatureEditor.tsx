import { FileUpload } from './FileUpload';
import { useId, useRef, useState } from 'react';
import { Signature, SavedSignature } from '../shared/letters';
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
export function SignatureEditor({
  initial,
  onSaved,
  onCancel,
  draft,
}: {
  initial: SavedSignature | null;
  onSaved: (value: SavedSignature) => void;
  onCancel: () => void;
  draft?: { id: string; data: Signature; transcript: string };
}) {
  const [signature, setSignature] = useState<Signature>(
    initial
      ? {
          lastName: initial.lastName,
          firstName: initial.firstName,
          patronymic: initial.patronymic,
          workPhone: initial.workPhone,
          mobilePhone: initial.mobilePhone,
          email: initial.email,
        }
      : draft?.data || empty,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [recognition, setRecognition] = useState<'idle' | 'pending' | 'success'>('idle'),
    [photoError, setPhotoError] = useState('');
  const inFlight = useRef(false);
  const photoFeedbackId = useId();
  async function run(fn: () => Promise<void>, recognize = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    if (recognize) {
      setRecognition('pending');
      setPhotoError('');
    }
    try {
      await fn();
      if (recognize) setRecognition('success');
    } catch (e) {
      if (recognize) {
        setRecognition('idle');
        setPhotoError((e as Error).message);
      } else setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="pico-signature-editor">
      <h2>{initial ? 'Редактировать подпись' : 'Добавить подпись'}</h2>
      <p>Эта подпись используется в ваших письмах для всех компаний.</p>
      {draft && (
        <details>
          <summary>Распознанный текст голосового</summary>
          <p className="preserve">{draft.transcript}</p>
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {
        <form
          className="inset form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const result = await api<SavedSignature>(
                draft
                  ? `/me/signature-drafts/${draft.id}/save`
                  : initial
                    ? '/me/letter-signatures/' + initial.id
                    : '/me/letter-signatures',
                initial ? 'PATCH' : 'POST',
                signature,
              );
              onSaved(result);
            });
          }}
        >
          <Field label="Фото визитки · JPEG или PNG, до 10 МБ">
            <FileUpload
              label="Фото визитки · JPEG или PNG, до 10 МБ"
              accept="image/jpeg,image/png"
              aria-describedby={photoFeedbackId}
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file || inFlight.current) return;
                setRecognition('idle');
                setPhotoError('');
                setError('');
                if (file.size > 10 * 1024 * 1024) {
                  setPhotoError('Загрузите фото до 10 МБ');
                  return;
                }
                void run(async () => {
                  const body = new FormData();
                  body.append('file', file);
                  setSignature(await api('/me/letter-signature/recognize', 'POST', body));
                }, true);
              }}
            />
            <span id={photoFeedbackId} className="signature-photo-feedback">
              <span role="status" aria-atomic="true" className="signature-photo-status">
                {recognition === 'pending'
                  ? 'Распознаём визитку…'
                  : recognition === 'success'
                    ? 'Данные распознаны. Проверьте поля и сохраните изменения.'
                    : ''}
              </span>
              {photoError && (
                <span role="alert" className="error">
                  {photoError}
                </span>
              )}
            </span>
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
          <button type="button" disabled={busy} onClick={onCancel}>
            Отмена
          </button>
        </form>
      }
    </section>
  );
}
