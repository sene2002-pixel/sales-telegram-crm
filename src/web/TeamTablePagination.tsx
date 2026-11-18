import { useRef, useState } from 'react';
import { Icon } from './Icons';

export function useTeamTablePage<T>(rows: readonly T[]) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(5);
  const tableRef = useRef<HTMLTableElement>(null);
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

  return {
    tableRef,
    visibleRows: rows.slice(offset, offset + pageSize),
    resetPage: () => setPage(0),
    pagination: { currentPage, pageSize, total: rows.length, goToPage },
  };
}

export function TeamTablePagination({
  currentPage,
  pageSize,
  total,
  goToPage,
}: {
  currentPage: number;
  pageSize: number;
  total: number;
  goToPage: (page: number, size?: number) => void;
}) {
  const offset = currentPage * pageSize;
  return (
    <div className="team-metrics-footer">
      <label className="team-page-size">
        Строк на странице
        <select value={pageSize} onChange={(event) => goToPage(0, Number(event.target.value))}>
          {[5, 10, 25, 50].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <div className="team-page-controls">
        <span aria-live="polite">
          {offset + 1}–{Math.min(offset + pageSize, total)} из {total}
        </span>
        {total > pageSize && (
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
              disabled={offset + pageSize >= total}
              onClick={() => goToPage(currentPage + 1)}
            >
              <Icon name="chevron-right" size={18} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
