import { EmployeeFilterOption, labels } from '../shared/contracts';
import { Icon } from './Icons';
export function EmployeeFilter({
  options,
  value,
  onChange,
  loading = false,
  busy = false,
  error = '',
  onRetry,
}: {
  options: EmployeeFilterOption[];
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
  busy?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const duplicateNames = new Set(
    options
      .filter(
        (option) =>
          options.filter(
            (other) =>
              other.name.trim().toLocaleLowerCase() === option.name.trim().toLocaleLowerCase(),
          ).length > 1,
      )
      .map((option) => option.name),
  );
  return (
    <section className="pico-employee-filter" aria-label="Фильтр сотрудника" aria-busy={busy}>
      <div className="pico-employee-filter-control">
        <span className="pico-employee-notebook">
          <Icon name="notebook" size={20} />
        </span>
        <label>
          <span>Данные сотрудника</span>
          <select
            aria-label="Данные сотрудника"
            value={value}
            disabled={loading || !!error || options.length === 0}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">
              {loading
                ? 'Загрузка сотрудников…'
                : options.length === 0
                  ? error
                    ? 'Список сотрудников недоступен'
                    : 'Нет доступных сотрудников'
                  : 'Все сотрудники'}
            </option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name + (duplicateNames.has(option.name) ? ` · ${labels[option.role]}` : '')}
              </option>
            ))}
          </select>
        </label>
        {value && (
          <button
            type="button"
            className="pico-employee-filter-reset"
            aria-label="Сбросить фильтр сотрудника"
            onClick={() => onChange('')}
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      {error && (
        <div className="pico-employee-filter-error">
          <p role="alert">{error}</p>
          {onRetry && <button onClick={onRetry}>Повторить</button>}
        </div>
      )}
    </section>
  );
}
