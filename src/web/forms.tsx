import { useState, FormEvent, ReactNode } from 'react';
import {
  CompanyData,
  companySchema,
  segments,
  stages,
  divisions,
  labels,
  CrmRecord,
  RecordKind,
} from '../shared/contracts';
import { today } from './api';
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
          {labels[v] || v}
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
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="section-head">
          <h2>{title}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
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
}: {
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
  const [data, setData] = useState<any>(initial ? clean : defaults[kind]);
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
