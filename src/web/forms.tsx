import { createPortal } from 'react-dom';
import { useState, useEffect, useRef, FormEvent, ReactNode } from 'react';
import {
  CompanyData,
  companySchema,
  segments,
  stages,
  divisions,
  primarySegments,
  primaryDivisions,
  divisionLabels,
  projectSupplyTypes,
  projectServiceTypes,
  labels,
  CrmRecord,
  RecordKind,
  Company,
  recordSchemas,
  taskTypes,
  taskTypeLabels,
} from '../shared/contracts';
import { today, api, money } from './api';
import { Chips, ClientPicker, PickerRow, fromMillions, millionValue } from './FormWidgets';
export { Chips, ClientPicker } from './FormWidgets';
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
  titleIcon,
  title,
  onClose,
  children,
}: {
  titleIcon?: ReactNode;
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
          <h2 className={titleIcon ? 'pico-modal-icon-title' : undefined}>
            {titleIcon}
            {title}
          </h2>
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
export function NewDirectionEditor({
  initial,
  onSave,
  onClose,
}: {
  initial?: { division: string; amount: number };
  onSave: (value: { division: string; amount: number }) => Promise<void>;
  onClose: () => void;
}) {
  const [division, setDivision] = useState(initial?.division || ''),
    [amount, setAmount] = useState(millionValue(initial?.amount)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title="Новое направление" onClose={onClose}>
      <form
        className="pico-compact-form"
        onSubmit={async (e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setError('');
          const value = fromMillions(amount);
          if (!division || value == null || !Number.isFinite(value) || value < 0) {
            setError('Выберите направление и укажите сумму');
            return;
          }
          setBusy(true);
          try {
            await onSave({ division, amount: value });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Chips
          label="Направление"
          options={
            initial?.division === 'drives' ? [...primaryDivisions, 'drives'] : primaryDivisions
          }
          value={division}
          onChange={setDivision}
        />
        <Field label="Потенциал, млн ₽">
          <input
            required
            type="number"
            min="0"
            max="1000000"
            step="any"
            value={amount}
            placeholder="Потребность на год, например 150"
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <p className="muted">Годовая потребность клиента. Сумма сохраняется в рублях.</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Добавить направление'}
        </button>
      </form>
    </Modal>
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
        : { ...companySchema.parse({ name: 'Новый клиент' }), name: '' },
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [direction, setDirection] = useState<{ division: string; amount: number } | null | false>(
      false,
    );
  function update(key: keyof CompanyData, value: any) {
    setData((current) => ({ ...current, [key]: value }));
  }
  return (
    <form
      className="pico-compact-form"
      onSubmit={async (e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
          await onSave(companySchema.parse(data));
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="ИНН">
        <input
          inputMode="numeric"
          value={data.inn}
          placeholder="10 или 12 цифр"
          onChange={(e) => update('inn', e.target.value)}
        />
      </Field>
      <div className="pico-form-two">
        <Field label="Название">
          <input
            required
            value={data.name}
            placeholder="ООО «Компания»"
            onChange={(e) => update('name', e.target.value)}
          />
        </Field>
        <Field label="Город">
          <input
            value={data.city}
            placeholder="Город"
            onChange={(e) => update('city', e.target.value)}
          />
        </Field>
      </div>
      <Chips
        label="Категория клиента"
        options={
          data.segment === 'shchitovik' ? [...primarySegments, 'shchitovik'] : primarySegments
        }
        value={data.segment}
        onChange={(value) => update('segment', value)}
      />
      <section className="pico-form-section">
        <div className="section-head">
          <h3>Потенциал</h3>
          <small>Потребность клиента за год</small>
        </div>
        {Object.entries(data.divisions).map(([division, amount]) => (
          <div className="pico-equipment-entry" key={division}>
            <button
              type="button"
              className="pico-entry-main"
              onClick={() => setDirection({ division, amount: amount! })}
            >
              {divisionLabels[division] || labels[division]}
            </button>
            <strong>{money(amount)}</strong>
            <button
              type="button"
              aria-label={'Убрать направление ' + (divisionLabels[division] || labels[division])}
              onClick={() => {
                const next = { ...data.divisions };
                delete next[division as keyof typeof next];
                update('divisions', next);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="pico-add-row pico-dashed"
          onClick={() => setDirection(null)}
        >
          <Icon name="plus" size={14} /> Добавить оборудование
        </button>
      </section>
      <details className="pico-advanced">
        <summary>Дополнительные поля</summary>
        <div className="pico-compact-form">
          <Field label="Отрасль">
            <input value={data.industry} onChange={(e) => update('industry', e.target.value)} />
          </Field>
          <Field label="Стадия">
            <Select value={data.stage} onChange={(v) => update('stage', v)} options={stages} />
          </Field>
          <Field label="Сегмент">
            <Select
              value={data.segment}
              onChange={(v) => update('segment', v)}
              options={segments}
            />
          </Field>
          <Field label="Оборот, ₽">
            <input
              type="number"
              min="0"
              step="any"
              value={data.revenue ?? ''}
              onChange={(e) =>
                update('revenue', e.target.value === '' ? null : Number(e.target.value))
              }
            />
          </Field>
          <Field label="Потенциал, ₽">
            <input
              type="number"
              min="0"
              step="any"
              value={data.potential ?? ''}
              onChange={(e) =>
                update('potential', e.target.value === '' ? null : Number(e.target.value))
              }
            />
          </Field>
          <Field label="Заметки">
            <textarea
              rows={2}
              value={data.notes}
              onChange={(e) => update('notes', e.target.value)}
            />
          </Field>
          <details>
            <summary>Потенциал по направлениям · рубли</summary>
            {divisions.map((d) => (
              <Field key={d} label={labels[d] + ' · ₽'}>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={data.divisions[d] ?? ''}
                  onChange={(e) => {
                    const next = { ...data.divisions };
                    if (e.target.value === '') delete next[d];
                    else next[d] = Number(e.target.value);
                    setData((current) => ({
                      ...current,
                      divisions: next,
                      potential: Object.values(next).reduce(
                        (sum, amount) => sum + (amount || 0),
                        0,
                      ),
                    }));
                  }}
                />
              </Field>
            ))}
          </details>
        </div>
      </details>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? 'Сохраняем…' : 'Сохранить клиента'}
      </button>
      {direction !== false && (
        <NewDirectionEditor
          initial={direction || undefined}
          onClose={() => setDirection(false)}
          onSave={async (value) => {
            setData((current) => ({
              ...current,
              divisions: { ...current.divisions, [value.division]: value.amount },
              potential: Object.values({
                ...current.divisions,
                [value.division]: value.amount,
              }).reduce((sum, amount) => sum + (amount || 0), 0),
            }));
          }}
        />
      )}
    </form>
  );
}
type TaskData = {
  text: string;
  due: string | null;
  time: string | null;
  type: string;
  done: boolean;
  contactId: string | null;
};
function TaskFields({
  data,
  onChange,
  contacts,
  projects,
  projectId,
  onProjectChange,
  clientRow,
}: {
  data: TaskData;
  onChange: (data: TaskData) => void;
  contacts: CrmRecord[];
  projects: CrmRecord[];
  projectId: string;
  onProjectChange: (id: string) => void;
  clientRow?: ReactNode;
}) {
  const [projectOpen, setProjectOpen] = useState(false),
    [contactOpen, setContactOpen] = useState(false);
  return (
    <>
      <textarea
        className="pico-task-textarea"
        aria-label="Задача"
        required
        maxLength={200}
        rows={3}
        value={data.text}
        placeholder={'Что нужно сделать? Например: «Позвонить в Газпром по КП на ячейки»'}
        onChange={(e) => onChange({ ...data, text: e.target.value })}
      />
      <div className="pico-picker-box">
        <PickerRow label="Дата" icon="calendar">
          <input
            aria-label="Срок"
            type="date"
            value={data.due || ''}
            onChange={(e) => onChange({ ...data, due: e.target.value || null })}
          />
        </PickerRow>
        <PickerRow label="Время" icon="clock">
          <input
            aria-label="Время"
            type="time"
            value={data.time || ''}
            onChange={(e) => onChange({ ...data, time: e.target.value || null })}
          />
        </PickerRow>
        {clientRow}
        <PickerRow
          label="Проект"
          icon="projects"
          value={projects.find((p) => p.id === projectId)?.data.name}
          onClick={() => setProjectOpen(!projectOpen)}
        />
        {projectOpen && (
          <div className="pico-inline-picker">
            <button
              type="button"
              aria-pressed={!projectId}
              onClick={() => {
                onProjectChange('');
                setProjectOpen(false);
              }}
            >
              Не выбран
            </button>
            {projects.map((p) => (
              <button
                type="button"
                key={p.id}
                aria-pressed={p.id === projectId}
                onClick={() => {
                  onProjectChange(p.id);
                  setProjectOpen(false);
                }}
              >
                {p.data.name}
                <Icon name={p.id === projectId ? 'check' : 'chevron-right'} size={14} />
              </button>
            ))}
          </div>
        )}
        <PickerRow
          label="Контакт"
          icon="contact"
          value={contacts.find((c) => c.id === data.contactId)?.data.name}
          onClick={() => setContactOpen(!contactOpen)}
        />
        {contactOpen && (
          <div className="pico-inline-picker">
            <button
              type="button"
              onClick={() => {
                onChange({ ...data, contactId: null });
                setContactOpen(false);
              }}
            >
              Не выбран
            </button>
            {contacts.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === data.contactId}
                onClick={() => {
                  onChange({ ...data, contactId: c.id });
                  setContactOpen(false);
                }}
              >
                {c.data.name}
                <small>{c.data.role}</small>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="pico-chip-field">
        <div className="pico-field-heading">Тип задачи</div>
        <div className="pico-chips">
          {taskTypes.map((type) => (
            <button
              type="button"
              key={type}
              aria-pressed={data.type === type}
              className={data.type === type ? 'active' : ''}
              onClick={() => onChange({ ...data, type })}
            >
              <Icon name={type} size={13} />
              {taskTypeLabels[type]}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
export function TaskComposer({
  companies,
  projects,
  initial,
  onSave,
}: {
  companies: Company[];
  projects: CrmRecord[];
  initial?: CrmRecord;
  onSave: (data: any, companyId: string, projectId: string | null) => Promise<void>;
}) {
  const [data, setData] = useState<TaskData>(() =>
      initial
        ? recordSchemas.task.parse(initial.data)
        : { text: '', due: today(), time: null, type: 'meeting', done: false, contactId: null },
    ),
    [companyId, setCompanyId] = useState(initial?.companyId || ''),
    [projectId, setProjectId] = useState(initial?.projectId || ''),
    [clientOpen, setClientOpen] = useState(false),
    [contacts, setContacts] = useState<CrmRecord[]>([]),
    [error, setError] = useState(''),
    [contactError, setContactError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setContacts([]);
    setContactError('');
    if (companyId)
      api<{ records: CrmRecord[] }>(`/companies/${companyId}`)
        .then((d) => {
          if (current) setContacts(d.records.filter((r) => r.kind === 'contact'));
        })
        .catch((e) => {
          if (current) setContactError(e.message);
        });
    return () => {
      current = false;
    };
  }, [companyId]);
  const clientRow = (
    <>
      <PickerRow
        label="Клиент"
        icon="clients"
        value={companies.find((c) => c.id === companyId)?.name}
        onClick={() => setClientOpen(!clientOpen)}
      />
      {clientOpen && (
        <ClientPicker
          companies={companies}
          value={companyId}
          onChange={(id) => {
            setCompanyId(id);
            setProjectId('');
            setData((current) => ({ ...current, contactId: null }));
            setClientOpen(false);
          }}
        />
      )}
    </>
  );
  return (
    <form
      className="pico-compact-form pico-task-composer"
      onSubmit={async (e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        if (!companyId) {
          setError('Выберите клиента');
          setClientOpen(true);
          return;
        }
        setBusy(true);
        setError('');
        try {
          await onSave(recordSchemas.task.parse(data), companyId, projectId || null);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <TaskFields
        data={data}
        onChange={setData}
        contacts={contacts}
        projects={projects.filter((p) => p.companyId === companyId)}
        projectId={projectId}
        onProjectChange={setProjectId}
        clientRow={clientRow}
      />
      {contactError && (
        <p role="alert" className="error">
          Контакты не загружены: {contactError}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? 'Сохраняем…' : 'Добавить задачу'}
      </button>
    </form>
  );
}
const participantRoles = [
  'Заказчик',
  'Проектный институт',
  'Генподрядчик',
  'Подрядчик',
  'Интегратор',
  'Коммерческая организация',
];
type EquipmentItem = { division: string; name: string; amount: number | null };
function EquipmentEditor({
  initial,
  onSave,
  onClose,
}: {
  initial: EquipmentItem[];
  onSave: (items: EquipmentItem[]) => void;
  onClose: () => void;
}) {
  const initialKeys = [...new Set(initial.map((e) => e.division))];
  const groups = Object.fromEntries(
    initialKeys.map((key) => [key, initial.filter((e) => e.division === key)]),
  );
  const [selected, setSelected] = useState<string[]>(initialKeys),
    [amounts, setAmounts] = useState<Record<string, string>>(
      Object.fromEntries(
        initialKeys.map((key) => [
          key,
          groups[key]!.every((e) => e.amount !== null)
            ? millionValue(groups[key]!.reduce((sum, e) => sum + (e.amount || 0), 0))
            : '',
        ]),
      ),
    ),
    [error, setError] = useState('');
  const choices = [
    ...primaryDivisions,
    ...projectSupplyTypes,
    ...projectServiceTypes,
    ...initial.filter((e) => e.division === 'drives').map((e) => e.division),
  ];
  return (
    <Modal title="Оборудование" onClose={onClose}>
      <div className="pico-compact-form">
        <Chips
          label="Направление"
          options={choices.filter((k) => primaryDivisions.includes(k as any) || k === 'drives')}
          multiple
          value={selected}
          onChange={setSelected}
        />
        <Chips
          label="Проектная поставка"
          options={projectSupplyTypes}
          multiple
          value={selected}
          onChange={setSelected}
        />
        <Chips
          label="Услуги"
          options={projectServiceTypes}
          multiple
          value={selected}
          onChange={setSelected}
        />
        <div className="section-head">
          <h3>Сумма по выбранному</h3>
          <small>млн ₽</small>
        </div>
        {selected.map((key) => (
          <div className="pico-amount-row" key={key}>
            <label htmlFor={'amount-' + key}>{divisionLabels[key] || labels[key] || key}</label>
            <input
              id={'amount-' + key}
              aria-label={'Сумма ' + (divisionLabels[key] || labels[key] || key) + ', млн ₽'}
              type="number"
              min="0"
              max="1000000"
              step="any"
              value={amounts[key] || ''}
              placeholder="Неизвестна"
              disabled={(groups[key]?.length || 0) > 1}
              onChange={(e) => setAmounts({ ...amounts, [key]: e.target.value })}
            />
          </div>
        ))}
        <p className="muted">
          У каждого направления своя сумма. Пустое поле означает, что сумма неизвестна. Несколько
          сохранённых позиций одного направления сохраняются раздельно.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          type="button"
          className="primary"
          disabled={!selected.length}
          onClick={() => {
            const invalid = selected.some(
              (k) =>
                amounts[k] &&
                (!Number.isFinite(Number(amounts[k])) ||
                  Number(amounts[k]) < 0 ||
                  Number(amounts[k]) > 1000000),
            );
            if (invalid) {
              setError('Укажите корректные суммы');
              return;
            }
            onSave(
              selected.flatMap((key) =>
                groups[key] && groups[key]!.length > 1
                  ? groups[key]!
                  : [
                      {
                        division: key,
                        name:
                          initial.find((e) => e.division === key)?.name ||
                          divisionLabels[key] ||
                          labels[key] ||
                          key,
                        amount: fromMillions(amounts[key] || ''),
                      },
                    ],
              ),
            );
            onClose();
          }}
        >
          Добавить в проект
        </button>
      </div>
    </Modal>
  );
}
export function RecordForm({
  kind,
  initial,
  projects,
  onSave,
  companies = [],
  contacts = [],
  clientRow,
}: {
  clientRow?: ReactNode;
  companies?: Company[];
  contacts?: CrmRecord[];
  kind: Exclude<RecordKind, 'file'>;
  initial?: CrmRecord;
  projects: CrmRecord[];
  onSave: (data: any, projectId: string | null) => Promise<void>;
}) {
  const clean = { ...initial?.data };
  delete clean.completedAt;
  delete clean.reportId;
  const defaults = {
    contact: { name: '', role: '', phone: '', email: '' },
    project: { name: '', amount: null, due: null, stage: 'new', notes: '' },
    task: { text: '', due: today(), time: null, type: 'meeting', done: false, contactId: null },
    activity: { text: '', occurredOn: today() },
  };
  const [data, setData] = useState<any>(() =>
      initial
        ? recordSchemas[kind].parse(clean)
        : {
            ...recordSchemas[kind].parse({
              ...defaults[kind],
              ...(kind === 'task' || kind === 'activity' ? { text: 'Запись' } : { name: 'Запись' }),
            }),
            ...defaults[kind],
          },
    ),
    [projectId, setProjectId] = useState(initial?.projectId || ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [equipmentOpen, setEquipmentOpen] = useState(false),
    [participantOpen, setParticipantOpen] = useState(false),
    [participantIndex, setParticipantIndex] = useState<number | null>(null),
    [participant, setParticipant] = useState<any>({
      companyId: '',
      role: 'Заказчик',
      contactId: null,
      currentTask: '',
      nextStep: '',
    }),
    [participantContacts, setParticipantContacts] = useState<CrmRecord[]>([]),
    [linkError, setLinkError] = useState(''),
    [linksLoading, setLinksLoading] = useState(false),
    [removeIndex, setRemoveIndex] = useState<number | null>(null),
    [dragIndex, setDragIndex] = useState<number | null>(null),
    [participantClientOpen, setParticipantClientOpen] = useState(true);
  useEffect(() => {
    let current = true;
    setParticipantContacts([]);
    setLinkError('');
    if (participantOpen && participant.companyId) {
      setLinksLoading(true);
      api<{ records: CrmRecord[] }>(`/companies/${participant.companyId}`)
        .then((detail) => {
          if (current) setParticipantContacts(detail.records.filter((r) => r.kind === 'contact'));
        })
        .catch((e) => {
          if (current) setLinkError(e.message);
        })
        .finally(() => {
          if (current) setLinksLoading(false);
        });
    } else setLinksLoading(false);
    return () => {
      current = false;
    };
  }, [participantOpen, participant.companyId]);
  function change(key: string, value: any) {
    setData((current: any) => ({ ...current, [key]: value }));
  }
  function reorder(from: number, to: number) {
    if (from === to || to < 0 || to >= data.participants.length) return;
    const next = [...data.participants],
      item = next.splice(from, 1)[0];
    next.splice(to, 0, item);
    change('participants', next);
  }
  function openParticipant(index: number | null) {
    setParticipantIndex(index);
    setParticipant(
      index === null
        ? { companyId: '', role: 'Заказчик', contactId: null, currentTask: '', nextStep: '' }
        : { ...data.participants[index] },
    );
    setParticipantClientOpen(index === null);
    setParticipantOpen(true);
  }
  const total =
    kind === 'project' &&
    data.equipment.length &&
    data.equipment.every((e: EquipmentItem) => e.amount !== null)
      ? data.equipment.reduce((s: number, e: EquipmentItem) => s + (e.amount || 0), 0)
      : null;
  return (
    <form
      className={'pico-compact-form pico-record-form form-' + kind}
      onSubmit={async (e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await onSave(recordSchemas[kind].parse(data), projectId || null);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {kind === 'contact' && (
        <>
          {[
            ['name', 'Имя'],
            ['role', 'Должность'],
            ['phone', 'Телефон'],
            ['email', 'Email'],
          ].map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                required={key === 'name'}
                type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'}
                value={data[key]}
                placeholder={
                  key === 'name'
                    ? 'Например, Иванов Сергей'
                    : key === 'phone'
                      ? '+7 900 000-00-00'
                      : undefined
                }
                onChange={(e) => change(key, e.target.value)}
              />
            </Field>
          ))}
          <p className="muted">
            <Icon name="sparkles" size={13} /> Pico выстроит контакты по иерархии компании
          </p>
        </>
      )}
      {kind === 'task' && (
        <TaskFields
          data={data}
          onChange={setData}
          contacts={contacts}
          projects={projects}
          projectId={projectId}
          onProjectChange={setProjectId}
        />
      )}
      {kind === 'activity' && (
        <>
          <Field label="Результат общения">
            <textarea
              required
              rows={4}
              value={data.text}
              onChange={(e) => change('text', e.target.value)}
            />
          </Field>
          <Field label="Дата общения">
            <input
              required
              type="date"
              value={data.occurredOn}
              onChange={(e) => change('occurredOn', e.target.value)}
            />
          </Field>
        </>
      )}
      {kind === 'project' && (
        <>
          <Field label="Название проекта">
            <input
              required
              value={data.name}
              placeholder="Например, ТЭЦ-3 — модернизация"
              onChange={(e) => change('name', e.target.value)}
            />
          </Field>
          {clientRow}
          <div className="pico-form-two">
            <Field label="Город проекта">
              <input
                value={data.city}
                placeholder="Калининград"
                onChange={(e) => change('city', e.target.value)}
              />
            </Field>
            <Field label="Тип объекта">
              <input
                value={data.objectType}
                placeholder="ТЭЦ, подстанция…"
                onChange={(e) => change('objectType', e.target.value)}
              />
            </Field>
          </div>
          <section className="pico-form-section">
            <div className="section-head">
              <h3>Оборудование</h3>
              <strong>Итого: {total === null ? 'Неизвестно' : money(total)}</strong>
            </div>
            {data.equipment.map((e: EquipmentItem, index: number) => (
              <div className="pico-equipment-entry" key={index}>
                <span>{e.name}</span>
                <strong>{money(e.amount)}</strong>
                <button
                  type="button"
                  aria-label={'Убрать оборудование ' + e.name}
                  onClick={() => {
                    const next = data.equipment.filter((_: any, i: number) => i !== index);
                    setData({
                      ...data,
                      equipment: next,
                      amount:
                        next.length && next.every((e: EquipmentItem) => e.amount !== null)
                          ? next.reduce((s: number, e: EquipmentItem) => s + (e.amount || 0), 0)
                          : null,
                    });
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="pico-add-row pico-dashed"
              onClick={() => setEquipmentOpen(true)}
            >
              <Icon name="plus" size={14} /> Добавить оборудование
            </button>
          </section>
          <div className="pico-form-two">
            <Field label="Дата закупки">
              <input
                type="date"
                value={data.purchaseDate || ''}
                onChange={(e) => change('purchaseDate', e.target.value || null)}
              />
            </Field>
            <Field label="Срок">
              <input
                type="date"
                value={data.due || ''}
                onChange={(e) => change('due', e.target.value || null)}
              />
            </Field>
          </div>
          <section className="pico-form-section">
            <div className="section-head">
              <h3>Участники</h3>
              <small>Меняйте порядок, хватайте мышью</small>
            </div>
            {data.participants.map((item: any, index: number) => (
              <div
                className="pico-participant-entry"
                key={item.companyId + '-' + index}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null) reorder(dragIndex, index);
                  setDragIndex(null);
                }}
              >
                <button
                  type="button"
                  className="pico-entry-main"
                  onClick={() => openParticipant(index)}
                >
                  <Icon name="clients" size={16} />
                  <span>
                    <strong>
                      {companies.find((c) => c.id === item.companyId)?.name || 'Клиент недоступен'}
                    </strong>
                    <small>{item.role}</small>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Переместить участника выше"
                  disabled={index === 0}
                  onClick={() => reorder(index, index - 1)}
                >
                  <Icon name="chevron-up" size={13} />
                </button>
                <button
                  type="button"
                  aria-label="Переместить участника ниже"
                  disabled={index === data.participants.length - 1}
                  onClick={() => reorder(index, index + 1)}
                >
                  <Icon name="chevron-down" size={13} />
                </button>
                <button
                  type="button"
                  aria-label="Убрать участника"
                  onClick={() => setRemoveIndex(index)}
                >
                  <Icon name="close" size={14} />
                </button>
                <span className="pico-drag-handle" aria-hidden="true">
                  ⠿
                </span>
              </div>
            ))}
            <button
              type="button"
              className="pico-add-row pico-dashed"
              onClick={() => openParticipant(null)}
            >
              <Icon name="plus" size={14} /> Добавить участника
            </button>
          </section>
          <details className="pico-advanced">
            <summary>Дополнительные поля</summary>
            <Field label="Стадия">
              <Select value={data.stage} onChange={(v) => change('stage', v)} options={stages} />
            </Field>
            <Field label="Сумма, ₽">
              <input
                type="number"
                min="0"
                step="any"
                value={data.amount ?? ''}
                onChange={(e) =>
                  change('amount', e.target.value === '' ? null : Number(e.target.value))
                }
              />
            </Field>
            <Field label="Описание">
              <textarea
                rows={2}
                value={data.notes}
                onChange={(e) => change('notes', e.target.value)}
              />
            </Field>
          </details>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy
          ? 'Сохраняем…'
          : kind === 'project'
            ? 'Сохранить проект'
            : kind === 'task'
              ? 'Добавить задачу'
              : kind === 'contact'
                ? 'Сохранить контакт'
                : 'Сохранить'}
      </button>
      {kind === 'project' && equipmentOpen && (
        <EquipmentEditor
          initial={data.equipment}
          onClose={() => setEquipmentOpen(false)}
          onSave={(items) =>
            setData({
              ...data,
              equipment: items,
              amount:
                items.length && items.every((e) => e.amount !== null)
                  ? items.reduce((s, e) => s + (e.amount || 0), 0)
                  : null,
            })
          }
        />
      )}
      {kind === 'project' && participantOpen && (
        <Modal
          title={participantIndex === null ? 'Новый участник' : 'Редактировать участника'}
          onClose={() => setParticipantOpen(false)}
        >
          <div className="pico-compact-form">
            {participantClientOpen ? (
              <ClientPicker
                companies={companies}
                value={participant.companyId}
                exclude={data.participants
                  .filter((_: any, i: number) => i !== participantIndex)
                  .map((p: any) => p.companyId)}
                onChange={(companyId) => {
                  setParticipant({ ...participant, companyId, contactId: null });
                  setParticipantClientOpen(false);
                }}
              />
            ) : (
              <PickerRow
                label="Клиент"
                icon="clients"
                value={
                  companies.find((c) => c.id === participant.companyId)?.name || 'Клиент недоступен'
                }
                onClick={() => setParticipantClientOpen(true)}
              />
            )}
            <Chips
              label="Роль в проекте"
              options={
                participantRoles.includes(participant.role)
                  ? participantRoles
                  : [...participantRoles, participant.role]
              }
              value={participant.role}
              onChange={(role) => setParticipant({ ...participant, role })}
            />
            <Field label="Контакт участника">
              <select
                value={participant.contactId || ''}
                disabled={linksLoading || !!linkError}
                onChange={(e) =>
                  setParticipant({ ...participant, contactId: e.target.value || null })
                }
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
            {linksLoading && <p role="status">Загрузка контактов…</p>}
            {linkError && (
              <p role="alert" className="error">
                Контакты недоступны: {linkError}
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={!participant.companyId || linksLoading || !!linkError}
              onClick={() => {
                const next = [...data.participants],
                  value = { ...participant, contactId: participant.contactId || null };
                if (participantIndex === null) next.push(value);
                else next[participantIndex] = value;
                change('participants', next);
                setParticipantOpen(false);
              }}
            >
              {participantIndex === null ? 'Добавить участника' : 'Сохранить участника'}
            </button>
          </div>
        </Modal>
      )}
      {removeIndex !== null && (
        <Modal title="Удалить участника?" onClose={() => setRemoveIndex(null)}>
          <p>Удалить участника из этого проекта?</p>
          <div className="actions">
            <button type="button" onClick={() => setRemoveIndex(null)}>
              Отмена
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                change(
                  'participants',
                  data.participants.filter((_: any, i: number) => i !== removeIndex),
                );
                setRemoveIndex(null);
              }}
            >
              Подтвердить удаление
            </button>
          </div>
        </Modal>
      )}
    </form>
  );
}
