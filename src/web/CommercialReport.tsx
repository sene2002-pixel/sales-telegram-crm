import { useEffect, useRef, useState } from 'react';
import { Actor } from '../shared/contracts';
import { api, ApiError, today } from './api';
import { Field } from './forms';
export function CommercialReport({
  users,
  employeeId,
  initialPeriod,
  onScopeDenied,
}: {
  users: Actor[];
  onScopeDenied?: (error: Error) => void;
  employeeId?: string;
  initialPeriod?: { from: string; to: string };
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(initialPeriod?.from || today().slice(0, 8) + '01'),
    [to, setTo] = useState(initialPeriod?.to || today()),
    [author, setAuthor] = useState('');
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const requestSequence = useRef(0);
  useEffect(() => {
    ++requestSequence.current;
    setAuthor(employeeId || '');
    setText('');
    setError('');
    setBusy(false);
    return () => {
      ++requestSequence.current;
    };
  }, [employeeId]);
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
            {employeeId === undefined ? (
              <Field label="Данные менеджера">
                <select
                  value={author}
                  onChange={(e) => {
                    ++requestSequence.current;
                    setAuthor(e.target.value);
                    setText('');
                    setBusy(false);
                  }}
                >
                  <option value="">Все сотрудники</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <p className="muted">
                {employeeId
                  ? `Автор: ${users.find((u) => u.id === employeeId)?.name || 'выбранный сотрудник'}`
                  : 'Авторы: все доступные сотрудники'}
              </p>
            )}
          </div>
          <button
            className="pico-commercial-report-submit"
            disabled={busy || !from || !to || from > to}
            onClick={async () => {
              const sequence = ++requestSequence.current;
              setBusy(true);
              setError('');
              setText('');
              try {
                const r = await api<{ text: string }>(
                  `/dashboard/commercial?${new URLSearchParams({ from, to, ...(employeeId ? { employeeId, authorId: employeeId } : employeeId === undefined && author ? { authorId: author } : {}) })}`,
                );
                if (sequence === requestSequence.current) setText(r.text);
              } catch (e) {
                if (sequence === requestSequence.current) {
                  setError((e as Error).message);
                  if (e instanceof ApiError && (e.status === 401 || e.status === 403))
                    onScopeDenied?.(e);
                }
              } finally {
                if (sequence === requestSequence.current) setBusy(false);
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
