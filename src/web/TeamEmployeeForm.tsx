import { useState } from 'react';
import { Actor, roles } from '../shared/contracts';
import { api } from './api';
import { Field, Select } from './forms';

type Draft = Pick<Actor, 'name' | 'role' | 'telegramId' | 'active' | 'supervisorId'>;

export function TeamEmployeeForm({
  employee,
  users,
  busy,
  onBusy,
  onDirty,
  onCancel,
  onChanged,
  onSaved,
}: {
  employee?: Actor;
  users: Actor[];
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
  onChanged: () => Promise<void>;
  onSaved: () => void;
}) {
  const [initial] = useState<Draft>(() => ({
    name: employee?.name ?? '',
    role: employee?.role ?? 'manager',
    active: employee?.active ?? true,
    telegramId: employee?.telegramId ?? '',
    supervisorId: employee?.supervisorId ?? null,
  }));
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  function update(fields: Partial<Draft>) {
    const next = { ...draft, ...fields };
    setDraft(next);
    onDirty((Object.keys(initial) as (keyof Draft)[]).some((key) => next[key] !== initial[key]));
    setError('');
  }

  return (
    <form
      className="team-employee-form"
      id={employee ? `employee-form-${employee.id}` : 'employee-form-new'}
      aria-label={employee ? `Редактирование: ${employee.name}` : 'Новый сотрудник'}
      aria-busy={busy}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        onBusy(true);
        setError('');
        try {
          if (!saved) {
            if (!employee && users.some((u) => u.telegramId === draft.telegramId.trim()))
              throw new Error('Сотрудник уже существует. Откройте его в разделе «Все сотрудники».');
            await api('/users', 'POST', draft);
            setSaved(true);
            onDirty(false);
          }
          try {
            await onChanged();
          } catch {
            setError('Данные сохранены. Не удалось обновить список сотрудников.');
            return;
          }
          onSaved();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          onBusy(false);
        }
      }}
    >
      {employee ? (
        <label className="team-employee-id">
          Telegram ID <input readOnly value={employee.telegramId} />
        </label>
      ) : (
        <h3>Новый сотрудник</h3>
      )}
      <fieldset disabled={busy || saved}>
        {!employee && (
          <Field label="Telegram ID">
            <input
              required
              inputMode="numeric"
              pattern="[1-9][0-9]{0,15}"
              value={draft.telegramId}
              onChange={(e) => update({ telegramId: e.target.value })}
            />
          </Field>
        )}
        <Field label="Имя сотрудника">
          <input
            required
            maxLength={200}
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </Field>
        <div className="team-employee-selects">
          <Field label="Роль">
            <Select
              value={draft.role}
              options={roles}
              onChange={(role) =>
                update({
                  role: role as Actor['role'],
                  supervisorId: role === 'manager' ? draft.supervisorId : null,
                })
              }
            />
          </Field>
          {draft.role === 'manager' && (
            <Field label="Руководитель">
              <select
                value={draft.supervisorId ?? ''}
                onChange={(e) => update({ supervisorId: e.target.value || null })}
              >
                <option value="">Не назначен</option>
                {users
                  .filter((u) => u.role === 'supervisor' && u.active && u.id !== employee?.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
        </div>
        <label className="team-employee-active">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => update({ active: e.target.checked })}
          />
          Доступ активен
        </label>
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="team-employee-actions">
        <button className="primary" disabled={busy}>
          {busy
            ? 'Сохранение…'
            : saved
              ? 'Обновить список'
              : employee
                ? 'Сохранить изменения'
                : 'Создать сотрудника'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {saved ? 'Закрыть' : 'Отмена'}
        </button>
      </div>
    </form>
  );
}
