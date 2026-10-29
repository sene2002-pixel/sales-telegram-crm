import { TextareaHTMLAttributes, useLayoutEffect, useRef } from 'react';

/** Wrap long values without hiding an internal vertical scrollbar. */
export function GrowingTextarea({
  singleLine = false,
  className = '',
  onChange,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { singleLine?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () => {
      if (!element.getClientRects().length) return;
      element.style.height = 'auto';
      const style = getComputedStyle(element);
      element.style.height = `${element.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
    };
    resize();
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width;
      if (next !== width) {
        width = next;
        resize();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.value]);
  return (
    <textarea
      {...props}
      ref={ref}
      rows={1}
      className={`pico-growing-textarea ${className}`}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (singleLine && event.key === 'Enter' && !event.nativeEvent.isComposing)
          event.preventDefault();
      }}
      onChange={(event) => {
        if (singleLine)
          event.currentTarget.value = event.currentTarget.value.replace(/[\r\n]+/g, ' ');
        onChange?.(event);
      }}
    />
  );
}
