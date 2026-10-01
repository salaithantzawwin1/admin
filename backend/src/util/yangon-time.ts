/**
 * Yangon wall-clock formatting that is safe on ANY host timezone.
 *
 * Why this exists: toLocaleString() WITHOUT an explicit timeZone option follows
 * the SERVER's zone. Production's container runs Asia/Yangon, so the bug was
 * invisible there — but the UTC CI runner rendered UTC times and failed the
 * approval-card suite (caught by the first CI run, commit c03da1b).
 *
 * The trick (Myanmar = UTC+06:30, no DST, so the offset never changes):
 * pre-shift the instant +6.5h, then read it back with the UTC getters —
 * getUTCHours() now returns the Yangon wall clock on every host.
 *
 * Use these everywhere Telegram/notification strings show a trip window or a
 * stamp. Never call toLocaleString/toLocaleTimeString without an explicit
 * timeZone in backend code.
 */

/** Myanmar's fixed offset (UTC+06:30) in ms — no DST, never changes. */
export const YANGON_OFFSET_MS = 6.5 * 60 * 60 * 1000;

const p2 = (n: number) => String(n).padStart(2, '0');

/** Yangon "now" as a pre-shifted instant ready for the UTC getters below. */
export function yangonNow(): Date {
  return new Date(Date.now() + YANGON_OFFSET_MS);
}

/** "29/9 14:30" — compact d/m + HH:mm (approval cards, schedule lines, stamps). */
export function yangonShort(d: Date): string {
  const s = new Date(new Date(d).getTime() + YANGON_OFFSET_MS);
  return `${s.getUTCDate()}/${s.getUTCMonth() + 1} ${p2(s.getUTCHours())}:${p2(s.getUTCMinutes())}`;
}

/** "29/09 14:30" — same, but zero-padded day+month (list columns). */
export function yangonShortPadded(d: Date): string {
  const s = new Date(new Date(d).getTime() + YANGON_OFFSET_MS);
  return `${p2(s.getUTCDate())}/${p2(s.getUTCMonth() + 1)} ${p2(s.getUTCHours())}:${p2(s.getUTCMinutes())}`;
}

/** "29/9" — the date part of yangonShort (draft prefill prefixes). */
export function yangonDayOnly(d: Date): string {
  const s = new Date(new Date(d).getTime() + YANGON_OFFSET_MS);
  return `${s.getUTCDate()}/${s.getUTCMonth() + 1}`;
}

/** "14:30" — clock only (action stamps, digest lines). */
export function yangonClock(d: Date): string {
  const s = new Date(new Date(d).getTime() + YANGON_OFFSET_MS);
  return `${p2(s.getUTCHours())}:${p2(s.getUTCMinutes())}`;
}
