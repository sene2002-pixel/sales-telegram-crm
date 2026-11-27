import { useEffect, useId, useRef, useState } from 'react';
import { Actor, isLeader } from '../shared/contracts';
import type { RemovalHandoff } from '../shared/client-handoff';
import { ApiError, api, countedWord } from './api';
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
  const [preview, setPreview] = useState<RemovalHandoff | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [recipient, setRecipient] = useState('');
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const self = actor.id === member.id;
  const hasReports = isLeader(member) && users.some((user) => user.supervisorId === member.id);
  const path = `/users/${encodeURIComponent(member.id)}`;
  const hasWork = Boolean(preview && (preview.companyCount > 0 || preview.taskCount > 0));

  useEffect(() => {
    let current = true;
    api<RemovalHandoff>(`${path}/handoff`)
      .then((value) => {
        if (!current) return;
        setPreview(value);
        setRecipient((selected) =>
          value.candidates.some((candidate) => candidate.id === selected)
            ? selected
            : (value.suggestedRecipientId ?? ''),
        );
      })
      .catch((cause: Error) => {
        if (current) setPreviewError(cause.message);
      });
    return () => {
      current = false;
    };
  }, [path, previewAttempt]);

  function reloadPreview() {
    setPreview(null);
    setPreviewError('');
    setError('');
    setPreviewAttempt((attempt) => attempt + 1);
  }

  function close() {
    if (inFlight.current) return;
    if (removed) onRemoved();
    else onClose();
  }

  async function confirm(transfer = false) {
    if (inFlight.current) return;
    if (transfer && (!preview || (preview.companyCount > 0 && !recipient))) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (!removed) {
        await api<void>(
          path,
          'DELETE',
          transfer && preview
            ? {
                ...(preview.companyCount > 0 ? { recipientId: recipient } : {}),
                revision: preview.revision,
              }
            : undefined,
        );
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
      {!removed && (
        <div className="team-removal-handoff">
          {!preview && !previewError && <p role="status">Проверяем, что нужно передать…</p>}
          {previewError && (
            <>
              <p className="error" role="alert">
                Не удалось проверить список дел. {previewError}
              </p>
              <button type="button" disabled={busy} onClick={reloadPreview}>
                Повторить проверку
              </button>
            </>
          )}
          {preview && hasWork && (
            <>
              <p>
                К передаче:{' '}
                <strong>
                  {preview.companyCount}{' '}
                  {countedWord(preview.companyCount, 'компания', 'компании', 'компаний')}
                </strong>
                {' · '}
                {preview.projectCount}{' '}
                {countedWord(
                  preview.projectCount,
                  'активный проект',
                  'активных проекта',
                  'активных проектов',
                )}
                {' · '}
                {preview.taskCount}{' '}
                {countedWord(
                  preview.taskCount,
                  'открытая задача',
                  'открытые задачи',
                  'открытых задач',
                )}
                .
              </p>
              {preview.separateTaskCount > 0 && (
                <p>
                  Задачи на других компаниях при передаче сразу вернутся их текущим ответственным.
                </p>
              )}
              {preview.unassignableTaskCount > 0 && (
                <p>
                  У части задач нет подходящего ответственного. Закройте доступ и распределите их из
                  очереди позже.
                </p>
              )}
              {preview.companyCount > 0 && preview.candidates.length > 0 && (
                <label className="field">
                  <span>Новый ответственный</span>
                  <select
                    value={recipient}
                    disabled={busy}
                    onChange={(event) => setRecipient(event.target.value)}
                  >
                    <option value="">Выберите сотрудника</option>
                    {preview.candidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {preview.companyCount > 0 && !preview.candidates.length && (
                <p>Сейчас нет активного сотрудника, которому можно передать компании.</p>
              )}
              <p>Если распределить позже, работа появится в «Клиенты → Требуют передачи».</p>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {error && !removed && preview && hasWork && (
        <button type="button" disabled={busy} onClick={reloadPreview}>
          Обновить список дел
        </button>
      )}
      <div className="team-removal-actions">
        <button type="button" ref={cancelRef} onClick={close} disabled={busy}>
          {removed ? 'Закрыть' : 'Отмена'}
        </button>
        {preview && hasWork && !removed && (
          <button
            type="button"
            className="danger"
            onClick={() => void confirm(true)}
            disabled={
              busy || (preview.companyCount > 0 && !recipient) || preview.unassignableTaskCount > 0
            }
          >
            Передать и удалить
          </button>
        )}
        <button
          type="button"
          onClick={() => void confirm()}
          className={removed ? undefined : 'danger'}
          disabled={busy || (!removed && !preview && !previewError)}
        >
          {removed
            ? busy
              ? 'Обновляем…'
              : 'Обновить список'
            : busy
              ? 'Удаляем…'
              : hasWork || previewError
                ? 'Удалить и распределить позже'
                : 'Удалить сотрудника'}
        </button>
      </div>
    </Modal>
  );
}
