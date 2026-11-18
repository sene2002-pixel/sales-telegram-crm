import { useState } from 'react';
import { Company, validInn } from '../shared/contracts';
import { companyDisplayName } from '../shared/company-display-name';
import { ClientPicker } from './FormWidgets';
import { Icon } from './Icons';
import { ClientTypeBadge } from './ClientTypeBadge';
import './new-holding-members.css';

export type NewMemberCompany = Pick<Company, 'inn' | 'name' | 'city'>;
export type HoldingMemberChoice = NewMemberCompany &
  (Pick<Company, 'id' | 'version'> | { id?: never; version?: never });

export function NewHoldingMembers({
  choices,
  members,
  onChange,
  draft,
  onDraftChange,
}: {
  choices: Company[];
  members: HoldingMemberChoice[];
  onChange: (members: HoldingMemberChoice[]) => void;
  draft: NewMemberCompany | null;
  onDraftChange: (draft: NewMemberCompany | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const candidates = choices.filter(
    (company) =>
      (!draft?.inn || company.inn === draft.inn.trim()) &&
      !members.some(
        (member) => member.id === company.id || (!!member.inn && member.inn === company.inn),
      ),
  );
  function addDraft() {
    if (!draft) return;
    const name = draft.name.trim(),
      inn = draft.inn.trim(),
      city = draft.city.trim();
    if (!validInn(inn)) return setError('Введите корректный ИНН компании из 10 или 12 цифр.');
    if (!name) return setError('Укажите название компании.');
    if (members.some((member) => member.inn === inn))
      return setError('Компания с этим ИНН уже добавлена в список.');
    if (choices.some((company) => company.inn === inn))
      return setError('Компания с этим ИНН есть в базе. Выберите её в поиске.');
    onChange([...members, { name, inn, city }]);
    closePicker();
  }
  function closePicker() {
    setPicking(false);
    setError('');
    onDraftChange(null);
  }
  const open = picking || draft !== null;
  return (
    <section className="new-holding-members" aria-label="Компании холдинга">
      <h3>Компании холдинга</h3>
      <div className="new-holding-list">
        {members.length > 0 && (
          <ul>
            {members.map((member) => (
              <li key={member.id || member.inn}>
                <ClientTypeBadge segment="end_client" />
                <div className="new-holding-summary">
                  <strong>{companyDisplayName(member.name)}</strong>
                  {member.id &&
                    !choices.some(
                      (company) => company.id === member.id && company.version === member.version,
                    ) && (
                      <span className="new-holding-changed">
                        Карточка изменилась. Уберите строку и выберите компанию повторно.
                      </span>
                    )}
                  <small>
                    {[member.city, member.inn && 'ИНН ' + member.inn].filter(Boolean).join(' · ')}
                  </small>
                </div>
                <button
                  type="button"
                  aria-label={`Убрать ${member.name} из холдинга`}
                  onClick={() => onChange(members.filter((item) => item !== member))}
                >
                  <Icon name="close" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {!open && (
          <button
            type="button"
            className="new-holding-add"
            disabled={members.length >= 100}
            onClick={() => setPicking(true)}
          >
            <Icon name="plus" size={16} />
            Добавить компанию
          </button>
        )}
        {open && (
          <div className="new-holding-picker">
            {(!draft || (draft.inn && candidates.length > 0)) && (
              <ClientPicker
                companies={candidates}
                value=""
                label="Поиск компании для холдинга"
                onChange={(id) => {
                  const company = candidates.find((entry) => entry.id === id);
                  if (company) {
                    onChange([
                      ...members,
                      {
                        id: company.id,
                        version: company.version,
                        name: company.name,
                        city: company.city,
                        inn: company.inn,
                      },
                    ]);
                    closePicker();
                  }
                }}
              />
            )}
            {draft ? (
              <>
                <label className="field">
                  <span>ИНН компании</span>
                  <input
                    inputMode="numeric"
                    placeholder="10 или 12 цифр"
                    value={draft.inn}
                    onChange={(e) => {
                      onDraftChange({ ...draft, inn: e.target.value });
                      setError('');
                    }}
                  />
                </label>
                <label className="field">
                  <span>Название компании</span>
                  <input
                    maxLength={200}
                    value={draft.name}
                    onChange={(e) => {
                      onDraftChange({ ...draft, name: e.target.value });
                      setError('');
                    }}
                  />
                </label>
                <label className="field">
                  <span>Город компании</span>
                  <input
                    maxLength={150}
                    value={draft.city}
                    onChange={(e) => onDraftChange({ ...draft, city: e.target.value })}
                  />
                </label>
                {error && (
                  <p role="alert" className="error">
                    {error}
                  </p>
                )}
                <button type="button" onClick={addDraft}>
                  Добавить в список
                </button>
              </>
            ) : (
              <button type="button" onClick={() => onDraftChange({ name: '', inn: '', city: '' })}>
                Создать по ИНН
              </button>
            )}
            <button type="button" onClick={closePicker}>
              Отмена
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
