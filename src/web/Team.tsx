import { useEffect, useState } from 'react';
import { Actor, roles, labels } from '../shared/contracts';
import { api, download, today } from './api';
import { Field, Select } from './forms';
export function Team({
  user,
  users,
  onChanged,
}: {
  user: Actor;
  users: Actor[];
  onChanged: () => Promise<void>;
}) {
  const [from, setFrom] = useState(today().slice(0, 8) + '01'),
    [to, setTo] = useState(today()),
    [stats, setStats] = useState<any[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [person, setPerson] = useState({ telegramId: '', name: '', role: 'manager', active: true });
  const [showEmployees, setShowEmployees] = useState(false);
  const [mode, setMode] = useState<'add' | 'edit' | null>(null);
  useEffect(() => {
    api(`/dashboard?from=${from}&to=${to}`)
      .then(setStats)
      .catch((e) => setError(e.message));
  }, [from, to, users]);
  if (user.role !== 'admin' && user.role !== 'supervisor') return null;
  return (
    <>
      <p className="eyebrow">ОБЩАЯ КАРТИНА</p>
      <h1>Команда</h1>
      <button onClick={() => setShowEmployees(!showEmployees)} aria-expanded={showEmployees}>
        Все сотрудники
      </button>
      {showEmployees && (
        <section className="panel" aria-label="Все сотрудники">
          <h3>Все сотрудники</h3>
          {users.map((u) => (
            <div key={u.id} className="employee-row">
              <p>
                {u.name}
                {u.id === user.id ? ' · Вы' : ''} · {labels[u.role]} ·{' '}
                {u.active ? 'активен' : 'заблокирован'}
              </p>
              {user.role === 'admin' && !u.telegramId.startsWith('dev-') && (
                <button
                  disabled={busy}
                  aria-label={`Редактировать ${u.name}`}
                  onClick={() => {
                    setPerson({
                      telegramId: u.telegramId,
                      name: u.name,
                      role: u.role,
                      active: u.active,
                    });
                    setMode('edit');
                    setError('');
                  }}
                >
                  Редактировать
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      <div className="filters">
        <Field label="С">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="По">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <button
          onClick={() =>
            download(`/dashboard/export?from=${from}&to=${to}`, 'team-report.csv').catch((e) =>
              setError(e.message),
            )
          }
        >
          Экспорт CSV
        </button>
      </div>
      <p className="muted">
        Контакты и выполненные задачи — за период. Компании, открытые и просроченные задачи — на
        текущий момент.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Сотрудник</th>
              <th>Компании</th>
              <th>Открыто</th>
              <th>Просрочено</th>
              <th>Выполнено</th>
              <th>Контакты</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong>
                  <small>
                    {labels[s.role]}
                    {!s.active ? ' · Заблокирован' : ''}
                  </small>
                </td>
                <td>{s.companies}</td>
                <td>{s.openTasks}</td>
                <td className={s.overdue ? 'danger' : ''}>{s.overdue}</td>
                <td>{s.completed}</td>
                <td>{s.interactions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="panel">
        <h3>Нет контакта 14 дней</h3>
        {stats.flatMap((s) =>
          s.inactiveCompanies.map((c: any) => (
            <p key={c.id}>
              {c.name} <span className="muted">· {s.name}</span>
            </p>
          )),
        )}
        {!stats.some((s) => s.inactiveCompanies.length) && (
          <p className="muted">Таких компаний нет.</p>
        )}
      </section>
      {user.role === 'admin' && (
        <section className="panel">
          <h3>Доступ сотрудников</h3>
          <p className="muted">
            Добавьте сотрудника по числовому Telegram ID, затем он сможет открыть бота.
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setPerson({ telegramId: '', name: '', role: 'manager', active: true });
              setMode('add');
              setError('');
            }}
          >
            Добавить сотрудника
          </button>
          {mode && (
            <>
              <h3>{mode === 'add' ? 'Новый сотрудник' : `Редактирование: ${person.name}`}</h3>
              {mode === 'edit' && (
                <p className="muted">
                  Telegram ID нельзя изменить. Для другого аккаунта добавьте нового сотрудника.
                </p>
              )}
              <form
                className="form-grid"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError('');
                  try {
                    if (
                      mode === 'add' &&
                      users.some((u) => u.telegramId === person.telegramId.trim())
                    )
                      throw new Error(
                        'Сотрудник уже существует. Откройте «Все сотрудники» и выберите «Редактировать».',
                      );
                    await api('/users', 'POST', person);
                    await onChanged();
                    setPerson({ telegramId: '', name: '', role: 'manager', active: true });
                    setMode(null);
                    setShowEmployees(true);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Field label="Telegram ID">
                  <input
                    required
                    readOnly={mode === 'edit'}
                    pattern="[0-9]+"
                    value={person.telegramId}
                    onChange={(e) => setPerson({ ...person, telegramId: e.target.value })}
                  />
                </Field>
                <Field label="Имя сотрудника">
                  <input
                    required
                    value={person.name}
                    onChange={(e) => setPerson({ ...person, name: e.target.value })}
                  />
                </Field>
                <Field label="Роль">
                  <Select
                    value={person.role}
                    options={roles}
                    onChange={(role) => setPerson({ ...person, role })}
                  />
                </Field>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={person.active}
                    onChange={(e) => setPerson({ ...person, active: e.target.checked })}
                  />
                  Доступ активен
                </label>
                <button disabled={busy} className="primary wide">
                  {mode === 'add' ? 'Создать сотрудника' : 'Сохранить изменения'}
                </button>
                <button type="button" disabled={busy} onClick={() => setMode(null)}>
                  Отмена
                </button>
              </form>
            </>
          )}
        </section>
      )}
    </>
  );
}
