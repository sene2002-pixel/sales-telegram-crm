import { useState } from 'react';
import { Company, divisionLabels, holdingAllocationSchema } from '../shared/contracts';
import { companyDisplayName } from '../shared/company-display-name';
import { api, ApiError, money } from './api';
import { millionValue } from './FormWidgets';
import './holding-members.css';

type Target = {
  companyId: string;
  version: number;
  values: Record<string, string>;
  amount: string;
};
export function HoldingMembers({
  company,
  members,
  onReveal,
  onChanged,
}: {
  company: Company;
  members: Company[];
  onReveal?: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Target[] | null>(null);
  const [keys, setKeys] = useState<string[]>([]);
  const [version, setVersion] = useState(company.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const temporary =
    company.potential ??
    (Object.keys(company.divisions).length
      ? Object.values(company.divisions).reduce<number>((n, v) => n + (v || 0), 0)
      : null);
  function begin() {
    const columns = [
      ...new Set([
        ...Object.keys(company.divisions),
        ...members.flatMap((member) => Object.keys(member.divisions)),
      ]),
    ];
    setKeys(columns);
    setDraft(
      members.map((member) => ({
        companyId: member.id,
        version: member.version,
        amount: millionValue(member.potential),
        values: Object.fromEntries(
          columns.map((key) => [
            key,
            millionValue(member.divisions[key as keyof typeof member.divisions]),
          ]),
        ),
      })),
    );
    setVersion(company.version);
    setError('');
    setConflict(false);
  }
  function rubles(value: string) {
    if (!value.trim()) return 0;
    const number = Number(value.replace(',', '.')) * 1_000_000;
    if (!Number.isFinite(number) || number < 0 || number > 1e12)
      throw new Error('Введите сумму от 0 до 1 000 000 млн ₽');
    return Math.round(number * 100) / 100;
  }
  return (
    <section className="holding-members" aria-label="Заказчики холдинга">
      {members.length ? (
        <ul>
          {members.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                className="text-button"
                disabled={!onReveal}
                onClick={() => onReveal?.(member.id)}
              >
                {companyDisplayName(member.name)}
              </button>
              <span>{money(member.potential)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">В холдинге пока нет заказчиков</p>
      )}
      {!!company.sites?.length && (
        <div>
          <strong>Площадки</strong>
          <ul>
            {company.sites.map((site, index) => (
              <li key={index}>{site}</li>
            ))}
          </ul>
        </div>
      )}
      {members.length > 0 && temporary !== null && temporary > 0 && !draft && (
        <div>
          <p>
            Временная оценка холдинга: <strong>{money(temporary)}</strong>
          </p>
          <button
            type="button"
            className="text-button"
            disabled={members.length > 100}
            onClick={begin}
          >
            Распределить временный потенциал
          </button>
          {members.length > 100 && (
            <p className="muted">Распределение поддерживает до 100 заказчиков за раз.</p>
          )}
        </div>
      )}
      {draft && (
        <form
          className="holding-allocation"
          onSubmit={async (event) => {
            event.preventDefault();
            setError('');
            setBusy(true);
            try {
              const allocations = draft.map((target) => {
                const divisions = Object.fromEntries(
                  keys
                    .filter((key) => target.values[key]?.trim())
                    .map((key) => [key, rubles(target.values[key]!)]),
                );
                return {
                  companyId: target.companyId,
                  version: target.version,
                  divisions,
                  potential: keys.length
                    ? Object.values(divisions).reduce((n, v) => n + v, 0)
                    : rubles(target.amount),
                };
              });
              const input = holdingAllocationSchema.parse({ version, allocations });
              await api(`/companies/${company.id}/holding-allocation`, 'POST', input);
              setDraft(null);
              await onChanged();
            } catch (cause) {
              setError((cause as Error).message);
              if (cause instanceof ApiError && cause.status === 409) setConflict(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h4>Распределение {money(temporary)}</h4>
          <p>
            Укажите итоговый потенциал каждого заказчика. Значения заменят прежние суммы; после
            подтверждения временная оценка холдинга будет очищена. Общая сумма и суммы по
            оборудованию должны совпасть с оценкой холдинга.
          </p>
          {draft.map((target, index) => (
            <details key={target.companyId} open={draft.length === 1}>
              <summary>
                {companyDisplayName(
                  members.find((member) => member.id === target.companyId)?.name || '',
                )}
              </summary>
              {(keys.length ? keys : ['total']).map((key) => (
                <label key={key}>
                  <span>{key === 'total' ? 'Потенциал, млн ₽' : divisionLabels[key] || key}</span>
                  <input
                    aria-label={`${companyDisplayName(members.find((member) => member.id === target.companyId)?.name || '')}: ${key === 'total' ? 'Потенциал' : divisionLabels[key] || key}, млн ₽`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    disabled={busy}
                    value={key === 'total' ? target.amount : target.values[key] || ''}
                    onChange={(event) =>
                      setDraft((current) =>
                        current!.map((row, i) =>
                          i !== index
                            ? row
                            : key === 'total'
                              ? { ...row, amount: event.target.value }
                              : { ...row, values: { ...row.values, [key]: event.target.value } },
                        ),
                      )
                    }
                  />
                </label>
              ))}
            </details>
          ))}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {conflict && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onChanged();
                  setDraft(null);
                  setConflict(false);
                } catch (cause) {
                  setError((cause as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Обновить исходные данные
            </button>
          )}
          <div className="cc-editor-actions">
            <button disabled={busy || conflict}>
              {busy ? 'Сохраняем…' : 'Подтвердить распределение'}
            </button>
            <button type="button" disabled={busy} onClick={() => setDraft(null)}>
              Отмена
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
