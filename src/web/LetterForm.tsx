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
  const [creating, setCreating] = useState(false);
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
        <div className="form-grid" style={{ alignItems: 'start' }}>
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
          <Field label="Моя подпись">
            <select
              disabled={busy}
              value={signatureId}
              onChange={(e) => {
                if (e.target.value === 'add') {
                  setCreating(true);
                  return;
                }
                setSignatureId(e.target.value);
              }}
            >
              <option value="" hidden={!signatures.length}>
                {signatures.length ? 'Выберите подпись' : '+ Добавить подпись'}
              </option>
              {signatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {[s.lastName, s.firstName, s.patronymic].filter(Boolean).join(' ')}
                  {s.email ? ' · ' + s.email : ''}
                </option>
              ))}
              {signatures.length < maxSignatures && <option value="add">+ Добавить подпись</option>}
            </select>
          </Field>
          {signature ? (
            <p className="preserve" style={{ gridColumn: '1 / -1' }}>
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
