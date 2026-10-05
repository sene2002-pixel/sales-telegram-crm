import { useState } from 'react';
import { Actor } from '../shared/contracts';
import { api, today } from './api';
import { Field } from './forms';
export function CommercialReport({ users }: { users: Actor[] }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(today().slice(0, 8) + '01'),
    [to, setTo] = useState(today()),
    [author, setAuthor] = useState('');
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="panel" aria-label="Коммерческий отчёт">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        Коммерческий отчёт руководителю
      </button>
      {open && (
        <>
          <div className="form-grid">
            <Field label="Период с">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Период по">
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Данные менеджера">
              <select value={author} onChange={(e) => setAuthor(e.target.value)}>
                <option value="">Все сотрудники</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button
            disabled={busy || !from || !to || from > to}
            onClick={async () => {
              setBusy(true);
              setError('');
              setText('');
              try {
                const r = await api<{ text: string }>(
                  `/dashboard/commercial?${new URLSearchParams({ from, to, ...(author ? { authorId: author } : {}) })}`,
                );
                setText(r.text);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Собираем…' : 'Сформировать коммерческий отчёт'}
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {text && <pre className="commercial-report">{text}</pre>}
        </>
      )}
    </section>
  );
}
