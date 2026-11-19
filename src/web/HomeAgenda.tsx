import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { companyDisplayName } from '../shared/company-display-name';
import { taskTypeLabels, taskTypes } from '../shared/contracts';
import type { NamedRecord } from './Screens';
import { Icon } from './Icons';
import { useTaskActions } from './TaskActions';
import { today } from './api';

export type AgendaTaskType = (typeof taskTypes)[number];

const shortcuts = [
  ['call', 'Позвонить клиенту', 'С кем давно не было контакта'],
  ['meeting', 'Назначить встречу', 'Обсудить новый проект'],
  ['reminder', 'Поставить задачу', 'Подготовить КП или счёт'],
] as const;

const day = 86_400_000;
const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const dayFormat = new Intl.NumberFormat('ru-RU', {
  style: 'unit',
  unit: 'day',
  unitDisplay: 'long',
});

function compareTasks(a: NamedRecord, b: NamedRecord) {
  return (
    (a.data.due || '9999').localeCompare(b.data.due || '9999') ||
    (a.data.time || '24:00').localeCompare(b.data.time || '24:00')
  );
}

function taskDate(due: string | null, date: string) {
  if (!due) return { label: 'Без даты', overdue: false };
  const offset = (Date.parse(due) - Date.parse(date)) / day;
  if (offset < 0) return { label: 'Просрочено ' + dayFormat.format(-offset), overdue: true };
  const label =
    offset === 0 ? 'Сегодня' : offset === 1 ? 'Завтра' : dateFormat.format(new Date(due));
  return { label, overdue: false };
}

function TaskBadge({ type }: { type: AgendaTaskType }) {
  const icon = type === 'reminder' ? 'tasks' : type;
  return (
    <span className={`pico-agenda-badge pico-agenda-badge-${type}`}>
      <Icon name={icon} size={20} />
    </span>
  );
}

export function HomeAgenda({
  tasks,
  projects,
  onOpen,
  onCreate,
}: {
  tasks: NamedRecord[];
  projects: NamedRecord[];
  onOpen: (task: NamedRecord) => void;
  onCreate: (type: AgendaTaskType) => void;
}) {
  const actions = useTaskActions();
  const list = actions
    .project(tasks, true)
    .filter((task) => !task.data.done && !task.data.deleted)
    .sort(compareTasks);
  const scrollable = list.length > 4;
  const date = today();
  const scroll = useRef<HTMLDivElement>(null);
  const hideThumb = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState(0);
  const [atBottom, setAtBottom] = useState(false);
  const [showThumb, setShowThumb] = useState(false);

  function measureScroll() {
    const el = scroll.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setPosition(max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0);
    setAtBottom(el.scrollTop >= max - 1);
  }

  useLayoutEffect(measureScroll, [list.length]);
  useEffect(() => () => clearTimeout(hideThumb.current), []);

  function onScroll() {
    if (!scrollable) return;
    measureScroll();
    setShowThumb(true);
    clearTimeout(hideThumb.current);
    hideThumb.current = setTimeout(() => setShowThumb(false), 1000);
  }

  const thumbHeight = scrollable ? Math.max(24, (100 * 5) / list.length) : 0;
  return (
    <section className="pico-agenda" aria-labelledby="home-agenda-heading">
      <h2 id="home-agenda-heading">Дела</h2>
      <div className="pico-agenda-panel">
        <div
          ref={scroll}
          className="pico-agenda-list"
          data-scrollable={scrollable}
          role={scrollable ? 'region' : undefined}
          aria-label={scrollable ? 'Список дел' : undefined}
          tabIndex={scrollable ? 0 : undefined}
          onScroll={onScroll}
        >
          {list.map((task) => {
            const type = taskTypes.find((type) => type === task.data.type) || 'reminder';
            const pending = actions.isSilentDonePending(task.id);
            const blocked = actions.queue.some(({ task: item }) => item.id === task.id && !pending);
            const due = taskDate(task.data.due, date);
            const details = [
              companyDisplayName(task.companyName),
              projects.find((project) => project.id === task.projectId)?.data.name ||
                task.projectName,
              type === 'reminder' ? 'Задача' : taskTypeLabels[type],
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <div className={`pico-agenda-row${pending ? ' is-completing' : ''}`} key={task.id}>
                <button
                  type="button"
                  className="pico-agenda-open"
                  disabled={pending || blocked}
                  onClick={() => onOpen(task)}
                >
                  <TaskBadge type={type} />
                  <span className="pico-agenda-details">
                    <strong title={task.data.text}>{task.data.text}</strong>
                    <small>
                      <span className={due.overdue ? 'pico-agenda-overdue' : undefined}>
                        {due.label}
                      </span>
                      {task.data.time && `, ${task.data.time}`}
                      {details && ` · ${details}`}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className="pico-agenda-checkbox"
                  role="checkbox"
                  aria-checked={pending}
                  aria-label={`Выполнено: ${task.data.text}`}
                  disabled={blocked}
                  onClick={() => actions.toggleSilentDone(task)}
                >
                  <span>{pending && <Icon name="check" size={14} />}</span>
                </button>
              </div>
            );
          })}
          {!list.length && (
            <div className="pico-agenda-empty">
              <div className="pico-agenda-empty-heading">
                <strong>День свободен</strong>
                <p>Время сделать шаг к новой сделке</p>
              </div>
              <div className="pico-agenda-shortcuts">
                {shortcuts.map(([type, title, description]) => (
                  <button type="button" key={type} onClick={() => onCreate(type)}>
                    <TaskBadge type={type} />
                    <span>
                      <strong>{title}</strong>
                      <small>{description}</small>
                    </span>
                    <Icon name="chevron-right" size={16} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {list.length > 0 && list.length <= 2 && (
            <div className="pico-agenda-hint">
              <strong>Время сделать шаг к новой сделке</strong>
              <p>Запланируйте следующий контакт с клиентом</p>
            </div>
          )}
        </div>
        {scrollable && !atBottom && <span aria-hidden="true" className="pico-agenda-fade" />}
        {scrollable && (
          <span aria-hidden="true" className="pico-agenda-scroll-track">
            <span
              className={showThumb ? 'is-visible' : undefined}
              style={{ height: thumbHeight, top: `calc((100% - ${thumbHeight}px) * ${position})` }}
            />
          </span>
        )}
        <button type="button" className="pico-agenda-add" onClick={() => onCreate('reminder')}>
          <Icon name="plus" size={20} />
          Добавить задачу
        </button>
      </div>
    </section>
  );
}
