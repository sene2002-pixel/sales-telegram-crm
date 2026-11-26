import { useId, useRef, useState } from 'react';
import { Actor, isLeader } from '../shared/contracts';
import { ApiError, api } from './api';
import { Modal } from './forms';
import './team-employees.css';

export function canRemoveTeamMember(actor: Actor | undefined, member: Actor, users: Actor[]) {
  if (!actor?.active || member.telegramId.startsWith('dev-')) return false;
  if (actor.role === 'admin') {
    return (
      member.role !== 'admin' ||
      !member.active ||
      users.some((user) => user.id !== member.id && user.role === 'admin' && user.active)
    );
  }
  return (
    actor.role === 'supervisor' && member.role === 'manager' && member.supervisorId === actor.id
  );
}

export function RemoveTeamMemberDialog({
  actor,
  member,
  users,
  onClose,
  onChanged,
  onRemoved,
}: {
  actor: Actor;
  member: Actor;
  users: Actor[];
  onClose: () => void;
  onChanged: (id: string) => Promise<void>;
  onRemoved: () => void;
}) {
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const self = actor.id === member.id;
  const hasReports = isLeader(member) && users.some((user) => user.supervisorId === member.id);

  function close() {
    if (inFlight.current) return;
    if (removed) onRemoved();
    else onClose();
  }

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (!removed) {
        await api<void>(`/users/${encodeURIComponent(member.id)}`, 'DELETE');
        setRemoved(true);
      }
      try {
        await onChanged(member.id);
      } catch (cause) {
        if (self && cause instanceof ApiError && (cause.status === 401 || cause.status === 403))
          return;
        setError('Сотрудник удалён. Не удалось обновить список.');
        return;
      }
      onRemoved();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Удалить из команды"
      className="team-removal-modal"
      dialogRole="alertdialog"
      descriptionId={removed ? undefined : descriptionId}
      closeDisabled={busy}
      initialFocusRef={cancelRef}
      onClose={close}
    >
      {!removed && (
        <div id={descriptionId}>
          <p>
            {self ? (
              'Вы потеряете доступ к Pico.'
            ) : (
              <>
                <strong>{member.name}</strong> потеряет доступ к Pico.
              </>
            )}{' '}
            Данные и история останутся в прежней команде. Чтобы снова войти, понадобится новое
            приглашение.
          </p>
          {hasReports && <p>У сотрудников этой команды больше не будет руководителя.</p>}
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="team-removal-actions">
        <button type="button" ref={cancelRef} onClick={close} disabled={busy}>
          {removed ? 'Закрыть' : 'Отмена'}
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          className={removed ? undefined : 'danger'}
          disabled={busy}
        >
          {removed
            ? busy
              ? 'Обновляем…'
              : 'Обновить список'
            : busy
              ? 'Удаляем…'
              : 'Удалить сотрудника'}
        </button>
      </div>
    </Modal>
  );
}
