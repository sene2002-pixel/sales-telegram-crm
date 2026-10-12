import { useState } from 'react';
import { Actor, labels, roles } from '../shared/contracts';
import { api } from './api';
import { Field, Modal, Select } from './forms';
import { Icon } from './Icons';
export function UsersScreen({
  users,
  user,
  onChanged,
}: {
  users: Actor[];
  user?: Actor;
  onChanged: () => Promise<void>;
}) {
  const [telegramId, setTelegramId] = useState(''),
    [editing, setEditing] = useState<Actor | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();
  return (
    <section className="pico-users">
      <h1>Пользователи</h1>
      <div className="pico-compact-list">
        {users.map((person) => (
          <button
            className="pico-user-row"
            key={person.id}
            onClick={() => {
              setEditing({ ...person });
              setError('');
            }}
          >
            <span
              className={
                'avatar badge-' +
                (person.role === 'admin'
                  ? 'amber'
                  : person.role === 'supervisor'
                    ? 'purple'
                    : 'blue')
              }
            >
              {initials(person.name)}
            </span>
            <span>
              <strong>{person.name}</strong>
              <small>
                {person.id === user?.id ? 'Вы · ' : ''}
                {labels[person.role]}
                {!person.active ? ' · Доступ заблокирован' : ''}
              </small>
            </span>
            <small className="pico-user-id">
              {person.telegramId.startsWith('dev-') ? 'Демо' : 'ID ' + person.telegramId}
            </small>
          </button>
        ))}
      </div>
      <section className="panel pico-admit-user">
        <h3>Добавить нового пользователя</h3>
        <p className="muted">Пользователь найдёт свой ID в Telegram-боте Pico</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            setNotice('');
            try {
              await api('/users/admit', 'POST', { telegramId });
              setTelegramId('');
              setNotice('Пользователь добавлен. Имя появится после первого входа в Pico.');
              try {
                await onChanged();
              } catch (e) {
                setError('Пользователь добавлен, но список не обновился: ' + (e as Error).message);
              }
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Telegram ID">
            <input
              inputMode="numeric"
              required
              pattern="[1-9][0-9]{0,15}"
              placeholder="ID пользователя"
              value={telegramId}
              onChange={(e) => setTelegramId(e.target.value)}
            />
          </Field>
          <button className="primary" disabled={busy}>
            <Icon name="plus" size={17} /> Добавить пользователя
          </button>
        </form>
      </section>
      {!editing && error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
      {editing && (
        <Modal
          title="Пользователь"
          onClose={() => {
            setEditing(null);
            setError('');
          }}
        >
          <p className="muted">ID {editing.telegramId}</p>
          <form
            className="pico-compact-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api('/users', 'POST', {
                  telegramId: editing.telegramId,
                  name: editing.name,
                  role: editing.role,
                  active: editing.active,
                  supervisorId: editing.supervisorId || null,
                });
                await onChanged();
                setEditing(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Имя сотрудника">
              <input
                value={editing.name}
                required
                maxLength={200}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Роль">
              <Select
                value={editing.role}
                options={roles}
                onChange={(role) =>
                  setEditing({
                    ...editing,
                    role: role as Actor['role'],
                    supervisorId: role === 'manager' ? editing.supervisorId : null,
                  })
                }
              />
            </Field>
            {editing.role === 'manager' && (
              <Field label="Руководитель">
                <select
                  value={editing.supervisorId || ''}
                  onChange={(e) => setEditing({ ...editing, supervisorId: e.target.value || null })}
                >
                  <option value="">Не назначен</option>
                  {users
                    .filter((u) => u.role === 'supervisor' && u.active)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
              />{' '}
              Доступ активен
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy || editing.telegramId.startsWith('dev-')}>
              Сохранить изменения
            </button>
            {editing.telegramId.startsWith('dev-') && (
              <p className="muted">Настройки демонстрационного пользователя не изменяются.</p>
            )}
          </form>
        </Modal>
      )}
    </section>
  );
}
