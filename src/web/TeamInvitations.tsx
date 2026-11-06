import { useEffect, useRef, useState } from 'react';
import { Actor } from '../shared/contracts';
import { api } from './api';
import { Field } from './forms';

type Invitation = {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  usedAt: string | null;
  supervisorId: string;
  createdAt: string;
};
type Created = { id: string; url: string; expiresAt: string };
export function TeamInvitations({ user, users }: { user: Actor; users: Actor[] }) {
  const [items, setItems] = useState<Invitation[]>([]);
  const [created, setCreated] = useState<Created | null>(null);
  const [supervisorId, setSupervisorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const refresh = async () => setItems(await api<Invitation[]>('/team-invitations'));
  useEffect(() => {
    let active = true;
    api<Invitation[]>('/team-invitations')
      .then((data) => {
        if (active) setItems(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const date = (value: string) => new Date(value).toLocaleString('ru-RU');
  return (
    <section className="panel team-invitations" aria-label="Приглашения в команду">
      <h3>Пригласить сотрудника</h3>
      <p className="muted">
        Сотрудник откроет ссылку в Telegram и присоединится к команде как менеджер. Ссылка действует
        24 часа и подходит для одного человека.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          setNotice('');
          try {
            const result = await api<Created>(
              '/team-invitations',
              'POST',
              user.role === 'admin' ? { supervisorId } : {},
            );
            setCreated(result);
            try {
              await refresh();
            } catch {
              setError(
                'Ссылка создана, но список не обновился. Скопируйте ссылку и обновите список.',
              );
            }
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {user.role === 'admin' && (
          <Field label="Команда руководителя">
            <select
              required
              value={supervisorId}
              onChange={(event) => setSupervisorId(event.target.value)}
            >
              <option value="">Выберите руководителя</option>
              {users
                .filter((person) => person.active && person.role === 'supervisor')
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <button className="primary" disabled={busy || (user.role === 'admin' && !supervisorId)}>
          Создать приглашение
        </button>
      </form>
      {created && (
        <div className="team-invitation-link">
          <Field label="Пригласительная ссылка">
            <input
              ref={input}
              readOnly
              value={created.url}
              onFocus={(event) => event.target.select()}
            />
          </Field>
          <p className="muted">
            До {date(created.expiresAt)}. Передайте лично сотруднику: любой получатель ссылки сможет
            вступить в команду. После ухода с этой страницы ссылка больше не отображается.
          </p>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(created.url);
                setNotice('Ссылка скопирована');
              } catch {
                input.current?.focus();
                input.current?.select();
                setNotice('Скопируйте выделенную ссылку вручную');
              }
            }}
          >
            Скопировать ссылку
          </button>
        </div>
      )}
      {loading && <p role="status">Загрузка приглашений…</p>}
      {!loading && !items.length && <p className="muted">Приглашений пока нет</p>}
      <ul className="team-invitation-list">
        {items.map((item) => {
          const status = item.revokedAt
            ? 'Отозвано'
            : item.usedAt
              ? 'Принято'
              : Date.parse(item.expiresAt) <= Date.now()
                ? 'Истекло'
                : 'Ожидает сотрудника';
          return (
            <li key={item.id}>
              <div>
                <strong>{status}</strong>
                <small>
                  {users.find((person) => person.id === item.supervisorId)?.name || 'Команда'} · до{' '}
                  {date(item.expiresAt)}
                </small>
              </div>
              {!item.revokedAt && !item.usedAt && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      await api(`/team-invitations/${item.id}/revoke`, 'POST', {});
                      if (created?.id === item.id) setCreated(null);
                      await refresh();
                      setNotice('Приглашение отозвано');
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Отозвать
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <div>
          <p role="alert" className="error">
            {error}
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await refresh();
                setError('');
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Обновить список
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
