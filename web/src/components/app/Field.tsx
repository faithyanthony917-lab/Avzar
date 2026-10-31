import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
}

export function Field({ id, label, value, onChange, error, hint, ...rest }: Props) {
  const describedBy = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ap-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
      {hint && <p id={`${id}-hint`} className="ap-hint">{hint}</p>}
      {error && <p id={`${id}-err`} className="ap-err">{error}</p>}
    </div>
  );
}

interface AreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
}

export function TextAreaField({ id, label, value, onChange, error, hint, ...rest }: AreaProps) {
  const describedBy = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ap-field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} name={id} rows={4} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
      {hint && <p id={`${id}-hint`} className="ap-hint">{hint}</p>}
      {error && <p id={`${id}-err`} className="ap-err">{error}</p>}
    </div>
  );
}

interface SelectProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  error?: string;
}

export function SelectField({ id, label, value, onChange, options, error }: SelectProps) {
  return (
    <div className="ap-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error && <p id={`${id}-err`} className="ap-err">{error}</p>}
    </div>
  );
}
