import { useEffect, useState } from 'react';
import {
  Company,
  CompanyDetail as Detail,
  labels,
  divisions,
  CrmRecord,
} from '../shared/contracts';
import { api, download, money } from './api';
import { CompanyForm, Modal, RecordForm } from './forms';
import { Icon, industryIcon } from './Icons';
export function ClientRow({
  company,
  onOpen,
  onChanged,
}: {
  company: Company;
  onChanged: () => Promise<void>;
  onOpen: (c: Company, tab?: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [contact, setContact] = useState<CrmRecord | 'new' | null>(null),
    [editContact, setEditContact] = useState(false),
    [editing, setEditing] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    [busy, setBusy] = useState(false);
  async function refreshDetail() {
    setDetail(await api<Detail>(`/companies/${company.id}`));
    await onChanged();
  }
  useEffect(() => {
    let current = true;
    if (open) {
      setLoading(true);
      api<Detail>(`/companies/${company.id}`)
        .then((d) => {
          if (current) {
            setDetail(d);
            setError('');
          }
        })
        .catch((e) => {
          if (current) setError(e.message);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }
    return () => {
      current = false;
    };
  }, [open, company]);
  const [icon, color] = industryIcon(company.industry, company.segment),
    contacts = detail?.records.filter((r) => r.kind === 'contact') || [],
    files = detail?.records.filter((r) => r.kind === 'file') || [];
  return (
    <article className={'pico-client-accordion ' + (open ? 'expanded' : '')}>
      <button className="pico-client-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={'icon-badge badge-' + color}>
          <Icon name={icon} />
        </span>
        <span>
          <strong>{company.name}</strong>
          <small>
            {[labels[company.segment], company.city, company.industry].filter(Boolean).join(' · ')}
          </small>
        </span>
        <span className="company-money">
          <small>Потенциал</small>
          <strong>{money(company.potential)}</strong>
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
      </button>
      {editing && (
        <Modal title="Редактировать клиента" onClose={() => setEditing(false)}>
          <CompanyForm
            initial={company}
            onSave={async (data) => {
              await api(`/companies/${company.id}`, 'PATCH', { version: company.version, data });
              await refreshDetail();
              setEditing(false);
            }}
          />
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
                  {contact.data.role} · {company.name}
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
                          await refreshDetail();
                          setContact(null);
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
          <section>
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
          <section>
            <div className="section-head">
              <h3>Потенциал · {money(company.potential)}</h3>
              <button
                aria-label={'Изменить потенциал · ' + company.name}
                onClick={() => setEditing(true)}
              >
                <Icon name="edit" size={16} />
              </button>
            </div>
            {divisions
              .filter((d) => company.divisions[d] != null)
              .map((d) => (
                <div className="pico-potential-client" key={d}>
                  <span>{labels[d]}</span>
                  <strong>{money(company.divisions[d])}</strong>
                </div>
              ))}
          </section>
          <section>
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
          <section>
            <div className="section-head">
              <h3>Заметки</h3>
              <button
                aria-label={'Изменить заметки · ' + company.name}
                onClick={() => setEditing(true)}
              >
                <Icon name="edit" size={16} />
              </button>
            </div>
            <p>{company.notes || 'Заметок пока нет'}</p>
          </section>
        </div>
      )}
    </article>
  );
}
