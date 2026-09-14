import { useEffect, useState } from 'react';
import {
  Actor,
  Company,
  CompanyDetail as Detail,
  CrmRecord,
  labels,
  RecordKind,
} from '../shared/contracts';
import { api, download, money } from './api';
import { CompanyForm, Field, Modal, RecordForm } from './forms';
const names: Record<RecordKind, string> = {
  task: 'Задачи',
  contact: 'Контакты',
  project: 'Проекты',
  activity: 'История',
  file: 'Файлы',
};
export function CompanyDetail({
  company,
  user,
  users,
  onClose,
  onChanged,
}: {
  company: Company;
  user: Actor;
  users: Actor[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [tab, setTab] = useState<RecordKind | 'audit'>('activity'),
    [edit, setEdit] = useState(false),
    [form, setForm] = useState<{ kind: Exclude<RecordKind, 'file'>; initial?: CrmRecord } | null>(
      null,
    );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [owner, setOwner] = useState(company.ownerId);
  const [category, setCategory] = useState('docs'),
    [projectId, setProjectId] = useState('');
  async function refresh() {
    const d = await api<Detail>(`/companies/${company.id}`);
    setDetail(d);
    setOwner(d.company.ownerId);
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [company.id]);
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <Modal title={company.name} onClose={onClose}>
        <p>{error || 'Загрузка…'}</p>
      </Modal>
    );
  const c = detail.company,
    projects = detail.records.filter((r) => r.kind === 'project');
  return (
    <Modal title={c.name} onClose={onClose}>
      <div className="chips">
        <span>{c.city || 'Город не указан'}</span>
        <span>{labels[c.segment]}</span>
        <span>{labels[c.stage]}</span>
        {c.archived && <span>Архив</span>}
      </div>
      <p className="muted">
        Ответственный: <strong>{c.ownerName}</strong> · ИНН {c.inn || 'не указан'}
      </p>
      <div className="metrics small">
        <div>
          <span>Оборот</span>
          <strong>{money(c.revenue)}</strong>
        </div>
        <div>
          <span>Потенциал</span>
          <strong>{money(c.potential)}</strong>
        </div>
      </div>
      {Object.keys(c.divisions).length > 0 && (
        <div className="chips">
          {Object.entries(c.divisions).map(([k, v]) => (
            <span key={k}>
              {labels[k]} · {money(v)}
            </span>
          ))}
        </div>
      )}
      {c.notes && <p className="preserve">{c.notes}</p>}
      <button onClick={() => setEdit(!edit)}>
        {edit ? 'Скрыть форму' : 'Редактировать компанию'}
      </button>
      {edit && (
        <CompanyForm
          initial={c}
          onSave={async (data) => {
            await api(`/companies/${c.id}`, 'PATCH', { version: c.version, data });
            setEdit(false);
            await refresh();
            await onChanged();
          }}
        />
      )}
      {user.role !== 'manager' && (
        <div className="assign">
          <Field label="Передать компанию">
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              {users
                .filter((u) => u.active)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </Field>
          <button
            disabled={busy || owner === c.ownerId}
            onClick={() =>
              run(() =>
                api(`/companies/${c.id}/assign`, 'POST', { ownerId: owner, version: c.version }),
              )
            }
          >
            Назначить
          </button>
          <small>Открытые задачи передаются вместе с компанией.</small>
        </div>
      )}
      <div className="tabs">
        {Object.entries(names).map(([k, v]) => (
          <button
            className={tab === k ? 'active' : ''}
            key={k}
            onClick={() => {
              setTab(k as RecordKind);
              setForm(null);
            }}
          >
            {v}
          </button>
        ))}
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
          Изменения
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tab !== 'file' && tab !== 'audit' && !c.archived && (
        <button className="primary" onClick={() => setForm({ kind: tab })}>
          + Добавить
        </button>
      )}
      {form && (
        <div className="inset">
          <div className="section-head">
            <h3>{names[form.kind]}</h3>
            <button onClick={() => setForm(null)}>Отмена</button>
          </div>
          <RecordForm
            key={form.initial?.id || form.kind}
            kind={form.kind}
            initial={form.initial}
            projects={projects}
            onSave={async (data, pid) => {
              if (form.initial)
                await api(`/records/${form.initial.id}`, 'PATCH', {
                  version: form.initial.version,
                  data,
                });
              else
                await api(`/companies/${c.id}/records/${form.kind}`, 'POST', {
                  data,
                  projectId: pid,
                });
              setForm(null);
              await refresh();
              await onChanged();
            }}
          />
        </div>
      )}
      {tab === 'file' && !c.archived && (
        <div className="inset form-grid">
          <Field label="Категория">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {['docs', 'catalog', 'brochure', 'ref', 'model'].map((k) => (
                <option key={k} value={k}>
                  {labels[k]}
                </option>
              ))}
            </select>
          </Field>
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
          <Field label="Загрузить файл · до 10 МБ">
            <input
              type="file"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  const b = new FormData();
                  b.append('file', file);
                  b.append('category', category);
                  if (projectId) b.append('projectId', projectId);
                  void run(() => api(`/companies/${c.id}/files`, 'POST', b));
                }
                e.target.value = '';
              }}
            />
          </Field>
        </div>
      )}
      <div className="records">
        {tab === 'audit'
          ? detail.audit.map((a) => (
              <article key={a.id}>
                <strong>{a.action}</strong>
                <small>
                  {a.actor_name} · {new Date(a.created_at).toLocaleString('ru')}
                </small>
                {a.action === 'company.assigned' && (
                  <p>
                    {users.find((u) => u.id === a.details.from)?.name || a.details.from} →{' '}
                    {users.find((u) => u.id === a.details.to)?.name || a.details.to}
                  </p>
                )}
              </article>
            ))
          : detail.records
              .filter((r) => r.kind === tab)
              .map((r) => (
                <article key={r.id}>
                  <div className="section-head">
                    <strong className={r.data.done ? 'done' : ''}>
                      {r.data.name || r.data.text}
                    </strong>
                    {tab === 'task' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            api(`/records/${r.id}`, 'PATCH', {
                              version: r.version,
                              data: { text: r.data.text, due: r.data.due, done: !r.data.done },
                            }),
                          )
                        }
                      >
                        {r.data.done ? 'Вернуть' : 'Выполнить'}
                      </button>
                    )}
                  </div>
                  {tab === 'contact' && (
                    <p>
                      {r.data.role} {r.data.phone} {r.data.email}
                    </p>
                  )}
                  {tab === 'project' && (
                    <p>
                      {money(r.data.amount)} · {labels[r.data.stage]}
                      <br />
                      {r.data.notes}
                    </p>
                  )}
                  <small>
                    {r.data.due
                      ? `Срок: ${r.data.due} · `
                      : r.data.occurredOn
                        ? `${r.data.occurredOn} · `
                        : ''}
                    {r.authorName}
                    {r.projectId
                      ? ' · ' + projects.find((p) => p.id === r.projectId)?.data.name
                      : ''}
                  </small>
                  {['contact', 'project', 'task'].includes(tab) && (
                    <button
                      className="text-button"
                      onClick={() => setForm({ kind: tab as any, initial: r })}
                    >
                      Изменить
                    </button>
                  )}
                  {tab === 'file' && (
                    <div className="actions">
                      <small>
                        {labels[r.data.category]} · {Math.ceil(r.data.size / 1024)} КБ
                      </small>
                      <button onClick={() => run(() => download(`/files/${r.id}`, r.data.name))}>
                        Скачать
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => run(() => api(`/files/${r.id}`, 'DELETE'))}
                      >
                        В архив
                      </button>
                    </div>
                  )}
                </article>
              ))}
      </div>
      {tab !== 'audit' && !detail.records.some((r) => r.kind === tab) && (
        <p className="empty">Записей пока нет.</p>
      )}
    </Modal>
  );
}
