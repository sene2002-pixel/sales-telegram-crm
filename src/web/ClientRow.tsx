import { companyDisplayName } from '../shared/company-display-name';
import { companyContactChanges } from '../shared/company-edit-contacts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  primarySegments,
  divisionLabels,
} from '../shared/contracts';
import { ClientScore, displayedClientPotential } from '../shared/analytics';
import { loadClientScores, invalidateClientScores } from './client-scores';
import { api, ApiError, download, money, compactMoney, fullMoney } from './api';
import { millionValue } from './FormWidgets';
import { HoldingMembers } from './HoldingMembers';
import { FileUpload } from './FileUpload';
import { Icon, industryIcon } from './Icons';
import { CompanyForm, Modal } from './forms';
import { InlineValue, SwipeAction } from './ClientCardWidgets';
import { InlineAmount } from './InlineAmount';
import { PicoNumberHandle, PicoNumberKeys, appendPicoNumberKey } from './PicoNumberInput';
import { GrowingTextarea } from './GrowingTextarea';
import './client-card.css';

type Detail = CompanyDetail & {
  holdingAllocationRequired?: boolean;
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
export function ClientRow({
  company,
  onOpen,
  onChanged,
  initiallyOpen = false,
  score: providedScore,
  employeeId = '',
  actorRole,
  holdingMembers,
  onReveal,
  revealVersion,
}: {
  company: Company;
  initiallyOpen?: boolean;
  onChanged: () => Promise<void>;
  onOpen: (c: Company, tab?: string) => void;
  score?: ClientScore;
  employeeId?: string;
  actorRole?: Role;
  holdingMembers?: Company[];
  onReveal?: (id: string) => void;
  revealVersion?: number;
}) {
  const [open, setOpen] = useState(initiallyOpen),
    [detail, setDetail] = useState<Detail | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [score, setScore] = useState<ClientScore | undefined>(providedScore),
    [scoreError, setScoreError] = useState(false),
    [editingClient, setEditingClient] = useState(false),
    [editorCompany, setEditorCompany] = useState<Company | null>(null),
    [editorContacts, setEditorContacts] = useState<CrmRecord[]>([]),
    [editingContact, setEditingContact] = useState<CrmRecord | null>(null),
    [savingContact, setSavingContact] = useState(false),
    [addingContact, setAddingContact] = useState(false),
    [newEquipment, setNewEquipment] = useState<Company | null>(null),
    [addedEquipment, setAddedEquipment] = useState<string[]>([]),
    [uploading, setUploading] = useState(false),
    [uploadFile, setUploadFile] = useState<File | null>(null),
    [fileError, setFileError] = useState('');
  const articleRef = useRef<HTMLElement>(null);
  const amountEditors = useRef<Record<string, PicoNumberHandle | null>>({});
  const contactRequest = useRef(0);
  useEffect(
    () => () => {
      contactRequest.current++;
    },
    [open],
  );
  async function openContact(record: CrmRecord) {
    const request = ++contactRequest.current;
    try {
      const latest = await read();
      if (request !== contactRequest.current) return;
      const contact = latest.records.find((r) => r.id === record.id && r.kind === 'contact');
      if (!contact) throw new Error('Контакт больше недоступен. Обновите карточку.');
      setEditingContact(structuredClone(contact));
    } catch (cause) {
      if (request === contactRequest.current) setError((cause as Error).message);
    }
  }
  const closeContact = () => {
    if (savingContact) return;
    contactRequest.current++;
    setEditingContact(null);
  };
  useLayoutEffect(() => {
    if (!editingContact) return;
    const element = articleRef.current?.querySelector<HTMLElement>('.cc-contact-selected');
    const sheet = document.querySelector<HTMLElement>('[data-pico-modal]:has(.cc-contact-form)');
    if (!element || !sheet) return;
    const root = document.documentElement;
    const reveal = () => {
      root.style.setProperty(
        '--pico-contact-sheet-height',
        `${sheet.getBoundingClientRect().height}px`,
      );
      const bounds = element.getBoundingClientRect();
      const top = (window.visualViewport?.offsetTop || 0) + 12;
      const bottom = sheet.getBoundingClientRect().top - 12;
      const delta =
        bounds.bottom > bottom
          ? Math.min(bounds.bottom - bottom, bounds.top - top)
          : Math.min(0, bounds.top - top);
      if (!delta) return;
      let parent = element.parentElement;
      while (
        parent &&
        !(
          parent.scrollHeight > parent.clientHeight &&
          /(auto|scroll)/.test(getComputedStyle(parent).overflowY)
        )
      )
        parent = parent.parentElement;
      if (parent) parent.scrollTop += delta;
      else window.scrollBy(0, delta);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(sheet);
    window.visualViewport?.addEventListener('resize', reveal);
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener('resize', reveal);
      root.style.removeProperty('--pico-contact-sheet-height');
    };
  }, [editingContact?.id]);
  useEffect(() => {
    if (initiallyOpen) {
      setOpen(true);
      requestAnimationFrame(() => articleRef.current?.scrollIntoView({ block: 'nearest' }));
    }
  }, [initiallyOpen, revealVersion]);
  const sequence = useRef(0);
  const c = detail && detail.company.version >= company.version ? detail.company : company;
  const isHolding = c.segment === 'holding';
  const members = holdingMembers ?? detail?.holdingMembers ?? [];
  const potential = displayedClientPotential(c, members);
  const [icon, color] = industryIcon(c.industry, c.segment);
  async function read() {
    const seq = ++sequence.current;
    const d = await api<Detail>(`/companies/${company.id}`);
    if (seq === sequence.current) setDetail(d);
    return d;
  }
  async function changed() {
    invalidateClientScores();
    try {
      await read();
      await onChanged();
      if (!providedScore) {
        const a = await loadClientScores(employeeId);
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
      setScoreError(false);
      return;
    }
    if (!open) return;
    let current = true;
    setScoreError(false);
    setScore(undefined);
    loadClientScores(employeeId)
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
  }, [open, company.id, company.version, providedScore, employeeId]);
  async function patch(update: Partial<CompanyData>, snapshot = c) {
    const data = companySchema.strip().parse({ ...snapshot, ...update });
    let saved: Company;
    try {
      saved = await api<Company>(`/companies/${c.id}`, 'PATCH', {
        version: snapshot.version,
        data,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await read();
      throw error;
    }
    setDetail((d) => (d ? { ...d, company: saved } : d));
    await changed();
  }
  async function deleteRecord(r: CrmRecord) {
    await api(`/${r.kind === 'file' ? 'files' : 'contacts'}/${r.id}`, 'DELETE');
    setDetail((d) => (d ? { ...d, records: d.records.filter((row) => row.id !== r.id) } : d));
    await changed();
  }
  async function equipment(key: string, raw: string | null, snapshot = c) {
    const next = { ...snapshot.divisions };
    if (raw === null) delete next[key as keyof typeof next];
    else {
      const amount = Number(raw.replace(',', '.').replace(/\s/g, ''));
      if (!raw.trim() || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000)
        throw new Error('Введите сумму от 0 до 1 000 000 млн ₽');
      next[key as keyof typeof next] = amount * 1_000_000;
    }
    await patch(
      {
        divisions: next,
        potential: Object.values(next).reduce((sum, v) => sum + (v || 0), 0),
      },
      snapshot,
    );
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
    <article ref={articleRef} className={`pico-client-accordion cc-card ${open ? 'expanded' : ''}`}>
      <SwipeAction
        label={`клиента «${companyDisplayName(c.name, c.country)}» в архив`}
        confirmation={{
          title: 'Перенести клиента в архив?',
          message: `«${companyDisplayName(c.name, c.country)}» появится во вкладке «Закрытые». Контакты, потенциал, заметки и файлы сохранятся. Восстановить клиента сможет администратор.`,
          action: 'Перенести в архив',
          pending: 'Переносим…',
          triggerLabel: `Перенести клиента «${companyDisplayName(c.name, c.country)}» в архив`,
        }}
        onEdit={
          c.archived
            ? undefined
            : () => {
                void read()
                  .then((d) => {
                    setEditorCompany(structuredClone(d.company));
                    setEditorContacts(
                      structuredClone(d.records.filter((r) => r.kind === 'contact')),
                    );
                    setEditingClient(true);
                  })
                  .catch((e) => setError(e.message));
              }
        }
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
            <strong className="pico-two-lines">{companyDisplayName(c.name, c.country)}</strong>
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
                  <i style={{ background: levels[levelIndex]?.[2] }} />
                  {score
                    ? levels[levelIndex]?.[1]
                    : scoreError
                      ? 'Уровень недоступен'
                      : 'Загрузка уровня…'}
                </strong>
                <span>{score ? `${score.score} баллов из 8` : ''}</span>
              </div>
              <div className="cc-segments">
                {levels.map(([key, label, tone], i) => (
                  <span
                    key={key}
                    title={label}
                    style={{
                      background: levelIndex >= i ? tone : '#E6EBF3',
                      flex: [1, 2, 3, 2, 1][i],
                    }}
                  />
                ))}
              </div>
            </div>
            {detail && (
              <>
                <details className="cc-section" open>
                  <summary>
                    Потенциал{' '}
                    <span>
                      {potential === null ? 'Не указан' : `${millionValue(potential)} млн ₽`}
                    </span>
                    <Icon name="chevron-down" size={18} />
                  </summary>
                  <div className="cc-section-body">
                    {isHolding ? (
                      <>
                        <p className="muted">Суммарный потенциал заказчиков холдинга</p>
                        {Object.entries(detail.holdingDivisions || {}).map(([key, value]) => (
                          <div className="cc-equipment" key={key}>
                            <span>{divisionLabels[key] || key}</span>
                            <strong>{millionValue(value)} млн ₽</strong>
                          </div>
                        ))}
                        {detail.holdingAllocationRequired && (
                          <p className="cc-allocation-warning" role="status">
                            У холдинга есть нераспределённый потенциал. Распределите его по
                            заказчикам, чтобы включить в итог группы.
                          </p>
                        )}
                        <HoldingMembers
                          company={c}
                          members={members}
                          onReveal={onReveal}
                          onChanged={changed}
                        />
                      </>
                    ) : (
                      <>
                        {[
                          ...divisions.filter((key) => !addedEquipment.includes(key)),
                          ...addedEquipment,
                        ]
                          .filter((key) => c.divisions[key as keyof typeof c.divisions] != null)
                          .map((key) => (
                            <SwipeAction
                              key={key}
                              label={`оборудование «${divisionLabels[key]}»`}
                              onDelete={() => equipment(key, null)}
                              onEdit={() => amountEditors.current[key]?.open()}
                            >
                              <InlineAmount
                                ref={(handle) => {
                                  amountEditors.current[key] = handle;
                                }}
                                label={divisionLabels[key]}
                                value={millionValue(c.divisions[key as keyof typeof c.divisions])}
                                unit="млн ₽"
                                onSave={(value) => equipment(key, value)}
                              />
                            </SwipeAction>
                          ))}
                        {!Object.keys(c.divisions).length && (
                          <p className="muted">Оборудование пока не добавлено</p>
                        )}
                        {primaryDivisions.some((key) => c.divisions[key] == null) && (
                          <button
                            className="cc-add"
                            onClick={() => setNewEquipment(structuredClone(c))}
                          >
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
                    <Icon name="chevron-down" size={18} />
                  </summary>
                  <div className="cc-section-body">
                    {contacts.map((r) => (
                      <SwipeAction
                        key={r.id}
                        label={`контакт «${r.data.name}»`}
                        onDelete={() => deleteRecord(r)}
                        onEdit={() => void openContact(r)}
                      >
                        <div
                          className={
                            'cc-contact' +
                            (editingContact?.id === r.id ? ' cc-contact-selected' : '')
                          }
                          role="button"
                          tabIndex={0}
                          aria-label={`Изменить контакт «${r.data.name}»`}
                          onClick={() => void openContact(r)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              void openContact(r);
                            }
                          }}
                        >
                          <div className="cc-contact-name">
                            <span>ФИО</span>
                            <strong>{r.data.name}</strong>
                          </div>
                          <div className="cc-contact-columns">
                            <div>
                              <span>Должность</span>
                              <span>{r.data.role || 'Не указана'}</span>
                            </div>
                            <div>
                              <span>Телефон</span>
                              <span>{r.data.phone || 'Не указан'}</span>
                            </div>
                          </div>
                          <div className="cc-contact-email">
                            <span>E-mail</span>
                            <span>{r.data.email || 'Не указан'}</span>
                          </div>
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
                    <Icon name="chevron-down" size={18} />
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
                          <span className="cc-file-icon">
                            <Icon name="file" size={20} />
                          </span>
                          <span>
                            <strong>{f.data.name}</strong>
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
                    <Icon name="chevron-down" size={18} />
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
                    <Icon name="chevron-down" size={18} />
                  </summary>
                  <div className="cc-section-body cc-data">
                    {[
                      ['inn', 'ИНН'],
                      ['name', 'Название'],
                    ].map(([key, label]) => (
                      <InlineValue
                        key={key}
                        label={label}
                        value={String(c[key as keyof Company] || '')}
                        multiline={key === 'name'}
                        singleLine={key === 'name'}
                        onSave={(value) => patch({ [key]: value })}
                      />
                    ))}
                    <InlineValue
                      label="Категория"
                      compact
                      value={c.segment}
                      options={(primarySegments.includes(
                        c.segment as (typeof primarySegments)[number],
                      )
                        ? primarySegments
                        : [...primarySegments, c.segment]
                      ).map((value) => ({ value, label: labels[value] }))}
                      onSave={(value) => patch({ segment: value as Company['segment'] })}
                    />
                    <InlineValue
                      label="Город"
                      value={c.city}
                      compact
                      wrapValue
                      multiline
                      singleLine
                      onSave={(city) => patch({ city })}
                    />
                    <InlineValue
                      label="Сайт"
                      value={c.website || ''}
                      onSave={(website) => patch({ website })}
                    />
                    <InlineValue
                      label={isHolding ? 'Описание деятельности' : 'Отрасль'}
                      value={c.industry}
                      multiline
                      singleLine
                      onSave={(industry) => patch({ industry })}
                    />
                    {isHolding && (
                      <>
                        <InlineValue
                          label="Сайты"
                          value={(c.sites || []).join('\n')}
                          multiline
                          onSave={(value) =>
                            patch({
                              sites: value
                                .split('\n')
                                .map((site) => site.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      </>
                    )}
                  </div>
                </details>
                {c.archived && actorRole === 'admin' && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onOpen(c, 'actions')}
                  >
                    Восстановить компанию
                  </button>
                )}
                <button type="button" className="text-button" onClick={() => onOpen(c, 'task')}>
                  Задачи и проекты
                </button>
              </>
            )}
          </div>
        )}
      </SwipeAction>
      {!open && error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {newEquipment && (
        <EquipmentSheet
          divisions={c.divisions}
          onCancel={() => setNewEquipment(null)}
          onSave={async (key, value) => {
            if (c.divisions[key as keyof typeof c.divisions] != null)
              throw new Error('Это оборудование уже добавлено. Выберите другой тип.');
            try {
              await equipment(key, value, newEquipment);
            } catch (error) {
              if (error instanceof ApiError && error.status === 409)
                throw new Error(
                  'Карточка изменилась. Сумма сохранена в форме. Закройте шторку и откройте её заново, чтобы проверить изменения перед сохранением.',
                );
              throw error;
            }
            setAddedEquipment((keys) => [...keys.filter((existing) => existing !== key), key]);
            setNewEquipment(null);
          }}
        />
      )}
      {editingClient && (
        <Modal sheet title="Редактирование карточки" onClose={() => setEditingClient(false)}>
          <CompanyForm
            initial={editorCompany || c}
            initialContacts={editorContacts.map((r) => ({
              id: r.id,
              version: r.version,
              name: r.data.name || '',
              role: r.data.role || '',
              phone: r.data.phone || '',
              email: r.data.email || '',
            }))}
            onSave={async ({ initialContacts = [], ...data }) => {
              try {
                await api(`/companies/${c.id}/editor`, 'PATCH', {
                  version: (editorCompany || c).version,
                  data,
                  contacts: companyContactChanges(initialContacts, editorContacts),
                });
              } catch (error) {
                if (error instanceof ApiError && error.status === 409)
                  throw new Error(
                    'Карточка или контакты изменились. Введённые данные сохранены в форме. Закройте форму и заново откройте карточку, чтобы проверить изменения перед сохранением.',
                  );
                throw error;
              }
              await changed();
              setEditingClient(false);
            }}
          />
        </Modal>
      )}
      {editingContact && (
        <Modal sheet title="Контакт" closeDisabled={savingContact} onClose={closeContact}>
          <ContactForm
            initial={editingContact.data}
            onCancel={closeContact}
            onBusyChange={setSavingContact}
            onSave={async (data) => {
              try {
                await api(`/records/${editingContact.id}`, 'PATCH', {
                  version: editingContact.version,
                  data,
                });
              } catch (error) {
                if (error instanceof ApiError && error.status === 409)
                  throw new Error(
                    'Контакт изменился. Введённые данные сохранены в форме. Закройте форму и заново откройте карточку, чтобы проверить изменения перед сохранением.',
                  );
                throw error;
              }
              await changed();
              setEditingContact(null);
            }}
          />
        </Modal>
      )}
    </article>
  );
}
function ContactForm({
  initial,
  onSave,
  onCancel,
  onBusyChange,
}: {
  initial?: Record<string, string>;
  onBusyChange?: (busy: boolean) => void;
  onSave: (data: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState({
      name: initial?.name || '',
      role: initial?.role || '',
      phone: initial?.phone || '',
      email: initial?.email || '',
    }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const saving = useRef(false);
  return (
    <form
      className={`cc-inline-editor ${initial ? 'cc-contact-form' : ''}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving.current) return;
        saving.current = true;
        setBusy(true);
        onBusyChange?.(true);
        setError('');
        try {
          await onSave(contactSchema.parse(draft));
        } catch (e) {
          setError((e as Error).message);
        } finally {
          saving.current = false;
          setBusy(false);
          onBusyChange?.(false);
        }
      }}
    >
      {[
        ['name', 'ФИО'],
        ['role', 'Должность'],
        ['phone', 'Телефон'],
        ['email', 'E-mail'],
      ].map(([key, label]) => (
        <label key={key}>
          {label}
          <GrowingTextarea
            singleLine
            aria-label={`${initial ? 'Контакт' : 'Новый контакт'} · ${label}`}
            inputMode={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'}
            autoComplete={
              key === 'email'
                ? 'email'
                : key === 'phone'
                  ? 'tel'
                  : key === 'name'
                    ? 'name'
                    : 'organization-title'
            }
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
        <button className="primary" disabled={busy}>
          {initial ? 'Сохранить' : 'Сохранить контакт'}
        </button>
        {!initial && (
          <button type="button" disabled={busy} onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
    </form>
  );
}
function EquipmentSheet({
  divisions: existing,
  onSave,
  onCancel,
}: {
  divisions: Company['divisions'];
  onSave: (key: string, value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [key, setKey] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const close = () => {
    if (!saving.current) onCancel();
  };
  const number = Number(amount.replace(',', '.'));
  const valid =
    amount.trim() !== '' && Number.isFinite(number) && number >= 0 && number <= 1_000_000;
  return (
    <Modal
      sheet
      swipeToClose
      title="Новое оборудование"
      onClose={close}
      closeDisabled={busy}
      initialFocusRef={amountRef}
    >
      <form
        className="cc-equipment-sheet"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving.current || !key || !valid || existing[key as keyof typeof existing] != null)
            return;
          saving.current = true;
          setBusy(true);
          setError('');
          try {
            await onSave(key, amount);
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            saving.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <legend>Тип</legend>
          <div className="cc-equipment-types" role="group" aria-label="Тип оборудования">
            {primaryDivisions.map((type) => (
              <button
                type="button"
                key={type}
                aria-pressed={key === type}
                disabled={existing[type] != null || busy}
                onClick={() => {
                  setKey(type);
                  setError('');
                }}
              >
                {divisionLabels[type]}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="cc-equipment-potential">
          <span>Потенциал</span>
          <span className="cc-equipment-amount-field">
            <input
              ref={amountRef}
              aria-label="Потенциал, млн ₽"
              inputMode="none"
              enterKeyHint="done"
              autoComplete="off"
              value={amount}
              disabled={busy}
              aria-invalid={amount !== '' && !valid}
              onChange={(event) => {
                setAmount(event.target.value);
                setError('');
              }}
            />
            <span>млн ₽</span>
          </span>
        </label>
        <PicoNumberKeys
          disabled={busy}
          onKey={(digit) => {
            setAmount((value) => appendPicoNumberKey(value, digit));
            setError('');
            amountRef.current?.focus({ preventScroll: true });
          }}
        />
        {amount !== '' && !valid && (
          <p className="error" role="alert">
            Введите сумму от 0 до 1 000 000 млн ₽
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="cc-equipment-submit"
          disabled={busy || !key || !valid || existing[key as keyof typeof existing] != null}
        >
          {busy ? 'Добавление…' : 'Добавить'}
        </button>
      </form>
    </Modal>
  );
}
