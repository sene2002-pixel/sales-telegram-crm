import { useEffect, useState } from 'react';
import {
  Actor,
  Company,
  CrmRecord,
  divisions,
  labels,
  stages,
  taskSchema,
  taskTypeLabels,
} from '../shared/contracts';
import { api, money, today } from './api';
import { Field, Modal, RecordForm } from './forms';
import { Icon } from './Icons';
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
    [contactError, setContactError] = useState('');
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
      <Field label="Клиент">
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">Выберите клиента</option>
          {companies
            .filter((c) => !c.archived)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </Field>
      {contactError && (
        <p className="error" role="alert">
          {contactError}
        </p>
      )}
      {companyId ? (
        <RecordForm
          key={companyId}
          kind={kind}
          companies={companies}
          contacts={contacts}
          projects={projects.filter((p) => p.companyId === companyId)}
          onSave={async (data, projectId) => {
            await api(`/companies/${companyId}/records/${kind}`, 'POST', { data, projectId });
            await onChanged();
            onClose();
          }}
        />
      ) : (
        <p className="muted">
          Выберите клиента, чтобы {kind === 'task' ? 'добавить задачу' : 'создать проект'}.
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
    <span>
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
          <article className="pico-task-row task-row" key={t.id}>
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
                {t.companyName}
                {t.data.due
                  ? ' · ' + t.data.due + (t.data.time ? ' · ' + t.data.time : '')
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
                  Через час
                </button>
                {[
                  ['Завтра', 1],
                  ['Через неделю', 7],
                ].map(([label, n]) => (
                  <button
                    key={label}
                    onClick={() => {
                      const d = new Date(today() + 'T12:00:00');
                      d.setDate(d.getDate() + Number(n));
                      setDue(
                        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                      );
                    }}
                  >
                    {label}
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
                <dd>{selected.companyName}</dd>
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
              <div className="actions">
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
      <div className="section-head">
        <h1>Привет, {props.user.name.split(' ')[0]}!</h1>
        {props.user.role === 'admin' && (
          <button
            className="pico-admin-button"
            aria-label="Управление пользователями"
            onClick={() => props.onNavigate('team')}
          >
            <Icon name="crown" />
          </button>
        )}
      </div>
      <p className="muted">
        {active.length ? 'Вот что важно на сегодня' : 'Здесь пока пусто. Давайте начнём'}
      </p>
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
    `${t.data.text} ${t.companyName} ${props.projects.find((p) => p.id === t.projectId)?.data.name || ''}`
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
            <button className="primary" onClick={() => setFiltersOpen(false)}>
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
        `${p.data.name} ${p.companyName}`.toLowerCase().includes(query.toLowerCase()) &&
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
          <Field label="Оборудование">
            <select value={equipment} onChange={(e) => setEquipment(e.target.value)}>
              <option value="">Все направления</option>
              {divisions.map((d) => (
                <option key={d} value={d}>
                  {labels[d]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Сортировка">
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="amount">Сумма ↓</option>
              <option value="due">Срок ↑</option>
              <option value="name">А–Я</option>
            </select>
          </Field>
          <div className="actions">
            <button
              onClick={() => {
                setEquipment('');
                setSort('amount');
              }}
            >
              Сбросить
            </button>
            <button className="primary" onClick={() => setFiltersOpen(false)}>
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
              <span className="pico-row-icon">
                <Icon name="projects" />
              </span>
              <span>
                <strong>{p.data.name}</strong>
                <small>{p.companyName}</small>
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
                      {props.companies.find((c) => c.id === member.companyId)?.name ||
                        'Клиент недоступен'}{' '}
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
              Открыть клиента · {p.companyName}
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
export function AnalyticsScreen({
  companies,
  user,
  users,
}: {
  companies: Company[];
  user: Actor;
  users: Actor[];
}) {
  const [period, setPeriod] = useState('30'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(today()),
    [periodOpen, setPeriodOpen] = useState(false),
    [draftPeriod, setDraftPeriod] = useState('30'),
    [draftFrom, setDraftFrom] = useState(''),
    [draftTo, setDraftTo] = useState(today());
  const start = new Date(today() + 'T00:00:00');
  start.setDate(start.getDate() - Number(period) + 1);
  const lower =
      period === 'custom'
        ? from
        : `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
    upper = period === 'custom' ? to : today();
  const active = companies.filter((c) => !c.archived),
    cohort = active.filter(
      (c) => c.createdAt.slice(0, 10) >= lower && c.createdAt.slice(0, 10) <= upper,
    ),
    closed = cohort.filter((c) => c.stage === 'closed').length;
  return (
    <>
      <div className="section-head">
        <h1>Аналитика</h1>
        <button
          aria-label="Период аналитики"
          onClick={() => {
            setDraftPeriod(period);
            setDraftFrom(from);
            setDraftTo(to);
            setPeriodOpen(true);
          }}
        >
          {period === 'custom' ? 'Свой период' : period + ' дней'}{' '}
          <Icon name="chevron-down" size={16} />
        </button>
      </div>
      {periodOpen && (
        <Modal title="Период" onClose={() => setPeriodOpen(false)}>
          <Field label="Период аналитики">
            <select value={draftPeriod} onChange={(e) => setDraftPeriod(e.target.value)}>
              <option value="7">Неделя</option>
              <option value="30">Месяц</option>
              <option value="90">Квартал</option>
              <option value="365">Год</option>
              <option value="custom">Свой период</option>
            </select>
          </Field>
          {draftPeriod === 'custom' && (
            <div className="form-grid">
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
            className="primary"
            disabled={draftPeriod === 'custom' && (!draftFrom || !draftTo || draftFrom > draftTo)}
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
      {active.length > 0 && (
        <>
          <section className="panel pico-funnel">
            <h2>
              <Icon name="filter" /> Воронка продаж
            </h2>
            <p className="muted">Текущие стадии клиентов, созданных за выбранный период</p>
            {stages.map((s, i) => {
              const count = cohort.filter((c) => c.stage === s).length;
              return (
                <div className="pico-funnel-row" key={s}>
                  <span
                    className={'pico-funnel-bar funnel-' + i}
                    style={{ width: `${100 - i * 13}%` }}
                  >
                    {count}
                  </span>
                  <span>{labels[s]}</span>
                  <strong>{count}</strong>
                </div>
              );
            })}
          </section>
          <div className="pico-analytics-metrics">
            <section className="panel">
              <small>Доля завершённых клиентов</small>
              <strong>{cohort.length ? Math.round((closed / cohort.length) * 100) : 0}%</strong>
              <small>Среди созданных за период</small>
            </section>
            <section className="panel">
              <small>Активные клиенты</small>
              <strong>{active.length}</strong>
              <small>Все неархивные клиенты</small>
            </section>
          </div>
          <section className="panel pico-potential">
            <h2>
              <Icon name="layers" /> Потенциал по направлениям
            </h2>
            <p className="muted">Годовой потенциал всех активных клиентов</p>
            {divisions.map((d) => {
              const list = active.filter((c) => c.divisions[d] != null),
                sum = list.reduce((s, c) => s + (c.divisions[d] || 0), 0);
              return (
                <details key={d}>
                  <summary>
                    <Icon name="projects" size={18} />
                    <span>{labels[d]}</span>
                    <strong>{list.length ? money(sum) : '—'}</strong>
                    <Icon name="chevron-down" size={16} />
                  </summary>
                  {list.map((c) => (
                    <div className="pico-potential-client" key={c.id}>
                      <span>{c.name}</span>
                      <strong>{money(c.divisions[d])}</strong>
                    </div>
                  ))}
                  {!list.length && <p className="muted">Потенциал пока не указан</p>}
                </details>
              );
            })}
          </section>
        </>
      )}
      {!active.length && (
        <>
          <section className="pico-intro">
            <h2>Как работает аналитика</h2>
            <p>Вы пишете в чат → Pico разбирает заметки → Вы видите итоги.</p>
            <p>Подтвердите данные клиентов, чтобы увидеть стадии и годовой потенциал.</p>
          </section>
          <ScreenGuide
            title="Как считаются показатели"
            items={[
              [
                'funnel',
                'Воронка продаж',
                'Текущие стадии клиентов, созданных за выбранный период',
              ],
              ['tasks', 'Доля завершённых', 'Доля завершённых клиентов среди созданных за период'],
              ['potential', 'Потенциал', 'Годовой потенциал активных клиентов по направлениям'],
            ]}
          />
        </>
      )}
      {user.role !== 'manager' && <CommercialReport users={users} />}
    </>
  );
}
