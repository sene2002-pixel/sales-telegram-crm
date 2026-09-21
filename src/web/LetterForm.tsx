import { useState } from 'react';
import { CrmRecord } from '../shared/contracts';
import { Signature, noContacts } from '../shared/letters';
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
    [signature, setSignature] = useState<Signature>(empty),
    [confirmed, setConfirmed] = useState(false),
    [message, setMessage] = useState('');
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
            const result = await api<{ signature: Signature | null }>('/me/letter-signature');
            setSignature(result.signature || empty);
            setConfirmed(!!result.signature);
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
          <h3>Моя подпись</h3>
          {confirmed ? (
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
          ) : (
            <p>Сначала сохраните подпись в разделе «Мой профиль» → «Подпись для писем».</p>
          )}
          <button
            className="primary"
            disabled={busy || !confirmed || !contactId}
            onClick={() =>
              void run(async () => {
                await api(`/companies/${companyId}/letters`, 'POST', { contactId });
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
