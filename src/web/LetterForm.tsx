import { useState } from 'react';
import { CrmRecord } from '../shared/contracts';
import { SavedSignature, maxSignatures, noContacts } from '../shared/letters';
import { api } from './api';
import { Field } from './forms';
import { SignatureManager } from './SignatureManager';
export function LetterForm({
  companyId,
  contacts,
  onCreated,
}: {
  companyId: string;
  contacts: CrmRecord[];
  onCreated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [contactId, setContactId] = useState(''),
    [signatures, setSignatures] = useState<SavedSignature[]>([]),
    [signatureId, setSignatureId] = useState(''),
    [message, setMessage] = useState('');
  const [choosing, setChoosing] = useState(false),
    [creating, setCreating] = useState(false);
  const signature = signatures.find((s) => s.id === signatureId);
  if (creating)
    return (
      <SignatureManager
        createInitially
        onBack={() => setCreating(false)}
        onCreated={(value) => {
          setSignatures((old) => [...old.filter((s) => s.id !== value.id), value]);
          setSignatureId(value.id);
          setCreating(false);
          setChoosing(false);
        }}
      />
    );
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="inset">
      <button
        disabled={busy}
        onClick={() => {
          setError('');
          setMessage('');
          if (!contacts.length) {
            setError(noContacts);
            return;
          }
          void run(async () => {
            const result = await api<SavedSignature[]>('/me/letter-signatures');
            setSignatures(result);
            setSignatureId(result.length === 1 ? result[0].id : '');
            setContactId(contacts.length === 1 ? contacts[0].id : '');
            setOpen(true);
          });
        }}
      >
        Создать письмо
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {open && (
        <div className="form-grid">
          <Field label="Получатель письма">
            <select
              disabled={busy}
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">Выберите контакт</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.data.name} — {c.data.role || 'Должность не указана'}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            disabled={busy}
            aria-expanded={choosing}
            onClick={() => setChoosing(!choosing)}
          >
            Моя подпись
          </button>
          {choosing && (
            <div className="inset" role="group" aria-label="Выбор подписи">
              {signatures.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  aria-pressed={signatureId === s.id}
                  onClick={() => {
                    setSignatureId(s.id);
                    setChoosing(false);
                  }}
                >
                  {s.lastName} {s.firstName} {s.patronymic}
                  {s.email ? ' · ' + s.email : ''}
                </button>
              ))}
              {signatures.length < maxSignatures && (
                <button type="button" onClick={() => setCreating(true)}>
                  + Добавить подпись
                </button>
              )}
            </div>
          )}
          {signature ? (
            <p className="preserve">
              {[
                'С уважением,',
                [signature.lastName, signature.firstName, signature.patronymic]
                  .filter(Boolean)
                  .join(' '),
                signature.workPhone,
                signature.mobilePhone,
                signature.email,
              ]
                .filter(Boolean)
                .join('\n')}
            </p>
          ) : signatures.length > 0 ? (
            <p>Выберите подпись для письма.</p>
          ) : null}
          <button
            className="primary"
            disabled={busy || !signature || !contactId}
            onClick={() =>
              void run(async () => {
                await api(`/companies/${companyId}/letters`, 'POST', { contactId, signatureId });
                await onCreated();
                setOpen(false);
                setMessage('Письмо сохранено в разделе «Файлы» компании.');
              })
            }
          >
            {busy ? 'Обработка…' : 'Сформировать PDF и сохранить'}
          </button>
          <button disabled={busy} onClick={() => setOpen(false)}>
            Отмена
          </button>
        </div>
      )}
    </section>
  );
}
