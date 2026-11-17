import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/** Text input with a leading icon and label. */
export function Field({ icon: Icon, label, hint, right, className = '', ...props }) {
  const id = useId();
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>{label}</label>
      <div className="input-wrap">
        {Icon && <Icon size={18} className="input-icon" />}
        <input id={id} className={Icon ? 'has-icon' : ''} {...props} />
        {right}
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function PasswordField(props) {
  const [show, setShow] = useState(false);
  return (
    <Field
      {...props}
      type={show ? 'text' : 'password'}
      right={
        <button type="button" className="input-action" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      }
    />
  );
}

/** 0–4 password strength meter. */
export function strength(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}
