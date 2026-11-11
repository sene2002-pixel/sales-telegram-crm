import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { CrmRecord, taskSchema } from '../shared/contracts';
import { api, token } from './api';
import { Icon } from './Icons';

type TaskAction = 'done' | 'deleted' | 'restore';
type PendingTask = { task: CrmRecord; action: TaskAction; session: string; id: number };
type TaskActions = {
  queue: PendingTask[];
  project: <T extends CrmRecord>(tasks: T[]) => T[];
  schedule: (task: CrmRecord, action: TaskAction) => void;
};
const Context = createContext<TaskActions | null>(null);
export function useTaskActions() {
  const context = useContext(Context);
  if (!context) throw new Error('Task actions provider is missing');
  return context;
}

// The queue belongs to the authenticated application, not an individual task list.
// Each action gets its own full undo window; no mutation is sent before it expires.
export function TaskActionsProvider({
  children,
  onChanged,
  session,
}: {
  children: ReactNode;
  onChanged: () => Promise<void>;
  session: string;
}) {
  const [queue, setQueue] = useState<PendingTask[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const serial = useRef(0);
  const committing = useRef<number | null>(null);
  const refresh = useRef(onChanged);
  refresh.current = onChanged;
  const active = queue[0];
  useEffect(() => {
    let current = true;
    setSaving(false);
    if (!active) return;
    const timer = window.setTimeout(async () => {
      if (active.session !== token || active.session !== session) {
        setQueue([]);
        return;
      }
      committing.current = active.id;
      setSaving(true);
      try {
        await api(`/records/${active.task.id}`, 'PATCH', {
          version: active.task.version,
          data: taskSchema.parse({
            ...taskSchema.strip().parse(active.task.data),
            done: active.action !== 'restore',
            deleted: active.action === 'deleted',
          }),
        });
        if (!current || active.session !== token) return;
        try {
          await refresh.current();
        } catch {
          if (current) setError('Изменение сохранено, но список не обновился. Обновите страницу.');
        }
      } catch (cause) {
        if (current && active.session === token)
          setError('Изменение не сохранено: ' + (cause as Error).message);
      } finally {
        if (current && active.session === token) {
          setSaving(false);
          setQueue((items) => items.filter((item) => item.id !== active.id));
        }
      }
    }, 3000);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [active?.id, session]);
  return (
    <Context.Provider
      value={{
        queue,
        project: (tasks) =>
          tasks.map((task) =>
            queue.some((pending) => pending.task.id === task.id && pending.action === 'restore')
              ? { ...task, data: { ...task.data, done: false, deleted: false } }
              : task,
          ),
        schedule(task, action) {
          if (session !== token) return;
          setError('');
          setQueue((items) =>
            items.some((item) => item.task.id === task.id)
              ? items
              : [...items, { task: structuredClone(task), action, session, id: ++serial.current }],
          );
        },
      }}
    >
      {children}
      {active && (
        <div className="pico-undo-toast" key={active.id} role="status" aria-live="polite">
          {!saving && <span className="pico-undo-fill" aria-hidden="true" />}
          <Icon name={active.action === 'deleted' ? 'close' : 'check'} size={22} />
          <span>
            {saving
              ? 'Сохранение…'
              : active.action === 'deleted'
                ? 'Задача удалена'
                : active.action === 'restore'
                  ? 'Задача снова в работе'
                  : 'Задача выполнена'}
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              if (committing.current !== active.id)
                setQueue((items) => items.filter((item) => item.id !== active.id));
            }}
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
    </Context.Provider>
  );
}
