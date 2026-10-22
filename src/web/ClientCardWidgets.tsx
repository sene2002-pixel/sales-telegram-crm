import { ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';

export function InlineValue({
  label,
  value,
  onSave,
  options,
  multiline,
  numeric,
  disabled,
  unit,
}: {
  label: string;
  value: string;
  onSave: (value: string) => Promise<void>;
  options?: readonly { value: string; label: string }[];
  multiline?: boolean;
  numeric?: boolean;
  disabled?: boolean;
  unit?: string;
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
          <span>{options?.find((o) => o.value === value)?.label || value || 'Не указано'}</span>
          {unit && <small>{unit}</small>}
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
  onEdit,
  disabled = false,
}: {
  children: ReactNode;
  label: string;
  onDelete?: () => Promise<void>;
  onEdit?: () => void;
  disabled?: boolean;
}) {
  const suppressClick = useRef(false);
  const mouseStart = useRef<{ x: number; y: number } | null>(null);
  const revealGesture = (
    origin: { x: number; y: number },
    point: { clientX: number; clientY: number },
  ) => {
    if (disabled || !(onDelete || onEdit)) return;
    const dx = point.clientX - origin.x,
      dy = point.clientY - origin.y;
    if (Math.abs(dy) < 35 && Math.abs(dx) > Math.max(50, Math.abs(dy) * 2)) {
      setRevealed(dx < 0);
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 350);
    }
  };
  const start = useRef<{ x: number; y: number; cancelled?: boolean } | null>(null);
  const [revealed, setRevealed] = useState(false),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const swipeRef = useRef<HTMLDivElement>(null);
  const [trashTop, setTrashTop] = useState(0);
  useEffect(() => {
    if (!revealed) return;
    let frame = 0;
    const measure = () => {
      const element = swipeRef.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const viewport = window.visualViewport;
      let visibleTop = viewport?.offsetTop || 0;
      let visibleBottom = visibleTop + (viewport?.height || window.innerHeight);
      const navigation = document.querySelector('.pico-bottom-nav')?.getBoundingClientRect();
      if (navigation && navigation.height > 0 && navigation.top > visibleTop)
        visibleBottom = Math.min(visibleBottom, navigation.top);
      // Intersect the real scroll viewport as well as the browser viewport.
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
          const parentBounds = parent.getBoundingClientRect();
          visibleTop = Math.max(visibleTop, parentBounds.top);
          visibleBottom = Math.min(visibleBottom, parentBounds.bottom);
        }
      }
      const top = Math.max(bounds.top, visibleTop);
      const bottom = Math.min(bounds.bottom, visibleBottom);
      setTrashTop(
        Math.max(
          0,
          Math.min(bounds.height - 44, (top + Math.max(top, bottom)) / 2 - bounds.top - 22),
        ),
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    const observer = new ResizeObserver(schedule);
    if (swipeRef.current) observer.observe(swipeRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [revealed]);
  return (
    <div
      ref={swipeRef}
      tabIndex={onEdit || onDelete ? 0 : undefined}
      role="group"
      aria-label={`Действия: ${label}`}
      onKeyDown={(e) => {
        if ((e.target as Element).closest('input,textarea,select,[contenteditable="true"]')) return;
        if (e.key === 'ArrowLeft' && !disabled && (onEdit || onDelete)) {
          e.preventDefault();
          e.stopPropagation();
          setRevealed(true);
        }
        if (e.key === 'ArrowRight' || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setRevealed(false);
        }
      }}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button === 0) {
          e.stopPropagation();
          mouseStart.current = { x: e.clientX, y: e.clientY };
        }
      }}
      onPointerMove={(e) => {
        const origin = mouseStart.current;
        if (
          e.pointerType === 'mouse' &&
          origin &&
          Math.abs(e.clientX - origin.x) > 12 &&
          Math.abs(e.clientX - origin.x) > Math.abs(e.clientY - origin.y)
        ) {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
        }
      }}
      onPointerUp={(e) => {
        if (e.pointerType === 'mouse' && mouseStart.current) {
          e.stopPropagation();
          revealGesture(mouseStart.current, e);
          mouseStart.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onPointerCancel={() => {
        mouseStart.current = null;
      }}
      className={`cc-swipe ${onEdit && onDelete ? 'cc-two-actions' : onEdit ? 'cc-single-edit' : ''} ${revealed ? 'cc-revealed' : ''}`}
      onClickCapture={(e) => {
        if (suppressClick.current && !(e.target as Element).closest('.cc-trash-track')) {
          e.preventDefault();
          e.stopPropagation();
          suppressClick.current = false;
        }
      }}
      onTouchStart={(e) => {
        e.stopPropagation();
        if (e.touches.length !== 1) {
          start.current = null;
          return;
        }
        const t = e.touches[0];
        start.current = { x: t.clientX, y: t.clientY };
      }}
      onTouchMove={(e) => {
        if (e.touches.length !== 1) {
          start.current = null;
          return;
        }
        const origin = start.current,
          point = e.touches[0];
        if (
          origin &&
          Math.abs(point.clientY - origin.y) > 12 &&
          Math.abs(point.clientY - origin.y) > Math.abs(point.clientX - origin.x)
        )
          origin.cancelled = true;
      }}
      onTouchCancel={() => {
        start.current = null;
      }}
      onTouchEnd={(e) => {
        e.stopPropagation();
        const s = start.current,
          t = e.changedTouches[0];
        if (s && !s.cancelled && t) revealGesture(s, t);
        start.current = null;
      }}
    >
      <div className="cc-swipe-content">{children}</div>
      {(onDelete || onEdit) && (
        <div className="cc-trash-track" aria-hidden={!revealed}>
          <div className="cc-swipe-actions" style={{ top: revealed ? trashTop : 0 }}>
            {onEdit && (
              <button
                type="button"
                className="cc-swipe-edit"
                aria-label={`Редактировать ${label}`}
                tabIndex={revealed ? 0 : -1}
                disabled={disabled || busy}
                onClick={() => {
                  if (!revealed) return;
                  suppressClick.current = false;
                  setRevealed(false);
                  onEdit();
                }}
              >
                <Icon name="edit" size={22} />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className="cc-trash"
                aria-label={`Удалить ${label}`}
                tabIndex={revealed ? 0 : -1}
                disabled={disabled || busy}
                onClick={() => {
                  if (revealed) {
                    suppressClick.current = false;
                    setConfirm(true);
                  }
                }}
              >
                <Icon name="trash" size={22} />
              </button>
            )}
          </div>
        </div>
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
