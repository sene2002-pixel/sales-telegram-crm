import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Actor, Company, CrmRecord, labels, segments, divisions, roles } from '../shared/contracts';
import { api, setToken, token, today, money, download } from './api';
import { CompanyForm, Modal, Select } from './forms';
import { CompanyDetail } from './CompanyDetail';
import { Reports } from './Reports';
import { Team } from './Team';
import './styles.css';
declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        ready: () => void;
        expand: () => void;
        BackButton?: {
          show: () => void;
          hide: () => void;
          onClick: (fn: () => void) => void;
          offClick: (fn: () => void) => void;
        };
      };
    };
  }
}
function App() {
  const [user, setUser] = useState<Actor | null>(null),
    [users, setUsers] = useState<Actor[]>([]),
    [companies, setCompanies] = useState<Company[]>([]),
    [tasks, setTasks] = useState<(CrmRecord & { companyName: string })[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [dev, setDev] = useState(false),
    [tab, setTab] = useState(
      new URLSearchParams(location.search).has('report') ? 'reports' : 'companies',
    );
  const [selected, setSelected] = useState<Company | null>(null),
    [create, setCreate] = useState(false),
    [query, setQuery] = useState(''),
    [city, setCity] = useState(''),
    [segment, setSegment] = useState(''),
    [division, setDivision] = useState(''),
    [owner, setOwner] = useState(''),
    [archive, setArchive] = useState(false),
    [taskFilter, setTaskFilter] = useState('open'),
    [date, setDate] = useState(today()),
    [calendarMonth, setCalendarMonth] = useState(today().slice(0, 7));
  const [files, setFiles] = useState<(CrmRecord & { companyName: string })[]>([]),
    [projects, setProjects] = useState<(CrmRecord & { companyName: string })[]>([]);
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const [c, u, t, f, p] = await Promise.all([
      api<Company[]>('/companies'),
      api<Actor[]>('/users'),
      api<any[]>('/records/task'),
      api<any[]>('/records/file'),
      api<any[]>('/records/project'),
    ]);
    setCompanies(c);
    setUsers(u);
    setTasks(t);
    setFiles(f);
    setProjects(p);
  }
  async function login(role?: string) {
    setError('');
    setLoading(true);
    try {
      const result = role
        ? await api('/auth/dev', 'POST', { role })
        : await api('/auth/telegram', 'POST', {
            initData: window.Telegram?.WebApp?.initData || '',
          });
      setToken(result.token);
      setUser(result.user);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
    api('/config')
      .then((c) => setDev(c.devAuth))
      .catch(() => {});
    (async () => {
      try {
        if (window.Telegram?.WebApp?.initData) {
          await login();
          return;
        }
        if (token) {
          setUser(await api('/me'));
          await refresh();
        }
      } catch (e) {
        setToken('');
        setUser(null);
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  useEffect(() => {
    const back = window.Telegram?.WebApp?.BackButton;
    if (!back) return;
    const close = () => {
      setSelected(null);
      setCreate(false);
    };
    if (selected || create) {
      back.show();
      back.onClick(close);
    } else back.hide();
    return () => back.offClick(close);
  }, [selected, create]);
  useEffect(() => {
    if (!user) return;
    const onFocus = () => refresh().catch((e) => setError(e.message));
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [user]);
  async function toggle(task: CrmRecord) {
    setBusy(true);
    setError('');
    try {
      await api(`/records/${task.id}`, 'PATCH', {
        version: task.version,
        data: { text: task.data.text, due: task.data.due, done: !task.data.done },
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!user)
    return (
      <main className="login">
        <div className="brand-mark">к</div>
        <p className="eyebrow">КОМАНДА. КЛИЕНТЫ. РЕЗУЛЬТАТ.</p>
        <h1>Контакт</h1>
        <p className="muted">
          CRM, которая начинается
          <br />с одного голосового сообщения.
        </p>
        {loading ? <p>Подключение…</p> : <p>Откройте приложение кнопкой CRM в Telegram-боте.</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {dev && (
          <div className="demo">
            <p>Локальная демонстрация</p>
            {roles.map((role) => (
              <button disabled={loading} key={role} onClick={() => login(role)}>
                {labels[role]}
              </button>
            ))}
          </div>
        )}
      </main>
    );
  const nav = [
    ['companies', 'База', '◫'],
    ['reports', 'Отчёты', '◉'],
    ['tasks', 'Задачи', '✓'],
    ['calendar', 'Календарь', '▦'],
    ['projects', 'Проекты', '▱'],
    ['files', 'Файлы', '▤'],
    ...(user.role !== 'manager' ? [['team', 'Команда', '◎']] : []),
  ];
  const visible = companies.filter(
    (c) =>
      c.archived === archive &&
      (!query || `${c.name} ${c.inn}`.toLowerCase().includes(query.toLowerCase())) &&
      (!city || c.city === city) &&
      (!segment || c.segment === segment) &&
      (!division || c.divisions[division as keyof typeof c.divisions] != null) &&
      (!owner || c.ownerId === owner),
  );
  const filteredTasks = tasks.filter((t) =>
    taskFilter === 'done'
      ? t.data.done
      : taskFilter === 'overdue'
        ? !t.data.done && t.data.due && t.data.due < today()
        : !t.data.done,
  );
  const taskRows = (list: typeof tasks) => (
    <div className="list">
      {list.map((t) => (
        <article className="task-row" key={t.id}>
          <button
            className={'checkbox ' + (t.data.done ? 'checked' : '')}
            aria-label={t.data.done ? 'Вернуть задачу' : 'Выполнить задачу'}
            disabled={busy}
            onClick={() => toggle(t)}
          >
            {t.data.done ? '✓' : ''}
          </button>
          <button
            className="task-text"
            onClick={() => setSelected(companies.find((c) => c.id === t.companyId) || null)}
          >
            <strong className={t.data.done ? 'done' : ''}>{t.data.text}</strong>
            <small>
              {t.companyName}
              {t.data.due ? ' · до ' + t.data.due : ' · без срока'} ·{' '}
              {users.find((u) => u.id === t.assigneeId)?.name || ''}
            </small>
          </button>
          {!t.data.done && t.data.due && t.data.due < today() && (
            <span className="status failed">Просрочено</span>
          )}
        </article>
      ))}
      {!list.length && (
        <div className="empty">
          Задач пока нет. Добавьте задачу в карточке компании или отправьте отчёт.
        </div>
      )}
    </div>
  );
  return (
    <div className="app-shell">
      <aside>
        <div className="logo">
          <span className="brand-mark">к</span>
          <strong>Контакт</strong>
          <span className="beta">CRM</span>
        </div>
        <nav>
          {nav.map(([key, label, icon]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              onClick={() => {
                setTab(key!);
                setError('');
              }}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="profile">
          <span className="avatar">{user.name.slice(0, 1)}</span>
          <div>
            <strong>{user.name}</strong>
            <small>{labels[user.role]}</small>
          </div>
          <button
            title="Выйти"
            onClick={() => {
              setToken('');
              setUser(null);
            }}
          >
            ↗
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <span>Рабочее пространство</span>
          <div>
            <span className="online-dot" />
            Подключено{' '}
            <button
              className="text-button"
              onClick={() => refresh().catch((e) => setError(e.message))}
            >
              Обновить
            </button>
          </div>
        </header>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {tab === 'companies' && (
          <>
            <div className="section-head">
              <div>
                <p className="eyebrow">ОТ ПЕРВОГО КОНТАКТА ДО ПОСТАВКИ</p>
                <h1>Клиенты и компании</h1>
              </div>
              <button className="primary" onClick={() => setCreate(true)}>
                + Компания
              </button>
            </div>
            <div className="metrics">
              <div>
                <span>Компаний в работе</span>
                <strong>{companies.filter((c) => !c.archived).length}</strong>
              </div>
              <div>
                <span>Открытых задач</span>
                <strong>{tasks.filter((t) => !t.data.done).length}</strong>
              </div>
              <div>
                <span>Просрочено</span>
                <strong className="danger">
                  {tasks.filter((t) => !t.data.done && t.data.due && t.data.due < today()).length}
                </strong>
              </div>
              <div>
                <span>Потенциал</span>
                <strong>
                  {money(
                    companies
                      .filter((c) => !c.archived)
                      .reduce((s, c) => s + (c.potential || 0), 0),
                  )}
                </strong>
              </div>
            </div>
            <div className="filters">
              <input
                aria-label="Поиск компаний"
                placeholder="Поиск по названию или ИНН"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Select
                value={city}
                onChange={setCity}
                options={[...new Set(companies.map((c) => c.city).filter(Boolean))].sort()}
                empty="Все города"
              />
              <Select
                value={segment}
                onChange={setSegment}
                options={segments}
                empty="Все сегменты"
              />
              <Select
                value={division}
                onChange={setDivision}
                options={divisions}
                empty="Все направления"
              />
              {user.role !== 'manager' && (
                <select
                  aria-label="Ответственный"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  <option value="">Все сотрудники</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              )}
              <button className={archive ? 'active' : ''} onClick={() => setArchive(!archive)}>
                {archive ? '✓ Архив' : 'Архив'}
              </button>
            </div>
            <div className="section-head">
              <h3>
                {archive ? 'Архив компаний' : 'База клиентов'}{' '}
                <span className="count">{visible.length}</span>
              </h3>
              <small>Данные сохраняются автоматически после подтверждения формы</small>
            </div>
            <div className="company-grid">
              {visible.map((c, i) => (
                <button className="company-card" key={c.id} onClick={() => setSelected(c)}>
                  <div className="section-head">
                    <span className={'city color-' + (i % 4)}>{c.city || 'Без города'}</span>
                    <span className="stage">{labels[c.stage]}</span>
                  </div>
                  <h2>{c.name}</h2>
                  <p>
                    {labels[c.segment]}
                    {c.industry ? ' · ' + c.industry : ''}
                  </p>
                  <div className="company-money">
                    <small>Потенциал</small>
                    <strong>{money(c.potential)}</strong>
                  </div>
                  <footer>
                    <span className="avatar small">{c.ownerName.slice(0, 1)}</span>
                    <span>{c.ownerName}</span>
                    <span className="arrow">↗</span>
                  </footer>
                </button>
              ))}
            </div>
            {!visible.length && (
              <div className="empty">
                <h3>
                  {companies.length
                    ? 'Нет компаний по выбранным фильтрам'
                    : 'Начните с первого клиента'}
                </h3>
                <p>Добавьте компанию вручную или отправьте голосовой отчёт боту.</p>
              </div>
            )}
          </>
        )}
        {tab === 'reports' && <Reports companies={companies} onChanged={refresh} />}
        {tab === 'tasks' && (
          <>
            <p className="eyebrow">СЛЕДУЮЩИЙ ШАГ</p>
            <h1>Задачи</h1>
            <div className="tabs">
              {[
                ['open', 'Открытые'],
                ['overdue', 'Просроченные'],
                ['done', 'Выполненные'],
              ].map(([k, l]) => (
                <button
                  key={k}
                  className={taskFilter === k ? 'active' : ''}
                  onClick={() => setTaskFilter(k!)}
                >
                  {l}
                </button>
              ))}
            </div>
            {taskRows(filteredTasks)}
          </>
        )}
        {tab === 'calendar' && (
          <>
            <p className="eyebrow">ПЛАН НА МЕСЯЦ</p>
            <h1>Календарь</h1>
            <div className="filters">
              <input
                aria-label="Месяц"
                type="month"
                value={calendarMonth}
                onChange={(e) => setCalendarMonth(e.target.value)}
              />
              <button
                onClick={() => {
                  setCalendarMonth(today().slice(0, 7));
                  setDate(today());
                }}
              >
                Сегодня
              </button>
            </div>
            <div className="calendar">
              {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => (
                <small key={d}>{d}</small>
              ))}
              {Array.from(
                { length: (new Date(calendarMonth + '-01T12:00:00').getDay() + 6) % 7 },
                (_, i) => (
                  <span key={'empty' + i} />
                ),
              )}
              {Array.from(
                {
                  length: new Date(
                    Number(calendarMonth.slice(0, 4)),
                    Number(calendarMonth.slice(5, 7)),
                    0,
                  ).getDate(),
                },
                (_, i) => {
                  const key = calendarMonth + '-' + String(i + 1).padStart(2, '0'),
                    count = tasks.filter((t) => t.data.due === key && !t.data.done).length;
                  return (
                    <button
                      className={date === key ? 'selected' : ''}
                      key={key}
                      onClick={() => setDate(key)}
                    >
                      <strong>{i + 1}</strong>
                      {count > 0 && <span>{count} задач</span>}
                    </button>
                  );
                },
              )}
            </div>
            <h3>{date}</h3>
            {taskRows(tasks.filter((t) => t.data.due === date))}
            <h3>Без срока</h3>
            {taskRows(tasks.filter((t) => !t.data.due && !t.data.done))}
          </>
        )}
        {tab === 'projects' && (
          <>
            <p className="eyebrow">ВОЗМОЖНОСТИ И ПОСТАВКИ</p>
            <h1>Проекты</h1>
            <div className="list">
              {projects.map((p) => (
                <button
                  className="report-row"
                  key={p.id}
                  onClick={() => setSelected(companies.find((c) => c.id === p.companyId) || null)}
                >
                  <strong>{p.data.name}</strong>
                  <span>
                    {p.companyName} · {money(p.data.amount)}
                  </span>
                  <small>
                    {labels[p.data.stage]} · {p.data.due || 'Без срока'}
                  </small>
                </button>
              ))}
            </div>
            {!projects.length && <p className="empty">Добавьте проект в карточке компании.</p>}
          </>
        )}
        {tab === 'files' && (
          <>
            <p className="eyebrow">ВСЁ ПОД РУКОЙ</p>
            <h1>Документы</h1>
            <div className="list">
              {files.map((f) => (
                <article className="task-row" key={f.id}>
                  <div className="task-text">
                    <strong>{f.data.name}</strong>
                    <small>
                      {f.companyName} · {labels[f.data.category]} · {Math.ceil(f.data.size / 1024)}{' '}
                      КБ
                    </small>
                  </div>
                  <button
                    onClick={() =>
                      download(`/files/${f.id}`, f.data.name).catch((e) => setError(e.message))
                    }
                  >
                    Скачать
                  </button>
                </article>
              ))}
            </div>
            {!files.length && (
              <p className="empty">Загрузите документы через карточку компании или проекта.</p>
            )}
          </>
        )}
        {tab === 'team' && user.role !== 'manager' && (
          <Team user={user} users={users} onChanged={refresh} />
        )}
      </main>
      {create && (
        <Modal title="Новая компания" onClose={() => setCreate(false)}>
          <CompanyForm
            onSave={async (data) => {
              const c = await api('/companies', 'POST', data);
              setCreate(false);
              await refresh();
              setSelected(c);
            }}
          />
        </Modal>
      )}
      {selected && (
        <CompanyDetail
          key={selected.id}
          company={selected}
          user={user}
          users={users}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
