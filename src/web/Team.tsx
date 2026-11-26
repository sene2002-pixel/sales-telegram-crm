import { TeamInvitations } from './TeamInvitations';
import { InactiveCompanies } from './InactiveCompanies';
import './team-overview.css';
import { useEffect, useRef, useState } from 'react';
import { Actor, labels } from '../shared/contracts';
import { api, today } from './api';
import { TeamEmployeeForm } from './TeamEmployeeForm';
import { canRemoveTeamMember, RemoveTeamMemberDialog } from './RemoveTeamMemberDialog';
import { Icon } from './Icons';
import './team-employees.css';
import { CommercialReport } from './CommercialReport';
import { TeamOverview } from './TeamOverview';
import type { TeamStats } from '../shared/team-metrics';

export function Team({
  user,
  users,
  onChanged,
  onMemberRemoved,
}: {
  user: Actor;
  users: Actor[];
  onChanged: () => Promise<void>;
  onMemberRemoved: (id: string) => Promise<void>;
}) {
  const to = today();
  const from = to.slice(0, 8) + '01';
  const [stats, setStats] = useState<TeamStats[] | null>(null);
  const [statsError, setStatsError] = useState('');
  const [showEmployees, setShowEmployees] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [savingEmployee, setSavingEmployee] = useState(false);
  const [savedEmployee, setSavedEmployee] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Actor | null>(null);
  const [removedName, setRemovedName] = useState('');
  const dirty = useRef(false);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const rosterToggle = useRef<HTMLButtonElement>(null);

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
      <TeamInvitations user={user} users={users} />
      <div className="pico-analytics-commercial team-commercial">
        <CommercialReport users={users} />
      </div>
      <div className="team-roster">
        <button
          ref={rosterToggle}
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
            {removedName && (
              <p className="team-removal-status" role="status">
                {removedName}: доступ закрыт.
              </p>
            )}
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
                    {canRemoveTeamMember(user, u, users) && (
                      <button
                        type="button"
                        className="team-employee-remove danger"
                        disabled={savingEmployee}
                        aria-label={`Удалить из команды: ${u.name}`}
                        title="Удалить из команды"
                        onClick={() => {
                          setRemovedName('');
                          setRemoving(u);
                        }}
                      >
                        <Icon name="trash" size={17} />
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
      <TeamOverview user={user} stats={stats} statsError={statsError} from={from} to={to} />
      {stats && <InactiveCompanies stats={stats} />}
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
      {removing && (
        <RemoveTeamMemberDialog
          actor={user}
          member={removing}
          users={users}
          onClose={() => setRemoving(null)}
          onChanged={onMemberRemoved}
          onRemoved={() => {
            if (editor === removing.id) {
              dirty.current = false;
              setEditor(null);
            }
            setRemovedName(removing.name);
            setRemoving(null);
            requestAnimationFrame(() => rosterToggle.current?.focus({ preventScroll: true }));
          }}
        />
      )}
    </>
  );
}
