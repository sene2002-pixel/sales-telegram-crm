import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';

export type PicoNumberHandle = { open: () => void };
export const PicoNumberInput = forwardRef<
  PicoNumberHandle,
  {
    label: string;
    value: string;
    onCommit: (value: string) => Promise<void> | void;
    onClose?: () => void;
    startOpen?: boolean;
    placeholder?: string;
    invalid?: boolean;
    describedBy?: string;
  }
>(
  (
    { label, value, onCommit, onClose, startOpen = false, placeholder, invalid, describedBy },
    ref,
  ) => {
    const [open, setOpen] = useState(startOpen);
    const [draft, setDraft] = useState(value);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const input = useRef<HTMLInputElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const saving = useRef(false);
    const commit = useRef(onCommit);
    const initial = useRef(value);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const begin = () => {
      if (open || saving.current) return;
      commit.current = onCommit;
      initial.current = value;
      setDraft(value);
      setError('');
      setOpen(true);
    };
    useImperativeHandle(ref, () => ({ open: begin }));
    async function save() {
      if (saving.current) return;
      const raw = draftRef.current;
      const number = Number(raw.replace(',', '.'));
      if (raw !== '' && (!Number.isFinite(number) || number < 0 || number > 1_000_000)) {
        setError('Введите сумму от 0 до 1 000 000 млн ₽');
        return;
      }
      saving.current = true;
      setBusy(true);
      setError('');
      try {
        if (raw !== initial.current) await commit.current(raw.replace(',', '.'));
        input.current?.blur();
        setOpen(false);
        onClose?.();
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        saving.current = false;
        setBusy(false);
      }
    }
    const saveRef = useRef(save);
    saveRef.current = save;
    useLayoutEffect(() => {
      if (!open) return;
      const field = input.current;
      if (!field) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }, [open]);
    useEffect(() => {
      if (!open) return;
      document.documentElement.dataset.picoNumberOpen = 'true';
      const measure = () =>
        document.documentElement.style.setProperty(
          '--pico-number-height',
          `${panel.current?.offsetHeight || 360}px`,
        );
      measure();
      const observer = new ResizeObserver(measure);
      if (panel.current) observer.observe(panel.current);
      const outside = (event: MouseEvent) => {
        const target = event.target as Node;
        if (input.current?.contains(target) || panel.current?.contains(target)) return;
        event.preventDefault();
        event.stopPropagation();
        void saveRef.current();
      };
      const outsidePointer = (event: PointerEvent) => {
        if (
          input.current?.contains(event.target as Node) ||
          panel.current?.contains(event.target as Node)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
      };
      const escape = (event: KeyboardEvent) => {
        if (event.key === 'Tab') {
          event.preventDefault();
          event.stopImmediatePropagation();
          void saveRef.current();
          return;
        }
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!saving.current) {
          input.current?.blur();
          setOpen(false);
          onClose?.();
        }
      };
      document.addEventListener('pointerdown', outsidePointer, true);
      document.addEventListener('keydown', escape, true);
      document.addEventListener('click', outside, true);
      const frame = requestAnimationFrame(() => {
        const field = input.current;
        if (!field) return;
        const bounds =
          field.closest('.cc-equipment')?.getBoundingClientRect() || field.getBoundingClientRect();
        const top = panel.current?.getBoundingClientRect().top || innerHeight;
        if (bounds.bottom > top - 12) {
          const delta = bounds.bottom - top + 12;
          let parent = field.parentElement;
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
        }
      });
      return () => {
        cancelAnimationFrame(frame);
        document.removeEventListener('click', outside, true);
        document.removeEventListener('pointerdown', outsidePointer, true);
        document.removeEventListener('keydown', escape, true);
        observer.disconnect();
        delete document.documentElement.dataset.picoNumberOpen;
        document.documentElement.style.removeProperty('--pico-number-height');
      };
    }, [open]);
    function key(value: string) {
      if (saving.current) return;
      setError('');
      setDraft((current) =>
        value === 'erase'
          ? current.slice(0, -1)
          : value === ',' && /[,.]/.test(current)
            ? current
            : current + value,
      );
      requestAnimationFrame(() => {
        input.current?.focus({ preventScroll: true });
        input.current?.setSelectionRange(input.current.value.length, input.current.value.length);
      });
    }
    return (
      <>
        <input
          ref={input}
          aria-label={label}
          aria-invalid={invalid || !!error}
          aria-describedby={describedBy}
          placeholder={placeholder}
          inputMode="none"
          enterKeyHint="done"
          readOnly={!open || busy}
          value={open ? draft : value}
          className="pico-number-input"
          style={{ width: `${Math.max(1, (open ? draft : value).length) + 0.5}ch` }}
          onPointerDown={(event) => {
            if (!open) event.preventDefault();
          }}
          onClick={begin}
          onFocus={begin}
          onChange={(event) => {
            setDraft(event.target.value);
            setError('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
          }}
        />
        {open &&
          createPortal(
            <div
              ref={panel}
              className="pico-number-keypad"
              role="region"
              aria-label="Клавиатура Pico"
              aria-busy={busy}
            >
              <div className="pico-number-handle" />
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="pico-number-keys">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'erase'].map((digit) => (
                  <button
                    type="button"
                    key={digit}
                    disabled={busy}
                    aria-label={digit === ',' ? 'Запятая' : digit === 'erase' ? 'Стереть' : digit}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => key(digit)}
                  >
                    {digit === 'erase' ? <Icon name="close" size={22} /> : digit}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="pico-number-done"
                disabled={busy}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void save()}
              >
                {busy ? 'Сохранение…' : 'Готово'}
              </button>
            </div>,
            input.current?.closest('[role="dialog"]') || document.body,
          )}
      </>
    );
  },
);
