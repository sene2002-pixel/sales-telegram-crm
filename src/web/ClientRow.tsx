import { companyDisplayName } from '../shared/company-display-name';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  Company,
  CompanyData,
  companySchema,
  CompanyDetail as Detail,
  labels,
  divisions,
  divisionLabels,
  CrmRecord,
} from '../shared/contracts';
import { companyPotential } from '../shared/analytics';
import { api, download, compactMoney, fullMoney } from './api';
import { CompanyForm, Modal, RecordForm, NewDirectionEditor } from './forms';
import { fromMillions, millionValue } from './FormWidgets';
import { Icon, industryIcon } from './Icons';
import { SwipeRow } from './SwipeRow';
import './client-card.css';

const levels = [
  ['new', 'Новый', '#6B78E8', 1],
  ['acquaintance', 'Знакомство', '#78A9F0', 2],
  ['development', 'Развитие', '#6CC3E6', 3],
  ['partner', 'Партнёр', '#5FCDB8', 2],
  ['ours', 'Наш клиент', '#22A86B', 1],
] as const;
function Section({
  title,
  value,
  children,
  className = '',
}: {
  title: string;
  value?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId(),
    [open, setOpen] = useState(false);
  return (
    <section className={'client-card-section ' + className}>
      <button
        className="client-section-heading"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span>{title}</span>
        <strong>{value}</strong>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} />
      </button>
      <div id={id} hidden={!open} className="client-section-body">
        {children}
      </div>
    </section>
  );
}
function Amount({
  value,
  label,
  onSave,
}: {
  value: number;
  label: string;
  onSave: (amount: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(millionValue(value)),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const saveSnapshot = useRef(onSave);
  async function save() {
    const n = fromMillions(draft.trim().replace(',', '.'));
    if (n == null || !Number.isFinite(n) || n < 0 || n > 1e12) {
      setError('Укажите сумму от 0 до 1 000 000 млн ₽');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveSnapshot.current(n);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="client-inline-amount">
      {editing ? (
        <>
          <input
            aria-label={'Сумма: ' + label}
            inputMode="decimal"
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void save();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
                setError('');
              }
            }}
          />
          <button
            type="button"
            disabled={busy}
            aria-label={'Сохранить сумму: ' + label}
            onClick={() => void save()}
          >
            <Icon name="check" size={16} />
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={'Отменить сумму: ' + label}
            onClick={() => {
              setEditing(false);
              setError('');
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </>
      ) : (
        <button
          type="button"
          className="client-amount-value"
          aria-label={'Изменить сумму: ' + label}
          onClick={() => {
            setDraft(millionValue(value));
            saveSnapshot.current = onSave;
            setEditing(true);
          }}
        >
          {millionValue(value)}
        </button>
      )}
      <small>млн ₽</small>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
export function ClientRow({
  company,
  onOpen,
  onChanged,
  initiallyOpen = false,
  canArchive = false,
}: {
  company: Company;
  initiallyOpen?: boolean;
  canArchive?: boolean;
  onChanged: () => Promise<void>;
  onOpen: (c: Company, tab?: string) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen),
    [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [contact, setContact] = useState<CrmRecord | 'new' | null>(null),
    [editing, setEditing] = useState<Company | null>(null),
    [busy, setBusy] = useState(false),
    [newDirection, setNewDirection] = useState<Company | null>(null),
    [notesOpen, setNotesOpen] = useState<Company | null>(null),
    [notes, setNotes] = useState(''),
    [remove, setRemove] = useState<{ label: string; run: () => Promise<void> } | null>(null);
  const readSequence = useRef(0);
  const currentCompany =
    detail && detail.company.version >= company.version ? detail.company : company;
  const contacts = detail?.records.filter((r) => r.kind === 'contact') || [],
    files = detail?.records.filter((r) => r.kind === 'file') || [];
  const score = detail?.clientScore,
    levelIndex = levels.findIndex((l) => l[0] === score?.level);
  const [icon, color] = industryIcon(currentCompany.industry, currentCompany.segment);
  async function refreshDetail() {
    const sequence = ++readSequence.current;
    const fresh = await api<Detail>(`/companies/${company.id}`);
    if (sequence === readSequence.current) setDetail(fresh);
    await onChanged();
  }
  async function afterSave() {
    try {
      await refreshDetail();
    } catch (e) {
      setError(`Изменения сохранены, но обновление не удалось: ${(e as Error).message}`);
    }
  }
  async function saveCompany(data: CompanyData, expectedVersion = currentCompany.version) {
    const saved = await api<Company>(`/companies/${company.id}`, 'PATCH', {
      version: expectedVersion,
      data,
    });
    ++readSequence.current;
    setDetail((d) => (d ? { ...d, company: saved } : { company: saved, records: [], audit: [] }));
    await afterSave();
  }
  async function saveDivisions(next: Company['divisions'], snapshot = currentCompany) {
    await saveCompany(
      {
        ...companySchema.strip().parse(snapshot),
        divisions: next,
        potential: Object.values(next).reduce((s, n) => s + (n || 0), 0),
      },
      snapshot.version,
    );
  }
  function removeRecord(record: CrmRecord) {
    setRemove({
      label: `Удалить ${record.kind === 'file' ? 'файл' : 'контакт'} «${record.data.name}»?`,
      run: async () => {
        await api(`/${record.kind === 'file' ? 'files' : 'contacts'}/${record.id}`, 'DELETE');
        ++readSequence.current;
        setDetail((d) => (d ? { ...d, records: d.records.filter((r) => r.id !== record.id) } : d));
        await afterSave();
      },
    });
  }
  useEffect(() => {
    let current = true;
    const sequence = ++readSequence.current;
    if (open) {
      setLoading(true);
      api<Detail>(`/companies/${company.id}`)
        .then((d) => {
          if (current && sequence === readSequence.current) {
            setDetail(d);
            setError('');
          }
        })
        .catch((e) => {
          if (current && sequence === readSequence.current) setError(e.message);
        })
        .finally(() => {
          if (current && sequence === readSequence.current) setLoading(false);
        });
    }
    return () => {
      current = false;
    };
  }, [open, company.id, company.version]);
  return (
    <>
      <SwipeRow
        className={'pico-client-accordion client-card ' + (open ? 'expanded' : '')}
        label={'клиент ' + companyDisplayName(currentCompany.name)}
        onEdit={
          !currentCompany.archived
            ? () => {
                setBusy(true);
                api<Detail>(`/companies/${company.id}`)
                  .then((fresh) => {
                    setDetail(fresh);
                    setEditing(fresh.company);
                  })
                  .catch((e) => {
                    setError(e.message);
                    setOpen(true);
                  })
                  .finally(() => setBusy(false));
              }
            : undefined
        }
        onDelete={
          canArchive && !currentCompany.archived
            ? () =>
                setRemove({
                  label: `Перенести «${companyDisplayName(currentCompany.name)}» в архив? Контакты, задачи и файлы сохранятся. Восстановить сможет администратор.`,
                  run: async () => {
                    await api(`/companies/${company.id}/archive`, 'POST', {
                      archived: true,
                      version: currentCompany.version,
                    });
                    await afterSave();
                  },
                })
            : undefined
        }
        disabled={busy}
      >
        <button className="pico-client-row" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={'icon-badge badge-' + color}>
            <Icon name={icon} />
          </span>
          <span className="pico-client-copy">
            <strong className="pico-two-lines" title={companyDisplayName(currentCompany.name)}>
              {companyDisplayName(currentCompany.name)}
            </strong>
            <small
              className="pico-client-metadata"
              title={[labels[currentCompany.segment], currentCompany.city, currentCompany.industry]
                .filter(Boolean)
                .join(' · ')}
            >
              <span>
                {[labels[currentCompany.segment], currentCompany.city].filter(Boolean).join(' · ')}
              </span>
              {currentCompany.industry && <span>{currentCompany.industry}</span>}
            </small>
          </span>
          <span className="company-money">
            <small>Потенциал</small>
            <strong title={fullMoney(companyPotential(currentCompany))}>
              {compactMoney(companyPotential(currentCompany))}
            </strong>
          </span>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} />
        </button>
        {open && (
          <div className="pico-client-content">
            {loading && <p role="status">Загрузка…</p>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="client-funnel" aria-label="Воронка клиента">
              {score && levelIndex >= 0 ? (
                <>
                  <div className="client-funnel-label">
                    <strong>
                      <i style={{ background: levels[levelIndex][2] }} />
                      {levels[levelIndex][1]}
                    </strong>
                    <span>
                      {score.score}{' '}
                      {score.score === 1
                        ? 'балл'
                        : score.score >= 2 && score.score <= 4
                          ? 'балла'
                          : 'баллов'}{' '}
                      из 8
                    </span>
                  </div>
                  <div className="client-funnel-segments" aria-hidden="true">
                    {levels.map((l, i) => (
                      <span
                        key={l[0]}
                        style={{ flex: l[3], background: i <= levelIndex ? l[2] : '#E6EBF3' }}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <p className="muted">
                  {currentCompany.archived
                    ? 'Клиент в архиве'
                    : loading
                      ? 'Обновляем статус…'
                      : 'Статус недоступен'}
                </p>
              )}
            </div>
            <Section
              title="Потенциал"
              value={compactMoney(companyPotential(currentCompany))}
              className="pico-client-potential"
            >
              {divisions
                .filter((d) => currentCompany.divisions[d] != null)
                .map((d) => (
                  <SwipeRow
                    key={d}
                    label={'оборудование ' + (divisionLabels[d] || labels[d])}
                    className="client-equipment-swipe"
                    disabled={busy}
                    onDelete={
                      !currentCompany.archived
                        ? () =>
                            setRemove({
                              label: `Убрать оборудование «${divisionLabels[d] || labels[d]}»?`,
                              run: async () => {
                                const next = { ...currentCompany.divisions };
                                delete next[d];
                                await saveDivisions(next);
                              },
                            })
                        : undefined
                    }
                  >
                    <div className="pico-potential-client">
                      <span>{divisionLabels[d] || labels[d]}</span>
                      {currentCompany.archived ? (
                        <strong>{compactMoney(currentCompany.divisions[d])}</strong>
                      ) : (
                        <Amount
                          value={currentCompany.divisions[d]!}
                          label={divisionLabels[d] || labels[d]}
                          onSave={(n) => saveDivisions({ ...currentCompany.divisions, [d]: n })}
                        />
                      )}
                    </div>
                  </SwipeRow>
                ))}
              {!currentCompany.archived && (
                <button className="client-add-link" onClick={() => setNewDirection(currentCompany)}>
                  + Добавить оборудование
                </button>
              )}
            </Section>
            <Section title="Контакты" value={contacts.length} className="pico-client-contacts">
              {contacts.map((r) => (
                <SwipeRow
                  key={r.id}
                  label={'контакт ' + r.data.name}
                  className="client-contact-swipe"
                  onEdit={!currentCompany.archived ? () => setContact(r) : undefined}
                  onDelete={!currentCompany.archived ? () => removeRecord(r) : undefined}
                  disabled={busy}
                >
                  <div className="client-compact-contact">
                    <div className="client-contact-field">
                      <small>ФИО</small>
                      <strong>{r.data.name}</strong>
                    </div>
                    <div className="client-contact-columns">
                      <div className="client-contact-field">
                        <small>Должность</small>
                        <span>{r.data.role || 'Не указана'}</span>
                      </div>
                      <div className="client-contact-field">
                        <small>Телефон</small>
                        {r.data.phone ? (
                          <a href={'tel:' + r.data.phone.replace(/[^+\d]/g, '')}>{r.data.phone}</a>
                        ) : (
                          <span>Не указан</span>
                        )}
                      </div>
                    </div>
                    <div className="client-contact-field">
                      <small>E-mail</small>
                      {r.data.email ? (
                        <a href={'mailto:' + r.data.email}>{r.data.email}</a>
                      ) : (
                        <span>Не указан</span>
                      )}
                    </div>
                  </div>
                </SwipeRow>
              ))}
              {!loading && !contacts.length && <p className="muted">Контактов пока нет</p>}
              {!currentCompany.archived && (
                <button
                  className="client-add-link"
                  aria-label={'Добавить контакт · ' + company.name}
                  onClick={() => setContact('new')}
                >
                  + Добавить контакт
                </button>
              )}
            </Section>
            <Section title="Файлы" value={files.length} className="pico-client-files">
              {files.map((f) => (
                <SwipeRow
                  key={f.id}
                  label={'файл ' + f.data.name}
                  className="client-file-swipe"
                  onDelete={!currentCompany.archived ? () => removeRecord(f) : undefined}
                  disabled={busy}
                >
                  <button
                    className="client-file"
                    onClick={() =>
                      download(`/files/${f.id}`, f.data.name).catch((e) => setError(e.message))
                    }
                  >
                    <span className="client-file-icon">
                      <Icon name="file" size={22} />
                      <small>
                        {String(f.data.name).split('.').pop()?.slice(0, 5).toUpperCase()}
                      </small>
                    </span>
                    <span>
                      <strong title={f.data.name}>{f.data.name}</strong>
                      <small>{new Date(f.createdAt).toLocaleDateString('ru-RU')}</small>
                    </span>
                  </button>
                </SwipeRow>
              ))}
              {!loading && !files.length && <p className="muted">Файлов пока нет</p>}
              {!currentCompany.archived && (
                <button className="client-add-link" onClick={() => onOpen(currentCompany, 'file')}>
                  + Добавить файл
                </button>
              )}
            </Section>
            <Section title="Заметки" className="pico-client-notes">
              <p className="client-notes">{currentCompany.notes || 'Заметок пока нет'}</p>
              {!currentCompany.archived && (
                <button
                  className="client-add-link"
                  aria-label={'Изменить заметки · ' + company.name}
                  onClick={() => {
                    setNotes(currentCompany.notes);
                    setNotesOpen(currentCompany);
                  }}
                >
                  Изменить заметки
                </button>
              )}
            </Section>
            <Section title="Данные" className="client-company-data">
              <dl>
                <div>
                  <dt>ИНН</dt>
                  <dd>{currentCompany.inn || 'Не указан'}</dd>
                </div>
                <div className="client-contact-columns">
                  <div>
                    <dt>Название</dt>
                    <dd>{companyDisplayName(currentCompany.name)}</dd>
                  </div>
                  <div>
                    <dt>Город</dt>
                    <dd>{currentCompany.city || 'Не указан'}</dd>
                  </div>
                </div>
                <div>
                  <dt>Категория клиента</dt>
                  <dd>{labels[currentCompany.segment]}</dd>
                </div>
                <div>
                  <dt>Сайт</dt>
                  <dd>{currentCompany.website || 'Не указан'}</dd>
                </div>
              </dl>
            </Section>
            <button className="client-open-full" onClick={() => onOpen(currentCompany)}>
              Карточка клиента
            </button>
          </div>
        )}
      </SwipeRow>
      {editing && (
        <Modal sheet title="Редактирование карточки" onClose={() => setEditing(null)}>
          <CompanyForm
            cardMode
            initial={editing}
            contactFields={
              <div className="client-form-contacts">
                <span className="pico-field-heading">Контакты</span>
                {contacts.map((r) => (
                  <button type="button" key={r.id} onClick={() => setContact(r)}>
                    {r.data.name} <Icon name="edit" size={16} />
                  </button>
                ))}
                <button type="button" className="client-add-link" onClick={() => setContact('new')}>
                  + Ещё контакт
                </button>
              </div>
            }
            onSave={async (data) => {
              await saveCompany(data, editing.version);
              setEditing(null);
            }}
          />
        </Modal>
      )}
      {newDirection && (
        <NewDirectionEditor
          onClose={() => setNewDirection(null)}
          onSave={(v) =>
            saveDivisions({ ...newDirection.divisions, [v.division]: v.amount }, newDirection)
          }
        />
      )}
      {contact && (
        <Modal sheet title="Контакт" onClose={() => setContact(null)}>
          <RecordForm
            key={contact === 'new' ? 'new' : contact.id}
            kind="contact"
            compactContact
            initial={contact === 'new' ? undefined : contact}
            projects={[]}
            onSave={async (data) => {
              const saved =
                contact === 'new'
                  ? await api<CrmRecord>(`/companies/${company.id}/records/contact`, 'POST', {
                      data,
                    })
                  : await api<CrmRecord>(`/records/${contact.id}`, 'PATCH', {
                      version: contact.version,
                      data,
                    });
              ++readSequence.current;
              setDetail((d) =>
                d
                  ? {
                      ...d,
                      records: d.records.some((r) => r.id === saved.id)
                        ? d.records.map((r) => (r.id === saved.id ? saved : r))
                        : [...d.records, saved],
                    }
                  : d,
              );
              setContact(null);
              await afterSave();
            }}
          />
        </Modal>
      )}
      {notesOpen && (
        <Modal sheet title="Заметки" onClose={() => setNotesOpen(null)}>
          <form
            className="pico-compact-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await saveCompany(
                  { ...companySchema.strip().parse(notesOpen), notes },
                  notesOpen.version,
                );
                setNotesOpen(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <textarea
              aria-label="Заметки"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              Сохранить заметки
            </button>
          </form>
        </Modal>
      )}
      {remove && (
        <Modal
          sheet
          title="Подтверждение"
          onClose={() => {
            if (!busy) {
              setRemove(null);
              setError('');
            }
          }}
        >
          <p>{remove.label}</p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="client-confirm-actions">
            <button
              disabled={busy}
              onClick={() => {
                setRemove(null);
                setError('');
              }}
            >
              Отмена
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await remove.run();
                  setRemove(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Подтвердить
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
