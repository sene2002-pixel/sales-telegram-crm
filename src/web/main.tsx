import { companyDisplayName } from '../shared/company-display-name';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Actor,
  EmployeeFilterOption,
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
import { EmployeeFilter } from './EmployeeFilter';
import { Icon } from './Icons';
import {
  HomeScreen,
  TasksScreen,
  ProjectsScreen,
  AnalyticsScreen,
  AnalyticsSettingsDialog,
  RecordCreate,
  ScreenGuide,
} from './Screens';
import './styles.css';
import { configureViewport, TelegramViewport } from './viewport';
declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramViewport & {
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
    [archive, setArchive] = useState(false);
  const [files, setFiles] = useState<(CrmRecord & { companyName: string })[]>([]),
    [projects, setProjects] = useState<(CrmRecord & { companyName: string })[]>([]),
    [contacts, setContacts] = useState<CrmRecord[]>([]);
  const [help, setHelp] = useState(false);
  const [analyticsSettingsOpen, setAnalyticsSettingsOpen] = useState(false),
    [analyticsRefreshVersion, setAnalyticsRefreshVersion] = useState(0);
  const [more, setMore] = useState(false),
    [recordCreate, setRecordCreate] = useState<'task' | 'project' | null>(null),
    [filtersOpen, setFiltersOpen] = useState(false),
    [clientStatus, setClientStatus] = useState('all'),
    [clientSort, setClientSort] = useState('name'),
    [selectedTab, setSelectedTab] = useState('contact'),
    [createdClientId, setCreatedClientId] = useState(''),
    [taskView, setTaskView] = useState<'open' | 'overdue'>('open');
  const [employeeId, setEmployeeId] = useState(''),
    [employeeOptions, setEmployeeOptions] = useState<EmployeeFilterOption[]>([]),
    [employeeError, setEmployeeError] = useState(''),
    [optionsLoading, setOptionsLoading] = useState(true),
    [scopeBusy, setScopeBusy] = useState(false),
    [scopeFailed, setScopeFailed] = useState(''),
    [scopeVersion, setScopeVersion] = useState(0),
    [reportToOpen, setReportToOpen] = useState<string | null>(null);
  const scopeGeneration = useRef(0);
  const employeeScope = useRef({ actorId: '', role: '', employeeId: '' });
  const refreshSequence = useRef(0);
  const employeeStorageKey = (actorId: string) => `pico-employee-filter:${actorId}`;
  function storeEmployee(actorId: string, id: string) {
    try {
      if (id) sessionStorage.setItem(employeeStorageKey(actorId), id);
      else sessionStorage.removeItem(employeeStorageKey(actorId));
    } catch {}
  }
  function clearScopeData() {
    setAnalyticsSettingsOpen(false);
    setTaskView('open');
    ++scopeGeneration.current;
    setCompanies([]);
    setTasks([]);
    setFiles([]);
    setProjects([]);
    setContacts([]);
    setSelected(null);
    setCreate(false);
    setRecordCreate(null);
    setFiltersOpen(false);
    setMore(false);
    setCreatedClientId('');
    setReportToOpen(null);
    setQuery('');
    setCity('');
    setSegment('');
    setDivision('');
    setArchive(false);
    setClientStatus('all');
  }
  async function changeEmployee(id: string) {
    if (!user || employeeScope.current.employeeId === id) return;
    ++refreshSequence.current;
    employeeScope.current = { actorId: user.id, role: user.role, employeeId: id };
    setEmployeeId(id);
    storeEmployee(user.id, id);
    setScopeVersion((v) => v + 1);
    clearScopeData();
    setError('');
    setScopeFailed('');
    setScopeBusy(true);
    const requestSequence = refreshSequence.current + 1;
    try {
      await refreshActor();
    } catch (e) {
      if (requestSequence === refreshSequence.current) setError((e as Error).message);
    }
  }

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
    setAnalyticsSettingsOpen(false);
    setTaskView('open');
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
    setArchive(false);
    setClientStatus('all');
    setClientSort('name');
    setSelectedTab('contact');
    setCreatedClientId('');
    setTab('home');
  }
  function logout() {
    ++scopeGeneration.current;
    storeEmployee(employeeScope.current.actorId || user?.id || '', '');
    employeeScope.current = { actorId: '', role: '', employeeId: '' };
    setEmployeeId('');
    setEmployeeOptions([]);
    setEmployeeError('');
    setScopeVersion((v) => v + 1);
    setReportToOpen(null);
    setScopeBusy(false);
    setScopeFailed('');
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
      if (sequence !== refreshSequence.current) return;
      if (
        sequence === refreshSequence.current &&
        e instanceof ApiError &&
        (e.status === 401 || e.status === 403)
      )
        logout();
      else {
        clearScopeData();
        setScopeVersion((v) => v + 1);
        setScopeFailed((e as Error).message);
        setScopeBusy(false);
      }
      throw e;
    }
    if (sequence !== refreshSequence.current) return;
    const previous = employeeScope.current;
    const accountChanged = previous.actorId !== actor.id || previous.role !== actor.role;
    if (previous.actorId && accountChanged) {
      clearAccountData();
      clearScopeData();
      setScopeBusy(true);
      setScopeFailed('');
      setScopeVersion((v) => v + 1);
      setEmployeeOptions([]);
      setEmployeeId('');
    }
    if (!previous.actorId) setScopeBusy(true);
    setUser(actor);
    let eligible: EmployeeFilterOption[] = [];
    if (actor.role !== 'manager') {
      setOptionsLoading(true);
      try {
        eligible = await api<EmployeeFilterOption[]>('/employee-filter/options');
      } catch (e) {
        if (sequence !== refreshSequence.current) return;
        if (sequence === refreshSequence.current) {
          clearScopeData();
          setScopeVersion((v) => v + 1);
          setScopeFailed('Не удалось загрузить список сотрудников');
          setEmployeeError('Не удалось загрузить список сотрудников');
          setOptionsLoading(false);
          setScopeBusy(false);
        }
        throw e;
      }
      if (sequence !== refreshSequence.current) return;
    }
    let resetWarning = '';
    let requested = previous.actorId === actor.id ? previous.employeeId : '';
    if (previous.actorId !== actor.id) {
      try {
        requested = sessionStorage.getItem(employeeStorageKey(actor.id)) || '';
      } catch {}
    }
    const accepted =
      actor.role === 'manager'
        ? ''
        : eligible.some((option) => option.id === requested)
          ? requested
          : '';
    if (actor.role === 'manager') storeEmployee(actor.id, '');
    if (requested && accepted !== requested) {
      storeEmployee(actor.id, '');
      clearScopeData();
      setScopeBusy(true);
      setScopeFailed('');
      setScopeVersion((v) => v + 1);
      resetWarning = 'Фильтр сотрудника сброшен: сотрудник больше недоступен.';
      setError(resetWarning);
    }
    employeeScope.current = { actorId: actor.id, role: actor.role, employeeId: accepted };
    setEmployeeId(accepted);
    setEmployeeOptions(eligible);
    setEmployeeError('');
    setOptionsLoading(false);
    const scoped = (path: string) =>
      accepted ? `${path}?${new URLSearchParams({ employeeId: accepted })}` : path;
    try {
      const [c, u, t, f, p, contacts] = await Promise.all([
        api<Company[]>(scoped('/companies')),
        api<Actor[]>('/users'),
        api<any[]>(scoped('/records/task')),
        api<any[]>(scoped('/records/file')),
        api<any[]>(scoped('/records/project')),
        api<CrmRecord[]>(scoped('/records/contact')),
      ]);
      if (sequence !== refreshSequence.current) return;
      setCompanies(c);
      setUsers(u);
      setUser((current) => (current ? actor : current));
      setTasks(t);
      setFiles(f);
      setProjects(p);
      setContacts(contacts);
      setScopeFailed('');
      setError(resetWarning);
    } catch (e) {
      if (sequence === refreshSequence.current) {
        clearScopeData();
        setScopeVersion((v) => v + 1);
        setScopeFailed((e as Error).message);
        throw e;
      }
      return;
    } finally {
      if (sequence === refreshSequence.current) setScopeBusy(false);
    }
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
    const cleanupViewport = configureViewport(window.Telegram?.WebApp);
    api('/config')
      .then((c) => setDev(c.devAuth))
      .catch(() => {});
    (async () => {
      let authenticatedActor: Actor | null = null;
      try {
        if (window.Telegram?.WebApp?.initData) {
          await login();
          return;
        }
        if (token) {
          authenticatedActor = await api<Actor>('/me');
          setScopeBusy(true);
          setUser(authenticatedActor);
          await refresh();
        }
      } catch (e) {
        if (!authenticatedActor) {
          setToken('');
          setUser(null);
        }
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    return cleanupViewport;
  }, []);
  useEffect(() => {
    if (user?.id) window.scrollTo(0, 0);
  }, [user?.id]);
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
  const scopeScreen = !['profile', 'users', 'team'].includes(tab);
  const renderedScopeGeneration = scopeGeneration.current;
  const handleScopeDenied = (e: Error) => {
    if (renderedScopeGeneration !== scopeGeneration.current) return;
    ++refreshSequence.current;
    clearScopeData();
    setScopeVersion((v) => v + 1);
    setScopeBusy(false);
    setScopeFailed(e.message);
    setError(e.message);
  };
  const openCompany = (company: Company, nextTab = 'contact') => {
    if (renderedScopeGeneration !== scopeGeneration.current) return;
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
        `${c.name} ${companyDisplayName(c.name)} ${c.inn} ${contacts
          .filter((contact) => contact.companyId === c.id)
          .map((contact) => `${contact.data.name} ${contact.data.phone} ${contact.data.email}`)
          .join(' ')}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (!city || c.city === city) &&
      (!segment || c.segment === segment) &&
      (!division || c.divisions[division as keyof typeof c.divisions] != null),
  );
  return (
    <div
      className={`app-shell${window.Telegram?.WebApp?.initData ? ' telegram-native-header' : ''}`}
    >
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
              className={tab === key || (tab === 'calendar' && key === 'tasks') ? 'active' : ''}
              onClick={() => {
                if (key === 'tasks') setTaskView('open');
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
            <button
              key={key}
              className={tab === key || (tab === 'calendar' && key === 'tasks') ? 'active' : ''}
              onClick={() => setTab(key!)}
            >
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
      <main className={`workspace ${tab === 'home' ? 'pico-home-workspace' : ''}`}>
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
              <strong>Pico Bot</strong>
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
            <Icon name="settings" size={26} />
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
              {user.role === 'admin' && (
                <button
                  onClick={() => {
                    setMore(false);
                    setAnalyticsSettingsOpen(true);
                  }}
                >
                  Настройки аналитики
                </button>
              )}
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
        {tab === 'home' && (
          <>
            <div className="pico-home-greeting">
              <div className="pico-home-welcome">
                <h1 aria-label={`Привет, ${user.name.split(' ')[0]}!`}>
                  Привет, {user.name.split(' ')[0]}!
                  {user.role === 'admin' && (
                    <>
                      {' '}
                      <button
                        className="pico-admin-button"
                        aria-label="Управление пользователями"
                        onClick={() => setTab('users')}
                      >
                        <Icon name="crown" size={16} />
                      </button>
                    </>
                  )}
                </h1>
                <p className="muted">Вот что важно на сегодня</p>
              </div>
            </div>
            <div className="pico-home-overview">
              {user.role !== 'manager' && (
                <EmployeeFilter
                  options={employeeOptions}
                  value={employeeId}
                  onChange={(id) => void changeEmployee(id)}
                  loading={optionsLoading && employeeOptions.length === 0}
                  busy={scopeBusy}
                  error={employeeError}
                  onRetry={() => void refresh().catch((e) => setError(e.message))}
                />
              )}
              {!scopeBusy && !scopeFailed && (
                <div className="pico-summary">
                  {[
                    ['Клиенты', companies.filter((c) => !c.archived).length, 'companies'],
                    ['Проекты', projects.length, 'projects'],
                    ['Задачи', tasks.filter((t) => !t.data.done).length, 'tasks'],
                  ].map(([label, count, route]) => (
                    <button key={label} onClick={() => setTab(String(route))}>
                      <strong>{count}</strong>
                      <small>{label}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {scopeBusy && scopeScreen && (
          <p role="status" className="pico-scope-loading">
            Обновляем данные сотрудника…
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {scopeFailed && scopeScreen && !scopeBusy && (
          <div className="pico-scope-loading">
            <p>Данные сотрудника не загружены.</p>
            <button onClick={() => void refresh().catch((e) => setError(e.message))}>
              Повторить загрузку
            </button>
          </div>
        )}
        {(!scopeScreen || (!scopeBusy && !scopeFailed)) && (
          <div key={`${user.id}:${employeeId}:${scopeVersion}`} className="pico-scoped-content">
            {tab === 'home' && (
              <HomeScreen
                {...screenProps}
                user={user}
                onNavigate={setTab}
                onOverdue={() => {
                  setTaskView('overdue');
                  setTab('tasks');
                }}
                onCreateCompany={() => setCreate(true)}
                onCreateRecord={setRecordCreate}
              />
            )}
            {tab === 'analytics' && (
              <AnalyticsScreen
                companies={companies}
                user={user}
                users={users}
                employeeId={employeeId}
                onScopeDenied={handleScopeDenied}
                refreshVersion={analyticsRefreshVersion}
              />
            )}
            {tab === 'companies' && (
              <>
                <div className="section-head">
                  <h1>Клиенты</h1>
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
                <div className="tabs pico-chips pico-filter-chip-row">
                  {[
                    ['all', 'Все'],
                    ['open', 'В работе'],
                    ['closed', 'Закрытые'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      aria-pressed={clientStatus === key}
                      className={clientStatus === key ? 'active' : ''}
                      onClick={() => setClientStatus(key)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    className="pico-filter-chip"
                    aria-label="Фильтры клиентов"
                    onClick={() => setFiltersOpen(true)}
                  >
                    <Icon name="filter" size={16} />
                  </button>
                </div>
                <button className="pico-add-row" onClick={() => setCreate(true)}>
                  <Icon name="plus" /> Добавить клиента <Icon name="chevron-right" size={16} />
                </button>
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
                      <button
                        className={archive ? 'active' : ''}
                        onClick={() => setArchive(!archive)}
                      >
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
                        canArchive={user.role === 'admin' || (user.role === 'supervisor' && (c.ownerId === user.id || users.some((u) => u.id === c.ownerId && u.supervisorId === user.id)))}
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
                        : employeeId
                          ? 'У сотрудника пока нет клиентов'
                          : 'Начните с первого клиента'}
                    </h3>
                    {employeeId ? (
                      <button className="text-button" onClick={() => void changeEmployee('')}>
                        Показать всех сотрудников
                      </button>
                    ) : (
                      <p>Добавьте компанию вручную или отправьте голосовой отчёт боту.</p>
                    )}
                  </div>
                )}
              </>
            )}
            {tab === 'companies' && !companies.length && !employeeId && (
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
            {tab === 'reports' && (
              <Reports
                companies={companies}
                onChanged={refresh}
                employeeId={employeeId}
                onScopeDenied={handleScopeDenied}
                initialReportId={reportToOpen}
                allowLinkedReport={scopeVersion === 0 && !employeeId}
                onOwnRecordCreated={async (id) => {
                  if (
                    employeeScope.current.actorId !== user.id ||
                    renderedScopeGeneration !== scopeGeneration.current
                  )
                    return;
                  const changing = changeEmployee('');
                  const expectedGeneration = scopeGeneration.current;
                  await changing;
                  if (
                    employeeScope.current.actorId === user.id &&
                    expectedGeneration === scopeGeneration.current
                  )
                    setReportToOpen(id);
                }}
              />
            )}
            {tab === 'profile' && <Profile key={user.id} />}
            {tab === 'users' && user.role === 'admin' && (
              <UsersScreen users={users} user={user} onChanged={refresh} />
            )}
            {tab === 'tasks' && (
              <TasksScreen
                {...screenProps}
                initialFilter={taskView}
                onCreate={() => setRecordCreate('task')}
              />
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
              <ProjectsScreen
                {...screenProps}
                employeeId={employeeId}
                onCreate={() => setRecordCreate('project')}
              />
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
                          {companyDisplayName(f.companyName)} · {labels[f.data.category]} ·{' '}
                          {Math.ceil(f.data.size / 1024)} КБ
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
          </div>
        )}
      </main>
      <nav className="pico-bottom-nav" aria-label="Основная навигация">
        {nav.map(([key, label, icon]) => (
          <button
            key={key}
            className={tab === key || (tab === 'calendar' && key === 'tasks') ? 'active' : ''}
            onClick={() => {
              if (key === 'tasks') setTaskView('open');
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
      {analyticsSettingsOpen && user.role === 'admin' && (
        <AnalyticsSettingsDialog
          key={user.id}
          onClose={() => setAnalyticsSettingsOpen(false)}
          onSaved={() => setAnalyticsRefreshVersion((v) => v + 1)}
          onScopeDenied={handleScopeDenied}
        />
      )}
      {create && (
        <Modal title="Новый клиент" onClose={() => setCreate(false)}>
          {employeeId && employeeId !== user.id && (
            <p className="muted">
              Новые клиенты создаются на ваше имя. Фильтр не меняет ответственного.
            </p>
          )}
          <CompanyForm
            onSave={async (data) => {
              const saveGeneration = scopeGeneration.current;
              const c = await api<Company>('/companies', 'POST', data);
              if (
                employeeScope.current.actorId !== user.id ||
                saveGeneration !== scopeGeneration.current
              )
                return;
              if (employeeScope.current.employeeId) {
                employeeScope.current = { ...employeeScope.current, employeeId: '' };
                setEmployeeId('');
                storeEmployee(user.id, '');
                setScopeVersion((v) => v + 1);
                clearScopeData();
              }
              ++refreshSequence.current;
              setCompanies((current) => [c, ...current.filter((existing) => existing.id !== c.id)]);
              setCreatedClientId(c.id);
              setTab('companies');
              setQuery('');
              setCity('');
              setSegment('');
              setDivision('');
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
createRoot(document.getElementById('root')!).render(
  <>
    <div id="pico-app">
      <App />
    </div>
    <section className="pico-portrait-guard" role="status" aria-live="polite">
      <div>
        <Icon name="phone" size={36} />
        <h1>Поверните устройство вертикально</h1>
        <p>Приложение работает в вертикальном положении.</p>
      </div>
    </section>
  </>,
);
