import { useMemo } from 'react';

/**
 * Score a password 0–4 (length + variety). Deliberately simple and honest —
 * the same rules the backend enforces (min 8) plus common-sense variety.
 */
export function passwordScore(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
}

const LEVELS: { label: string; color: string }[] = [
  { label: 'Too weak', color: 'bg-red-500' },
  { label: 'Weak', color: 'bg-orange-500' },
  { label: 'Fair', color: 'bg-yellow-500' },
  { label: 'Good', color: 'bg-lime-600' },
  { label: 'Strong', color: 'bg-green-600' },
];

/** 4-segment strength bar + label, shown under a new-password input. */
export function PasswordStrength({ value, className = '' }: { value: string; className?: string }) {
  const score = useMemo(() => passwordScore(value), [value]);
  const level = LEVELS[score];

  return (
    <div className={`mt-1.5 ${className}`} aria-live="polite">
      <div className="flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${i < score ? level.color : 'bg-gray-200'}`}
          />
        ))}
      </div>
      <div className="text-xs text-gray-500 mt-0.5">
        {value ? (
          <>
            Strength: <span className="font-medium text-gray-700">{level.label}</span>
            {score < 2 && ' — use 8+ chars with mixed case, numbers and symbols'}
          </>
        ) : (
          'Use 8+ characters with mixed case, numbers and symbols'
        )}
      </div>
    </div>
  );
}
