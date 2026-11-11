import { ReactNode, useEffect, useState } from 'react';
import {
  Actor,
  Company,
  CrmRecord,
  taskSchema,
  taskTypeLabels,
  taskTypes,
} from '../shared/contracts';
import { companyDisplayName } from '../shared/company-display-name';
import { api } from './api';
import { Field, Modal } from './forms';
import { Icon } from './Icons';
import { useTaskActions } from './TaskActions';

type Task = CrmRecord & { companyName: string; projectName?: string | null };
type Props = {
  task: Task;
  projects: Task[];
  users: Actor[];
  companies: Company[];
  advice: ReactNode;
  contactLabel: ReactNode;
  onCompany: (company: Company) => void;
  onChanged: () => Promise<void>;
  onSaved: (task: Task) => void;
  onClose: () => void;
};
const formatDate = (value: string | null) => {
  if (!value) return '';
  const text = new Date(value + 'T12:00:00').toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  });
  return text[0]!.toUpperCase() + text.slice(1);
};
export function TaskDetailSheet(props: Props) {
  const { task } = props;
  const actions = useTaskActions();
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [contacts, setContacts] = useState<CrmRecord[]>([]);
  const [assignees, setAssignees] = useState<Pick<Actor, 'id' | 'name' | 'role'>[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [error, setError] = useState('');
  const deleted = !!task.data.deleted;
  useEffect(() => {
    if (field !== 'Контакт' && field !== 'Ответственный') return;
    let current = true;
    setLoading(true);
    setOptionsFailed(false);
    const request =
      field === 'Контакт'
        ? api<{ records: CrmRecord[] }>(`/companies/${task.companyId}`).then((detail) => {
            if (current) setContacts(detail.records.filter((record) => record.kind === 'contact'));
          })
        : Promise.all([
            api<Pick<Actor, 'id' | 'name' | 'role'>[]>('/employee-filter/options'),
            props.companies.find((company) => company.id === task.companyId) ||
              api<{ company: Company }>(`/companies/${task.companyId}`).then(
                (detail) => detail.company,
              ),
          ]).then(([people, company]) => {
            if (current)
              setAssignees(
                people.filter(
                  (person) => person.role !== 'manager' || person.id === company.ownerId,
                ),
              );
          });
    void request
      .catch((cause) => {
        if (current) {
          setError((cause as Error).message);
          setOptionsFailed(true);
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [field, task.companyId]);
  const values: Record<string, string | ReactNode> = {
    Дата: formatDate(task.data.due),
    Время: task.data.time,
    Тип: taskTypeLabels[task.data.type] || 'Напоминание',
    Клиент: companyDisplayName(task.companyName),
    Проект:
      props.projects.find((project) => project.id === task.projectId)?.data.name ||
      task.projectName,
    Контакт: task.data.contactId ? props.contactLabel : '',
    Ответственный: props.users.find((user) => user.id === task.assigneeId)?.name,
  };
  const raw: Record<string, string> = {
    Дата: task.data.due || '',
    Время: task.data.time || '',
    Тип: task.data.type || 'reminder',
    Проект: task.projectId || '',
    Контакт: task.data.contactId || '',
    Ответственный: task.assigneeId || '',
  };
  async function openField(label: string) {
    if (busy || deleted) return;
    setError('');
    if (label === 'Клиент') {
      setBusy(true);
      try {
        const company =
          props.companies.find((company) => company.id === task.companyId) ||
          (await api<{ company: Company }>(`/companies/${task.companyId}`)).company;
        props.onClose();
        props.onCompany(company);
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    setOptionsFailed(false);
    setValue(raw[label] || '');
    setField(label);
  }
  async function saveField() {
    if (busy || loading) return;
    setBusy(true);
    setError('');
    try {
      const keys: Record<string, string> = {
        Дата: 'due',
        Время: 'time',
        Тип: 'type',
        Контакт: 'contactId',
      };
      const data = taskSchema.strip().parse(task.data);
      const body =
        field === 'Проект'
          ? { projectId: value || null }
          : field === 'Ответственный'
            ? { assigneeId: value || null }
            : {};
      if (keys[field]) (data as any)[keys[field]!] = value || null;
      const saved = await api<CrmRecord>(`/records/${task.id}`, 'PATCH', {
        version: task.version,
        data,
        ...body,
      });
      props.onSaved({
        ...task,
        ...saved,
        projectName: saved.projectId
          ? props.projects.find((project) => project.id === saved.projectId)?.data.name
          : null,
      });
      setField('');
      try {
        await props.onChanged();
      } catch {
        setError('Изменение сохранено, но список не обновился. Обновите страницу.');
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function restore() {
    actions.schedule(task, 'restore');
    props.onClose();
  }
  const unavailableSelection =
    !!value &&
    ((field === 'Проект' &&
      !props.projects.some(
        (project) => project.id === value && project.companyId === task.companyId,
      )) ||
      (field === 'Контакт' && !contacts.some((contact) => contact.id === value)) ||
      (field === 'Ответственный' && !assignees.some((person) => person.id === value)));
  return (
    <Modal
      sheet
      showHandle={false}
      title={task.data.text}
      titleIcon={
        <span className="pico-task-sheet-badge">
          <Icon name="reminder" size={22} />
        </span>
      }
      closeDisabled={busy}
      onClose={() => {
        if (!busy) props.onClose();
      }}
    >
      <div className="pico-task-detail-body">
        {error && !field && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="pico-task-field-group">
          {Object.entries(values).map(([label, content]) => (
            <button
              type="button"
              key={label}
              aria-label={label}
              disabled={busy || deleted}
              onClick={() => void openField(label)}
            >
              <span>{label}</span>
              <strong className={!content ? 'is-empty' : ''}>{content || 'Не выбрано'}</strong>
              <Icon name="chevron-right" size={16} />
            </button>
          ))}
        </div>
        {props.advice}
        {task.data.done ? (
          <button
            className="primary pico-task-restore"
            disabled={busy}
            onClick={() => void restore()}
          >
            Вернуть задачу
          </button>
        ) : (
          <div className="pico-task-sheet-actions">
            <button
              type="button"
              className="pico-task-sheet-delete"
              onClick={() => {
                actions.schedule(task, 'deleted');
                props.onClose();
              }}
            >
              <Icon name="trash" size={18} />
              Удалить
            </button>
            <button
              type="button"
              className="pico-task-sheet-done"
              onClick={() => {
                actions.schedule(task, 'done');
                props.onClose();
              }}
            >
              <Icon name="check" size={18} />
              Выполнено
            </button>
          </div>
        )}
      </div>
      {field && (
        <Modal
          title={'Изменить ' + field}
          onClose={() => {
            if (!busy) setField('');
          }}
          closeDisabled={busy}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveField();
            }}
          >
            <Field label={field}>
              {field === 'Дата' || field === 'Время' ? (
                <input
                  aria-label={field}
                  type={field === 'Дата' ? 'date' : 'time'}
                  value={value}
                  disabled={busy}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setError('');
                  }}
                />
              ) : (
                <select
                  aria-label={field}
                  value={value}
                  disabled={busy || loading}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setError('');
                  }}
                >
                  {field !== 'Тип' && <option value="">Не выбрано</option>}
                  {unavailableSelection && (
                    <option value={value} disabled>
                      {typeof values[field] === 'string' && values[field]
                        ? values[field]
                        : 'Текущая связь недоступна'}
                    </option>
                  )}
                  {field === 'Тип' &&
                    taskTypes.map((type) => (
                      <option key={type} value={type}>
                        {taskTypeLabels[type]}
                      </option>
                    ))}
                  {field === 'Проект' &&
                    props.projects
                      .filter((project) => project.companyId === task.companyId)
                      .map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.data.name}
                        </option>
                      ))}
                  {field === 'Контакт' &&
                    contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.data.name}
                      </option>
                    ))}
                  {field === 'Ответственный' &&
                    assignees.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            {loading && <p role="status">Загрузка…</p>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <button className="primary" disabled={busy || loading || optionsFailed}>
                Сохранить
              </button>
              <button type="button" disabled={busy} onClick={() => setField('')}>
                Отмена
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Modal>
  );
}
