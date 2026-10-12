import { createPortal } from 'react-dom';
import { useState, useEffect, useRef, FormEvent, ReactNode } from 'react';
import {
  CompanyData,
  companySchema,
  segments,
  stages,
  divisions,
  labels,
  CrmRecord,
  RecordKind,
  Company,
  recordSchemas,
  taskTypes,
  taskTypeLabels,
} from '../shared/contracts';
import { today, api } from './api';
import { Icon } from './Icons';
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Select({
  value,
  onChange,
  options,
  empty,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  empty?: string;
}) {
  return (
    <select aria-label={empty} value={value} onChange={(e) => onChange(e.target.value)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map((v) => (
        <option key={v} value={v}>
          {taskTypeLabels[v] || labels[v] || v}
        </option>
      ))}
    </select>
  );
}
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current!;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ),
      ).filter((el) => el.getClientRects().length > 0);
    (focusable()[0] || dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (
        document.querySelectorAll('[role="dialog"]')[
          document.querySelectorAll('[role="dialog"]').length - 1
        ] !== dialog
      )
        return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const elements = focusable(),
          first = elements[0],
          last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          dialog.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last!.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const back = window.Telegram?.WebApp?.BackButton;
    const onBack = () => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] === dialog) closeRef.current();
    };
    back?.show();
    back?.onClick(onBack);
    return () => {
      back?.offClick(onBack);
      if (Array.from(document.querySelectorAll('[role="dialog"]')).some((el) => el !== dialog))
        back?.show();
      else back?.hide();
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="section-head">
          <h2>{title}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Закрыть">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}
export function CompanyForm({
  initial,
  onSave,
}: {
  initial?: CompanyData;
  onSave: (data: CompanyData) => Promise<void>;
}) {
  const [data, setData] = useState<CompanyData>(
    initial
      ? companySchema.strip().parse(initial)
      : { ...companySchema.parse({ name: 'Новая компания' }), name: '' },
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const update = (k: keyof CompanyData, v: any) => setData((p) => ({ ...p, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(companySchema.parse(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="form-grid">
      <Field label="Название">
        <input required value={data.name} onChange={(e) => update('name', e.target.value)} />
      </Field>
      <Field label="ИНН">
        <input
          inputMode="numeric"
          value={data.inn}
          onChange={(e) => update('inn', e.target.value)}
          placeholder="10 или 12 цифр"
        />
      </Field>
      <Field label="Город">
        <input value={data.city} onChange={(e) => update('city', e.target.value)} />
      </Field>
      <Field label="Отрасль">
        <input value={data.industry} onChange={(e) => update('industry', e.target.value)} />
      </Field>
      <Field label="Сегмент">
        <Select value={data.segment} onChange={(v) => update('segment', v)} options={segments} />
      </Field>
      <Field label="Стадия">
        <Select value={data.stage} onChange={(v) => update('stage', v)} options={stages} />
      </Field>
      <Field label="Оборот, ₽">
        <input
          type="number"
          min="0"
          step="0.01"
          value={data.revenue ?? ''}
          onChange={(e) => update('revenue', e.target.value === '' ? null : Number(e.target.value))}
        />
      </Field>
      <Field label="Потенциал, ₽">
        <input
          type="number"
          min="0"
          step="0.01"
          value={data.potential ?? ''}
          onChange={(e) =>
            update('potential', e.target.value === '' ? null : Number(e.target.value))
          }
        />
      </Field>
      <div className="wide">
        <h3>Потенциал по направлениям</h3>
        <div className="form-grid">
          {divisions.map((key) => (
            <Field key={key} label={labels[key]! + ' · ₽'}>
              <input
                type="number"
                min="0"
                step="0.01"
                value={data.divisions[key] ?? ''}
                onChange={(e) => {
                  const next = { ...data.divisions };
                  if (e.target.value === '') delete next[key];
                  else next[key] = Number(e.target.value);
                  update('divisions', next);
                }}
              />
            </Field>
          ))}
        </div>
      </div>
      <div className="wide">
        <Field label="Заметки">
          <textarea rows={3} value={data.notes} onChange={(e) => update('notes', e.target.value)} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="error wide">
          {error}
        </p>
      )}
      <button disabled={busy} className="primary wide">
        {busy ? 'Сохраняем…' : 'Сохранить компанию'}
      </button>
    </form>
  );
}
export function RecordForm({
  kind,
  initial,
  projects,
  onSave,
  companies = [],
  contacts = [],
}: {
  companies?: Company[];
  contacts?: CrmRecord[];
  kind: Exclude<RecordKind, 'file'>;
  initial?: CrmRecord;
  projects: CrmRecord[];
  onSave: (data: any, projectId: string | null) => Promise<void>;
}) {
  const defaults = {
    contact: { name: '', role: '', phone: '', email: '' },
    project: { name: '', amount: null, due: null, stage: 'new', notes: '' },
    task: { text: '', due: null, done: false },
    activity: { text: '', occurredOn: today() },
  };
  const clean = { ...initial?.data };
  delete clean.completedAt;
  delete clean.reportId;
  const [data, setData] = useState<any>(() =>
    initial
      ? recordSchemas[kind].parse(clean)
      : {
          ...recordSchemas[kind].parse({
            ...defaults[kind],
            ...(kind === 'task'
              ? { text: 'Новая задача' }
              : kind === 'activity'
                ? { text: 'Запись' }
                : { name: 'Новая запись' }),
          }),
          ...defaults[kind],
        },
  );
  const [equipmentOpen, setEquipmentOpen] = useState(false),
    [participantOpen, setParticipantOpen] = useState(false);
  const [equipment, setEquipment] = useState({ division: 'lv', name: labels.lv!, amount: '' });
  const [participant, setParticipant] = useState({
    companyId: '',
    role: 'Заказчик',
    contactId: '',
    currentTask: '',
    nextStep: '',
  });
  const [participantContacts, setParticipantContacts] = useState<CrmRecord[]>([]),
    [linkError, setLinkError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setParticipantContacts([]);
    setLinkError('');
    if (participant.companyId)
      api(`/companies/${participant.companyId}`)
        .then((detail) => {
          if (!cancelled)
            setParticipantContacts(detail.records.filter((r: CrmRecord) => r.kind === 'contact'));
        })
        .catch((e) => {
          if (!cancelled) setLinkError(e.message);
        });
    return () => {
      cancelled = true;
    };
  }, [participant.companyId]);
  const [projectId, setProjectId] = useState(initial?.projectId || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const fields: Record<string, [string, string][]> = {
    contact: [
      ['name', 'Имя'],
      ['role', 'Должность'],
      ['phone', 'Телефон'],
      ['email', 'Email'],
    ],
    project: [
      ['name', 'Название проекта'],
      ['amount', 'Сумма, ₽'],
      ['due', 'Срок'],
      ['stage', 'Стадия'],
      ['notes', 'Описание'],
    ],
    task: [
      ['text', 'Задача'],
      ['due', 'Срок'],
    ],
    activity: [
      ['text', 'Результат общения'],
      ['occurredOn', 'Дата общения'],
    ],
  };
  return (
    <form
      className="form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await onSave(data, projectId || null);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {fields[kind]!.map(([key, label]) => (
        <Field key={key} label={label}>
          {key === 'stage' ? (
            <Select
              value={data[key]}
              onChange={(v) => setData({ ...data, [key]: v })}
              options={stages}
            />
          ) : key === 'notes' || (key === 'text' && kind === 'activity') ? (
            <textarea
              required={key === 'text'}
              rows={4}
              value={data[key]}
              onChange={(e) => setData({ ...data, [key]: e.target.value })}
            />
          ) : (
            <input
              required={['name', 'text', 'occurredOn'].includes(key)}
              type={
                ['due', 'occurredOn'].includes(key)
                  ? 'date'
                  : key === 'amount'
                    ? 'number'
                    : key === 'email'
                      ? 'email'
                      : 'text'
              }
              min={key === 'amount' ? 0 : undefined}
              step={key === 'amount' ? '0.01' : undefined}
              value={data[key] ?? ''}
              onChange={(e) =>
                setData({
                  ...data,
                  [key]:
                    key === 'amount'
                      ? e.target.value === ''
                        ? null
                        : Number(e.target.value)
                      : key === 'due'
                        ? e.target.value || null
                        : e.target.value,
                })
              }
            />
          )}
        </Field>
      ))}
      {kind === 'task' && (
        <>
          <Field label="Тип задачи">
            <Select
              value={data.type}
              onChange={(type) => setData({ ...data, type })}
              options={taskTypes}
            />
          </Field>
          <Field label="Время">
            <input
              type="time"
              value={data.time || ''}
              onChange={(e) => setData({ ...data, time: e.target.value || null })}
            />
          </Field>
          <Field label="Контакт">
            <select
              value={data.contactId || ''}
              onChange={(e) => setData({ ...data, contactId: e.target.value || null })}
            >
              <option value="">Не выбран</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.data.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      {kind === 'project' && (
        <>
          <Field label="Город проекта">
            <input value={data.city} onChange={(e) => setData({ ...data, city: e.target.value })} />
          </Field>
          <Field label="Тип объекта">
            <input
              value={data.objectType}
              onChange={(e) => setData({ ...data, objectType: e.target.value })}
            />
          </Field>
          <Field label="Дата закупки">
            <input
              type="date"
              value={data.purchaseDate || ''}
              onChange={(e) => setData({ ...data, purchaseDate: e.target.value || null })}
            />
          </Field>
          <div className="wide">
            <h3>Оборудование</h3>
            {data.equipment.map((item: any, index: number) => (
              <div className="equipment-line" key={index}>
                <span>{item.name}</span>
                <strong>
                  {item.amount === null ? 'Не указано' : item.amount.toLocaleString('ru') + ' ₽'}
                </strong>
                <button
                  type="button"
                  aria-label={`Убрать оборудование ${item.name}`}
                  onClick={() => {
                    const equipment = data.equipment.filter((_: any, i: number) => i !== index);
                    setData({
                      ...data,
                      equipment,
                      amount:
                        equipment.length && equipment.every((item: any) => item.amount !== null)
                          ? equipment.reduce(
                              (sum: number, item: any) => sum + (item.amount || 0),
                              0,
                            )
                          : null,
                    });
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
            <button type="button" className="pico-add-row" onClick={() => setEquipmentOpen(true)}>
              + Добавить оборудование
            </button>
          </div>
          <div className="wide">
            <h3>Участники</h3>
            {data.participants.map((item: any, index: number) => (
              <div className="participant-line" key={item.companyId}>
                <div>
                  <strong>
                    {companies.find((c) => c.id === item.companyId)?.name || 'Клиент'}
                  </strong>
                  <small>{item.role}</small>
                </div>
                <button
                  type="button"
                  disabled={index === 0}
                  aria-label="Переместить участника выше"
                  onClick={() => {
                    const participants = [...data.participants];
                    [participants[index - 1], participants[index]] = [
                      participants[index],
                      participants[index - 1],
                    ];
                    setData({ ...data, participants });
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="Убрать участника"
                  onClick={() =>
                    setData({
                      ...data,
                      participants: data.participants.filter((_: any, i: number) => i !== index),
                    })
                  }
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
            <button type="button" className="pico-add-row" onClick={() => setParticipantOpen(true)}>
              + Добавить участника
            </button>
          </div>
        </>
      )}
      {equipmentOpen && (
        <Modal title="Оборудование" onClose={() => setEquipmentOpen(false)}>
          <div className="form-grid">
            <Field label="Направление">
              <Select
                value={equipment.division}
                options={divisions}
                onChange={(division) =>
                  setEquipment({ ...equipment, division, name: labels[division]! })
                }
              />
            </Field>
            <Field label="Оборудование">
              <input
                value={equipment.name}
                onChange={(e) => setEquipment({ ...equipment, name: e.target.value })}
              />
            </Field>
            <Field label="Сумма оборудования, ₽">
              <input
                type="number"
                min="0"
                value={equipment.amount}
                onChange={(e) => setEquipment({ ...equipment, amount: e.target.value })}
              />
            </Field>
            <button
              type="button"
              className="primary wide"
              disabled={
                !equipment.name.trim() ||
                (equipment.amount !== '' &&
                  (!Number.isFinite(Number(equipment.amount)) || Number(equipment.amount) < 0))
              }
              onClick={() => {
                const next = [
                  ...data.equipment,
                  {
                    ...equipment,
                    amount: equipment.amount === '' ? null : Number(equipment.amount),
                  },
                ];
                setData({
                  ...data,
                  equipment: next,
                  amount: next.every((item: any) => item.amount !== null)
                    ? next.reduce((sum: number, item: any) => sum + item.amount, 0)
                    : null,
                });
                setEquipmentOpen(false);
              }}
            >
              Добавить в проект
            </button>
          </div>
        </Modal>
      )}
      {participantOpen && (
        <Modal title="Новый участник" onClose={() => setParticipantOpen(false)}>
          <div className="form-grid">
            <Field label="Клиент участника">
              <select
                value={participant.companyId}
                onChange={(e) =>
                  setParticipant({ ...participant, companyId: e.target.value, contactId: '' })
                }
              >
                <option value="">Выберите клиента</option>
                {companies
                  .filter(
                    (c) => !c.archived && !data.participants.some((p: any) => p.companyId === c.id),
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Роль в проекте">
              <select
                value={participant.role}
                onChange={(e) => setParticipant({ ...participant, role: e.target.value })}
              >
                {[
                  'Заказчик',
                  'Проектный институт',
                  'Генподрядчик',
                  'Подрядчик',
                  'Интегратор',
                  'Коммерческая организация',
                ].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </Field>
            <Field label="Контакт участника">
              <select
                value={participant.contactId}
                onChange={(e) => setParticipant({ ...participant, contactId: e.target.value })}
              >
                <option value="">Не выбран</option>
                {participantContacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.data.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Текущая задача">
              <input
                value={participant.currentTask}
                onChange={(e) => setParticipant({ ...participant, currentTask: e.target.value })}
              />
            </Field>
            <Field label="Следующий шаг">
              <input
                value={participant.nextStep}
                onChange={(e) => setParticipant({ ...participant, nextStep: e.target.value })}
              />
            </Field>
            {linkError && (
              <p role="alert" className="error">
                {linkError}
              </p>
            )}
            <button
              type="button"
              className="primary wide"
              disabled={!participant.companyId || !!linkError}
              onClick={() => {
                setData({
                  ...data,
                  participants: [
                    ...data.participants,
                    { ...participant, contactId: participant.contactId || null },
                  ],
                });
                setParticipantOpen(false);
                setParticipant({
                  companyId: '',
                  role: 'Заказчик',
                  contactId: '',
                  currentTask: '',
                  nextStep: '',
                });
              }}
            >
              Добавить участника
            </button>
          </div>
        </Modal>
      )}
      {kind === 'task' && !initial && (
        <Field label="Проект">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Без проекта</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.data.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {error && (
        <p role="alert" className="error wide">
          {error}
        </p>
      )}
      <button disabled={busy} className="primary wide">
        {busy ? 'Сохраняем…' : 'Сохранить'}
      </button>
    </form>
  );
}
