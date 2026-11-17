import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CrmRecord, taskSchema } from '../shared/contracts';
import { api, token } from './api';
import { Icon } from './Icons';

type ActionKind = 'done' | 'deleted' | 'restore';
export type CommittedRecord = {
  companyId: string;
  id: string;
  record?: CrmRecord;
};
type UndoAction = {
  key: string;
  label: string;
  kind: ActionKind;
  commit: () => Promise<void | CommittedRecord>;
  task?: CrmRecord;
  silentUntil?: number;
  onCommitted?: () => Promise<void>;
};

const taskLabels: Record<ActionKind, string> = {
  done: 'Задача выполнена',
  deleted: 'Задача удалена',
  restore: 'Задача снова в работе',
};
const actionIcons: Record<ActionKind, string> = {
  done: 'check',
  deleted: 'close',
  restore: 'restore',
};

const Context = createContext<{
  queue: UndoAction[];
  pending: ReadonlySet<string>;
  expiredSilent: ReadonlySet<string>;
  committedRecord: CommittedRecord | null;
  schedule: (action: UndoAction) => void;
  cancel: (key: string) => void;
} | null>(null);

export function useUndoActions() {
  const context = useContext(Context);
  if (!context) throw new Error('Undo actions provider is missing');
  return context;
}

export function useTaskActions() {
  const actions = useUndoActions();
  const queue = actions.queue.flatMap(({ task, kind }) => (task ? [{ task, action: kind }] : []));
  function schedule(
    task: CrmRecord,
    kind: ActionKind,
    onCommitted?: () => Promise<void>,
    silentUntil?: number,
  ) {
    const { id, version, data } = structuredClone(task);
    actions.schedule({
      key: `task:${id}`,
      label: taskLabels[kind],
      kind,
      task,
      silentUntil,
      onCommitted,
      commit: async () => {
        const record = await api<CrmRecord>(`/records/${id}`, 'PATCH', {
          version,
          data: taskSchema.parse({
            ...taskSchema.strip().parse(data),
            done: kind !== 'restore',
            deleted: kind === 'deleted',
          }),
        });
        return { companyId: task.companyId, id, record };
      },
    });
  }
  function isSilentDonePending(id: string) {
    return actions.queue.some(
      (item) => item.key === `task:${id}` && item.silentUntil !== undefined,
    );
  }
  return {
    queue,
    schedule,
    isSilentDonePending,
    toggleSilentDone(task: CrmRecord) {
      const key = `task:${task.id}`;
      if (isSilentDonePending(task.id)) actions.cancel(key);
      else if (!task.data.done && !actions.pending.has(key))
        schedule(task, 'done', undefined, performance.now() + 3000);
    },
    project: <T extends CrmRecord>(tasks: T[], hideCompleted = false): T[] =>
      tasks.flatMap((task) => {
        const action = queue.find((pending) => pending.task.id === task.id)?.action;
        if (action === 'deleted' || (hideCompleted && actions.expiredSilent.has(`task:${task.id}`)))
          return [];
        if (action === 'restore')
          return [{ ...task, data: { ...task.data, done: false, deleted: false } }];
        return [task];
      }),
  };
}

// The authenticated application owns the queue so navigation keeps pending actions.
export function TaskActionsProvider({
  children,
  onChanged,
  session,
}: {
  children: ReactNode;
  onChanged: () => Promise<void>;
  session: string;
}) {
  const [queue, setQueue] = useState<UndoAction[]>([]);
  const [saving, setSaving] = useState(false);
  const [expiredSilent, setExpiredSilent] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const [committedRecord, setCommittedRecord] = useState<CommittedRecord | null>(null);
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const committing = useRef<UndoAction | null>(null);
  const timerId = useRef<number | undefined>(undefined);
  const refresh = useRef(onChanged);
  refresh.current = onChanged;
  const active = queue[0];
  const timing = useRef<{ item: UndoAction; startedAt: number } | null>(null);
  const visibleAction = active && active.silentUntil === undefined && !saving ? active : null;
  const showBanner = Boolean(visibleAction || error);
  function cancel(key: string) {
    if (committing.current?.key === key) return;
    const deadline = queue.find((item) => item.key === key)?.silentUntil;
    if (deadline !== undefined && performance.now() >= deadline) return;
    if (active?.key === key) window.clearTimeout(timerId.current);
    setQueue((items) => items.filter((item) => item.key !== key));
  }
  // Home rows own their visible undo deadlines even when writes are queued behind another action.
  useEffect(() => {
    let timer: number | undefined;
    function update() {
      const now = performance.now();
      const expired = new Set<string>();
      let next = Infinity;
      for (const item of queue) {
        if (item.silentUntil === undefined) continue;
        if (item.silentUntil <= now) expired.add(item.key);
        else next = Math.min(next, item.silentUntil);
      }
      setExpiredSilent((current) =>
        current.size === expired.size && [...current].every((key) => expired.has(key))
          ? current
          : expired,
      );
      if (Number.isFinite(next)) timer = window.setTimeout(update, Math.ceil(next - now));
    }
    update();
    return () => window.clearTimeout(timer);
  }, [queue]);
  useEffect(() => {
    if (!showBanner) return;
    const updateDialog = () => {
      const dialogs = document.querySelectorAll<HTMLElement>('[data-pico-modal]');
      setDialog(dialogs[dialogs.length - 1] ?? null);
    };
    updateDialog();
    const observer = new MutationObserver(updateDialog);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [showBanner]);
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    timing.current = { item: active, startedAt: performance.now() };
    const isCurrent = () => mounted && session === token;
    const timer = window.setTimeout(
      async () => {
        if (!isCurrent()) return;
        committing.current = active;
        setSaving(true);
        let result: void | CommittedRecord = undefined;
        try {
          result = await active.commit();
          if (!isCurrent()) return;
          try {
            await Promise.all([refresh.current(), active.onCommitted?.()]);
          } catch {
            if (isCurrent())
              setError('Изменение сохранено, но список не обновился. Обновите страницу.');
          }
        } catch (cause) {
          if (isCurrent()) setError('Изменение не сохранено: ' + (cause as Error).message);
        } finally {
          if (isCurrent()) {
            if (result) setCommittedRecord(result);
            committing.current = null;
            setSaving(false);
            setQueue((items) => items.filter((item) => item !== active));
          }
        }
      },
      active.silentUntil === undefined ? 3000 : Math.max(0, active.silentUntil - performance.now()),
    );
    timerId.current = timer;
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [active, session]);
  return (
    <Context.Provider
      value={{
        queue,
        pending: new Set(queue.map((item) => item.key)),
        expiredSilent,
        committedRecord,
        cancel,
        schedule(action) {
          if (session !== token) return;
          setError('');
          setQueue((items) =>
            items.some((item) => item.key === action.key) ? items : [...items, action],
          );
        },
      }}
    >
      {children}
      {showBanner &&
        createPortal(
          <>
            {visibleAction && (
              <div className="pico-undo-toast" key={visibleAction.key} role="status">
                <span
                  className="pico-undo-fill"
                  aria-hidden="true"
                  ref={(fill) => {
                    if (fill && !fill.style.animationDelay) {
                      const elapsed =
                        timing.current?.item === visibleAction
                          ? performance.now() - timing.current.startedAt
                          : 0;
                      fill.style.animationDelay = `-${Math.max(0, elapsed)}ms`;
                    }
                  }}
                />
                <Icon name={actionIcons[visibleAction.kind]} size={22} />
                <span>{visibleAction.label}</span>
                <button
                  type="button"
                  ref={(button) => {
                    if (button && document.activeElement === document.body)
                      button.focus({ preventScroll: true });
                  }}
                  onClick={() => cancel(visibleAction.key)}
                >
                  Отменить
                </button>
              </div>
            )}
            {error && (
              <div className="pico-task-action-error" role="alert">
                {error}
                <button type="button" onClick={() => setError('')}>
                  Закрыть
                </button>
              </div>
            )}
          </>,
          dialog?.isConnected ? dialog : document.body,
        )}
    </Context.Provider>
  );
}
