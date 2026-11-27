import { contactPhone } from '../shared/contact-phone';
import { companyDisplayName } from '../shared/company-display-name';
import { companyContactChanges } from '../shared/company-edit-contacts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Actor,
  Company,
  CompanyDetail as Detail,
  CrmRecord,
  labels,
  RecordKind,
} from '../shared/contracts';
import { api, ApiError, download, money } from './api';
import { CompanyForm, Field, Modal, RecordForm } from './forms';
import { LetterForm } from './LetterForm';
import { CompanySales } from './SalesCard';
import { FileUpload } from './FileUpload';
import { useTaskActions } from './TaskActions';
import {
  applyCommittedRecord,
  companyTransitionPending,
  contactDeleteKey,
  pendingEquipment,
  useClientUndo,
} from './client-undo';
const names: Record<RecordKind, string> = {
  task: 'Задачи',
  contact: 'Контакты',
  project: 'Проекты',
  activity: 'История',
  file: 'Файлы',
};
const auditActionLabels: Record<string, string> = {
  'company.created': 'Клиент добавлен',
  'company.updated': 'Карточка клиента изменена',
  'company.archived': 'Клиент перенесён в архив',
  'company.restored': 'Клиент восстановлен',
  'company.assigned': 'Ответственный изменён',
  'company.sales_updated': 'Коммерческие сведения обновлены',
  'contact.created': 'Контакт добавлен',
  'contact.updated': 'Контакт изменён',
  'contact.deleted': 'Контакт удалён',
  'project.created': 'Проект добавлен',
  'project.updated': 'Проект изменён',
  'task.created': 'Задача добавлена',
  'task.updated': 'Задача изменена',
  'task.assigned': 'Исполнитель задачи изменён',
  'task.deleted': 'Задача удалена',
  'activity.created': 'Запись общения добавлена',
  'activity.updated': 'Запись общения изменена',
  'file.created': 'Файл добавлен',
  'file.updated': 'Файл изменён',
  'file.archived': 'Файл перенесён в архив',
  'report.applied': 'Отчёт подтверждён и сохранён',
  'report.received': 'Отчёт получен',
  'report.edited': 'Черновик отчёта изменён',
  'report.cancelled': 'Отчёт отменён',
};
function auditActionLabel(action: unknown) {
  return typeof action === 'string'
    ? auditActionLabels[action] || 'Изменение данных'
    : 'Изменение данных';
}
export function CompanyDetail({
  company,
  user,
  users,
  companies = [],
  initialTab = 'activity',
  onClose,
  onChanged,
}: {
  company: Company;
  companies?: Company[];
  initialTab?: string;
  user: Actor;
  users: Actor[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [tab, setTab] = useState<RecordKind | 'audit'>(
      ['contact', 'project', 'task', 'activity', 'file', 'audit'].includes(initialTab)
        ? (initialTab as RecordKind | 'audit')
        : 'activity',
    ),
    [edit, setEdit] = useState(false),
    [form, setForm] = useState<{ kind: Exclude<RecordKind, 'file'>; initial?: CrmRecord } | null>(
      null,
    );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [owner, setOwner] = useState(company.ownerId);
  const [category, setCategory] = useState('docs'),
    [projectId, setProjectId] = useState('');
  const [editorCompany, setEditorCompany] = useState<Company | null>(null);
  const [editorContacts, setEditorContacts] = useState<CrmRecord[]>([]);
  const refreshSequence = useRef(0);
  const mounted = useRef(true);
  const clientsUndo = useClientUndo();
  const latestCommit = useRef(clientsUndo.committedRecord);
  const taskActions = useTaskActions();
  const pendingTask = (id: string) => taskActions.queue.find(({ task }) => task.id === id);
  async function refresh() {
    const sequence = ++refreshSequence.current;
    const d = applyCommittedRecord(
      await api<Detail>(`/companies/${company.id}`),
      latestCommit.current,
    );
    if (sequence !== refreshSequence.current) return;
    setDetail(d);
    setOwner(d.company.ownerId);
    return d;
  }
  useEffect(() => {
    mounted.current = true;
    refresh().catch((e) => {
      if (mounted.current) setError(e.message);
    });
    return () => {
      mounted.current = false;
      ++refreshSequence.current;
    };
  }, [company.id]);
  const currentDetail = detail && applyCommittedRecord(detail, clientsUndo.committedRecord);
  useLayoutEffect(() => {
    const committed = clientsUndo.committedRecord;
    if (latestCommit.current === committed) return;
    latestCommit.current = committed;
    if (committed?.companyId !== company.id) return;
    setDetail((current) => current && applyCommittedRecord(current, committed));
    void refresh().catch((cause) => {
      if (mounted.current) setError((cause as Error).message);
    });
  }, [clientsUndo.committedRecord, company.id]);
  async function refreshUndoDetail() {
    if (mounted.current) await refresh();
  }
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
  if (!currentDetail)
    return (
      <Modal title={companyDisplayName(company.name, company.country)} onClose={onClose}>
        <p>{error || 'Загрузка…'}</p>
      </Modal>
    );
  const c = currentDetail.company;
  const canManageOwnership =
    currentDetail.canManageOwnership ??
    (user.role === 'admin' ||
      (user.role === 'supervisor' &&
        (c.ownerId === user.id ||
          users.some((u) => u.id === c.ownerId && u.supervisorId === user.id))));
  const eligibleOwners = users.filter(
    (u) => u.active && (user.role === 'admin' || u.id === user.id || u.supervisorId === user.id),
  );
  const visibleContacts = currentDetail.records.filter(
    (record) => record.kind === 'contact' && !clientsUndo.pending.has(contactDeleteKey(record.id)),
  );
  const projects = currentDetail.records.filter((r) => r.kind === 'project');
  const records =
    tab === 'contact'
      ? visibleContacts
      : tab === 'task'
        ? taskActions.project(currentDetail.records.filter((r) => r.kind === 'task'))
        : currentDetail.records.filter((r) => r.kind === tab);
  return (
    <Modal title={companyDisplayName(c.name, c.country)} onClose={onClose}>
      <div className="company-detail">
        <nav className="tabs company-detail-tabs">
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
        </nav>

        <div className="chips">
          <span>{c.city || 'Город не указан'}</span>
          <span>{labels[c.segment]}</span>
          <span>{labels[c.stage]}</span>
          {c.archived && <span>Архив</span>}
        </div>
        <details className="company-detail-summary">
          <summary>Сведения о клиенте</summary>
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
          <CompanySales records={currentDetail.records} />
        </details>
        <details className="company-detail-actions" open={initialTab === 'actions' || undefined}>
          <summary>Действия с клиентом</summary>
          {!c.archived && (
            <LetterForm
              key={c.id}
              companyId={c.id}
              contacts={visibleContacts}
              onCreated={async () => {
                await refresh();
                setTab('file');
                await onChanged();
              }}
            />
          )}
          <button
            onClick={async () => {
              if (edit) {
                setEdit(false);
                return;
              }
              try {
                const latest = await refresh();
                if (!latest) return;
                setEditorCompany(structuredClone(latest.company));
                setEditorContacts(
                  structuredClone(latest.records.filter((record) => record.kind === 'contact')),
                );
                setEdit(true);
              } catch (cause) {
                setError((cause as Error).message);
              }
            }}
          >
            {edit ? 'Скрыть форму' : 'Редактировать компанию'}
          </button>
          {canManageOwnership && (!c.archived || user.role === 'admin') && (
            <button
              className={c.archived ? undefined : 'danger'}
              disabled={
                busy ||
                edit ||
                companyTransitionPending(c, clientsUndo.pending) ||
                Boolean(pendingEquipment(c, clientsUndo.pending))
              }
              onClick={() => {
                clientsUndo.setArchived(c);
                onClose();
              }}
            >
              {c.archived ? 'Восстановить компанию' : 'Удалить компанию'}
            </button>
          )}
          {edit && (
            <CompanyForm
              holdings={companies.filter((holding) => holding.ownerId === c.ownerId)}
              initial={editorCompany || c}
              initialContacts={editorContacts.map((record) => ({
                id: record.id,
                version: record.version,
                name: record.data.name || '',
                role: record.data.role || '',
                phone: record.data.phone || '',
                email: record.data.email || '',
              }))}
              onSave={async ({ initialContacts = [], ...data }) => {
                try {
                  await api(`/companies/${c.id}/editor`, 'PATCH', {
                    version: (editorCompany || c).version,
                    data,
                    contacts: companyContactChanges(initialContacts, editorContacts),
                  });
                } catch (cause) {
                  if (cause instanceof ApiError && cause.status === 409)
                    throw new Error(
                      'Карточка или контакты изменились. Введённые данные сохранены в форме. Закройте форму и заново откройте карточку, чтобы проверить изменения перед сохранением.',
                    );
                  throw cause;
                }
                setEdit(false);
                await refresh();
                await onChanged();
              }}
            />
          )}
          {canManageOwnership && (
            <div className="assign">
              <Field label="Передать компанию">
                <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                  {!eligibleOwners.some((u) => u.id === c.ownerId) && (
                    <option value={c.ownerId} disabled>
                      {c.ownerName || 'Текущий ответственный'}
                    </option>
                  )}
                  {eligibleOwners.map((u) => (
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
                    api(`/companies/${c.id}/assign`, 'POST', {
                      ownerId: owner,
                      version: c.version,
                    }),
                  )
                }
              >
                Назначить
              </button>
              <small>Открытые задачи передаются вместе с компанией.</small>
            </div>
          )}
        </details>
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
              companies={companies}
              contacts={visibleContacts}
              onSave={async (data, pid) => {
                const saved = form.initial
                  ? await api<CrmRecord>(`/records/${form.initial.id}`, 'PATCH', {
                      version: form.initial.version,
                      data,
                    })
                  : await api<CrmRecord>(`/companies/${c.id}/records/${form.kind}`, 'POST', {
                      data,
                      projectId: pid,
                    });
                // Invalidate older reads and show only the record acknowledged by the database.
                ++refreshSequence.current;
                setDetail(
                  (current) =>
                    current && {
                      ...current,
                      records: current.records.some((r) => r.id === saved.id)
                        ? current.records.map((r) => (r.id === saved.id ? { ...r, ...saved } : r))
                        : [...current.records, saved],
                    },
                );
                setForm(null);
                try {
                  await refresh();
                  await onChanged();
                } catch (e) {
                  setError(
                    `Запись сохранена, но не удалось обновить данные: ${(e as Error).message}`,
                  );
                }
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
              <FileUpload
                label="Загрузить файл · до 10 МБ"
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
                  <strong>{auditActionLabel(a.action)}</strong>
                  <small>
                    {a.actor_name || 'Сотрудник'} · {new Date(a.created_at).toLocaleString('ru')}
                  </small>
                  {(a.action === 'company.assigned' || a.action === 'task.assigned') && (
                    <p>
                      {users.find((u) => u.id === a.details?.from)?.name || 'Другой сотрудник'} →{' '}
                      {users.find((u) => u.id === a.details?.to)?.name || 'Другой сотрудник'}
                    </p>
                  )}
                </article>
              ))
            : records.map((r) => (
                <article key={r.id}>
                  <div className="section-head">
                    <strong
                      className={
                        'company-record-title ' +
                        (r.data.done || (tab === 'task' && pendingTask(r.id)?.action === 'done')
                          ? 'done'
                          : '')
                      }
                    >
                      {r.data.name || r.data.text}
                    </strong>
                    {tab === 'task' && (
                      <button
                        disabled={busy || Boolean(pendingTask(r.id))}
                        onClick={() =>
                          taskActions.schedule(
                            r,
                            r.data.done ? 'restore' : 'done',
                            refreshUndoDetail,
                          )
                        }
                      >
                        {r.data.done ? 'Вернуть' : 'Выполнить'}
                      </button>
                    )}
                  </div>
                  {tab === 'contact' && (
                    <p className="company-contact-values">
                      <span>{r.data.role}</span>{' '}
                      <span>{contactPhone(r.data.phone, r.data.extension)}</span>{' '}
                      <span>{r.data.email}</span>
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
                      disabled={tab === 'task' && Boolean(pendingTask(r.id))}
                      onClick={() => setForm({ kind: tab as any, initial: r })}
                    >
                      Изменить
                    </button>
                  )}
                  {tab === 'file' && (
                    <div className="file-details">
                      <small>
                        {labels[r.data.category]} · {Math.ceil(r.data.size / 1024)} КБ
                      </small>
                      <div className="file-actions">
                        <button
                          disabled={busy}
                          onClick={() => run(() => download(`/files/${r.id}`, r.data.name))}
                        >
                          Скачать
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => run(() => api(`/files/${r.id}`, 'DELETE'))}
                        >
                          В архив
                        </button>
                      </div>
                    </div>
                  )}
                  {tab === 'contact' && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        clientsUndo.deleteContact(r, refreshUndoDetail);
                        if (form?.initial?.id === r.id) setForm(null);
                      }}
                    >
                      Удалить контакт
                    </button>
                  )}
                </article>
              ))}
        </div>
        {tab !== 'audit' && !records.length && <p className="empty">Записей пока нет.</p>}
      </div>
    </Modal>
  );
}
