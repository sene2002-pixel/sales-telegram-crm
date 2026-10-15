import { useEffect, useRef, useState } from 'react';
import {
  Actor,
  AnalyticsSettings,
  Company,
  dateSchema,
  primaryDivisions,
  divisionLabels,
} from '../shared/contracts';
import { AnalyticsSummary, ClientAnalytics, MetricComparison } from '../shared/analytics';
import { companyDisplayName } from '../shared/company-display-name';
import { api, ApiError, compactMoney, fullMoney, today } from './api';
import { Field, Modal } from './forms';
import { Icon } from './Icons';
import { CommercialReport } from './CommercialReport';

type PeriodKey = 'all' | '7' | '30' | '90' | '365' | 'custom';
const periods: [PeriodKey, string][] = [
  ['all', 'Весь период'],
  ['7', '7 дней'],
  ['30', '30 дней'],
  ['90', '90 дней'],
  ['365', 'Год'],
  ['custom', 'Свой период'],
];
const levels = [
  { key: 'new', label: 'Новый', color: '#6B78E8', range: '0', weight: 1 },
  { key: 'acquaintance', label: 'Знакомство', color: '#78A9F0', range: '1–2', weight: 2 },
  { key: 'development', label: 'Развитие', color: '#6CC3E6', range: '3–5', weight: 3 },
  { key: 'partner', label: 'Партнёр', color: '#5FCDB8', range: '6–7', weight: 2 },
  { key: 'ours', label: 'Наш клиент', color: '#22A86B', range: '8', weight: 1 },
];
function rangeFor(key: PeriodKey, anchor = today()) {
  const end = new Date(anchor + 'T12:00:00');
  const start = new Date(end);
  start.setDate(end.getDate() - (key === 'all' || key === 'custom' ? 29 : Number(key) - 1));
  const format = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: format(start), to: anchor };
}
function readPeriod(actorId: string): { period: PeriodKey; from: string; to: string } {
  try {
    const value = JSON.parse(sessionStorage.getItem(`pico-analytics-period:${actorId}`) || 'null');
    if (
      value &&
      periods.some(([key]) => key === value.period) &&
      dateSchema.safeParse(value.from).success &&
      dateSchema.safeParse(value.to).success &&
      value.from <= value.to
    )
      return value;
  } catch {}
  return { period: 'all', ...rangeFor('all') };
}
function Comparison({ value }: { value: MetricComparison }) {
  if (value.kind === 'none') return null;
  return (
    <small className={'pico-metric-delta tone-' + value.tone}>
      {value.kind === 'new'
        ? 'новое'
        : value.kind === 'unavailable'
          ? 'Нет данных для сравнения'
          : `${value.percent === 0 ? '' : value.tone === 'positive' ? '↑ +' : value.tone === 'negative' ? '↓ ' : ''}${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value.tone === 'negative' ? Math.abs(value.percent ?? 0) : (value.percent ?? 0))}%`}
    </small>
  );
}
function countedWord(count: number, one: string, few: string, many: string) {
  const lastHundred = Math.abs(count) % 100;
  const last = lastHundred % 10;
  return lastHundred >= 11 && lastHundred <= 14
    ? many
    : last === 1
      ? one
      : last >= 2 && last <= 4
        ? few
        : many;
}
function Metric({
  icon,
  label,
  value,
  money = false,
  unit,
  detail,
  delta,
}: {
  icon: string;
  label: string;
  value: number | null;
  money?: boolean;
  unit?: string;
  detail: string;
  delta: MetricComparison;
}) {
  const million = money && value !== null && Math.abs(value) >= 1_000_000;
  return (
    <section className="pico-client-metric" aria-label={label}>
      <div className="pico-metric-label">
        <Icon name={icon} size={16} />
        <span>{label}</span>
      </div>
      <div className="pico-metric-value">
        <strong title={money ? fullMoney(value) : undefined}>
          {value === null
            ? '—'
            : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: money ? 1 : 0 }).format(
                million ? value / 1_000_000 : value,
              )}
        </strong>
        {value !== null && <span>{money ? (million ? 'млн ₽' : '₽') : unit}</span>}
        <Comparison value={delta} />
      </div>
      <p title={detail}>{value === null ? 'Недостаточно истории' : detail}</p>
    </section>
  );
}
function Funnel({
  data,
  companies,
  onShowLevel,
}: {
  data: ClientAnalytics;
  companies: Company[];
  onShowLevel: (key: string, label: string, ids: string[]) => void;
}) {
  return (
    <section className="pico-client-funnel">
      <h2>
        <Icon name="analytics-funnel" size={22} />
        Воронка продаж
      </h2>
      <div className="pico-client-funnel-content">
        <svg
          width="150"
          height="146"
          viewBox="0 0 150 146"
          role="img"
          aria-label="Пять уровней клиентов по восьмибалльной оценке"
        >
          {levels.map((level, i) => {
            const top = 2 + i * 30,
              left = 2 + i * 9,
              right = 148 - i * 9,
              count = data.clientFunnel.find((s) => s.key === level.key)?.count;
            return (
              <g key={level.key}>
                <polygon
                  points={`${left},${top} ${right},${top} ${right - 9},${top + 22} ${left + 9},${top + 22}`}
                  fill={level.color}
                  stroke={level.color}
                  strokeWidth="4"
                  strokeLinejoin="round"
                />
                <text
                  x="75"
                  y={top + 15}
                  textAnchor="middle"
                  fill="white"
                  fontSize="12"
                  fontWeight="700"
                >
                  {count ?? '—'}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="pico-client-funnel-legend">
          {levels.map((level) => (
            <div key={level.key}>
              <i style={{ background: level.color }} />
              <span>{level.label}</span>
              <strong>{data.clientFunnel.find((s) => s.key === level.key)?.count ?? '—'}</strong>
            </div>
          ))}
        </div>
      </div>
      <details className="pico-levels">
        <summary>
          Клиенты по уровням <Icon name="chevron-down" size={18} />
        </summary>
        {levels.map((level) => {
          const ids = new Set(data.clients.filter((c) => c.level === level.key).map((c) => c.id));
          const clients = companies.filter((c) => !c.archived && ids.has(c.id));
          const heading = (
            <>
              <i style={{ background: level.color }} />
              <span>{level.label}</span>
              <strong>{clients.length}</strong>
            </>
          );
          return clients.length ? (
            <details className="pico-level" key={level.key}>
              <summary>
                {heading}
                <Icon name="chevron-down" size={18} />
              </summary>
              <div className="pico-level-clients">
                {clients.slice(0, 3).map((company) => (
                  <div key={company.id}>
                    <span>{companyDisplayName(company.name)}</span>
                    <strong>
                      {company.potential == null ? '—' : compactMoney(company.potential)}
                    </strong>
                  </div>
                ))}
                <button
                  className="text-button"
                  onClick={() =>
                    onShowLevel(
                      level.key,
                      level.label,
                      clients.map((c) => c.id),
                    )
                  }
                >
                  Показать всех, {clients.length}
                </button>
              </div>
            </details>
          ) : (
            <div className="pico-level-empty" key={level.key}>
              {heading}
            </div>
          );
        })}
      </details>
    </section>
  );
}
function ScorePath({ settings }: { settings: AnalyticsSettings }) {
  return (
    <section className="pico-score-path">
      <div className="pico-score-path-heading">
        <h2>Путь к своему клиенту</h2>
        <span>баллы</span>
      </div>
      <div className="pico-score-scale">
        {levels.map((level) => (
          <div key={level.key} style={{ flex: level.weight }}>
            <i style={{ background: level.color }} />
            <span>{level.range}</span>
          </div>
        ))}
      </div>
      <p>
        Каждый шаг даёт <b>+1 балл</b>: задачи, контакты, потенциал, встречи, проекты. Держите ритм,
        и клиент придёт в зелёную зону.
      </p>
      <details className="pico-score-explanation">
        <summary>Как считаются баллы</summary>
        <p>
          Максимум 8: пять баллов за базу и три за регулярность. Это уровень работы с клиентом, а не
          шестибалльная оценка сделки.
        </p>
        <ul>
          <li>
            База: задача, больше одного предоставленного контакта, указанный потенциал, состоявшаяся
            встреча, участие в проекте.
          </li>
          <li>
            Контакты, найденные ботом, не учитываются. Старые контакты с неизвестным источником не
            считаются предоставленными вручную.
          </li>
          <li>
            Регулярность: задача за последние {settings.taskDays} дней, состоявшаяся встреча,
            созданная за последние {settings.meetingMonths} мес., новый проект за последние{' '}
            {settings.projectMonths} мес.
          </li>
          <li>По истечении срока балл регулярности снимается автоматически.</li>
        </ul>
      </details>
    </section>
  );
}
export function AnalyticsScreen({
  companies,
  user,
  users,
  employeeId = '',
  onScopeDenied,
  refreshVersion = 0,
  onShowLevel,
}: {
  companies: Company[];
  user: Actor;
  users: Actor[];
  employeeId?: string;
  onScopeDenied?: (error: Error) => void;
  refreshVersion?: number;
  onShowLevel: (key: string, label: string, ids: string[], query: string) => void;
}) {
  const [initial] = useState(() => readPeriod(user.id));
  const [period, setPeriod] = useState<PeriodKey>(initial.period),
    [from, setFrom] = useState(initial.from),
    [to, setTo] = useState(initial.to);
  const [draftPeriod, setDraftPeriod] = useState(period),
    [draftFrom, setDraftFrom] = useState(from),
    [draftTo, setDraftTo] = useState(to),
    [periodOpen, setPeriodOpen] = useState(false);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        `pico-analytics-period:${user.id}`,
        JSON.stringify({ period, from, to }),
      );
    } catch {}
  }, [user.id, period, from, to]);
  useEffect(() => {
    let active = true;
    setSummary(null);
    setError('');
    api<AnalyticsSummary>(
      `/analytics?${new URLSearchParams({ mode: period === 'all' ? 'all' : 'range', from, to, ...(employeeId ? { employeeId } : {}) })}`,
    )
      .then((value) => {
        if (active) setSummary(value);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          if (e instanceof ApiError && [401, 403].includes(e.status)) onScopeDenied?.(e);
        }
      });
    return () => {
      active = false;
    };
  }, [period, from, to, companies, employeeId, refreshVersion, retry]);
  const data = summary?.clientAnalytics,
    current = companies.filter((c) => !c.archived);
  const directions: readonly string[] = current.some((c) => c.divisions.drives != null)
    ? [...primaryDivisions, 'drives']
    : primaryDivisions;
  const equipmentNames: Record<string, string> = {
    lv: 'Выключатели 0,4 кВ',
    mv: 'Выключатели 6–35 кВ',
    drives_lv: 'ПЧ и УПП 0,4 кВ',
    drives_mv: 'ПЧ и УПП 6–35 кВ',
    cells: 'Ячейки КРУ (КСО)',
    heat: 'Теплотехника',
    services: 'Услуги',
  };
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
  return (
    <div className="pico-analytics-final">
      <div className="section-head pico-analytics-heading">
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
          {periods.find(([key]) => key === period)?.[1]}
          <Icon name="chevron-down" size={16} />
        </button>
      </div>
      {periodOpen && (
        <Modal title="Период" onClose={() => setPeriodOpen(false)}>
          <div className="pico-period-options" role="radiogroup" aria-label="Период аналитики">
            {periods.map(([key, label]) => (
              <button
                type="button"
                role="radio"
                aria-checked={draftPeriod === key}
                className="pico-period-option"
                key={key}
                onClick={() => {
                  setDraftPeriod(key);
                  if (key !== 'custom') {
                    const range = rangeFor(key);
                    setDraftFrom(range.from);
                    setDraftTo(range.to);
                  }
                }}
              >
                <span className={'pico-radio ' + (draftPeriod === key ? 'checked' : '')} />
                <strong>{label}</strong>
                <small>
                  {key === 'all'
                    ? 'Без ограничения по дате'
                    : key === 'custom'
                      ? 'Выбрать даты'
                      : [rangeFor(key).from, rangeFor(key).to]
                          .map((d) =>
                            new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', {
                              day: 'numeric',
                              month: 'long',
                            }),
                          )
                          .join(' — ')}
                </small>
              </button>
            ))}
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
        <div role="alert" className="error">
          <p>{error}</p>
          <button onClick={() => setRetry(retry + 1)}>Повторить загрузку</button>
        </div>
      )}
      {!summary && !error && <p role="status">Загрузка аналитики…</p>}
      {summary && !data && (
        <p role="alert">Новая аналитика недоступна. Обновите приложение или повторите загрузку.</p>
      )}
      {data && (
        <>
          <Funnel
            data={data}
            companies={current}
            onShowLevel={(key, label, ids) =>
              onShowLevel(
                key,
                label,
                ids,
                new URLSearchParams({
                  mode: period === 'all' ? 'all' : 'range',
                  from,
                  to,
                }).toString(),
              )
            }
          />
          <ScorePath settings={data.settings} />
          <div className="pico-client-metrics">
            <Metric
              icon="analytics-client-potential"
              label="Потенциал клиентов"
              value={data.metrics.potential.value}
              money
              detail={
                period === 'all'
                  ? `по ${data.metrics.potential.companies} ${countedWord(data.metrics.potential.companies, 'клиенту', 'клиентам', 'клиентам')}`
                  : `добавлено за период`
              }
              delta={data.metrics.potential.delta}
            />
            <Metric
              icon="analytics-project-potential"
              label="Потенциал проектов"
              value={data.metrics.projects.value}
              money
              detail={
                period === 'all'
                  ? `по ${data.metrics.projects.count} ${countedWord(data.metrics.projects.count, 'проекту', 'проектам', 'проектам')}`
                  : `${data.metrics.projects.count} ${countedWord(data.metrics.projects.count, 'новый проект', 'новых проекта', 'новых проектов')}`
              }
              delta={data.metrics.projects.delta}
            />
            <Metric
              icon="analytics-growth"
              label="Рост по воронке"
              value={data.metrics.growth.value}
              unit={countedWord(data.metrics.growth.value ?? 0, 'клиент', 'клиента', 'клиентов')}
              detail={
                data.metrics.growth.share === null
                  ? 'Нет данных о доле базы'
                  : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(data.metrics.growth.share)}% базы поднялись`
              }
              delta={data.metrics.growth.delta}
            />
            <Metric
              icon="analytics-active"
              label="Активные клиенты"
              value={data.metrics.active.value}
              unit={`из ${data.metrics.active.total}`}
              detail={period === 'all' ? 'ведётся работа' : 'действия за период'}
              delta={data.metrics.active.delta}
            />
          </div>
          {(data.historyIncomplete > 0 || data.contactSourcesUnknown > 0) && (
            <div className="pico-analytics-limits" role="note">
              {data.historyIncomplete > 0 && (
                <p>Не всю историю можно подтвердить. Для таких данных сравнения недоступны.</p>
              )}
              {data.contactSourcesUnknown > 0 && (
                <p>
                  Контакты с неизвестным источником: {data.contactSourcesUnknown}. Балл за контакты
                  рассчитывается без них.
                </p>
              )}
            </div>
          )}
          <section className="pico-client-equipment">
            <h2>
              <Icon name="analytics-equipment" size={22} />
              Потенциал по оборудованию
            </h2>
            {directions.map((direction) => {
              const list = current.filter(
                  (c) => c.divisions[direction as keyof Company['divisions']] != null,
                ),
                amount = list.reduce(
                  (total, c) => total + (c.divisions[direction as keyof Company['divisions']] || 0),
                  0,
                );
              return (
                <details key={direction}>
                  <summary>
                    <span className="pico-equipment-tile">
                      <Icon name={equipmentIcon(direction)} size={18} />
                    </span>
                    <span>{equipmentNames[direction] || divisionLabels[direction]}</span>
                    <strong title={list.length ? fullMoney(amount) : undefined}>
                      {list.length ? compactMoney(amount) : '—'}
                    </strong>
                    <Icon name="chevron-down" size={18} />
                  </summary>
                  {list.map((c) => (
                    <div className="pico-potential-client" key={c.id}>
                      <span>{companyDisplayName(c.name)}</span>
                      <strong
                        title={fullMoney(c.divisions[direction as keyof Company['divisions']])}
                      >
                        {compactMoney(c.divisions[direction as keyof Company['divisions']])}
                      </strong>
                    </div>
                  ))}
                  {!list.length && (
                    <div className="pico-potential-client">
                      <span>Потенциал пока не указан</span>
                    </div>
                  )}
                </details>
              );
            })}
          </section>
          {user.role !== 'manager' && (
            <div className="pico-analytics-commercial">
              <CommercialReport
                key={`${period}:${from}:${to}`}
                users={users}
                employeeId={employeeId}
                initialPeriod={period === 'all' ? rangeFor('30') : { from, to }}
                onScopeDenied={onScopeDenied}
              />
              {period === 'all' && (
                <p className="muted pico-commercial-period-note">
                  Для коммерческого отчёта выберите его собственный период. По умолчанию — последние
                  30 дней.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function AnalyticsSettingsDialog({
  onClose,
  onSaved,
  onScopeDenied,
}: {
  onClose: () => void;
  onSaved: () => void;
  onScopeDenied?: (error: Error) => void;
}) {
  const [settings, setSettings] = useState<AnalyticsSettings | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const active = useRef(true);
  const sequence = useRef(0);
  async function load(keepError = false) {
    if (!keepError) setError('');
    const request = ++sequence.current;
    try {
      const value = await api<AnalyticsSettings>('/analytics/settings');
      if (active.current && request === sequence.current) {
        setSettings(value);
        return true;
      }
    } catch (e) {
      if (active.current && request === sequence.current) {
        setError((e as Error).message);
        if (e instanceof ApiError && [401, 403].includes(e.status)) onScopeDenied?.(e);
      }
    }
    return false;
  }
  useEffect(() => {
    active.current = true;
    load();
    return () => {
      active.current = false;
      ++sequence.current;
    };
  }, []);
  const valid =
    settings &&
    Number.isInteger(settings.taskDays) &&
    settings.taskDays >= 1 &&
    settings.taskDays <= 365 &&
    Number.isInteger(settings.meetingMonths) &&
    settings.meetingMonths >= 1 &&
    settings.meetingMonths <= 24 &&
    Number.isInteger(settings.projectMonths) &&
    settings.projectMonths >= 1 &&
    settings.projectMonths <= 24;
  return (
    <Modal title="Настройки аналитики" onClose={onClose}>
      <p className="muted">
        Сроки регулярности общие для всех сотрудников. Для сравнения периодов применяются текущие
        настройки.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!settings && error && <button onClick={() => load()}>Повторить загрузку</button>}
      {!settings ? (
        !error && <p role="status">Загрузка настроек…</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valid || busy) return;
            const request = ++sequence.current;
            setBusy(true);
            setError('');
            try {
              const { updatedAt: _, ...body } = settings;
              await api('/analytics/settings', 'PUT', body);
              if (active.current && request === sequence.current) {
                onSaved();
                onClose();
              }
            } catch (e) {
              if (active.current && request === sequence.current) {
                setError(
                  e instanceof ApiError && e.status === 409
                    ? 'Настройки изменены другим пользователем. Загружаем актуальные значения…'
                    : (e as Error).message,
                );
                if (e instanceof ApiError && e.status === 409) {
                  setSettings(null);
                  if (await load(true))
                    setError(
                      'Настройки изменены другим пользователем. Загружены актуальные значения; проверьте и сохраните снова.',
                    );
                }
                if (e instanceof ApiError && [401, 403].includes(e.status)) onScopeDenied?.(e);
              }
            } finally {
              if (active.current) setBusy(false);
            }
          }}
        >
          {(
            [
              ['taskDays', 'Задачи: интервал, дней', 365],
              ['meetingMonths', 'Встречи: интервал, месяцев', 24],
              ['projectMonths', 'Проекты: интервал, месяцев', 24],
            ] as const
          ).map(([key, label, max]) => (
            <Field label={label} key={key}>
              <input
                type="number"
                min="1"
                max={max}
                step="1"
                value={settings[key]}
                onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })}
                disabled={busy}
                required
              />
            </Field>
          ))}
          <button className="primary pico-sheet-submit" disabled={busy || !valid}>
            {busy ? 'Сохраняем…' : 'Сохранить настройки'}
          </button>
        </form>
      )}
    </Modal>
  );
}
