import { companyDisplayName } from '../shared/company-display-name';
import { ReactNode, useState } from 'react';
import { Company, labels, divisionLabels } from '../shared/contracts';
import { Icon, industryIcon } from './Icons';
export function Chips({
  label,
  options,
  value,
  onChange,
  multiple = false,
}: {
  label: string;
  options: readonly string[];
  value: string | string[];
  onChange: (value: any) => void;
  multiple?: boolean;
}) {
  return (
    <div className="pico-chip-field" role="group" aria-label={label}>
      <div className="pico-field-heading">{label}</div>
      <div className="pico-chips">
        {options.map((option) => {
          const selected = Array.isArray(value) ? value.includes(option) : value === option;
          return (
            <button
              type="button"
              key={option}
              aria-pressed={selected}
              className={selected ? 'active' : ''}
              onClick={() =>
                onChange(
                  multiple
                    ? selected
                      ? (value as string[]).filter((v) => v !== option)
                      : [...(value as string[]), option]
                    : option,
                )
              }
            >
              {divisionLabels[option] || labels[option] || option}
            </button>
          );
        })}
      </div>
    </div>
  );
}
export function ClientPicker({
  companies,
  value,
  onChange,
  label = 'Клиент',
  exclude = [],
}: {
  companies: Company[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  exclude?: string[];
}) {
  const [query, setQuery] = useState('');
  const list = companies.filter(
    (c) =>
      !c.archived &&
      !exclude.includes(c.id) &&
      `${c.name} ${companyDisplayName(c.name, c.country)} ${c.city} ${c.industry}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="pico-client-picker" role="group" aria-label={label}>
      <div className="pico-search">
        <Icon name="search" size={16} />
        <input
          aria-label="Поиск клиента"
          placeholder="Найти клиента"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="section-head">
        <h3>Клиенты</h3>
        <small>{list.length} · по алфавиту</small>
      </div>
      <div className="pico-picker-list">
        {list
          .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
          .map((c) => {
            const [icon, color] = industryIcon(c.industry, c.segment);
            return (
              <button
                type="button"
                key={c.id}
                aria-pressed={value === c.id}
                onClick={() => onChange(c.id)}
              >
                <span className={'icon-badge badge-' + color}>
                  <Icon name={icon} size={16} />
                </span>
                <span>
                  <strong>{companyDisplayName(c.name, c.country)}</strong>
                  <small>
                    {[labels[c.segment], c.city, c.industry].filter(Boolean).join(' · ')}
                  </small>
                </span>
                <span className={'pico-radio ' + (value === c.id ? 'checked' : '')}>
                  {value === c.id && <Icon name="check" size={12} />}
                </span>
              </button>
            );
          })}
        {!list.length && <p className="muted">Клиенты не найдены</p>}
      </div>
    </div>
  );
}
export function PickerRow({
  label,
  icon,
  value,
  children,
  onClick,
}: {
  label: string;
  icon: string;
  value?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div className="pico-picker-row">
      <span className="pico-picker-row-label">
        <Icon name={icon} size={16} />
        {label}
      </span>
      {onClick ? (
        <button type="button" onClick={onClick}>
          <span className="pico-picker-value">{value || 'Не выбран'}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      ) : (
        children
      )}
    </div>
  );
}
export function millionValue(value: number | null | undefined) {
  return value == null ? '' : String(value / 1_000_000);
}
export function fromMillions(value: string) {
  return value === '' ? null : Number(value) * 1_000_000;
}
