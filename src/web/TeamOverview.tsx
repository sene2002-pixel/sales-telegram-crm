import { useRef, useState } from 'react';
import { Actor, labels, roles } from '../shared/contracts';
import {
  TeamStats,
  TeamMetricsFilter,
  selectTeamMetrics,
  teamMetrics,
} from '../shared/team-metrics';
import { api, download } from './api';
import { Field } from './forms';
import { Icon } from './Icons';
import './team-overview.css';

export function TeamOverview({
  user,
  stats,
  statsError,
  from,
  to,
}: {
  user: Actor;
  stats: TeamStats[] | null;
  statsError: string;
  from: string;
  to: string;
}) {
  const [filter, setFilter] = useState<TeamMetricsFilter>({});
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(5);
  const tableRef = useRef<HTMLTableElement>(null);
  const rows = stats ? selectTeamMetrics(stats, filter) : [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  const offset = currentPage * pageSize;
  function goToPage(nextPage: number, nextSize = pageSize) {
    setPageSize(nextSize);
    setPage(nextPage);
    requestAnimationFrame(() => {
      const table = tableRef.current;
      if (!table) return;
      const visibleTop =
        (window.visualViewport?.offsetTop ?? 0) +
        parseFloat(getComputedStyle(table).scrollMarginTop);
      if (table.getBoundingClientRect().top < visibleTop) {
        table.focus({ preventScroll: true });
        table.scrollIntoView({ block: 'start' });
      }
    });
  }
  function updateFilter(change: TeamMetricsFilter) {
    setFilter({ ...filter, ...change });
    setPage(0);
  }
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [exportError, setExportError] = useState('');
  async function exportCsv(inBot = false) {
    setExportBusy(true);
    setExportError('');
    setExportStatus('');
    const params = {
      from,
      to,
      ...(filter.q?.trim() && { q: filter.q.trim() }),
      ...(filter.role && { role: filter.role }),
      ...(filter.sort && { sort: filter.sort, direction: filter.direction }),
    };
    try {
      if (inBot) {
        await api('/dashboard/export-bot', 'POST', params);
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
            params,
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
            `/dashboard/export?${new URLSearchParams(params)}`,
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
  return (
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
          <div className="team-metrics-filters">
            <label className="team-metrics-search">
              <Icon name="search" size={18} />
              <input
                type="search"
                aria-label="Имя, фамилия или роль"
                placeholder="Имя, фамилия или роль"
                value={filter.q ?? ''}
                maxLength={200}
                onChange={(event) => updateFilter({ q: event.target.value })}
              />
            </label>
            <Field label="Роль сотрудника">
              <select
                value={filter.role ?? ''}
                onChange={(event) =>
                  updateFilter({
                    role: (event.target.value || undefined) as TeamMetricsFilter['role'],
                  })
                }
              >
                <option value="">Все роли</option>
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {labels[role]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Сортировка">
              <select
                value={filter.sort ?? ''}
                onChange={(event) =>
                  updateFilter({
                    sort: (event.target.value || undefined) as TeamMetricsFilter['sort'],
                    direction: 'desc',
                  })
                }
              >
                <option value="">По имени</option>
                {teamMetrics.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {filter.sort && (
              <button
                type="button"
                className="team-metrics-direction"
                title="Сменить направление сортировки"
                onClick={() =>
                  updateFilter({ direction: filter.direction === 'desc' ? 'asc' : 'desc' })
                }
              >
                <Icon name="arrow-up-down" size={16} />
                {filter.direction === 'asc' ? 'Сначала меньше' : 'Сначала больше'}
              </button>
            )}
          </div>
          {rows.length === 0 ? (
            <div className="team-metrics-empty">
              <p>Сотрудники не найдены</p>
              <button type="button" onClick={() => updateFilter({ q: '', role: undefined })}>
                Сбросить фильтры
              </button>
            </div>
          ) : (
            <>
              <table
                ref={tableRef}
                tabIndex={-1}
                role="table"
                aria-labelledby="team-overview-title"
                className="team-stats"
              >
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">
                      Сотрудник
                    </th>
                    {teamMetrics.map(([key, label]) => (
                      <th
                        key={key}
                        scope="col"
                        role="columnheader"
                        aria-sort={
                          filter.sort === key
                            ? filter.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : undefined
                        }
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {rows.slice(offset, offset + pageSize).map((s) => (
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
              <div className="team-metrics-footer">
                <label className="team-page-size">
                  Строк на странице
                  <select
                    value={pageSize}
                    onChange={(event) => goToPage(0, Number(event.target.value))}
                  >
                    {[5, 10, 25, 50].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="team-page-controls">
                  <span aria-live="polite">
                    {offset + 1}–{Math.min(offset + pageSize, rows.length)} из {rows.length}
                  </span>
                  {rows.length > pageSize && (
                    <>
                      <button
                        type="button"
                        aria-label="Предыдущая страница"
                        disabled={currentPage === 0}
                        onClick={() => goToPage(currentPage - 1)}
                      >
                        <Icon name="chevron-left" size={18} />
                      </button>
                      <button
                        type="button"
                        aria-label="Следующая страница"
                        disabled={offset + pageSize >= rows.length}
                        onClick={() => goToPage(currentPage + 1)}
                      >
                        <Icon name="chevron-right" size={18} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
