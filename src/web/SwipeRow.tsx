import { CSSProperties, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icons';

/** A gesture reveals controls; only an explicit button click performs an action. */
export function SwipeRow({
  children,
  label,
  className = '',
  onEdit,
  onDelete,
  disabled = false,
}: {
  children: ReactNode;
  label: string;
  className?: string;
  onEdit?: () => void;
  onDelete?: () => void;
  disabled?: boolean;
}) {
  const id = useId(),
    root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [offset, setOffset] = useState<number | null>(null),
    [railTop, setRailTop] = useState<number | undefined>();
  const width = (Number(!!onEdit) + Number(!!onDelete)) * 56;
  const gesture = useRef<{
    x: number;
    y: number;
    base: number;
    horizontal: boolean;
    vertical: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  function reveal(value: boolean) {
    if (value) window.dispatchEvent(new CustomEvent('pico-swipe-open', { detail: id }));
    setOpen(value);
    setOffset(null);
  }
  useEffect(() => {
    function other(event: Event) {
      if ((event as CustomEvent).detail !== id) {
        setOpen(false);
        setOffset(null);
      }
    }
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        setOffset(null);
      }
    }
    window.addEventListener('pico-swipe-open', other);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pico-swipe-open', other);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [id]);
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = root.current?.getBoundingClientRect();
        if (!rect) return;
        const nav = document.querySelector('.pico-bottom-nav')?.getBoundingClientRect();
        const bottom = Math.min(rect.bottom, nav?.top || window.innerHeight);
        const top = Math.max(rect.top, 0);
        setRailTop(Math.max(28, Math.min(rect.height - 28, (top + bottom) / 2 - rect.top)));
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const observer = new ResizeObserver(place);
    if (root.current) observer.observe(root.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);
  return (
    <div
      ref={root}
      className={'client-swipe ' + className + (open ? ' swipe-open' : '')}
      style={{ '--swipe-width': `${width}px` } as CSSProperties}
    >
      <div className="client-swipe-actions" style={{ top: railTop }} aria-hidden={!open}>
        {onEdit && (
          <button
            type="button"
            aria-label={'Редактировать ' + label}
            disabled={!open || disabled}
            tabIndex={open ? 0 : -1}
            onClick={() => {
              reveal(false);
              onEdit();
            }}
          >
            <Icon name="edit" size={22} />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            aria-label={'Убрать ' + label}
            disabled={!open || disabled}
            tabIndex={open ? 0 : -1}
            onClick={() => {
              reveal(false);
              onDelete();
            }}
          >
            <Icon name="trash" size={22} />
          </button>
        )}
      </div>
      <div
        className="client-swipe-surface"
        style={{
          transform: `translateX(${offset ?? (open ? -width : 0)}px)`,
          transition: offset !== null ? 'none' : undefined,
        }}
        onPointerDown={(e) => {
          if (
            disabled ||
            e.button !== 0 ||
            (e.target as HTMLElement).closest('input,textarea,select,a')
          )
            return;
          e.stopPropagation();
          suppressClick.current = false;
          gesture.current = {
            x: e.clientX,
            y: e.clientY,
            base: open ? -width : 0,
            horizontal: false,
            vertical: false,
          };
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g || g.vertical) return;
          const dx = e.clientX - g.x,
            dy = e.clientY - g.y;
          if (!g.horizontal && Math.max(Math.abs(dx), Math.abs(dy)) > 10) {
            if (Math.abs(dy) >= Math.abs(dx)) {
              g.vertical = true;
              return;
            }
            g.horizontal = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          if (g.horizontal) {
            e.stopPropagation();
            suppressClick.current = true;
            setOffset(Math.max(-width, Math.min(0, g.base + dx)));
          }
        }}
        onPointerUp={(e) => {
          const g = gesture.current;
          gesture.current = null;
          if (g?.horizontal) {
            e.stopPropagation();
            reveal(g.base + e.clientX - g.x < -width / 3);
          }
        }}
        onPointerCancel={() => {
          gesture.current = null;
          setOffset(null);
        }}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.preventDefault();
            e.stopPropagation();
            suppressClick.current = false;
          } else if (open) {
            e.preventDefault();
            e.stopPropagation();
            reveal(false);
          }
        }}
      >
        {children}
        {width > 0 && (
          <button
            type="button"
            className="client-swipe-toggle"
            aria-label={'Действия: ' + label}
            aria-expanded={open}
            disabled={disabled}
            onClick={() => reveal(!open)}
          >
            <Icon name="more" size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
