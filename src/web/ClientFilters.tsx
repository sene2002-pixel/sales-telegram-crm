import { useEffect, useRef, useState } from 'react';
import { divisionLabels, labels, primaryDivisions, primarySegments } from '../shared/contracts';
import { ClientSort, clientSortLabels } from '../shared/client-filters';
import { Modal } from './forms';
import { Icon } from './Icons';
export function ClientFilters({
  city,
  cities,
  segments,
  divisions,
  sort,
  count,
  scoresLoading,
  scoresError,
  onRetry,
  onCity,
  onSegments,
  onDivisions,
  onSort,
  onReset,
  onClose,
}: {
  city: string;
  cities: string[];
  segments: string[];
  divisions: string[];
  sort: ClientSort;
  count: number;
  scoresLoading: boolean;
  scoresError: string;
  onRetry: () => void;
  onCity: (city: string) => void;
  onSegments: (segments: string[]) => void;
  onDivisions: (divisions: string[]) => void;
  onSort: (sort: ClientSort) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [menuHeight, setMenuHeight] = useState(336);
  const [menuAbove, setMenuAbove] = useState(false);
  const sortArea = useRef<HTMLDivElement>(null);
  const sortTrigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!menu) return;
    optionRefs.current[Object.keys(clientSortLabels).indexOf(sort)]?.focus();
    const outside = (event: PointerEvent) => {
      if (!sortArea.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setMenu(false);
      sortTrigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [menu]);
  const toggle = (items: string[], value: string) =>
    items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
  const processed = sort === 'processed' || sort === 'processedAsc';
  return (
    <Modal sheet title="Фильтры" onClose={onClose}>
      <div className="pico-client-filters">
        <div className="pico-client-filter-top">
          <label>
            <span>Город</span>
            <span className="pico-client-select">
              <select
                aria-label="Город"
                value={city}
                onChange={(event) => onCity(event.target.value)}
              >
                <option value="">Все города</option>
                {cities.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={16} />
            </span>
          </label>
          <div ref={sortArea} className="pico-client-sort">
            <span>Сортировка</span>
            <button
              ref={sortTrigger}
              type="button"
              aria-label={'Сортировка: ' + clientSortLabels[sort]}
              aria-haspopup="menu"
              aria-expanded={menu}
              className={menu ? 'is-open' : ''}
              title={clientSortLabels[sort]}
              onClick={() => {
                const bounds = sortTrigger.current?.getBoundingClientRect();
                if (bounds) {
                  const top = window.visualViewport?.offsetTop || 0;
                  const bottom = top + (window.visualViewport?.height || window.innerHeight);
                  const below = bottom - bounds.bottom - 12;
                  const above = bounds.top - top - 12;
                  const upwards = below < 180 && above > below;
                  setMenuAbove(upwards);
                  setMenuHeight(Math.max(40, Math.min(336, upwards ? above : below)));
                }
                setMenu(!menu);
              }}
            >
              <span>{clientSortLabels[sort]}</span>
              <Icon name="chevron-down" size={16} />
            </button>
            {menu && (
              <div
                className={'pico-client-sort-menu' + (menuAbove ? ' is-above' : '')}
                style={{ maxHeight: menuHeight }}
                role="menu"
                aria-label="Сортировка клиентов"
                onKeyDown={(event) => {
                  const current = optionRefs.current.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const length = Object.keys(clientSortLabels).length;
                  const next =
                    event.key === 'ArrowDown'
                      ? (current + 1) % length
                      : event.key === 'ArrowUp'
                        ? (current + length - 1) % length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? length - 1
                            : null;
                  if (next !== null) {
                    event.preventDefault();
                    optionRefs.current[next]?.focus();
                  }
                  if (event.key === 'Tab') {
                    event.preventDefault();
                    setMenu(false);
                    const filters = sortArea.current?.closest('.pico-client-filters');
                    filters
                      ?.querySelector<HTMLElement>(
                        event.shiftKey ? 'select' : '.pico-client-filter-chips button',
                      )
                      ?.focus();
                  }
                }}
              >
                {Object.entries(clientSortLabels).map(([key, label], index) => (
                  <button
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    key={key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sort === key}
                    onClick={() => {
                      onSort(key as ClientSort);
                      setMenu(false);
                      sortTrigger.current?.focus();
                    }}
                  >
                    <span>{label}</span>
                    {sort === key && <Icon name="check" size={16} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <section>
          <h3>Категория клиента</h3>
          <div className="pico-client-filter-chips" role="group" aria-label="Категория клиента">
            {primarySegments.map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={segments.includes(value)}
                onClick={() => onSegments(toggle(segments, value))}
              >
                {labels[value]}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h3>Оборудование</h3>
          <div className="pico-client-filter-chips" role="group" aria-label="Оборудование">
            {primaryDivisions.map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={divisions.includes(value)}
                onClick={() => onDivisions(toggle(divisions, value))}
              >
                {divisionLabels[value]}
              </button>
            ))}
          </div>
        </section>
        {processed && scoresLoading && <p role="status">Загрузка проработки клиентов…</p>}
        {processed && scoresError && (
          <div className="error" role="alert">
            {scoresError}
            <button type="button" onClick={onRetry}>
              Повторить
            </button>
          </div>
        )}
        <div className="pico-client-filter-footer">
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              onReset();
            }}
          >
            Сбросить
          </button>
          <button
            type="button"
            disabled={processed && (scoresLoading || !!scoresError)}
            aria-live="polite"
            onClick={onClose}
          >
            Показать {count} клиентов
          </button>
        </div>
      </div>
    </Modal>
  );
}
