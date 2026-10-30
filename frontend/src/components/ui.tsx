import { ReactNode, useEffect, useId, useRef, useState } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-lg sm:text-xl font-bold text-gray-900 tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  // overflow-x-auto: wide tables scroll inside the card on small screens
  return <div className={`bg-white rounded-xl border border-gray-200/80 shadow-card overflow-x-auto ${className}`}>{children}</div>;
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  /** native tooltip (hover hint, e.g. on icon-only buttons) */
  title?: string;
}) {
  const styles = {
    primary: 'bg-gold text-gray-900 hover:bg-gold-light shadow-sm',
    ghost: 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
    // soft red outline: destructive actions stay recognisably red but
    // harmonise with the light/gold theme (solid red felt heavy)
    danger: 'border border-red-300 bg-red-50 text-red-700 hover:bg-red-100',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${styles}`}
    >
      {children}
    </button>
  );
}

// Shared field chrome for Input/Textarea/Select: identical radius, typography
// and focus treatment everywhere. `invalid` switches border + focus ring to a
// subtle error-red; `error` additionally shows the reason as a small message
// under the field and links it via aria-describedby (invalid is implied).
// Fields are always wrapped in a plain <div> so toggling an error never
// remounts the control (keeps focus while typing); width utilities like !w-64
// still land on the control itself.
function fieldCls(invalid: boolean | undefined, size: string, className?: string) {
  return [
    size,
    'rounded-lg text-sm bg-white text-gray-800 placeholder:text-gray-400 focus:outline-none transition-shadow',
    invalid
      ? 'border border-red-300 focus:ring-2 focus:ring-red-300/60 focus:border-red-400'
      : 'border border-gray-300 focus:ring-2 focus:ring-gold/60 focus:border-gold',
    className ?? '',
  ].join(' ');
}

function fieldErrorId(fieldId: string) {
  return `${fieldId}-error`;
}

function fieldHintId(fieldId: string) {
  return `${fieldId}-hint`;
}

export function Input({ invalid, error, describe, className, id, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; error?: string; describe?: string }) {
  const autoId = useId(); // always called — hooks must not be conditional
  const fieldId = id ?? autoId;
  const describedBy = [props['aria-describedby'], error ? fieldErrorId(fieldId) : undefined, describe ? fieldHintId(fieldId) : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <input
        {...props}
        id={fieldId}
        aria-invalid={(invalid || !!error) || undefined}
        aria-describedby={describedBy}
        className={fieldCls(invalid || !!error, 'w-full h-10 px-3 py-2', className)}
      />
      {error && <p id={fieldErrorId(fieldId)} className="mt-1 text-xs text-red-600">{error}</p>}
      {describe && <p id={fieldHintId(fieldId)} className="mt-1 text-xs text-gray-400">{describe}</p>}
    </div>
  );
}

/**
 * Number field that never snaps back mid-edit.
 *
 * A plain `type="number"` bound to a numeric state was painful everywhere: on a
 * phone clearing it re-rendered the old value immediately (so "1" could not be
 * replaced by "12"), and on desktop the existing digit had to be selected
 * before typing or the new digit was appended to it.
 *
 * Fix: the DOM value is a text draft. Empty is legal while typing and nothing is
 * pushed to the caller until it parses; blur normalises (clamp to min/max,
 * integer rounding, min as the empty fallback) and focus selects the old value
 * so typing replaces it. `onChange` always receives a real number, so existing
 * numeric state keeps working unchanged.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  integer = false,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'> & {
  value: number | null | undefined;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  /** whole numbers only (counts, capacities) — decimals stay allowed otherwise */
  integer?: boolean;
}) {
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
  const editing = useRef(false);
  useEffect(() => {
    // external writes (steppers, API reload) win — but never while the user is
    // typing, or the box would be rewritten under their cursor
    if (!editing.current) setDraft(value === null || value === undefined ? '' : String(value));
  }, [value]);
  const clamp = (n: number) => {
    let v = integer ? Math.round(n) : n;
    if (min !== undefined && v < min) v = min;
    if (max !== undefined && v > max) v = max;
    return v;
  };
  return (
    <div>
      <input
        {...props}
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        autoComplete="off"
        value={draft}
        onFocus={(e) => {
          editing.current = true;
          e.currentTarget.select();
          props.onFocus?.(e);
        }}
        onChange={(e) => {
          const raw = e.target.value.replace(integer ? /[^0-9]/g : /[^0-9.]/g, '');
          setDraft(raw);
          // "" and a lone "." are intermediate states — pushing a number here is
          // exactly what used to snap the field back to its previous value
          if (raw === '' || raw === '.') return;
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(clamp(n));
        }}
        onBlur={(e) => {
          editing.current = false;
          const n = Number(draft);
          const v = draft === '' || !Number.isFinite(n) ? (min ?? 0) : clamp(n);
          setDraft(String(v));
          onChange(v);
          props.onBlur?.(e);
        }}
        className={fieldCls(undefined, 'w-full h-10 px-3 py-2', className)}
      />
    </div>
  );
}

export function Textarea({ invalid, error, describe, className, id, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; error?: string; describe?: string }) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const describedBy = [props['aria-describedby'], error ? fieldErrorId(fieldId) : undefined, describe ? fieldHintId(fieldId) : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <textarea
        {...props}
        id={fieldId}
        aria-invalid={(invalid || !!error) || undefined}
        aria-describedby={describedBy}
        className={fieldCls(invalid || !!error, 'w-full px-3 py-2', className)}
      />
      {error && <p id={fieldErrorId(fieldId)} className="mt-1 text-xs text-red-600">{error}</p>}
      {describe && <p id={fieldHintId(fieldId)} className="mt-1 text-xs text-gray-400">{describe}</p>}
    </div>
  );
}

export function Select({ invalid, error, describe, className, id, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean; error?: string; describe?: string }) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const describedBy = [props['aria-describedby'], error ? fieldErrorId(fieldId) : undefined, describe ? fieldHintId(fieldId) : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <select
        {...props}
        id={fieldId}
        aria-invalid={(invalid || !!error) || undefined}
        aria-describedby={describedBy}
        // multi-select boxes size themselves (caller passes h-28 etc.); single ones stay h-10
        className={fieldCls(invalid || !!error, `w-full ${props.multiple ? '' : 'h-10'} px-3 py-2`, className)}
      />
      {error && <p id={fieldErrorId(fieldId)} className="mt-1 text-xs text-red-600">{error}</p>}
      {describe && <p id={fieldHintId(fieldId)} className="mt-1 text-xs text-gray-400">{describe}</p>}
    </div>
  );
}

export function Badge({ children, color = 'gray', title }: { children: ReactNode; color?: 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'orange' | 'teal'; title?: string }) {
  const styles = {
    gray: 'bg-gray-100 text-gray-700 ring-1 ring-inset ring-gray-200',
    green: 'bg-green-50 text-green-700 ring-1 ring-inset ring-green-200',
    red: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200',
    blue: 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200',
    yellow: 'bg-yellow-50 text-yellow-800 ring-1 ring-inset ring-yellow-200',
    orange: 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200',
    // COMPLETED = teal: finished-but-green collided with APPROVED (green),
    // so the two states looked identical in every list
    teal: 'bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-200',
  }[color];
  return <span title={title} className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${styles}`}>{children}</span>;
}

export function statusColor(status: string): 'green' | 'red' | 'gray' {
  if (status === 'ACTIVE') return 'green';
  if (status === 'DISABLED' || status === 'INACTIVE' || status === 'LOCKED') return 'red';
  return 'gray';
}

/** Columns whose content is a badge or a button group — rendered centred. */
const CENTERED_COLS = new Set(['STATUS', 'ACTIONS']);

/** Numeric (money/quantity) columns — values are right-aligned with
 *  tabular-nums, so the header must match or the column reads as ragged. */
const RIGHT_COLS = new Set(['COST (MMK)', 'AMOUNT (MMK)', 'TOTAL', 'PAID', 'BALANCE', 'USED BY']);

/** `className` reaches the <table> itself — e.g. `!min-w-0` opts a short table
 *  out of the global mobile min-width:640px scroll rule in index.css. */
export function Table({ head, children, className = '' }: { head: string[]; children: ReactNode; className?: string }) {
  return (
    <Card>
      <table className={`w-full text-sm ${className}`}>
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wider bg-gray-50/70">
            {head.map((h) => (
              // STATUS badges and ACTIONS buttons are centred so a short pill / small
              // button group doesn't sit flush against the left edge of a wide column.
              <th key={h} className={`px-4 py-3 font-semibold first:pl-5 last:pr-5 ${CENTERED_COLS.has(h.trim().toUpperCase()) ? 'text-center' : RIGHT_COLS.has(h.trim().toUpperCase()) ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">{children}</tbody>
      </table>
    </Card>
  );
}

export function Empty({ label = 'No data' }: { label?: string }) {
  return <div className="text-center text-sm text-gray-400 py-10">{label}</div>;
}

/** Route-level lazy-loading fallback — shown while a page chunk loads. */
export function PageLoader() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center" role="status" aria-label="Loading">
      <div className="w-8 h-8 rounded-full border-2 border-gold border-t-transparent animate-spin" />
    </div>
  );
}
