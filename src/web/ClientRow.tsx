import { companyDisplayName } from '../shared/company-display-name';
import { useEffect, useRef, useState } from 'react';
import {
  Company,
  CompanyData,
  CompanyDetail,
  CrmRecord,
  Role,
  companySchema,
  contactSchema,
  labels,
  segments,
  divisions,
  primaryDivisions,
  divisionLabels,
} from '../shared/contracts';
import { AnalyticsSummary, ClientScore } from '../shared/analytics';
import { api, ApiError, download, money, compactMoney, fullMoney, today, token } from './api';
import { FileUpload } from './FileUpload';
import { Icon, industryIcon } from './Icons';
import { InlineValue, SwipeAction } from './ClientCardWidgets';
import './client-card.css';

type Detail = CompanyDetail & {
  holdingMembers?: Company[];
  holdingPotential?: number | null;
  holdingDivisions?: Record<string, number>;
};
const levels = [
  ['new', 'Новый', '#6B78E8'],
  ['acquaintance', 'Знакомство', '#78A9F0'],
  ['development', 'Развитие', '#6CC3E6'],
  ['partner', 'Партнёр', '#5FCDB8'],
  ['ours', 'Наш клиент', '#22A86B'],
];
let analyticsRequest: Promise<AnalyticsSummary> | undefined;
let analyticsSession = '';
function loadScores() {
  if (analyticsSession !== token) {
    analyticsRequest = undefined;
    analyticsSession = token;
  }
  if (analyticsRequest) return analyticsRequest;
  const request = api<AnalyticsSummary>(`/analytics?mode=all&from=${today()}&to=${today()}`);
  analyticsRequest = request;
  const clear = () => {
    if (analyticsRequest === request) analyticsRequest = undefined;
  };
  void request.then(clear, clear);
  return request;
}
export function ClientRow({
  company,
  onOpen,
  onChanged,
  initiallyOpen = false,
  score: providedScore,
  actorRole,
  holdingMembers,
}: {
  company: Company;
  initiallyOpen?: boolean;
  onChanged: () => Promise<void>;
  onOpen: (c: Company, tab?: string) => void;
  score?: ClientScore;
  actorRole?: Role;
  holdingMembers?: Company[];
}) {
  const [open, setOpen] = useState(initiallyOpen),
    [detail, setDetail] = useState<Detail | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [score, setScore] = useState<ClientScore | undefined>(providedScore),
    [scoreError, setScoreError] = useState(false),
    [addingContact, setAddingContact] = useState(false),
    [newEquipment, setNewEquipment] = useState(false),
    [uploading, setUploading] = useState(false),
    [uploadFile, setUploadFile] = useState<File | null>(null),
    [fileError, setFileError] = useState('');
  const sequence = useRef(0);
  const c = detail && detail.company.version >= company.version ? detail.company : company;
  const isHolding = c.segment === 'holding';
  const members = detail?.holdingMembers ?? holdingMembers ?? [];
  const potential =
    isHolding && members.length
      ? members.reduce<number | null>((sum, child) => {
          const amount =
            child.potential ??
            (Object.keys(child.divisions).length
              ? Object.values(child.divisions).reduce<number>((n, v) => n + (v || 0), 0)
              : null);
          return amount === null ? sum : (sum ?? 0) + amount;
        }, null)
      : c.potential;
  const [icon, color] = industryIcon(c.industry, c.segment);
  async function read() {
    const seq = ++sequence.current;
    const d = await api<Detail>(`/companies/${company.id}`);
    if (seq === sequence.current) setDetail(d);
  }
  async function changed() {
    analyticsRequest = undefined;
    try {
      await read();
      await onChanged();
      if (!providedScore) {
        const a = await loadScores();
        setScore(a.clientAnalytics?.clients.find((s) => s.id === company.id));
      }
    } catch (e) {
      setError(`Изменения сохранены, но обновление не удалось: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError('');
    read()
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      ++sequence.current;
    };
  }, [open, company.id, company.version]);
  useEffect(() => {
    if (providedScore) {
      setScore(providedScore);
      return;
    }
    if (!open) return;
    let current = true;
    setScoreError(false);
    loadScores()
      .then((a) => {
        if (current) {
          const found = a.clientAnalytics?.clients.find((s) => s.id === company.id);
          setScore(found);
          setScoreError(!found);
        }
      })
      .catch(() => {
        if (current) setScoreError(true);
      });
    return () => {
      current = false;
    };
  }, [open, company.id, providedScore]);
  async function patch(update: Partial<CompanyData>) {
    const data = companySchema.strip().parse({ ...c, ...update });
    let saved: Company;
    try {
      saved = await api<Company>(`/companies/${c.id}`, 'PATCH', { version: c.version, data });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await read();
      throw error;
    }
    setDetail((d) => (d ? { ...d, company: saved } : d));
    await changed();
  }
  async function editRecord(r: CrmRecord, key: string, value: string) {
    const data = contactSchema.parse({ ...r.data, [key]: value });
    let saved: CrmRecord;
    try {
      saved = await api<CrmRecord>(`/records/${r.id}`, 'PATCH', { version: r.version, data });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await read();
      throw error;
    }
    setDetail((d) =>
      d ? { ...d, records: d.records.map((row) => (row.id === saved.id ? saved : row)) } : d,
    );
    await changed();
  }
  async function deleteRecord(r: CrmRecord) {
    await api(`/${r.kind === 'file' ? 'files' : 'contacts'}/${r.id}`, 'DELETE');
    setDetail((d) => (d ? { ...d, records: d.records.filter((row) => row.id !== r.id) } : d));
    await changed();
  }
  async function equipment(key: string, raw: string | null) {
    const next = { ...c.divisions };
    if (raw === null) delete next[key as keyof typeof next];
    else {
      const amount = Number(raw.replace(',', '.').replace(/\s/g, ''));
      if (!raw.trim() || !Number.isFinite(amount) || amount < 0)
        throw new Error('Введите сумму от 0 до 1 000 000 000 000 ₽');
      next[key as keyof typeof next] = amount;
    }
    await patch({
      divisions: next,
      potential: Object.values(next).reduce((sum, v) => sum + (v || 0), 0),
    });
  }
  async function upload() {
    if (!uploadFile) return;
    setUploading(true);
    setFileError('');
    try {
      const body = new FormData();
      body.append('file', uploadFile);
      body.append('category', 'docs');
      await api(`/companies/${c.id}/files`, 'POST', body);
      setUploadFile(null);
      await changed();
    } catch (e) {
      setFileError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  const contacts = detail?.records.filter((r) => r.kind === 'contact') || [],
    files = detail?.records.filter((r) => r.kind === 'file') || [];
  const levelIndex = levels.findIndex((l) => l[0] === score?.level);
  const canArchive = !c.archived && (actorRole === 'admin' || actorRole === 'supervisor');
  return (
    <article className={`pico-client-accordion cc-card ${open ? 'expanded' : ''}`}>
      <SwipeAction
        label={`клиента «${companyDisplayName(c.name)}» в архив`}
        onDelete={
          canArchive
            ? async () => {
                await api(`/companies/${c.id}/archive`, 'POST', {
                  archived: true,
                  version: c.version,
                });
                await onChanged();
              }
            : undefined
        }
      >
        <button className="pico-client-row" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`icon-badge badge-${color}`}>
            <Icon name={icon} />
          </span>
          <span className="pico-client-copy">
            <strong className="pico-two-lines">{companyDisplayName(c.name)}</strong>
            <small className="pico-client-metadata">
              <span>{[labels[c.segment], c.city].filter(Boolean).join(' · ')}</span>
              {c.industry && <span>{c.industry}</span>}
            </small>
          </span>
          <span className="company-money">
            <small>Потенциал</small>
            <strong title={fullMoney(potential)}>{compactMoney(potential)}</strong>
          </span>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
        </button>
        {open && (
          <div className="cc-body">
            {loading && <p role="status">Загрузка…</p>}
            {error && (
              <p className="error" role="alert">
                {error}
                <button
                  onClick={() => {
                    setError('');
                    void read().catch((e) => setError(e.message));
                  }}
                >
                  Повторить
                </button>
              </p>
            )}
            <div
              className="cc-score"
              aria-label={
                score
                  ? `${score.score} из 8 баллов · ${levels[levelIndex]?.[1]}`
                  : 'Уровень клиента'
              }
            >
              <div>
                <strong>
                  {score
                    ? `${score.score} / 8 баллов`
                    : scoreError
                      ? 'Уровень недоступен'
                      : 'Загрузка уровня…'}
                </strong>
                <span>{levels[levelIndex]?.[1]}</span>
              </div>
              <div className="cc-segments">
                {levels.map(([key, label, tone], i) => (
                  <span
                    key={key}
                    title={label}
                    style={{ background: levelIndex >= i ? tone : '#E6EBF3' }}
                  />
                ))}
              </div>
            </div>
            {detail && (
              <>
                <details className="cc-section" open>
                  <summary>
                    Потенциал <span>{money(potential)}</span>
                    <Icon name="chevron-down" size={16} />
                  </summary>
                  <div className="cc-section-body">
                    {isHolding ? (
                      <>
                        <p className="muted">Суммарный потенциал заказчиков холдинга</p>
                        {Object.entries(detail.holdingDivisions || {}).map(([key, value]) => (
                          <div className="cc-equipment" key={key}>
                            <span>{divisionLabels[key] || key}</span>
                            <strong>{money(value)}</strong>
                          </div>
                        ))}
                        {detail.holdingMembers?.length ? (
                          <ul className="cc-members">
                            {detail.holdingMembers.map((member) => (
                              <li key={member.id}>
                                {companyDisplayName(member.name)}
                                <strong>{money(member.potential)}</strong>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted">В холдинге пока нет заказчиков</p>
                        )}
                      </>
                    ) : (
                      <>
                        {divisions
                          .filter((key) => c.divisions[key] != null)
                          .map((key) => (
                            <SwipeAction
                              key={key}
                              label={`оборудование «${divisionLabels[key]}»`}
                              onDelete={() => equipment(key, null)}
                            >
                              <div className="cc-equipment">
                                <InlineValue
                                  label={divisionLabels[key]}
                                  value={String(c.divisions[key])}
                                  numeric
                                  onSave={(value) => equipment(key, value)}
                                />
                              </div>
                            </SwipeAction>
                          ))}
                        {!Object.keys(c.divisions).length && (
                          <p className="muted">Оборудование пока не добавлено</p>
                        )}
                        {newEquipment ? (
                          <EquipmentForm
                            keys={primaryDivisions.filter((key) => c.divisions[key] == null)}
                            onCancel={() => setNewEquipment(false)}
                            onSave={async (key, value) => {
                              await equipment(key, value);
                              setNewEquipment(false);
                            }}
                          />
                        ) : (
                          <button className="cc-add" onClick={() => setNewEquipment(true)}>
                            <Icon name="plus" size={14} />
                            Добавить оборудование
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </details>
                <details className="cc-section">
                  <summary>
                    Контакты <span>{contacts.length}</span>
                    <Icon name="chevron-down" size={16} />
                  </summary>
                  <div className="cc-section-body">
                    {contacts.map((r) => (
                      <SwipeAction
                        key={r.id}
                        label={`контакт «${r.data.name}»`}
                        onDelete={() => deleteRecord(r)}
                      >
                        <div className="cc-contact">
                          {[
                            ['name', 'ФИО'],
                            ['role', 'Должность'],
                            ['phone', 'Телефон'],
                            ['email', 'Email'],
                          ].map(([key, label]) => (
                            <InlineValue
                              key={key}
                              label={label}
                              value={r.data[key] || ''}
                              onSave={(value) => editRecord(r, key, value)}
                            />
                          ))}
                        </div>
                      </SwipeAction>
                    ))}
                    {!contacts.length && <p className="muted">Контактов пока нет</p>}
                    {addingContact ? (
                      <ContactForm
                        onCancel={() => setAddingContact(false)}
                        onSave={async (data) => {
                          await api(`/companies/${c.id}/records/contact`, 'POST', { data });
                          setAddingContact(false);
                          await changed();
                        }}
                      />
                    ) : (
                      <button className="cc-add" onClick={() => setAddingContact(true)}>
                        <Icon name="plus" size={14} />
                        Добавить контакт
                      </button>
                    )}
                  </div>
                </details>
                <details className="cc-section">
                  <summary>
                    Файлы <span>{files.length}</span>
                    <Icon name="chevron-down" size={16} />
                  </summary>
                  <div className="cc-section-body">
                    {files.map((f) => (
                      <SwipeAction
                        key={f.id}
                        label={`файл «${f.data.name}»`}
                        onDelete={() => deleteRecord(f)}
                      >
                        <button
                          className="cc-file"
                          onClick={() =>
                            void download(`/files/${f.id}`, f.data.name).catch((e) =>
                              setError(e.message),
                            )
                          }
                        >
                          <Icon name="file" size={20} />
                          <span>
                            {f.data.name}
                            <small>{new Date(f.createdAt).toLocaleDateString('ru-RU')}</small>
                          </span>
                        </button>
                      </SwipeAction>
                    ))}
                    {!files.length && <p className="muted">Файлов пока нет</p>}
                    <FileUpload
                      label="Добавить файл · до 10 МБ"
                      disabled={uploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        setFileError('');
                        if (f && f.size > 10 * 1024 * 1024) {
                          setFileError('Максимальный размер файла — 10 МБ');
                          setUploadFile(null);
                        } else setUploadFile(f || null);
                        e.target.value = '';
                      }}
                    />
                    {uploadFile && (
                      <button disabled={uploading} onClick={() => void upload()}>
                        {uploading ? 'Загрузка…' : `Загрузить ${uploadFile.name}`}
                      </button>
                    )}
                    {fileError && (
                      <p className="error" role="alert">
                        {fileError}
                      </p>
                    )}
                  </div>
                </details>
                <details className="cc-section">
                  <summary>
                    Заметки
                    <Icon name="chevron-down" size={16} />
                  </summary>
                  <div className="cc-section-body">
                    <InlineValue
                      label="Заметки о клиенте"
                      value={c.notes}
                      multiline
                      onSave={(notes) => patch({ notes })}
                    />
                  </div>
                </details>
                <details className="cc-section">
                  <summary>
                    Данные
                    <Icon name="chevron-down" size={16} />
                  </summary>
                  <div className="cc-section-body">
                    {[
                      ['inn', 'ИНН'],
                      ['name', 'Название'],
                      ['city', 'Город'],
                      ['website', 'Сайт'],
                    ].map(([key, label]) => (
                      <InlineValue
                        key={key}
                        label={label}
                        value={String(c[key as keyof Company] || '')}
                        onSave={(value) => patch({ [key]: value })}
                      />
                    ))}
                    <InlineValue
                      label="Категория"
                      value={c.segment}
                      options={segments.map((value) => ({ value, label: labels[value] }))}
                      onSave={(value) => patch({ segment: value as Company['segment'] })}
                    />
                  </div>
                </details>
                <button type="button" className="text-button" onClick={() => onOpen(c, 'task')}>
                  Задачи и проекты
                </button>
              </>
            )}
          </div>
        )}
      </SwipeAction>
    </article>
  );
}
function ContactForm({
  onSave,
  onCancel,
}: {
  onSave: (data: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState({ name: '', role: '', phone: '', email: '' }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="cc-inline-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await onSave(contactSchema.parse(draft));
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {[
        ['name', 'ФИО'],
        ['role', 'Должность'],
        ['phone', 'Телефон'],
        ['email', 'Email'],
      ].map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            aria-label={`Новый контакт · ${label}`}
            value={draft[key as keyof typeof draft]}
            required={key === 'name'}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        </label>
      ))}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="cc-editor-actions">
        <button disabled={busy}>Сохранить контакт</button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
function EquipmentForm({
  keys,
  onSave,
  onCancel,
}: {
  keys: readonly string[];
  onSave: (key: string, value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [key, setKey] = useState(keys[0] || ''),
    [amount, setAmount] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="cc-inline-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await onSave(key, amount);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Оборудование
        <select
          aria-label="Оборудование"
          value={key}
          disabled={busy}
          onChange={(e) => setKey(e.target.value)}
        >
          {keys.map((k) => (
            <option key={k} value={k}>
              {divisionLabels[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Потенциал, ₽
        <input
          aria-label="Потенциал, ₽"
          value={amount}
          inputMode="decimal"
          disabled={busy}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="cc-editor-actions">
        <button disabled={busy || !key}>Добавить</button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
