import { companyDisplayName } from '../shared/company-display-name';
import { useEffect, useState } from 'react';
import {
  Actor,
  Company,
  CrmRecord,
  divisions,
  primaryDivisions,
  primarySegments,
  projectSupplyTypes,
  projectServiceTypes,
  divisionLabels,
  labels,
  stages,
  taskSchema,
  taskTypeLabels,
} from '../shared/contracts';
import { api, money, today } from './api';
import { Field, Modal, RecordForm, TaskComposer, Chips, ClientPicker } from './forms';
import { Icon, industryIcon } from './Icons';
import { PickerRow } from './FormWidgets';
import { AnalyticsSummary } from '../shared/analytics';
import { CommercialReport } from './CommercialReport';
export type NamedRecord = CrmRecord & { companyName: string };
type Common = {
  companies: Company[];
  projects: NamedRecord[];
  tasks: NamedRecord[];
  users: Actor[];
  onChanged: () => Promise<void>;
  onCompany: (company: Company) => void;
};
export function RecordCreate({
  kind,
  companies,
  projects,
  onClose,
  onChanged,
}: Pick<Common, 'companies' | 'projects' | 'onChanged'> & {
  kind: 'task' | 'project';
  onClose: () => void;
}) {
  const [companyId, setCompanyId] = useState(''),
    [contacts, setContacts] = useState<CrmRecord[]>([]),
    [contactError, setContactError] = useState(''),
    [companyPickerOpen, setCompanyPickerOpen] = useState(false),
    [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    let current = true;
    setContacts([]);
    setContactError('');
    if (companyId)
      api<{ records: CrmRecord[] }>(`/companies/${companyId}`)
        .then((detail) => {
          if (current) setContacts(detail.records.filter((r) => r.kind === 'contact'));
        })
        .catch((e) => {
          if (current) setContactError(e.message);
        });
    return () => {
      current = false;
    };
  }, [companyId]);
  return (
    <Modal title={kind === 'task' ? 'Новая задача' : 'Новый проект'} onClose={onClose}>
      {acknowledged ? (
        <>
          <p role="status">Запись сохранена. Обновите список, чтобы увидеть изменения.</p>
          <button className="primary pico-sheet-submit" onClick={onClose}>
            Готово
          </button>
        </>
      ) : kind === 'task' ? (
        <TaskComposer
          companies={companies}
          projects={projects}
          onSave={async (data, cid, pid) => {
            await api(`/companies/${cid}/records/task`, 'POST', { data, projectId: pid });
            setAcknowledged(true);
            try {
              await onChanged();
              onClose();
            } catch (e) {
              setContactError(
                'Запись сохранена, но обновление не удалось: ' + (e as Error).message,
              );
            }
          }}
        />
      ) : (
        <RecordForm
          kind="project"
          companies={companies}
          contacts={contacts}
          projects={projects.filter((p) => p.companyId === companyId)}
          clientRow={
            <div className="pico-picker-box">
              <PickerRow
                label="Заказчик"
                icon="clients"
                value={companyDisplayName(companies.find((c) => c.id === companyId)?.name)}
                onClick={() => setCompanyPickerOpen(!companyPickerOpen)}
              />
              {companyPickerOpen && (
                <ClientPicker
                  companies={companies}
                  value={companyId}
                  onChange={(id) => {
                    setCompanyId(id);
                    setCompanyPickerOpen(false);
                  }}
                  label="Клиент проекта"
                />
              )}
            </div>
          }
          onSave={async (data, projectId) => {
            if (!companyId) throw new Error('Выберите заказчика проекта');
            await api(`/companies/${companyId}/records/project`, 'POST', { data, projectId });
            setAcknowledged(true);
            try {
              await onChanged();
              onClose();
            } catch (e) {
              setContactError('Проект сохранён, но обновление не удалось: ' + (e as Error).message);
            }
          }}
        />
      )}
      {contactError && (
        <p role="alert" className="error">
          {contactError}
        </p>
      )}
    </Modal>
  );
}
function ContactLabel({ companyId, contactId }: { companyId: string; contactId?: string | null }) {
  const [contact, setContact] = useState<CrmRecord | null>(null),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setContact(null);
    setLoaded(false);
    setError('');
    if (contactId)
      api<{ records: CrmRecord[] }>(`/companies/${companyId}`)
        .then((d) => {
          if (current) {
            setContact(d.records.find((r) => r.id === contactId && r.kind === 'contact') || null);
            setLoaded(true);
          }
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [companyId, contactId]);
  return (
    <span className="pico-contact-label">
      {error ? (
        'Контакт недоступен'
      ) : contact ? (
        <>
          {contact.data.name}
          <small>
            {[contact.data.role, contact.data.phone, contact.data.email]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </>
      ) : contactId ? (
        loaded ? (
          'Контакт недоступен'
        ) : (
          'Загрузка контакта…'
        )
      ) : (
        'Не выбран'
      )}
    </span>
  );
}
function TaskAdvice({ id }: { id: string }) {
  const [advice, setAdvice] = useState<{
      text: string;
      source: string;
      asOf: string | null;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api(`/tasks/${id}/advice`)
      .then((a) => {
        if (active) setAdvice(a);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <section className="pico-task-advice">
      <h3>
        <Icon name="sparkles" size={16} /> Pico подсказывает
      </h3>
      {advice ? (
        <>
          <p>{advice.text}</p>
          {advice.asOf && <small>По подтверждённым данным от {advice.asOf}</small>}
        </>
      ) : (
        <p>{error ? 'Подсказка недоступна. ' + error : 'Загрузка подсказки…'}</p>
      )}
    </section>
  );
}
export function ScreenGuide({
  title,
  items,
}: {
  title: string;
  items: [string, string, string][];
}) {
  return (
    <section className="pico-guide">
      <h3>{title}</h3>
      <div className="pico-compact-list">
        {items.map(([icon, label, detail]) => (
          <div className="pico-guide-row" key={label}>
            <span className="pico-row-icon">
              <Icon name={icon} />
            </span>
            <span>
              <strong>{label}</strong>
              <small>{detail}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
function Empty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div className="pico-empty">
      <span className="pico-empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
export function TaskList({
  list,
  inlineActions = false,
  ...props
}: Common & { list: NamedRecord[]; inlineActions?: boolean }) {
  const [selected, setSelected] = useState<NamedRecord | null>(null),
    [postpone, setPostpone] = useState(false),
    [due, setDue] = useState(today()),
    [time, setTime] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expanded, setExpanded] = useState('');
  async function remove(task: NamedRecord) {
    if (!window.confirm('Удалить задачу?')) return;
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${task.id}`, 'DELETE', { version: task.version });
      await props.onChanged();
      setSelected(null);
      setExpanded('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function update(task: NamedRecord, changes: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      await api(`/records/${task.id}`, 'PATCH', {
        version: task.version,
        data: taskSchema.parse({
          text: task.data.text,
          due: task.data.due,
          done: task.data.done,
          type: task.data.type || 'reminder',
          time: task.data.time || null,
          contactId: task.data.contactId || null,
          ...changes,
        }),
      });
      await props.onChanged();
      setSelected(null);
      setPostpone(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="pico-compact-list">
        {list.map((t) => (
          <article
            className={'pico-task-row task-row task-type-' + (t.data.type || 'reminder')}
            key={t.id}
          >
            <button
              className={
                'checkbox task-type-' +
                (t.data.type || 'reminder') +
                ' ' +
                (t.data.done ? 'checked' : '')
              }
              aria-label={t.data.done ? 'Вернуть задачу' : 'Выполнить задачу'}
              disabled={busy}
              onClick={() => update(t, { done: !t.data.done })}
            >
              <Icon name={t.data.done ? 'check' : t.data.type || 'reminder'} size={16} />
            </button>
            <button
              className="task-text"
              onClick={() => {
                if (inlineActions) {
                  setExpanded(expanded === t.id ? '' : t.id);
                  return;
                }
                setSelected(t);
                setDue(t.data.due || today());
                setTime(t.data.time || '');
                setError('');
              }}
            >
              <strong className={t.data.done ? 'done' : ''}>{t.data.text}</strong>
              <small>
                {props.projects.find((p) => p.id === t.projectId)?.data.name ||
                  companyDisplayName(t.companyName)}
                {t.data.due
                  ? ' · ' +
                    (inlineActions
                      ? ''
                      : new Date(t.data.due + 'T12:00:00').toLocaleDateString('ru-RU', {
                          day: 'numeric',
                          month: 'short',
                        }) + ' · ') +
                    (t.data.time || 'Без времени')
                  : ' · Без срока'}
              </small>
            </button>
            {!t.data.done && t.data.due && t.data.due < today() && (
              <span className="status failed">Просрочено</span>
            )}
            <Icon name="chevron-right" size={16} />
            {inlineActions && expanded === t.id && (
              <div className="pico-task-actions">
                <button disabled={busy} onClick={() => update(t, { done: !t.data.done })}>
                  <Icon name="check" size={14} />
                  {t.data.done ? 'Вернуть' : 'Выполнено'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setSelected(t);
                    setPostpone(true);
                    setDue(t.data.due || today());
                    setTime(t.data.time || '');
                  }}
                >
                  <Icon name="clock" size={14} />
                  Отложить
                </button>
                <button disabled={busy} onClick={() => remove(t)}>
                  <Icon name="trash" size={14} />
                  Удалить
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {!list.length && (
        <Empty
          icon="calendar"
          title="Задач пока нет"
          text="Создайте задачу или отправьте отчёт в чат Pico."
        />
      )}
      {selected && (
        <Modal
          title={postpone ? 'Отложить задачу' : selected.data.text}
          titleIcon={
            !postpone ? (
              <span className={'pico-detail-type task-type-' + (selected.data.type || 'reminder')}>
                <span className="checkbox">
                  <Icon name={selected.data.type || 'reminder'} size={16} />
                </span>
              </span>
            ) : undefined
          }
          onClose={() => {
            setSelected(null);
            setPostpone(false);
          }}
        >
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {postpone ? (
            <>
              <Field label="Дата">
                <input type="date" required value={due} onChange={(e) => setDue(e.target.value)} />
              </Field>
              <Field label="Время">
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
              <div className="pico-quick-dates">
                <button
                  onClick={() => {
                    const d = new Date();
                    d.setHours(d.getHours() + 1);
                    setDue(
                      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                    );
                    setTime(
                      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
                    );
                  }}
                >
                  <Icon name="clock" size={16} />
                  <strong>Через час</strong>
                  <small>
                    {new Date(Date.now() + 3600000).toLocaleString('ru-RU', {
                      day: 'numeric',
                      month: 'long',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                </button>
                {[
                  ['Завтра утром', 1],
                  ['Через неделю', 7],
                ].map(([label, n]) => (
                  <button
                    key={label}
                    onClick={() => {
                      const d = new Date(today() + 'T12:00:00');
                      d.setDate(d.getDate() + Number(n));
                      if (Number(n) === 1) setTime('10:00');
                      setDue(
                        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                      );
                    }}
                  >
                    <Icon name="calendar" size={16} />
                    <strong>{label}</strong>
                    <small>
                      {(() => {
                        const d = new Date(today() + 'T12:00:00');
                        d.setDate(d.getDate() + Number(n));
                        return (
                          d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) +
                          ', ' +
                          (Number(n) === 1 ? '10:00' : time || 'без времени')
                        );
                      })()}
                    </small>
                  </button>
                ))}
              </div>
              <button
                disabled={busy || !due}
                className="primary"
                onClick={() => update(selected, { due, time: time || null })}
              >
                Отложить
              </button>
            </>
          ) : (
            <>
              <dl className="pico-detail-fields">
                <dt>Дата</dt>
                <dd>{selected.data.due || 'Без срока'}</dd>
                <dt>Время</dt>
                <dd>{selected.data.time || 'Не указано'}</dd>
                <dt>Тип задачи</dt>
                <dd>{taskTypeLabels[selected.data.type] || 'Напоминание'}</dd>
                <dt>Клиент</dt>
                <dd>{companyDisplayName(selected.companyName)}</dd>
                <dt>Проект</dt>
                <dd>
                  {props.projects.find((p) => p.id === selected.projectId)?.data.name ||
                    'Не выбран'}
                </dd>
                <dt>Контакт</dt>
                <dd>
                  <ContactLabel
                    companyId={selected.companyId}
                    contactId={selected.data.contactId}
                  />
                </dd>
                <dt>Ответственный</dt>
                <dd>
                  {props.users.find((u) => u.id === selected.assigneeId)?.name || 'Не назначен'}
                </dd>
              </dl>
              <TaskAdvice id={selected.id} />
              <div className="actions pico-task-detail-actions">
                <button onClick={() => setPostpone(true)} disabled={busy}>
                  Отложить
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => update(selected, { done: !selected.data.done })}
                >
                  {selected.data.done ? 'Вернуть задачу' : 'Выполнено'}
                </button>
                <button
                  onClick={() => {
                    const c = props.companies.find((c) => c.id === selected.companyId);
                    if (c) props.onCompany(c);
                    setSelected(null);
                  }}
                >
                  Открыть клиента
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm('Удалить задачу?')) return;
                    setBusy(true);
                    try {
                      await api(`/tasks/${selected.id}`, 'DELETE', { version: selected.version });
                      await props.onChanged();
                      setSelected(null);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Удалить задачу
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
export function HomeScreen(
  props: Common & {
    user: Actor;
    onNavigate: (tab: string) => void;
    onCreateCompany: () => void;
    onCreateRecord: (kind: 'task' | 'project') => void;
  },
) {
  const active = props.companies.filter((c) => !c.archived),
    open = props.tasks.filter((t) => !t.data.done),
    todays = open.filter((t) => t.data.due === today());
  return (
    <div className="pico-home">
      <div className="pico-home-greeting">
        {props.user.role === 'admin' && (
          <button
            className="pico-admin-button"
            aria-label="Управление пользователями"
            onClick={() => props.onNavigate('users')}
          >
            <Icon name="crown" />
          </button>
        )}
        <div className="pico-home-welcome">
          <h1>Привет, {props.user.name.split(' ')[0]}!</h1>
          <p className="muted">
            {active.length ? 'Вот что важно на сегодня' : 'Здесь пока пусто. Давайте начнём'}
          </p>
        </div>
      </div>
      {active.length > 0 && (
        <div className="pico-summary">
          {[
            ['Клиенты', active.length, 'companies'],
            ['Проекты', props.projects.length, 'projects'],
            ['Задачи', open.length, 'tasks'],
          ].map(([label, count, tab]) => (
            <button key={label} onClick={() => props.onNavigate(String(tab))}>
              <strong>{count}</strong>
              <small>{label}</small>
            </button>
          ))}
        </div>
      )}
      {!active.length && (
        <>
          <section className="pico-intro">
            <h2>Как работает Pico</h2>
            <p>
              <Icon name="send" /> <strong>Telegram-бот</strong>
            </p>
            <p>
              Пишите или говорите в чат: найти клиента, составить письмо, сделать быструю аналитику.
            </p>
            <p>
              <Icon name="clients" /> <strong>CRM в приложении</strong>
            </p>
            <p>Здесь всё, что собрал бот: клиенты, проекты, задачи и результаты вашей работы.</p>
          </section>
          <h2>С чего начать</h2>
          <div className="pico-onboarding pico-compact-list">
            {[
              [
                'clients',
                'Добавить клиента',
                'Вручную или через Telegram-чат Pico',
                props.onCreateCompany,
              ],
              [
                'projects',
                'Создать проект',
                'Объект, сумма и срок',
                () => props.onCreateRecord('project'),
              ],
              [
                'tasks',
                'Поставить задачу',
                'Следующий шаг по клиенту',
                () => props.onCreateRecord('task'),
              ],
              [
                'analytics',
                'Смотреть аналитику',
                'Потенциал и стадии клиентов',
                () => props.onNavigate('analytics'),
              ],
            ].map(([icon, title, text, action]) => (
              <button key={String(title)} onClick={action as () => void}>
                <span className="pico-row-icon">
                  <Icon name={String(icon)} />
                </span>
                <span>
                  <strong>{String(title)}</strong>
                  <small>{String(text)}</small>
                </span>
                <Icon name="chevron-right" size={16} />
              </button>
            ))}
          </div>
        </>
      )}
      {active.length > 0 && (
        <>
          <h2>Сегодня</h2>
          {todays.some((t) => t.data.type !== 'meeting') ? (
            <TaskList
              inlineActions
              {...props}
              list={todays.filter((t) => t.data.type !== 'meeting')}
            />
          ) : (
            <Empty
              icon="calendar"
              title="На сегодня задач нет"
              text="Хорошее время, чтобы запланировать следующий контакт с клиентами."
            />
          )}
          <h2>Встречи</h2>
          {open.some((t) => t.data.type === 'meeting') ? (
            <TaskList
              {...props}
              list={open
                .filter((t) => t.data.type === 'meeting')
                .sort((a, b) =>
                  String(a.data.due || '9999').localeCompare(String(b.data.due || '9999')),
                )}
            />
          ) : (
            <Empty
              icon="clients"
              title="Встреч пока нет"
              text="Создайте задачу типа «Встреча», чтобы запланировать общение с клиентом."
            />
          )}
        </>
      )}
      {open.some((t) => t.data.due && t.data.due < today()) && (
        <button className="pico-add-row" onClick={() => props.onNavigate('tasks')}>
          Просроченные задачи · {open.filter((t) => t.data.due && t.data.due < today()).length}
          <Icon name="chevron-right" size={16} />
        </button>
      )}
    </div>
  );
}
export function TasksScreen(props: Common & { calendarOnly?: boolean; onCreate: () => void }) {
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('open'),
    [month, setMonth] = useState(today().slice(0, 7)),
    [date, setDate] = useState(today()),
    [byDate, setByDate] = useState(!!props.calendarOnly),
    [type, setType] = useState(''),
    [filtersOpen, setFiltersOpen] = useState(false);
  const search = props.tasks.filter((t) =>
    `${t.data.text} ${t.companyName} ${companyDisplayName(t.companyName)} ${props.projects.find((p) => p.id === t.projectId)?.data.name || ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const list = search
    .filter((t) => !type || t.data.type === type)
    .filter((t) =>
      filter === 'done'
        ? t.data.done
        : filter === 'overdue'
          ? !t.data.done && t.data.due && t.data.due < today()
          : !t.data.done,
    )
    .filter((t) => !byDate || t.data.due === date);
  function shift(n: number) {
    const d = new Date(month + '-01T12:00:00');
    d.setMonth(d.getMonth() + n);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return (
    <>
      <div className="section-head">
        <h1>{props.calendarOnly ? 'Календарь' : 'Задачи'}</h1>
        <button aria-label="Фильтры задач" onClick={() => setFiltersOpen(true)}>
          <Icon name="filter" />
        </button>
      </div>
      <div className="pico-search">
        <Icon name="search" />
        <input
          aria-label="Поиск задач"
          placeholder="Поиск задач, проектов, клиентов"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="pico-calendar panel">
        <div className="section-head">
          <button aria-label="Предыдущий месяц" onClick={() => shift(-1)}>
            <Icon name="chevron-left" />
          </button>
          <strong>
            {new Date(month + '-01T12:00:00').toLocaleDateString('ru-RU', {
              month: 'long',
              year: 'numeric',
            })}
          </strong>
          <button aria-label="Следующий месяц" onClick={() => shift(1)}>
            <Icon name="chevron-right" />
          </button>
        </div>
        <input
          aria-label="Месяц"
          type="month"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
        />
        <div className="calendar">
          {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => (
            <small key={d}>{d}</small>
          ))}
          {Array.from({ length: (new Date(month + '-01T12:00:00').getDay() + 6) % 7 }, (_, i) => (
            <span key={'empty' + i} />
          ))}
          {Array.from(
            { length: new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate() },
            (_, i) => {
              const day = month + '-' + String(i + 1).padStart(2, '0'),
                count = props.tasks.filter((t) => !t.data.done && t.data.due === day).length;
              return (
                <button
                  key={day}
                  aria-label={`${day}${count ? `, открытых задач: ${count}` : ''}`}
                  aria-pressed={byDate && date === day}
                  className={byDate && date === day ? 'selected' : ''}
                  onClick={() => {
                    setDate(day);
                    setByDate(true);
                  }}
                >
                  <strong>{i + 1}</strong>
                  {count > 0 && <span className="calendar-count">{count}</span>}
                </button>
              );
            },
          )}
        </div>
      </div>
      <button className="pico-add-row" onClick={props.onCreate}>
        <Icon name="plus" /> Добавить задачу <Icon name="chevron-right" size={16} />
      </button>
      {filtersOpen && (
        <Modal title="Фильтры задач" onClose={() => setFiltersOpen(false)}>
          <h3>Статус</h3>
          <div className="tabs pico-chips">
            {[
              ['open', 'Открытые'],
              ['overdue', 'Просроченные'],
              ['done', 'Выполненные'],
            ].map(([k, l]) => (
              <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
                {l}
              </button>
            ))}
          </div>
          <h3>Тип задачи</h3>
          <div className="tabs pico-chips">
            {[
              ['', 'Все типы'],
              ['meeting', 'Встреча'],
              ['call', 'Звонок'],
              ['email', 'Письмо'],
              ['reminder', 'Напоминание'],
            ].map(([k, l]) => (
              <button key={k} className={type === k ? 'active' : ''} onClick={() => setType(k)}>
                {l}
              </button>
            ))}
          </div>
          <div className="actions">
            <button className={!byDate ? 'active' : ''} onClick={() => setByDate(false)}>
              Все даты
            </button>
            <button
              onClick={() => {
                setDate(today());
                setMonth(today().slice(0, 7));
                setByDate(true);
              }}
            >
              Сегодня
            </button>
            <button
              onClick={() => {
                setFilter('open');
                setType('');
                setByDate(false);
              }}
            >
              Сбросить
            </button>
            <button className="primary pico-sheet-submit" onClick={() => setFiltersOpen(false)}>
              Показать ({list.length})
            </button>
          </div>
        </Modal>
      )}
      <div className="tabs pico-chips">
        <button className={!byDate ? 'active' : ''} onClick={() => setByDate(false)}>
          Все даты
        </button>
        <button
          onClick={() => {
            setDate(today());
            setMonth(today().slice(0, 7));
            setByDate(true);
          }}
        >
          Сегодня
        </button>
      </div>
      {byDate && <p className="muted">{date}</p>}
      <TaskList {...props} list={list} />
      {props.calendarOnly && (
        <>
          <h3>Без срока</h3>
          <TaskList {...props} list={search.filter((t) => !t.data.due && !t.data.done)} />
        </>
      )}
    </>
  );
}
export function ProjectsScreen(props: Common & { onCreate: () => void }) {
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [filtersOpen, setFiltersOpen] = useState(false),
    [equipment, setEquipment] = useState(''),
    [sort, setSort] = useState('amount'),
    [editing, setEditing] = useState<NamedRecord | null>(null),
    [editingContacts, setEditingContacts] = useState<CrmRecord[]>([]),
    [editingError, setEditingError] = useState('');
  useEffect(() => {
    let current = true;
    setEditingContacts([]);
    setEditingError('');
    if (editing)
      api<{ records: CrmRecord[] }>(`/companies/${editing.companyId}`)
        .then((d) => {
          if (current) setEditingContacts(d.records.filter((r) => r.kind === 'contact'));
        })
        .catch((e) => {
          if (current) setEditingError(e.message);
        });
    return () => {
      current = false;
    };
  }, [editing?.companyId]);
  const list = props.projects
    .filter(
      (p) =>
        (!equipment || p.data.equipment?.some((e: any) => e.division === equipment)) &&
        `${p.data.name} ${p.companyName} ${companyDisplayName(p.companyName)}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'closed' ? p.data.stage === 'closed' : p.data.stage !== 'closed')),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.data.name.localeCompare(b.data.name, 'ru')
        : sort === 'due'
          ? String(a.data.due || '9999').localeCompare(String(b.data.due || '9999'))
          : (b.data.amount || 0) - (a.data.amount || 0),
    );
  return (
    <>
      <div className="section-head">
        <h1>Проекты</h1>
        <button aria-label="Фильтры проектов" onClick={() => setFiltersOpen(true)}>
          <Icon name="filter" />
        </button>
      </div>
      {filtersOpen && (
        <Modal title="Фильтры проектов" onClose={() => setFiltersOpen(false)}>
          <Chips
            label="Оборудование"
            options={primaryDivisions.filter((d) => d !== 'services')}
            value={equipment}
            onChange={setEquipment}
          />
          <Chips
            label="Проектная поставка"
            options={projectSupplyTypes}
            value={equipment}
            onChange={setEquipment}
          />
          <Chips
            label="Услуги"
            options={projectServiceTypes}
            value={equipment}
            onChange={setEquipment}
          />
          <Field label="Сортировка">
            <select
              className="pico-filter-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="amount">Сумма ↓</option>
              <option value="due">Срок ↑</option>
              <option value="name">А–Я</option>
            </select>
          </Field>
          <div className="actions pico-project-filter-actions">
            <button
              onClick={() => {
                setEquipment('');
                setSort('amount');
              }}
            >
              Сбросить
            </button>
            <button className="primary pico-sheet-submit" onClick={() => setFiltersOpen(false)}>
              Показать ({list.length})
            </button>
          </div>
        </Modal>
      )}
      <div className="pico-search">
        <Icon name="search" />
        <input
          aria-label="Поиск проектов"
          placeholder="Поиск проекта или клиента"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="tabs pico-chips">
        {[
          ['all', 'Все'],
          ['open', 'В работе'],
          ['closed', 'Закрытые'],
        ].map(([k, l]) => (
          <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
      </div>
      <button className="pico-add-row" onClick={props.onCreate}>
        <Icon name="plus" /> Добавить проект <Icon name="chevron-right" size={16} />
      </button>
      {editing && (
        <Modal title="Изменить проект" onClose={() => setEditing(null)}>
          {editingError && (
            <p role="alert" className="error">
              {editingError}
            </p>
          )}
          <RecordForm
            kind="project"
            initial={editing}
            contacts={editingContacts}
            projects={props.projects.filter((p) => p.companyId === editing.companyId)}
            companies={props.companies}
            onSave={async (data) => {
              await api(`/records/${editing.id}`, 'PATCH', { version: editing.version, data });
              await props.onChanged();
              setEditing(null);
            }}
          />
        </Modal>
      )}
      <div className="pico-project-list">
        {list.map((p) => (
          <details className="pico-project-row panel" key={p.id}>
            <summary>
              {(() => {
                const company = props.companies.find((c) => c.id === p.companyId),
                  [icon, color] = industryIcon(
                    company?.industry || p.data.objectType || '',
                    company?.segment,
                  );
                return (
                  <span className={'icon-badge badge-' + color}>
                    <Icon name={icon} />
                  </span>
                );
              })()}
              <span>
                <strong>{p.data.name}</strong>
                <small>{companyDisplayName(p.companyName)}</small>
                <small>
                  Сумма: <b>{money(p.data.amount)}</b>
                </small>
              </span>
              <Icon name="chevron-down" size={16} />
            </summary>
            <button className="pico-add-row" onClick={() => setEditing(p)}>
              <Icon name="edit" /> Изменить проект
            </button>
            <dl className="pico-detail-fields">
              <dt>Стадия</dt>
              <dd>{labels[p.data.stage]}</dd>
              <dt>Срок реализации</dt>
              <dd>{p.data.due || 'Не указан'}</dd>
              <dt>Город</dt>
              <dd>{p.data.city || 'Не указан'}</dd>
              <dt>Тип объекта</dt>
              <dd>{p.data.objectType || 'Не указан'}</dd>
              <dt>Дата закупки</dt>
              <dd>{p.data.purchaseDate || 'Не указана'}</dd>
              <dt>Описание</dt>
              <dd>{p.data.notes || 'Не указано'}</dd>
            </dl>
            {p.data.equipment?.length > 0 && (
              <section>
                <h3>
                  Оборудование ·{' '}
                  {money(
                    p.data.equipment.every((e: any) => e.amount !== null)
                      ? p.data.equipment.reduce((s: number, e: any) => s + e.amount, 0)
                      : null,
                  )}
                </h3>
                {p.data.equipment.map((e: any, i: number) => (
                  <div className="pico-potential-client" key={i}>
                    <span>{e.name || labels[e.division]}</span>
                    <strong>{money(e.amount)}</strong>
                  </div>
                ))}
              </section>
            )}
            {p.data.participants?.length > 0 && (
              <section>
                <h3>Участники проекта</h3>
                {p.data.participants.map((member: any, i: number) => (
                  <details key={i}>
                    <summary>
                      {companyDisplayName(
                        props.companies.find((c) => c.id === member.companyId)?.name,
                      ) || 'Клиент недоступен'}{' '}
                      · {member.role}
                    </summary>
                    <dl className="pico-detail-fields">
                      <dt>Контакт</dt>
                      <dd>
                        <ContactLabel companyId={member.companyId} contactId={member.contactId} />
                      </dd>
                      <dt>Текущая задача</dt>
                      <dd>{member.currentTask || 'Не указана'}</dd>
                      <dt>Следующий шаг</dt>
                      <dd>{member.nextStep || 'Не указан'}</dd>
                    </dl>
                    <button
                      onClick={() => {
                        const c = props.companies.find((c) => c.id === member.companyId);
                        if (c) props.onCompany(c);
                      }}
                    >
                      Открыть участника
                    </button>
                  </details>
                ))}
              </section>
            )}
            <button
              className="pico-add-row"
              onClick={() => {
                const c = props.companies.find((c) => c.id === p.companyId);
                if (c) props.onCompany(c);
              }}
            >
              Открыть клиента · {companyDisplayName(p.companyName)}
              <Icon name="chevron-right" size={16} />
            </button>
            <h3>Задачи проекта</h3>
            <TaskList {...props} list={props.tasks.filter((t) => t.projectId === p.id)} />
          </details>
        ))}
      </div>
      {!list.length && (
        <Empty
          icon="projects"
          title="Проектов пока нет"
          text="Добавьте новый проект: строительство, модернизация или расширение."
        />
      )}
      {!props.projects.length && (
        <ScreenGuide
          title="Что будет в карточке проекта"
          items={[
            ['contact', 'Заказчик и объект', 'Кто строит и какой объект'],
            ['projects', 'Оборудование', 'Суммы по направлениям'],
            ['clients', 'Участники', 'Заказчик, проектный институт, подрядчик'],
            ['clock', 'Срок реализации', 'Когда закупка и поставка'],
          ]}
        />
      )}
    </>
  );
}
type PeriodKey = '7' | '30' | '90' | '365' | 'custom';
function calendarRange(key: PeriodKey, anchor = today()) {
  const d = new Date(anchor + 'T12:00:00'),
    format = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (key === '7') {
    const first = new Date(d);
    first.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const last = new Date(first);
    last.setDate(first.getDate() + 6);
    return { from: format(first), to: format(last) };
  }
  if (key === '90') {
    const current = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1, 12),
      first = new Date(current);
    first.setMonth(first.getMonth() - 3);
    const last = new Date(+current - 86400000);
    return { from: format(first), to: format(last) };
  }
  if (key === '365') return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` };
  const first = new Date(d);
  first.setDate(first.getDate() - 29);
  return { from: format(first), to: anchor };
}
const readableRange = (from: string, to: string) =>
  [from, to]
    .map((d) =>
      new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }),
    )
    .join(' — ');
const equipmentIcon = (key: string) =>
  key === 'heat'
    ? 'heat'
    : key === 'services'
      ? 'edit'
      : key === 'cells'
        ? 'server'
        : key.startsWith('drives')
          ? 'gear'
          : 'chip';
export function AnalyticsScreen({
  companies,
  user,
  users,
}: {
  companies: Company[];
  user: Actor;
  users: Actor[];
}) {
  const [period, setPeriod] = useState<PeriodKey>('30'),
    [from, setFrom] = useState(calendarRange('30').from),
    [to, setTo] = useState(today()),
    [periodOpen, setPeriodOpen] = useState(false),
    [draftPeriod, setDraftPeriod] = useState<PeriodKey>('30'),
    [draftFrom, setDraftFrom] = useState(from),
    [draftTo, setDraftTo] = useState(to),
    [summary, setSummary] = useState<AnalyticsSummary | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    setSummary(null);
    api<AnalyticsSummary>(
      `/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
      .then((s) => {
        if (active) setSummary(s);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [from, to, companies]);
  const active = companies.filter((c) => !c.archived),
    directions: readonly string[] = active.some((c) => c.divisions.drives != null)
      ? [...primaryDivisions, 'drives']
      : primaryDivisions;
  const delta = (value: number | null, unit: string) =>
    value == null ? (
      <small className="muted">Нет данных для сравнения</small>
    ) : (
      <small className={value >= 0 ? 'pico-growth positive' : 'pico-growth negative'}>
        {value >= 0 ? '↑ +' : '↓ '}
        {Math.round(value * 10) / 10}
        {unit} к предыдущему периоду
      </small>
    );
  return (
    <>
      <div className="section-head">
        <h1>Аналитика</h1>
        <button
          className="pico-period-trigger"
          aria-label="Период аналитики"
          onClick={() => {
            setDraftPeriod(period);
            setDraftFrom(from);
            setDraftTo(to);
            setPeriodOpen(true);
          }}
        >
          {period === 'custom'
            ? 'Свой период'
            : period === '90'
              ? 'Квартал'
              : period === '365'
                ? 'Год'
                : period === '7'
                  ? 'Неделя'
                  : '30 дней'}{' '}
          <Icon name="chevron-down" size={14} />
        </button>
      </div>
      {periodOpen && (
        <Modal title="Период" onClose={() => setPeriodOpen(false)}>
          <div className="pico-period-options" role="radiogroup" aria-label="Период аналитики">
            {(
              [
                ['7', 'Неделя'],
                ['30', 'Месяц'],
                ['90', 'Квартал'],
                ['365', 'Год'],
                ['custom', 'Свой период'],
              ] as [PeriodKey, string][]
            ).map(([key, title]) => {
              const range = calendarRange(key);
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={draftPeriod === key}
                  className="pico-period-option"
                  key={key}
                  onClick={() => {
                    setDraftPeriod(key);
                    if (key !== 'custom') {
                      setDraftFrom(range.from);
                      setDraftTo(range.to);
                    }
                  }}
                >
                  <span className={'pico-radio ' + (draftPeriod === key ? 'checked' : '')} />
                  <strong>{title}</strong>
                  <small>
                    {key === 'custom'
                      ? 'Выбрать даты'
                      : key === '365'
                        ? String(new Date().getFullYear())
                        : readableRange(range.from, range.to)}
                  </small>
                </button>
              );
            })}
          </div>
          {draftPeriod === 'custom' && (
            <div className="pico-form-two">
              <Field label="Начало периода">
                <input
                  type="date"
                  value={draftFrom}
                  max={draftTo}
                  onChange={(e) => setDraftFrom(e.target.value)}
                />
              </Field>
              <Field label="Конец периода">
                <input
                  type="date"
                  value={draftTo}
                  min={draftFrom}
                  onChange={(e) => setDraftTo(e.target.value)}
                />
              </Field>
            </div>
          )}
          <button
            className="primary pico-sheet-submit"
            disabled={!draftFrom || !draftTo || draftFrom > draftTo}
            onClick={() => {
              setPeriod(draftPeriod);
              setFrom(draftFrom);
              setTo(draftTo);
              setPeriodOpen(false);
            }}
          >
            Применить
          </button>
        </Modal>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!companies.length ? (
        <>
          <section className="pico-intro">
            <h2>Как работает аналитика</h2>
            <div className="pico-analytics-journey">
              <span>
                <Icon name="email" size={28} />
                Вы пишете в чат
              </span>
              <Icon name="chevron-right" />
              <span>
                <Icon name="sparkles" size={28} />
                Pico разбирает заметки
              </span>
              <Icon name="chevron-right" />
              <span>
                <Icon name="analytics" size={28} />
                Видите итоги
              </span>
            </div>
            <p>
              Pico структурирует заметки по каждому клиенту и подсказывает, что ещё уточнить для
              следующего шага.
            </p>
          </section>
          <ScreenGuide
            title="Как считаются показатели"
            items={[
              ['funnel', 'Воронка продаж', 'Стадии клиентов, созданных за выбранный период'],
              ['tasks', 'Конверсия', 'Доля завершённых клиентов среди созданных за период'],
              ['potential', 'Потенциал', 'Годовой потенциал активных клиентов по направлениям'],
            ]}
          />
        </>
      ) : (
        <>
          {!summary && !error && <p role="status">Загрузка аналитики…</p>}
          {summary && (
            <>
              <section className="panel pico-funnel">
                <h2>
                  <span className="pico-row-icon">
                    <Icon name="funnel" />
                  </span>
                  Воронка продаж
                </h2>
                <p className="muted">По подтверждённым данным CRM за {readableRange(from, to)}</p>
                {summary.funnel.map((stage, index) => (
                  <div className="pico-funnel-row" key={stage.key}>
                    <span
                      className={'pico-funnel-bar funnel-' + index}
                      style={{ width: `${100 - index * 13}%` }}
                    >
                      {stage.count}
                    </span>
                    <span>{stage.label}</span>
                    <strong>{stage.count}</strong>
                  </div>
                ))}
              </section>
              <div className="pico-analytics-metrics">
                <section className="panel">
                  <small>
                    <Icon name="tasks" size={15} /> Конверсия
                  </small>
                  <strong>
                    {summary.conversion == null ? '—' : Math.round(summary.conversion) + '%'}
                  </strong>
                  {delta(summary.conversionDelta, ' п.п.')}
                </section>
                <section className="panel">
                  <small>
                    <Icon name="clients" size={15} /> Активные клиенты
                  </small>
                  <strong>{summary.activeClients}</strong>
                  {delta(summary.activeDelta, '%')}
                </section>
              </div>
              {summary.historyIncomplete > 0 && (
                <p className="muted">
                  Для части старых клиентов недостаточно данных для сравнения периодов.
                </p>
              )}
            </>
          )}
          <section className="panel pico-potential">
            <h2>
              <span className="pico-row-icon">
                <Icon name="potential" />
              </span>
              Потенциал по оборудованию
            </h2>
            {directions.map((direction) => {
              const list = active.filter(
                  (c) => c.divisions[direction as keyof Company['divisions']] != null,
                ),
                sum = list.reduce(
                  (total, c) => total + (c.divisions[direction as keyof Company['divisions']] || 0),
                  0,
                );
              return (
                <details key={direction}>
                  <summary>
                    <span className="pico-row-icon">
                      <Icon name={equipmentIcon(direction)} size={16} />
                    </span>
                    <span className="pico-equipment-label">{divisionLabels[direction]}</span>
                    <strong>{list.length ? money(sum) : '—'}</strong>
                    <Icon name="chevron-down" size={16} />
                  </summary>
                  {list.map((c) => (
                    <div className="pico-potential-client" key={c.id}>
                      <span>{companyDisplayName(c.name)}</span>
                      <strong>{money(c.divisions[direction as keyof Company['divisions']])}</strong>
                    </div>
                  ))}
                  {!list.length && <p className="muted">Потенциал пока не указан</p>}
                </details>
              );
            })}
          </section>
        </>
      )}
      {user.role !== 'manager' && <CommercialReport users={users} />}
    </>
  );
}
