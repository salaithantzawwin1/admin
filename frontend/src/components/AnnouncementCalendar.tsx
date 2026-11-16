import { useState } from 'react';
import { fmtDate } from '../util/yangonTime';

/** The bits of an announcement the calendar draws (the admin list object). */
export interface CalendarAnnouncement {
  id: string;
  code: string;
  title: string;
  status: string;
  priority: string;
  publishAt: string | null;
  endAt: string | null;
}

const TZ = 'Asia/Yangon';
const pad = (n: number) => String(n).padStart(2, '0');
/** Yangon calendar day of a timestamp — the same anchor the list badges use. */
const dayKey = (v: string | null) =>
  v ? new Date(v).toLocaleDateString('en-CA', { timeZone: TZ }) : null;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type Event = { a: CalendarAnnouncement; kind: 'live' | 'end' };

const CHIP: Record<string, string> = {
  EMERGENCY: 'bg-red-100 text-red-700 border-red-200',
  URGENT: 'bg-orange-100 text-orange-700 border-orange-200',
  IMPORTANT: 'bg-amber-100 text-amber-800 border-amber-200',
  NORMAL: 'bg-blue-50 text-blue-700 border-blue-200',
};

/**
 * Month view of when notices go live and when they expire. The list answers
 * "what is there"; this answers "what lands next week" — scheduled drafts show
 * up before they reach anyone, and an expiry date is visible as its own event.
 */
export function AnnouncementCalendar({
  items,
  onOpen,
}: {
  items: CalendarAnnouncement[];
  onOpen: (a: CalendarAnnouncement) => void;
}) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const todayKey = now.toLocaleDateString('en-CA', { timeZone: TZ });

  const first = new Date(cursor.y, cursor.m, 1);
  const leading = (first.getDay() + 6) % 7; // Monday-first week
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const byDay = new Map<string, Event[]>();
  const push = (key: string | null, e: Event) => {
    if (!key) return;
    byDay.set(key, [...(byDay.get(key) ?? []), e]);
  };
  for (const a of items) {
    push(dayKey(a.publishAt), { a, kind: 'live' });
    push(dayKey(a.endAt), { a, kind: 'end' });
  }

  const shift = (delta: number) => {
    const m = cursor.m + delta;
    setCursor({ y: cursor.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 });
  };

  const monthCount = items.filter((a) => {
    const k = dayKey(a.publishAt);
    return k?.startsWith(`${cursor.y}-${pad(cursor.m + 1)}`);
  }).length;

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="h-7 w-7 rounded-lg text-gray-500 hover:bg-gray-100"
            onClick={() => shift(-1)}
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            className="h-7 w-7 rounded-lg text-gray-500 hover:bg-gray-100"
            onClick={() => shift(1)}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
        <div className="text-sm font-semibold text-gray-800">
          {MONTHS[cursor.m]} {cursor.y}
        </div>
        <span className="text-xs text-gray-400">
          {monthCount === 0 ? 'nothing scheduled' : `${monthCount} notice${monthCount === 1 ? '' : 's'} going out`}
        </span>
        <button
          type="button"
          className="ml-auto rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
          onClick={() => setCursor({ y: now.getFullYear(), m: now.getMonth() })}
        >
          Today
        </button>
      </div>

      <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50/60 text-[11px] font-medium uppercase tracking-wide text-gray-400">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-center">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const key = day ? `${cursor.y}-${pad(cursor.m + 1)}-${pad(day)}` : '';
          const events = day ? (byDay.get(key) ?? []) : [];
          return (
            <div
              key={i}
              className={`min-h-[5.5rem] border-b border-r border-gray-100 p-1 ${day ? '' : 'bg-gray-50/40'} ${
                key === todayKey ? 'bg-blue-50/40' : ''
              }`}
            >
              {day && (
                <>
                  <div
                    className={`mb-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-medium ${
                      key === todayKey ? 'bg-blue-600 text-white' : 'text-gray-500'
                    }`}
                  >
                    {day}
                  </div>
                  <div className="space-y-0.5">
                    {events.slice(0, 2).map((e, j) => (
                      <button
                        key={`${e.a.id}-${e.kind}-${j}`}
                        type="button"
                        onClick={() => onOpen(e.a)}
                        title={`${e.kind === 'end' ? 'Expires' : 'Goes out'} — ${e.a.title}`}
                        className={`block w-full truncate rounded border px-1 py-0.5 text-left text-[10px] leading-tight ${
                          e.kind === 'end'
                            ? 'border-gray-200 bg-gray-50 text-gray-500'
                            : (CHIP[e.a.priority] ?? CHIP.NORMAL)
                        } ${e.a.status === 'DRAFT' ? 'border-dashed' : ''}`}
                      >
                        {e.kind === 'end' ? '⏳ ' : ''}
                        {e.a.title}
                      </button>
                    ))}
                    {events.length > 2 && (
                      <div className="pl-1 text-[10px] text-gray-400">+{events.length - 2} more</div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-[11px] text-gray-400">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-blue-500" /> goes out (publish date)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-gray-400" /> expires (end date)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm border border-dashed border-gray-400" /> draft — not live yet
        </span>
        <span className="ml-auto">
          {items.length === 0 ? 'No notice in the list' : `showing ${items.length} notice${items.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="sr-only">
        {items.length > 0 && `First notice in view: ${items[0].title}, published ${fmtDate(items[0].publishAt)}`}
      </div>
    </div>
  );
}
