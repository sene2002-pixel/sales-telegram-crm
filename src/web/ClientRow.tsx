import { companyDisplayName } from '../shared/company-display-name';
import { useEffect, useRef, useState } from 'react';
import {
  Company,
  CompanyDetail as Detail,
  labels,
  divisions,
  divisionLabels,
  CrmRecord,
} from '../shared/contracts';
import { api, download, money, compactMoney, fullMoney } from './api';
import { CompanyForm, Modal, RecordForm, NewDirectionEditor } from './forms';
import { Icon, industryIcon } from './Icons';
export function ClientRow({
  company,
  onOpen,
  onChanged,
  initiallyOpen = false,
}: {
  company: Company;
  initiallyOpen?: boolean;
  onChanged: () => Promise<void>;
  onOpen: (c: Company, tab?: string) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen),
    [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [contact, setContact] = useState<CrmRecord | 'new' | null>(null),
    [editContact, setEditContact] = useState(false),
    [editing, setEditing] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    [busy, setBusy] = useState(false),
    [newDirection, setNewDirection] = useState(false),
    [notesOpen, setNotesOpen] = useState(false),
    [notes, setNotes] = useState('');
  const readSequence = useRef(0);
  const currentCompany =
    detail && detail.company.version >= company.version ? detail.company : company;
  async function refreshDetail() {
    const sequence = ++readSequence.current;
    const fresh = await api<Detail>(`/companies/${company.id}`);
    if (sequence === readSequence.current) setDetail(fresh);
    await onChanged();
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
  const [icon, color] = industryIcon(company.industry, company.segment),
    contacts = detail?.records.filter((r) => r.kind === 'contact') || [],
    files = detail?.records.filter((r) => r.kind === 'file') || [];
  return (
    <article className={'pico-client-accordion ' + (open ? 'expanded' : '')}>
      <button className="pico-client-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={'icon-badge badge-' + color}>
          <Icon name={icon} />
        </span>
        <span className="pico-client-copy">
          <strong className="pico-two-lines" title={companyDisplayName(company.name)}>
            {companyDisplayName(company.name)}
          </strong>
          <small
            className="pico-client-metadata"
            title={[labels[company.segment], company.city, company.industry]
              .filter(Boolean)
              .join(' · ')}
          >
            <span>{[labels[company.segment], company.city].filter(Boolean).join(' · ')}</span>
            {company.industry && <span>{company.industry}</span>}
          </small>
        </span>
        <span className="company-money">
          <small>Потенциал</small>
          <strong title={fullMoney(currentCompany.potential)}>
            {compactMoney(currentCompany.potential)}
          </strong>
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
      </button>
      {editing && (
        <Modal title="Редактировать клиента" onClose={() => setEditing(false)}>
          <CompanyForm
            initial={currentCompany}
            onSave={async (data) => {
              const saved = await api<Company>(`/companies/${company.id}`, 'PATCH', {
                version: currentCompany.version,
                data,
              });
              ++readSequence.current;
              setDetail((current) => (current ? { ...current, company: saved } : current));
              try {
                await refreshDetail();
              } catch (e) {
                setError(`Клиент сохранён, но обновление не удалось: ${(e as Error).message}`);
              }
              setEditing(false);
            }}
          />
        </Modal>
      )}
      {newDirection && (
        <NewDirectionEditor
          onClose={() => setNewDirection(false)}
          onSave={async (value) => {
            const divisions = { ...currentCompany.divisions, [value.division]: value.amount };
            const { id, ownerId, ownerName, version, createdAt, updatedAt, ...base } =
              currentCompany;
            const saved = await api<Company>(`/companies/${company.id}`, 'PATCH', {
              version: currentCompany.version,
              data: {
                ...base,
                divisions,
                potential: Object.values(divisions).reduce((sum, amount) => sum + (amount || 0), 0),
              },
            });
            ++readSequence.current;
            setDetail((current) => (current ? { ...current, company: saved } : current));
            try {
              await refreshDetail();
            } catch (e) {
              setError(`Направление сохранено, но обновление не удалось: ${(e as Error).message}`);
            }
          }}
        />
      )}
      {notesOpen && (
        <Modal title="Заметки" onClose={() => setNotesOpen(false)}>
          <form
            className="pico-compact-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                const { id, ownerId, ownerName, version, createdAt, updatedAt, ...base } =
                  currentCompany;
                const saved = await api<Company>(`/companies/${company.id}`, 'PATCH', {
                  version: currentCompany.version,
                  data: { ...base, notes },
                });
                ++readSequence.current;
                setDetail((current) => (current ? { ...current, company: saved } : current));
                try {
                  await refreshDetail();
                } catch (e) {
                  setError(`Заметки сохранены, но обновление не удалось: ${(e as Error).message}`);
                }
                setNotesOpen(false);
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
      {contact && (
        <Modal
          title={
            contact === 'new'
              ? 'Новый контакт'
              : editContact
                ? 'Редактировать контакт'
                : contact.data.name
          }
          onClose={() => {
            setContact(null);
            setError('');
          }}
        >
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {editContact ? (
            <RecordForm
              kind="contact"
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
                setDetail((current) =>
                  current
                    ? {
                        ...current,
                        records: current.records.some((r) => r.id === saved.id)
                          ? current.records.map((r) => (r.id === saved.id ? saved : r))
                          : [...current.records, saved],
                      }
                    : current,
                );
                setContact(saved);
                setEditContact(false);
                try {
                  await refreshDetail();
                } catch (e) {
                  setError(`Контакт сохранён, но обновление не удалось: ${(e as Error).message}`);
                }
              }}
            />
          ) : (
            contact !== 'new' && (
              <>
                <p className="muted">
                  {contact.data.role} · {companyDisplayName(company.name)}
                </p>
                <dl className="pico-detail-fields">
                  <dt>Телефон</dt>
                  <dd>{contact.data.phone || 'Не указан'}</dd>
                  <dt>Email</dt>
                  <dd>{contact.data.email || 'Не указан'}</dd>
                </dl>
                <button onClick={() => setEditContact(true)}>
                  <Icon name="edit" size={16} /> Редактировать
                </button>
                <button className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  Удалить
                </button>
                {confirmDelete && (
                  <section role="alertdialog" aria-label="Удаление контакта">
                    <p>Удалить контакт «{contact.data.name}»?</p>
                    <button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api(`/contacts/${contact.id}`, 'DELETE');
                          ++readSequence.current;
                          setDetail((current) =>
                            current
                              ? {
                                  ...current,
                                  records: current.records.filter((r) => r.id !== contact.id),
                                }
                              : current,
                          );
                          setContact(null);
                          try {
                            await refreshDetail();
                          } catch (e) {
                            setError(
                              `Контакт удалён, но обновление не удалось: ${(e as Error).message}`,
                            );
                          }
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Подтвердить удаление
                    </button>
                    <button disabled={busy} onClick={() => setConfirmDelete(false)}>
                      Отмена
                    </button>
                  </section>
                )}
              </>
            )
          )}
        </Modal>
      )}
      {open && (
        <div className="pico-client-content">
          {loading && <p role="status">Загрузка…</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="section-head">
            <span className="stage">{labels[company.stage]}</span>
            <button onClick={() => onOpen(company)}>Карточка клиента</button>
          </div>
          <section className="pico-client-contacts">
            <div className="section-head">
              <h3>Контакты</h3>
              <button
                aria-label={'Добавить контакт · ' + company.name}
                onClick={() => {
                  setContact('new');
                  setEditContact(true);
                  setConfirmDelete(false);
                }}
              >
                <Icon name="plus" size={16} />
              </button>
            </div>
            {contacts.map((r) => (
              <button
                className="pico-inline-contact"
                key={r.id}
                onClick={() => {
                  setContact(r);
                  setEditContact(false);
                  setConfirmDelete(false);
                }}
              >
                <Icon name="contact" />
                <span>
                  <strong>{r.data.name}</strong>
                  <small>{r.data.role}</small>
                  <small>{[r.data.phone, r.data.email].filter(Boolean).join(' · ')}</small>
                </span>
                <Icon name="chevron-right" size={16} />
              </button>
            ))}
            {!loading && !contacts.length && <p className="muted">Контактов пока нет</p>}
          </section>
          <section className="pico-client-potential">
            <div className="section-head">
              <h3>Потенциал · {money(currentCompany.potential)}</h3>
              <button
                aria-label={'Изменить потенциал · ' + company.name}
                onClick={() => setEditing(true)}
              >
                <Icon name="edit" size={16} />
              </button>
            </div>
            {divisions
              .filter((d) => currentCompany.divisions[d] != null)
              .map((d) => (
                <div className="pico-potential-client" key={d}>
                  <span>{divisionLabels[d] || labels[d]}</span>
                  <strong>{money(currentCompany.divisions[d])}</strong>
                </div>
              ))}
            <button
              className="pico-add-row pico-dashed pico-direction-add"
              onClick={() => setNewDirection(true)}
            >
              <Icon name="plus" size={12} /> Добавить направление
            </button>
          </section>
          <section className="pico-client-files">
            <div className="section-head">
              <h3>Файлы</h3>
              <button onClick={() => onOpen(company, 'file')}>Добавить файл</button>
            </div>
            {files.map((f) => (
              <button
                className="pico-add-row"
                key={f.id}
                onClick={() =>
                  download(`/files/${f.id}`, f.data.name).catch((e) => setError(e.message))
                }
              >
                <Icon name="file" />
                {f.data.name}
              </button>
            ))}
            {!loading && !files.length && <p className="muted">Файлов пока нет</p>}
          </section>
          <section className="pico-client-notes">
            <div className="section-head">
              <h3>Заметки</h3>
              <button
                aria-label={'Изменить заметки · ' + company.name}
                onClick={() => {
                  setNotes(currentCompany.notes);
                  setNotesOpen(true);
                }}
              >
                <Icon name="edit" size={16} />
              </button>
            </div>
            <p>{currentCompany.notes || 'Заметок пока нет'}</p>
          </section>
        </div>
      )}
    </article>
  );
}
