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
  const to = today();
  const from = to.slice(0, 8) + '01';
  const [stats, setStats] = useState<any[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const emptyPerson = {
    telegramId: '',
    name: '',
    role: 'manager',
    active: true,
    supervisorId: null as string | null,
  };
  const [person, setPerson] = useState(emptyPerson);
  const [showEmployees, setShowEmployees] = useState(false);
  const [mode, setMode] = useState<'add' | 'edit' | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  async function exportCsv(inBot = false) {
    setExportBusy(true);
    setError('');
    setExportStatus('');
    try {
      if (inBot) {
        await api('/dashboard/export-bot', 'POST', { from, to });
        setExportStatus(
          'CSV отправлен в ваш личный чат с ботом. Откройте чат и сохраните документ.',
        );
      } else {
        const telegram = window.Telegram?.WebApp;
        if (telegram?.initData) {
          if (!telegram.downloadFile || !telegram.isVersionAtLeast?.('8.0')) {
            setExportStatus(
              'В этой версии Telegram скачивание недоступно. Нажмите «Получить CSV в боте».',
            );
            return;
          }
          const file = await api<{ url: string; filename: string }>(
            '/dashboard/export-link',
            'POST',
            { from, to },
          );
          setExportStatus(
            'Подтвердите скачивание в Telegram. Если файл не появился, получите его в боте.',
          );
          telegram.downloadFile({ url: file.url, file_name: file.filename }, (accepted) => {
            setExportStatus(
              accepted
                ? 'Telegram принял запрос на скачивание. Если файл не появился, получите его в боте.'
                : 'Скачивание отменено. Можно повторить или получить CSV в боте.',
            );
          });
        } else {
          await download(
            `/dashboard/export?from=${from}&to=${to}`,
            `team-report-${from}-${to}.csv`,
          );
          setExportStatus('Файл передан браузеру для скачивания.');
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExportBusy(false);
    }
  }
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
                {u.supervisorId
                  ? ` · Руководитель: ${users.find((person) => person.id === u.supervisorId)?.name || '—'}`
                  : ''}
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
                      supervisorId: u.supervisorId ?? null,
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
        <span>Текущий месяц · по сегодня</span>
        <button disabled={exportBusy} onClick={() => void exportCsv()}>
          Экспорт CSV
        </button>
        {!user.telegramId.startsWith('dev-') && (
          <button disabled={exportBusy} onClick={() => void exportCsv(true)}>
            Получить CSV в боте
          </button>
        )}
      </div>
      {exportStatus && <p role="status">{exportStatus}</p>}
      <p className="muted">
        Контакты и выполненные задачи — с начала текущего месяца по сегодня. Компании, открытые и
        просроченные задачи — на текущий момент.
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
              setPerson(emptyPerson);
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
                    setPerson(emptyPerson);
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
                    onChange={(role) =>
                      setPerson({
                        ...person,
                        role,
                        supervisorId: role === 'manager' ? person.supervisorId : null,
                      })
                    }
                  />
                </Field>
                {person.role === 'manager' && (
                  <Field label="Руководитель">
                    <select
                      value={person.supervisorId ?? ''}
                      onChange={(e) =>
                        setPerson({ ...person, supervisorId: e.target.value || null })
                      }
                    >
                      <option value="">Не назначен</option>
                      {users
                        .filter((u) => u.role === 'supervisor' && u.active)
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                )}
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
