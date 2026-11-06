import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { PicoNumberHandle, PicoNumberInput } from './PicoNumberInput';

export const InlineAmount = forwardRef<
  PicoNumberHandle,
  {
    label: string;
    value: string;
    unit: string;
    onSave: (value: string) => Promise<void>;
  }
>(({ label, value, unit, onSave }, ref) => {
  const [editing, setEditing] = useState(false);
  const session = useRef(onSave);
  const begin = () => {
    if (editing) return;
    session.current = onSave;
    setEditing(true);
  };
  useImperativeHandle(ref, () => ({ open: begin }));
  return (
    <div className="cc-amount-group">
      <div className={`cc-equipment ${editing ? 'cc-equipment-editing' : ''}`} onClick={begin}>
        <span className="cc-amount-label">{label}</span>
        {editing ? (
          <div className="cc-amount-editor">
            <PicoNumberInput
              label={label}
              value={value}
              startOpen
              onCommit={(raw) => session.current(raw)}
              onClose={() => setEditing(false)}
            />
            <small>{unit}</small>
          </div>
        ) : (
          <button type="button" className="cc-amount-value" aria-label={`Изменить ${label}`}>
            <span>{value}</span>
            <small>{unit}</small>
          </button>
        )}
      </div>
    </div>
  );
});
