import { useRef, useState } from 'react';

export function InlineAmount({
  label,
  value,
  unit,
  onSave,
}: {
  label: string;
  value: string;
  unit: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const session = useRef({ save: onSave, value, cancelled: false, busy: false });
  const button = useRef<HTMLButtonElement>(null);
  function cancel() {
    if (session.current.busy) return;
    session.current.cancelled = true;
    setEditing(false);
    setError('');
  }
  async function save(fromKeyboard = false) {
    const opening = session.current;
    if (opening.cancelled || opening.busy) return;
    if (draft === opening.value) {
      opening.cancelled = true;
      setEditing(false);
      if (fromKeyboard) requestAnimationFrame(() => button.current?.focus());
      return;
    }
    opening.busy = true;
    setBusy(true);
    setError('');
    try {
      await opening.save(draft);
      opening.cancelled = true;
      setEditing(false);
      if (fromKeyboard) requestAnimationFrame(() => button.current?.focus());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      opening.busy = false;
      setBusy(false);
    }
  }
  return (
    <div className="cc-amount-group">
      <div
        className={`cc-equipment ${editing ? 'cc-equipment-editing' : ''}`}
        onClick={() => {
          if (editing) return;
          session.current = { save: onSave, value, cancelled: false, busy: false };
          setDraft(value);
          setError('');
          setEditing(true);
        }}
      >
        <span className="cc-amount-label">{label}</span>
        {editing ? (
          <form
            className="cc-amount-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void save(true);
            }}
          >
            <input
              aria-label={label}
              aria-invalid={!!error}
              aria-busy={busy}
              inputMode="decimal"
              enterKeyHint="done"
              value={draft}
              readOnly={busy}
              style={{ width: `${Math.max(1, draft.length)}ch` }}
              ref={(input) => {
                if (input && document.activeElement !== input && !input.dataset.opened) {
                  input.dataset.opened = 'true';
                  input.focus();
                  input.setSelectionRange(input.value.length, input.value.length);
                }
              }}
              onChange={(event) => {
                setDraft(event.target.value);
                setError('');
              }}
              onBlur={(event) => {
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.dataset.amountCancel
                )
                  return;
                void save();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  cancel();
                  requestAnimationFrame(() => button.current?.focus());
                }
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void save(true);
                }
              }}
            />
            <small>{unit}</small>
          </form>
        ) : (
          <button
            ref={button}
            type="button"
            className="cc-amount-value"
            aria-label={`Изменить ${label}`}
          >
            <span>{value}</span>
            <small>{unit}</small>
          </button>
        )}
      </div>
      {busy && (
        <span className="pico-visually-hidden" role="status">
          Сохранение суммы
        </span>
      )}
      {error && (
        <div className="cc-amount-error">
          <p className="error" role="alert">
            {error}
          </p>
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void save()}
          >
            Повторить сохранение суммы
          </button>
          <button
            type="button"
            data-amount-cancel="true"
            onPointerDown={(event) => event.preventDefault()}
            onClick={cancel}
          >
            Отменить правку суммы
          </button>
        </div>
      )}
    </div>
  );
}
