import { useState } from 'react';

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

/** How a day reads in an aria label: "12 Nov 2026". */
const spoken = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
};

/**
 * Month view of when notices go live and when they expire. The list answers
 * "what is there"; this answers "what lands next week" — scheduled drafts show
 * up before they reach anyone, and an expiry date is visible as its own event.
 *
 * A day holds two events before it truncates: "+N more" opens that day in place
 * instead of pointing at nothing, so a busy day is still readable.
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
  const [expanded, setExpanded] = useState<string | null>(null);
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
  // Same day: what goes out first, then what runs out, each by title.
  for (const [key, list] of byDay) {
    byDay.set(
      key,
      list.sort((x, y) =>
        x.kind === y.kind ? x.a.title.localeCompare(y.a.title) : x.kind === 'live' ? -1 : 1,
      ),
    );
  }

  const monthPrefix = `${cursor.y}-${pad(cursor.m + 1)}`;
  const liveCount = items.filter((a) => dayKey(a.publishAt)?.startsWith(monthPrefix)).length;
  const endCount = items.filter((a) => dayKey(a.endAt)?.startsWith(monthPrefix)).length;

  const go = (delta: number) => {
    const m = cursor.m + delta;
    setCursor({ y: cursor.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 });
    setExpanded(null);
  };
  const goToday = () => {
    setCursor({ y: now.getFullYear(), m: now.getMonth() });
    setExpanded(null);
  };

  const monthLabel = `${MONTHS[cursor.m]} ${cursor.y}`;
  const countText =
    liveCount + endCount === 0
      ? 'nothing scheduled'
      : [liveCount ? `${liveCount} going out` : '', endCount ? `${endCount} expiring` : '']
          .filter(Boolean)
          .join(' · ');
  const isThisMonth = cursor.y === now.getFullYear() && cursor.m === now.getMonth();

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-gray-100 px-3 py-2.5">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-lg leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            onClick={() => go(-1)}
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-lg leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            onClick={() => go(1)}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
        <div className="text-sm font-semibold text-gray-800">{monthLabel}</div>
        <span
          aria-live="polite"
          className={`text-xs ${liveCount + endCount === 0 ? 'text-gray-400' : 'text-gray-500'}`}
        >
          {countText}
        </span>
        {isThisMonth ? (
          <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">this month</span>
        ) : (
          <button
            type="button"
            className="ml-auto rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            onClick={goToday}
          >
            Today
          </button>
        )}
      </div>

      <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50/70 text-[10px] font-medium uppercase tracking-wide text-gray-400 sm:text-[11px]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-1 py-1.5 text-center sm:px-2">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const key = day ? `${monthPrefix}-${pad(day)}` : '';
          const events = day ? (byDay.get(key) ?? []) : [];
          const isToday = key === todayKey;
          const open = expanded === key;
          const col = (leading + (day ?? 1) - 1) % 7;
          const weekend = day != null && col >= 5;
          const shown = open ? events : events.slice(0, 2);
          return (
            <div
              key={i}
              className={`min-h-[4.5rem] border-b border-r border-gray-100 p-1 last:border-r-0 sm:min-h-[5.75rem] sm:p-1.5 [&:nth-child(7n)]:border-r-0 ${
                day ? (weekend ? 'bg-gray-50/40' : '') : 'bg-gray-50/60'
              } ${isToday ? 'bg-blue-50/60' : ''}`}
            >
              {day && (
                <>
                  <div className="mb-1 flex items-center">
                    <span
                      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-medium ${
                        isToday ? 'bg-blue-600 text-white' : 'text-gray-500'
                      }`}
                    >
                      {day}
                    </span>
                    {isToday && <span className="ml-1 hidden text-[10px] font-medium text-blue-700 sm:inline">today</span>}
                  </div>
                  <div className="space-y-0.5">
                    {shown.map((e, j) => {
                      const what = e.kind === 'end' ? 'Expires' : 'Goes out';
                      return (
                        <button
                          key={`${e.a.id}-${e.kind}-${j}`}
                          type="button"
                          onClick={() => onOpen(e.a)}
                          title={`${what} — ${e.a.title}`}
                          aria-label={`${what} ${spoken(key)}: ${e.a.title}`}
                          className={`block w-full truncate rounded border px-1 py-0.5 text-left text-[10px] leading-tight transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                            e.kind === 'end'
                              ? 'border-gray-200 bg-gray-50 text-gray-500'
                              : (CHIP[e.a.priority] ?? CHIP.NORMAL)
                          } ${e.a.status === 'DRAFT' ? 'border-dashed' : ''}`}
                        >
                          {e.kind === 'end' ? '⏳ ' : ''}
                          {e.a.title}
                        </button>
                      );
                    })}
                    {events.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : key)}
                        aria-expanded={open}
                        title={events
                          .slice(2)
                          .map((e) => `${e.kind === 'end' ? 'Expires' : 'Goes out'}: ${e.a.title}`)
                          .join('\n')}
                        className="block w-full rounded px-1 text-left text-[10px] font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        {open ? '× show less' : `+${events.length - 2} more`}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[11px] text-gray-400">
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
          {items.length === 0
            ? 'No notice in the list'
            : `${items.length} notice${items.length === 1 ? '' : 's'} in view`}
        </span>
      </div>
    </div>
  );
}
