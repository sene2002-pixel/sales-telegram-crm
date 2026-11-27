import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { HandoffCompany, HandoffQueue, HandoffTask } from '../shared/client-handoff';
import { labels, type Company, type CompanyDetail } from '../shared/contracts';
import { api, ApiError, countedWord, today } from './api';
import { Field, Modal } from './forms';
import { Icon } from './Icons';
import './client-handoff.css';

type View = 'companies' | 'tasks';
type Selection = { kind: 'companies'; item: HandoffCompany } | { kind: 'tasks'; item: HandoffTask };
const views: { id: View; label: string }[] = [
  { id: 'companies', label: 'Компании' },
  { id: 'tasks', label: 'Отдельные задачи' },
];
const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const formatDue = (due: string) => dateFormat.format(new Date(`${due}T00:00:00Z`));

function counts(company: HandoffCompany) {
  const projects = company.projects.length;
  const tasks = company.tasks.length;
  return `${projects} ${countedWord(projects, 'активный проект', 'активных проекта', 'активных проектов')} · ${tasks} ${countedWord(tasks, 'открытая задача', 'открытые задачи', 'открытых задач')}`;
}

function Due({ value, currentDay }: { value: string; currentDay: string }) {
  return (
    <span className={value < currentDay ? 'handoff-overdue' : 'handoff-secondary'}>
      {value < currentDay ? 'Просрочено' : 'Срок'}: <time dateTime={value}>{formatDue(value)}</time>
    </span>
  );
}

export function ClientHandoffQueue({
  companies,
  onChanged,
  onOpenCompany,
}: {
  // Normal CRM refreshes also invalidate the separately scoped queue.
  companies: readonly Company[];
  onChanged: () => Promise<void>;
  onOpenCompany: (company: Company, nextTab?: string) => void;
}) {
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const loadSequence = useRef(0);
  const [queue, setQueue] = useState<HandoffQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('companies');
  const [expanded, setExpanded] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const next = await api<HandoffQueue>('/client-handoff');
      if (sequence === loadSequence.current) setQueue(next);
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        setQueue(null);
        setSelection(null);
      }
      setLoadError(cause instanceof Error ? cause.message : 'Не удалось загрузить очередь.');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      ++loadSequence.current;
    };
  }, [companies, load]);

  const count = queue ? queue.companies.length + queue.tasks.length : null;
  const currentDay = today();

  function finishAssignment(assigned: Selection) {
    ++loadSequence.current;
    setLoading(false);
    setQueue((current) => {
      if (!current) return current;
      return assigned.kind === 'companies'
        ? { ...current, companies: current.companies.filter(({ id }) => id !== assigned.item.id) }
        : { ...current, tasks: current.tasks.filter(({ id }) => id !== assigned.item.id) };
    });
    setSelection(null);
    setExpanded('');
    setNotice(
      assigned.kind === 'companies'
        ? `Компания передана: ${assigned.item.name}.`
        : `Задача назначена: ${assigned.item.text}.`,
    );
    requestAnimationFrame(() => trigger.current?.focus());
    void onChanged().catch(() => {
      // The transfer did succeed. Retry reads only; never issue a second mutation.
      if (trigger.current) void load();
    });
  }

  function beginAssignment(target: Selection) {
    setNotice('');
    setSelection(target);
  }

  return (
    <section className="pico-client-handoff" aria-label="Требуют передачи">
      <button
        ref={trigger}
        className="pico-handoff-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <span>Требуют передачи{count === null ? '' : ` · ${count}`}</span>
        <Icon name="chevron-down" size={18} />
      </button>
      <p className="pico-handoff-notice" role="status">
        {notice}
      </p>
      <div id={panelId} hidden={!open} className="pico-handoff-panel">
        {loading && !queue && <p role="status">Загружаем очередь…</p>}
        {loadError && (
          <div className="pico-handoff-load-error">
            <p role="alert">Не удалось обновить очередь. {loadError}</p>
            <button type="button" onClick={() => void load()}>
              Повторить
            </button>
          </div>
        )}
        {open && queue && (
          <>
            <div className="pico-handoff-views" role="group" aria-label="Что передать">
              {views.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={view === id}
                  onClick={() => {
                    setView(id);
                    setExpanded('');
                  }}
                >
                  {label} · {queue[id].length}
                </button>
              ))}
            </div>
            {queue[view].length === 0 ? (
              <p className="handoff-secondary">
                {count === 0
                  ? 'Всё распределено'
                  : view === 'companies'
                    ? 'Нет компаний к передаче'
                    : 'Нет отдельных задач к передаче'}
              </p>
            ) : (
              <div className="pico-handoff-stack">
                {view === 'companies'
                  ? queue.companies.map((company) => {
                      const due = [...company.projects, ...company.tasks].reduce<string | null>(
                        (closest, item) =>
                          item.due && (!closest || item.due < closest) ? item.due : closest,
                        null,
                      );
                      return (
                        <QueueItem
                          key={company.id}
                          title={company.name}
                          meta={
                            <>
                              <span>Бывший ответственный: {company.formerOwner.name}</span>
                              <span>{counts(company)}</span>
                              {due && <Due value={due} currentDay={currentDay} />}
                            </>
                          }
                          open={expanded === company.id}
                          onToggle={() => setExpanded(expanded === company.id ? '' : company.id)}
                        >
                          {company.projects.length > 0 && (
                            <div>
                              <h4>Активные проекты</h4>
                              <ul>
                                {company.projects.map((project) => (
                                  <li key={project.id}>
                                    <strong>{project.name}</strong>
                                    <span className="handoff-secondary">
                                      {labels[project.stage] || project.stage}
                                    </span>
                                    {project.due && (
                                      <Due value={project.due} currentDay={currentDay} />
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {company.tasks.length > 0 && (
                            <div>
                              <h4>Открытые задачи к передаче</h4>
                              <ul>
                                {company.tasks.map((task) => (
                                  <li key={task.id}>
                                    <strong>{task.text}</strong>
                                    {task.due && <Due value={task.due} currentDay={currentDay} />}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <div className="pico-handoff-card-actions">
                            <AssignmentButton
                              selection={{ kind: 'companies', item: company }}
                              onSelect={beginAssignment}
                            />
                            <OpenHandoffCompany
                              id={company.id}
                              company={companies.find(({ id }) => id === company.id)}
                              onOpen={onOpenCompany}
                            />
                          </div>
                        </QueueItem>
                      );
                    })
                  : queue.tasks.map((task) => (
                      <QueueItem
                        key={task.id}
                        title={task.text}
                        meta={
                          <>
                            <span>Компания: {task.companyName}</span>
                            <span>Бывший исполнитель: {task.formerAssignee.name}</span>
                            {task.due && <Due value={task.due} currentDay={currentDay} />}
                          </>
                        }
                        open={expanded === task.id}
                        onToggle={() => setExpanded(expanded === task.id ? '' : task.id)}
                      >
                        <p className="handoff-secondary">
                          Ответственный за компанию останется прежним.
                        </p>
                        <AssignmentButton
                          selection={{ kind: 'tasks', item: task }}
                          onSelect={beginAssignment}
                        />
                      </QueueItem>
                    ))}
              </div>
            )}
          </>
        )}
      </div>
      {selection && (
        <HandoffConfirmation
          key={selection.item.id}
          selection={selection}
          onClose={() => setSelection(null)}
          onAssigned={finishAssignment}
          onReload={() => {
            setSelection(null);
            requestAnimationFrame(() => trigger.current?.focus());
            void load();
          }}
        />
      )}
    </section>
  );
}

function QueueItem({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  meta: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <article className="pico-handoff-item">
      <h3>
        <button
          type="button"
          className="pico-handoff-item-trigger"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          <span>
            <strong>{title}</strong>
            <span className="pico-handoff-meta handoff-secondary">{meta}</span>
          </span>
          <Icon name="chevron-down" size={18} />
        </button>
      </h3>
      <div id={id} className="pico-handoff-item-content" hidden={!open}>
        {open && children}
      </div>
    </article>
  );
}

function AssignmentButton({
  selection,
  onSelect,
}: {
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  return selection.item.candidates.length ? (
    <button className="primary" type="button" onClick={() => onSelect(selection)}>
      {selection.kind === 'companies' ? 'Назначить ответственного' : 'Назначить исполнителя'}
    </button>
  ) : (
    <p className="handoff-secondary">Нет активных сотрудников, которым можно передать работу.</p>
  );
}

function OpenHandoffCompany({
  id,
  company,
  onOpen,
}: {
  id: string;
  company?: Company;
  onOpen: (company: Company, nextTab?: string) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function open() {
    if (inFlight.current) return;
    setError('');
    if (company) {
      onOpen(company, 'project');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const detail = await api<CompanyDetail>(`/companies/${id}`);
      if (button.current) onOpen(detail.company, 'project');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось открыть карточку.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <button ref={button} type="button" disabled={busy} onClick={() => void open()}>
        {busy ? 'Открываем…' : 'Открыть карточку компании'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function HandoffConfirmation({
  selection,
  onClose,
  onAssigned,
  onReload,
}: {
  selection: Selection;
  onClose: () => void;
  onAssigned: (selection: Selection) => void;
  onReload: () => void;
}) {
  const descriptionId = useId();
  const select = useRef<HTMLSelectElement>(null);
  const inFlight = useRef(false);
  const [recipientId, setRecipientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isCompany = selection.kind === 'companies';
  const title = isCompany ? 'Передать компанию' : 'Передать задачу';
  const name = selection.kind === 'companies' ? selection.item.name : selection.item.text;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recipientId || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/client-handoff/${selection.kind}/${selection.item.id}`, 'POST', {
        recipientId,
        version: selection.item.version,
        ...(selection.kind === 'companies' ? { revision: selection.item.revision } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось передать работу.');
      inFlight.current = false;
      setBusy(false);
      return;
    }
    onAssigned(selection);
  }

  return (
    <Modal
      title={title}
      descriptionId={descriptionId}
      initialFocusRef={select}
      className="pico-handoff-confirmation"
      closeDisabled={busy}
      onClose={() => {
        if (!inFlight.current) onClose();
      }}
    >
      <p id={descriptionId}>
        <strong>{name}</strong>
        {selection.kind === 'companies' ? (
          <> · {counts(selection.item)}. История и задачи коллег сохранятся.</>
        ) : (
          <> · {selection.item.companyName}. Меняется только исполнитель.</>
        )}
      </p>
      <form onSubmit={submit}>
        <Field label={isCompany ? 'Новый ответственный' : 'Новый исполнитель'}>
          <select
            ref={select}
            value={recipientId}
            onChange={(event) => {
              setRecipientId(event.target.value);
              setError('');
            }}
            disabled={busy}
            required
          >
            <option value="">Выбрать сотрудника</option>
            {selection.item.candidates.map(({ id, name: candidateName }) => (
              <option key={id} value={id}>
                {candidateName}
              </option>
            ))}
          </select>
        </Field>
        {error && (
          <div className="pico-handoff-load-error">
            <p role="alert" className="error">
              {error}
            </p>
            <button type="button" onClick={onReload}>
              Обновить очередь
            </button>
          </div>
        )}
        <div className="pico-handoff-confirm-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="primary" disabled={busy || !recipientId}>
            {busy ? 'Передаём…' : title}
          </button>
        </div>
      </form>
    </Modal>
  );
}
