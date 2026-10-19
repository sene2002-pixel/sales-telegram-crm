import { ReactNode, useRef, useState } from 'react';
import { Icon } from './Icons';

export function InlineValue({
  label,
  value,
  onSave,
  options,
  multiline,
  numeric,
  disabled,
}: {
  label: string;
  value: string;
  onSave: (value: string) => Promise<void>;
  options?: readonly { value: string; label: string }[];
  multiline?: boolean;
  numeric?: boolean;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(value),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (!editing)
    return (
      <div className="cc-field">
        <span>{label}</span>
        <button
          disabled={disabled}
          aria-label={`Изменить ${label}`}
          onClick={() => {
            setDraft(value);
            setError('');
            setEditing(true);
          }}
        >
          {options?.find((o) => o.value === value)?.label || value || 'Не указано'}
          <Icon name="edit" size={14} />
        </button>
      </div>
    );
  const control = {
    'aria-label': label,
    value: draft,
    disabled: busy,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setDraft(e.target.value),
    autoFocus: true,
  };
  return (
    <form
      className="cc-inline-editor"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) setEditing(false);
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await onSave(draft);
          setEditing(false);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {label}
        {options ? (
          <select {...control}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : multiline ? (
          <textarea {...control} rows={4} />
        ) : (
          <input {...control} inputMode={numeric ? 'decimal' : undefined} />
        )}
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="cc-editor-actions">
        <button disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button>
        <button type="button" disabled={busy} onClick={() => setEditing(false)}>
          Отмена
        </button>
      </div>
    </form>
  );
}

export function SwipeAction({
  children,
  label,
  onDelete,
  disabled = false,
}: {
  children: ReactNode;
  label: string;
  onDelete?: () => Promise<void>;
  disabled?: boolean;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [revealed, setRevealed] = useState(false),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div
      className={`cc-swipe ${revealed ? 'cc-revealed' : ''}`}
      onTouchStart={(e) => {
        e.stopPropagation();
        const t = e.touches[0];
        start.current = { x: t.clientX, y: t.clientY };
      }}
      onTouchEnd={(e) => {
        e.stopPropagation();
        const s = start.current,
          t = e.changedTouches[0];
        if (s && onDelete && Math.abs(t.clientY - s.y) < 35 && Math.abs(t.clientX - s.x) > 50)
          setRevealed(t.clientX < s.x);
        start.current = null;
      }}
    >
      <div className="cc-swipe-content">{children}</div>
      {onDelete && (
        <button
          type="button"
          className="cc-trash"
          aria-label={`Удалить ${label}`}
          disabled={disabled || busy}
          onClick={() => {
            setConfirm(true);
            setRevealed(true);
          }}
        >
          <Icon name="trash" size={22} />
        </button>
      )}
      {confirm && (
        <section className="cc-confirm" role="alertdialog" aria-label={`Удаление ${label}`}>
          <p>Удалить {label}?</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button
            autoFocus
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await onDelete?.();
                setConfirm(false);
                setRevealed(false);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Подтвердить удаление
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setConfirm(false);
              setRevealed(false);
            }}
          >
            Отмена
          </button>
        </section>
      )}
    </div>
  );
}
