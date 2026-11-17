import { TeamInvitations } from './TeamInvitations';
import { companyDisplayName } from '../shared/company-display-name';
import { useEffect, useRef, useState } from 'react';
import { Actor, labels } from '../shared/contracts';
import { api, download, today } from './api';
import { TeamEmployeeForm } from './TeamEmployeeForm';
import { Icon } from './Icons';
import './team-employees.css';
import { CommercialReport } from './CommercialReport';
import './team-overview.css';

const teamMetrics = [
  ['companies', 'Компании'],
  ['openTasks', 'Открыто'],
  ['overdue', 'Просрочено'],
  ['completed', 'Выполнено'],
  ['interactions', 'Контакты'],
] as const;

type TeamStats = Pick<Actor, 'id' | 'role' | 'name' | 'active'> &
  Record<(typeof teamMetrics)[number][0], number> & {
    inactiveCompanies: { id: string; name: string }[];
  };

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
  const [stats, setStats] = useState<TeamStats[] | null>(null);
  const [statsError, setStatsError] = useState('');
  const [showEmployees, setShowEmployees] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [savingEmployee, setSavingEmployee] = useState(false);
  const [savedEmployee, setSavedEmployee] = useState<string | null>(null);
  const dirty = useRef(false);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);

  function canLeaveEditor() {
    return !dirty.current || window.confirm('Закрыть форму и сбросить несохранённые изменения?');
  }
  function openEditor(id: string, trigger: HTMLButtonElement) {
    if (!canLeaveEditor()) return;
    dirty.current = false;
    setSavedEmployee(null);
    editorTrigger.current = trigger;
    setEditor(editor === id ? null : id);
  }
  function closeEditor() {
    dirty.current = false;
    setEditor(null);
    requestAnimationFrame(() => editorTrigger.current?.focus({ preventScroll: true }));
  }
  function employeeForm(employee?: Actor) {
    return (
      <TeamEmployeeForm
        employee={employee}
        users={users}
        busy={savingEmployee}
        onBusy={setSavingEmployee}
        onDirty={(changed) => {
          dirty.current = changed;
        }}
        onCancel={closeEditor}
        onChanged={onChanged}
        onSaved={() => {
          setSavedEmployee(employee?.id ?? 'new');
          if (!employee) setShowEmployees(true);
          closeEditor();
        }}
      />
    );
  }
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [exportError, setExportError] = useState('');
  async function exportCsv(inBot = false) {
    setExportBusy(true);
    setExportError('');
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
      setExportError((e as Error).message);
    } finally {
      setExportBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    setStats(null);
    setStatsError('');
    api<TeamStats[]>(`/dashboard?from=${from}&to=${to}`)
      .then((rows) => {
        if (active) setStats(rows);
      })
      .catch((e) => {
        if (active) setStatsError(e.message);
      });
    return () => {
      active = false;
    };
  }, [from, to, users]);
  if (user.role !== 'admin' && user.role !== 'supervisor') return null;
  return (
    <>
      <h1>Команда</h1>
      {user.role === 'supervisor' && <TeamInvitations user={user} users={users} />}
      <div className="pico-analytics-commercial team-commercial">
        <CommercialReport users={users} />
      </div>
      <div className="team-roster">
        <button
          className="team-roster-toggle"
          disabled={savingEmployee}
          aria-expanded={showEmployees}
          aria-controls={showEmployees ? 'team-roster-list' : undefined}
          onClick={() => {
            if (showEmployees && editor && editor !== 'new') {
              if (!canLeaveEditor()) return;
              dirty.current = false;
              setEditor(null);
            }
            setShowEmployees(!showEmployees);
          }}
        >
          <span>Все сотрудники</span>
          <span className="team-roster-count" aria-hidden="true">
            {users.length}
          </span>
          <Icon name="chevron" size={18} />
        </button>
        {showEmployees && (
          <section id="team-roster-list" aria-label="Все сотрудники">
            {!users.length && <p className="team-roster-empty">Сотрудников пока нет.</p>}
            <ul>
              {users.map((u) => (
                <li key={u.id} className="employee-row">
                  <div className="team-employee-summary">
                    <div className="team-employee-identity">
                      <strong>
                        {u.name}
                        {u.id === user.id && <small>Вы</small>}
                      </strong>
                      <span className="team-employee-meta">
                        {labels[u.role]}
                        <span aria-hidden="true"> · </span>
                        <span className={u.active ? '' : 'team-employee-blocked'}>
                          {u.active ? 'активен' : 'заблокирован'}
                        </span>
                      </span>
                      {u.supervisorId && (
                        <span className="team-employee-meta">
                          Руководитель:{' '}
                          {users.find((person) => person.id === u.supervisorId)?.name || '—'}
                        </span>
                      )}
                    </div>
                    {user.role === 'admin' && !u.telegramId.startsWith('dev-') && (
                      <button
                        className="team-employee-edit"
                        disabled={savingEmployee}
                        aria-expanded={editor === u.id}
                        aria-controls={editor === u.id ? `employee-form-${u.id}` : undefined}
                        aria-label={
                          editor === u.id
                            ? `Закрыть форму сотрудника ${u.name}`
                            : `Редактировать ${u.name}`
                        }
                        title={editor === u.id ? 'Закрыть форму' : 'Редактировать'}
                        onClick={(event) => openEditor(u.id, event.currentTarget)}
                      >
                        <Icon name={editor === u.id ? 'close' : 'edit'} size={17} />
                      </button>
                    )}
                  </div>
                  {user.role === 'admin' && editor === u.id && employeeForm(u)}
                  {savedEmployee === u.id && (
                    <p className="team-employee-notice" role="status">
                      Изменения сохранены
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <section className="team-overview" aria-labelledby="team-overview-title">
        <div className="team-overview-head">
          <div>
            <h2 id="team-overview-title">Показатели команды</h2>
            <p>Текущий месяц · по сегодня</p>
          </div>
          <div className="team-export">
            <button disabled={exportBusy} onClick={() => void exportCsv()}>
              Экспорт CSV
            </button>
            {!user.telegramId.startsWith('dev-') && (
              <button disabled={exportBusy} onClick={() => void exportCsv(true)}>
                Получить CSV в боте
              </button>
            )}
          </div>
        </div>
        {exportStatus && (
          <p className="team-overview-note" role="status">
            {exportStatus}
          </p>
        )}
        {exportError && (
          <p className="team-overview-note error" role="alert">
            {exportError}
          </p>
        )}
        {statsError ? (
          <p className="team-overview-note error" role="alert">
            {statsError}
          </p>
        ) : !stats ? (
          <p className="team-overview-note" role="status">
            Загружаем показатели…
          </p>
        ) : stats.length === 0 ? (
          <p className="team-overview-note">Пока нет данных по сотрудникам.</p>
        ) : (
          <>
            <p className="team-overview-note">
              Выполненные задачи и контакты — с начала месяца. Остальные показатели — на сегодня.
            </p>
            <table role="table" aria-labelledby="team-overview-title" className="team-stats">
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">
                    Сотрудник
                  </th>
                  {teamMetrics.map(([key, label]) => (
                    <th key={key} scope="col" role="columnheader">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup">
                {stats.map((s) => (
                  <tr key={s.id} role="row">
                    <th scope="row" role="rowheader">
                      <strong>{s.name}</strong>
                      <small>
                        {labels[s.role]}
                        {!s.active && ' · Заблокирован'}
                      </small>
                    </th>
                    {teamMetrics.map(([key, label]) => (
                      <td
                        key={key}
                        role="cell"
                        className={key === 'overdue' && s.overdue ? 'danger' : undefined}
                      >
                        <span className="team-metric-label" aria-hidden="true">
                          {label}
                        </span>
                        {s[key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
      {stats && (
        <section className="panel pico-team-inactive">
          <h3>Нет контакта 14 дней</h3>
          {stats.flatMap((s) =>
            s.inactiveCompanies.map((c) => (
              <p key={c.id}>
                {companyDisplayName(c.name)} <span className="muted">· {s.name}</span>
              </p>
            )),
          )}
          {!stats.some((s) => s.inactiveCompanies.length) && (
            <p className="muted">Таких компаний нет.</p>
          )}
        </section>
      )}
      {user.role === 'admin' && (
        <section className="panel pico-team-access">
          <h3>Доступ сотрудников</h3>
          <p className="muted">
            Добавьте сотрудника по числовому Telegram ID, затем он сможет открыть бота.
          </p>
          <button
            className="team-employee-add"
            disabled={savingEmployee}
            aria-expanded={editor === 'new'}
            aria-controls={editor === 'new' ? 'employee-form-new' : undefined}
            onClick={(event) => openEditor('new', event.currentTarget)}
          >
            <Icon name="plus" size={16} />
            Добавить сотрудника
          </button>
          {editor === 'new' && employeeForm()}
          {savedEmployee === 'new' && (
            <p className="team-employee-notice" role="status">
              Сотрудник добавлен
            </p>
          )}
        </section>
      )}
    </>
  );
}
