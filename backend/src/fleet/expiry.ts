/**
 * VMS spec §6.3 — the ONE server-side expiry-status calculation, shared by the
 * vehicle/driver lists, the document register, the dashboard feed and the daily
 * alert job (spec: "Use a single server-side status calculation shared by
 * dashboard, APIs, reports, and notifications").
 *
 * Extracted to a leaf module in Phase B so compliance checks can use it without
 * importing FleetService (which now depends on the compliance service).
 */

/** Business-local calendar date ('YYYY-MM-DD') in the organization timezone.
 *  Spec §6.3: browser/UTC-local time must never be the source of truth for
 *  expiry math — 'en-CA' formatting yields an ISO date part that compares
 *  lexicographically = chronologically. */
export const EXPIRY_TZ = 'Asia/Yangon';
export const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: EXPIRY_TZ }).format(d);

/** Warning thresholds (calendar days before expiry) — spec §6.4 defaults. */
export const EXPIRY_WARNING_DAYS = [30, 14, 7, 1] as const;

export type ExpiryStatus = 'EXPIRED' | 'DUE_TODAY' | 'UPCOMING' | 'VALID';

/** Single server-side status calculation. Returns null when no date is set
 *  (field-level NOT_CONFIGURED — the document types decide whether a missing
 *  document is a violation). */
export function expiryStatus(expiry: Date | null | undefined, now: Date = new Date()): ExpiryStatus | null {
  if (!expiry) return null;
  const today = ymd(now);
  const exp = ymd(expiry);
  if (exp < today) return 'EXPIRED';
  if (exp === today) return 'DUE_TODAY';
  return (Date.parse(exp) - Date.parse(today)) / 86_400_000 <= 30 ? 'UPCOMING' : 'VALID';
}

/** Whole business-local days until expiry: 0 = today, negative = overdue. */
export function daysUntilExpiry(expiry: Date, now: Date = new Date()): number {
  return Math.round((Date.parse(ymd(expiry)) - Date.parse(ymd(now))) / 86_400_000);
}
