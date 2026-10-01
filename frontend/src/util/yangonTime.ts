/**
 * Yangon wall-clock formatting for the web UI — ONE formatter for every page.
 *
 * Why: bare `toLocaleString()` renders in the BROWSER's timezone. Every user of
 * this office runs Asia/Yangon, but a laptop set to UTC (or a different zone)
 * silently shows the wrong times for trip windows, schedules and audit stamps.
 * Anchoring the office wall clock on the backend (Telegram cards, notifications)
 * and the frontend on the same Yangon zone keeps every surface consistent.
 *
 * Replaces the bare toLocaleString / toLocaleDateString / toLocaleTimeString
 * call sites across pages and components. Number formatting (money, mileage)
 * and the meeting calendar's deliberate date-only UTC helpers are out of scope.
 */

const YANGON_TZ = 'Asia/Yangon';
type D = string | number | Date | null | undefined;

const formatter = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: YANGON_TZ, ...opts });

const fDateTime = formatter({ dateStyle: 'medium', timeStyle: 'medium' }); // 2 Oct 2026, 09:00:30
const fDate = formatter({ year: 'numeric', month: 'short', day: 'numeric' }); // 2 Oct 2026
const fTime = formatter({ hour: '2-digit', minute: '2-digit', hour12: false }); // 09:00
const fShort = formatter({ day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** "2 Oct 2026, 09:00:30" — schedule windows, audit/assignment stamps. */
export function fmtDateTime(v: D): string {
  return v ? fDateTime.format(new Date(v)) : '—';
}

/** "2 Oct 2026" — table date columns, relTime fallbacks. */
export function fmtDate(v: D): string {
  return v ? fDate.format(new Date(v)) : '—';
}

/** "09:00" — 24h office clock. */
export function fmtTime(v: D): string {
  return v ? fTime.format(new Date(v)) : '—';
}

/** "2/10 09:00" — compact d/m + HH:mm, matching the Telegram cards. */
export function fmtShort(v: D): string {
  if (!v) return '—';
  const parts = Object.fromEntries(fShort.formatToParts(new Date(v)).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}
