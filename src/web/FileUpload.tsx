import { InputHTMLAttributes, useState } from 'react';

export function FileUpload({
  label,
  onChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string }) {
  const [filename, setFilename] = useState('');
  return (
    <span className="pico-file-picker">
      <span className="pico-file-picker-button">
        Выбрать файл
        <input
          {...props}
          type="file"
          aria-label={label}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) setFilename(file.name);
            onChange?.(event);
          }}
        />
      </span>
      <span className="pico-file-picker-name" aria-live="polite">
        {filename || 'Файл не выбран'}
      </span>
    </span>
  );
}
