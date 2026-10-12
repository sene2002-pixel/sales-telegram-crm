import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Actor,
  Company,
  CrmRecord,
  labels,
  segments,
  divisions,
  roles,
  primarySegments,
  primaryDivisions,
} from '../shared/contracts';
import { api, ApiError, setToken, token, download } from './api';
import { CompanyForm, Modal, Select, Chips } from './forms';
import { CompanyDetail } from './CompanyDetail';
import { Reports } from './Reports';
import { Team } from './Team';
import { RoleGuide } from './RoleGuide';
import { Profile } from './Profile';
import { UsersScreen } from './Users';
import { ClientRow } from './ClientRow';
import { Icon } from './Icons';
import {
  HomeScreen,
  TasksScreen,
  ProjectsScreen,
  AnalyticsScreen,
  RecordCreate,
  ScreenGuide,
} from './Screens';
import './styles.css';
declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        ready: () => void;
        expand: () => void;
        isVersionAtLeast?: (version: string) => boolean;
        downloadFile?: (
          params: { url: string; file_name: string },
          callback?: (accepted: boolean) => void,
        ) => void;
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
      new URLSearchParams(location.search).has('report') ? 'reports' : 'home',
    );
  const [selected, setSelected] = useState<Company | null>(null),
    [create, setCreate] = useState(false),
    [query, setQuery] = useState(''),
    [city, setCity] = useState(''),
    [segment, setSegment] = useState(''),
    [division, setDivision] = useState(''),
    [owner, setOwner] = useState(''),
    [archive, setArchive] = useState(false);
  const [files, setFiles] = useState<(CrmRecord & { companyName: string })[]>([]),
    [projects, setProjects] = useState<(CrmRecord & { companyName: string })[]>([]),
    [contacts, setContacts] = useState<CrmRecord[]>([]);
  const [help, setHelp] = useState(false);
  const [more, setMore] = useState(false),
    [recordCreate, setRecordCreate] = useState<'task' | 'project' | null>(null),
    [filtersOpen, setFiltersOpen] = useState(false),
    [clientStatus, setClientStatus] = useState('all'),
    [clientSort, setClientSort] = useState('name'),
    [selectedTab, setSelectedTab] = useState('contact'),
    [createdClientId, setCreatedClientId] = useState('');
  const refreshSequence = useRef(0);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !moreMenuRef.current?.contains(event.target) &&
        !moreButtonRef.current?.contains(event.target)
      )
        setMore(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMore(false);
        moreButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [more]);
  function clearAccountData() {
    setCompanies([]);
    setUsers([]);
    setTasks([]);
    setFiles([]);
    setProjects([]);
    setContacts([]);
    setSelected(null);
    setCreate(false);
    setRecordCreate(null);
    setFiltersOpen(false);
    setHelp(false);
    setMore(false);
    setQuery('');
    setCity('');
    setSegment('');
    setDivision('');
    setOwner('');
    setArchive(false);
    setClientStatus('all');
    setClientSort('name');
    setSelectedTab('contact');
    setCreatedClientId('');
    setTab('home');
  }
  function logout() {
    ++refreshSequence.current;
    setToken('');
    setUser(null);
    clearAccountData();
    setError('');
  }
  async function refreshActor() {
    const sequence = ++refreshSequence.current;
    let actor: Actor;
    try {
      actor = await api<Actor>('/me');
    } catch (e) {
      if (
        sequence === refreshSequence.current &&
        e instanceof ApiError &&
        (e.status === 401 || e.status === 403)
      )
        logout();
      throw e;
    }
    if (sequence !== refreshSequence.current) return;
    if (user && (user.id !== actor.id || user.role !== actor.role)) clearAccountData();
    setUser((current) => (current ? actor : current));
    const [c, u, t, f, p, contacts] = await Promise.all([
      api<Company[]>('/companies'),
      api<Actor[]>('/users'),
      api<any[]>('/records/task'),
      api<any[]>('/records/file'),
      api<any[]>('/records/project'),
      api<CrmRecord[]>('/records/contact'),
    ]);
    if (sequence !== refreshSequence.current) return;
    setCompanies(c);
    setUsers(u);
    setUser((current) => (current ? actor : current));
    setTasks(t);
    setFiles(f);
    setProjects(p);
    setContacts(contacts);
    return actor;
  }
  async function refresh() {
    await refreshActor();
  }
  useEffect(() => {
    if (
      (tab === 'users' && user?.role !== 'admin') ||
      (tab === 'team' && user?.role === 'manager')
    ) {
      setTab('home');
    }
  }, [user?.role, tab]);
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
      const actor = await refreshActor();
      if (actor) setUser(actor);
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
    if (!user) return;
    const onFocus = () => refresh().catch((e) => setError(e.message));
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [user]);
  if (!user)
    return (
      <main className="login">
        <img
          className="brand-mark"
          src="/brand/pico-avatar.png"
          alt="Pico — AI-помощник"
          width="112"
          height="112"
        />
        <p className="eyebrow">ТВОЙ AI-ПОМОЩНИК В TELEGRAM</p>
        <h1>Pico</h1>
        <p className="muted">
          CRM, которая начинается
          <br />с одного голосового сообщения.
        </p>
        {loading ? (
          <p role="status">Подключение…</p>
        ) : (
          <p>Откройте приложение кнопкой CRM в Telegram-боте.</p>
        )}
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
    ['home', 'Главная', 'home'],
    ['companies', 'Клиенты', 'clients'],
    ['projects', 'Проекты', 'projects'],
    ['tasks', 'Задачи', 'tasks'],
    ['analytics', 'Аналитика', 'analytics'],
  ];
  const secondary = [
    ['reports', 'Отчёты'],
    ['calendar', 'Календарь'],
    ['files', 'Файлы'],
    ['profile', 'Мой профиль'],
    ...(user.role !== 'manager' ? [['team', 'Команда']] : []),
    ...(user.role === 'admin' ? [['users', 'Пользователи']] : []),
  ];
  const openCompany = (company: Company, nextTab = 'contact') => {
    setSelectedTab(nextTab);
    setSelected(company);
  };
  const screenProps = {
    companies,
    projects,
    tasks,
    users,
    onChanged: refresh,
    onCompany: openCompany,
  };
  const visible = companies.filter(
    (c) =>
      c.archived === archive &&
      (clientStatus === 'all' ||
        (clientStatus === 'closed' ? c.stage === 'closed' : c.stage !== 'closed')) &&
      (!query ||
        `${c.name} ${c.inn} ${contacts
          .filter((contact) => contact.companyId === c.id)
          .map((contact) => `${contact.data.name} ${contact.data.phone} ${contact.data.email}`)
          .join(' ')}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (!city || c.city === city) &&
      (!segment || c.segment === segment) &&
      (!division || c.divisions[division as keyof typeof c.divisions] != null) &&
      (!owner || c.ownerId === owner),
  );
  return (
    <div className="app-shell">
      <aside>
        <div className="logo">
          <img className="brand-mark" src="/brand/pico-avatar.png" alt="" width="40" height="40" />
          <strong>Pico</strong>
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
              <Icon name={icon!} />
              {label}
            </button>
          ))}
        </nav>
        <div className="pico-secondary-nav">
          {secondary.map(([key, label]) => (
            <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key!)}>
              {label}
            </button>
          ))}
        </div>
        <div className="profile">
          <span className="avatar">{user.name.slice(0, 1)}</span>
          <div>
            <strong>{user.name}</strong>
            <small>{labels[user.role]}</small>
          </div>
          <button title="Выйти" onClick={logout}>
            ↗
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <div className="header-leading">
            <div className="mobile-brand" aria-label="Pico CRM">
              <img
                className="brand-mark"
                src="/brand/pico-avatar.png"
                alt=""
                width="28"
                height="28"
              />
              <strong>Pico</strong>
            </div>
            <button className="text-button" onClick={() => setHelp(true)}>
              Права и помощь
            </button>
          </div>
          <button
            ref={moreButtonRef}
            className="pico-more-button"
            aria-label="Дополнительное меню"
            aria-expanded={more}
            onClick={() => setMore(!more)}
          >
            <Icon name="more" />
          </button>
          {more && (
            <div ref={moreMenuRef} className="pico-more-menu">
              <button
                onClick={() => {
                  setMore(false);
                  refresh().catch((e) => setError(e.message));
                }}
              >
                Обновить
              </button>
              <button
                onClick={() => {
                  setMore(false);
                  setHelp(true);
                }}
              >
                Права и помощь
              </button>
              {secondary.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => {
                    setTab(key!);
                    setMore(false);
                  }}
                >
                  {label}
                </button>
              ))}
              <button onClick={logout}>Выйти</button>
            </div>
          )}
          <div className="connection-state">
            <span className="online-dot" />
            <span className="connection-label">Подключено</span>{' '}
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
        {tab === 'home' && (
          <HomeScreen
            {...screenProps}
            user={user}
            onNavigate={setTab}
            onCreateCompany={() => setCreate(true)}
            onCreateRecord={setRecordCreate}
          />
        )}
        {tab === 'analytics' && <AnalyticsScreen companies={companies} user={user} users={users} />}
        {tab === 'companies' && (
          <>
            <div className="section-head">
              <h1>Клиенты</h1>
              <button aria-label="Фильтры клиентов" onClick={() => setFiltersOpen(!filtersOpen)}>
                <Icon name="filter" />
              </button>
            </div>
            <div className="pico-search">
              <Icon name="search" />
              <input
                aria-label="Поиск компаний"
                placeholder="Поиск клиента, компании или контакта"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button className="pico-add-row" onClick={() => setCreate(true)}>
              <Icon name="plus" /> Добавить клиента <Icon name="chevron-right" size={16} />
            </button>
            <div className="tabs pico-chips">
              {[
                ['all', 'Все'],
                ['open', 'В работе'],
                ['closed', 'Закрытые'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={clientStatus === key ? 'active' : ''}
                  onClick={() => setClientStatus(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            {filtersOpen && (
              <Modal title="Фильтры клиентов" onClose={() => setFiltersOpen(false)}>
                <div className="filters">
                  <Select
                    value={city}
                    onChange={setCity}
                    options={[...new Set(companies.map((c) => c.city).filter(Boolean))].sort()}
                    empty="Все города"
                  />
                  <Chips
                    label="Категория клиента"
                    options={primarySegments}
                    value={segment}
                    onChange={setSegment}
                  />
                  <Chips
                    label="Оборудование"
                    options={primaryDivisions}
                    value={division}
                    onChange={setDivision}
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
                    {archive ? '✓ Архив компаний' : 'Архив компаний'}
                  </button>
                  <label className="field">
                    <span>Сортировка</span>
                    <select value={clientSort} onChange={(e) => setClientSort(e.target.value)}>
                      <option value="name">А–Я</option>
                      <option value="potential">Потенциал ↓</option>
                      <option value="updated">Обновление ↓</option>
                    </select>
                  </label>
                  <button
                    onClick={() => {
                      setCity('');
                      setSegment('');
                      setDivision('');
                      setOwner('');
                      setArchive(false);
                      setClientSort('name');
                    }}
                  >
                    Сбросить
                  </button>
                  <button
                    className="primary pico-sheet-submit"
                    onClick={() => setFiltersOpen(false)}
                  >
                    Показать ({visible.length})
                  </button>
                </div>
              </Modal>
            )}
            <div className="pico-client-list">
              {[...visible]
                .sort((a, b) =>
                  clientSort === 'potential'
                    ? (b.potential || 0) - (a.potential || 0)
                    : clientSort === 'updated'
                      ? b.updatedAt.localeCompare(a.updatedAt)
                      : a.name.localeCompare(b.name, 'ru'),
                )
                .map((c) => (
                  <ClientRow
                    key={c.id}
                    company={c}
                    onOpen={openCompany}
                    onChanged={refresh}
                    initiallyOpen={c.id === createdClientId}
                  />
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
        {tab === 'companies' && !companies.length && (
          <ScreenGuide
            title="Что будет в карточке клиента"
            items={[
              ['contact', 'Контакты', 'ЛПР и все, кто влияет на выбор'],
              ['potential', 'Потенциал', 'Потребность в оборудовании за год'],
              ['file', 'Файлы', 'Письма и КП, которые подготовил Pico'],
              ['notes', 'Заметки', 'Договорённости и следующий шаг'],
            ]}
          />
        )}
        {tab === 'reports' && <Reports companies={companies} onChanged={refresh} />}
        {tab === 'profile' && <Profile key={user.id} />}
        {tab === 'users' && user.role === 'admin' && (
          <UsersScreen users={users} user={user} onChanged={refresh} />
        )}
        {tab === 'tasks' && (
          <TasksScreen {...screenProps} onCreate={() => setRecordCreate('task')} />
        )}
        {tab === 'calendar' && (
          <TasksScreen
            key="calendar"
            {...screenProps}
            calendarOnly
            onCreate={() => setRecordCreate('task')}
          />
        )}
        {tab === 'projects' && (
          <ProjectsScreen {...screenProps} onCreate={() => setRecordCreate('project')} />
        )}
        {tab === 'files' && (
          <>
            <p className="eyebrow">ВСЁ ПОД РУКОЙ</p>
            <h1>Документы</h1>
            <div className="list pico-files-list">
              {files.map((f) => (
                <article className="task-row pico-file-row" key={f.id}>
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
      <nav className="pico-bottom-nav" aria-label="Основная навигация">
        {nav.map(([key, label, icon]) => (
          <button
            key={key}
            className={tab === key ? 'active' : ''}
            onClick={() => {
              setTab(key!);
              setError('');
            }}
          >
            <Icon name={icon!} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {recordCreate && (
        <RecordCreate
          kind={recordCreate}
          companies={companies}
          projects={projects}
          onChanged={refresh}
          onClose={() => setRecordCreate(null)}
        />
      )}
      {help && <RoleGuide role={user.role} onClose={() => setHelp(false)} />}
      {create && (
        <Modal title="Новый клиент" onClose={() => setCreate(false)}>
          <CompanyForm
            onSave={async (data) => {
              const c = await api<Company>('/companies', 'POST', data);
              ++refreshSequence.current;
              setCompanies((current) => [c, ...current.filter((existing) => existing.id !== c.id)]);
              setCreatedClientId(c.id);
              setTab('companies');
              setQuery('');
              setCity('');
              setSegment('');
              setDivision('');
              setOwner('');
              setArchive(false);
              setClientStatus('all');
              setCreate(false);
              try {
                await refresh();
              } catch (e) {
                setError(`Клиент создан, но обновление не удалось: ${(e as Error).message}`);
              }
            }}
          />
        </Modal>
      )}
      {selected && (
        <CompanyDetail
          key={selected.id}
          company={selected}
          companies={companies}
          initialTab={selectedTab}
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
