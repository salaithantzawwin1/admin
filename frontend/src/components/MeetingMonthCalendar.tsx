import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Button, Card } from './ui';

interface CalBooking {
  requestId: string;
  docNumber?: string;
  requester?: string;
  title: string;
  attendees: number;
  status: string;
  startTime: string;
  endTime: string;
}
interface CalRoom {
  id: string;
  name: string;
  location?: string;
  capacity: number;
  facilities?: string;
  status: string;
  bookings: CalBooking[];
}
interface MonthData {
  monthStart: string;
  monthEnd: string;
  rooms: CalRoom[];
}
export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}
export interface PrefillSlot {
  dateKey: string; // YYYY-MM-DD (Yangon)
  roomId: string;
  roomName?: string;
  startLocal: string; // datetime-local value
  endLocal: string;
}

const ROOM_STATUS: Record<string, 'green' | 'blue' | 'yellow' | 'red'> = {
  AVAILABLE: 'green',
  IN_USE: 'blue',
  UNDER_MAINTENANCE: 'yellow',
  OUT_OF_SERVICE: 'red',
};

// chip color by booking status — contrasts the live bookings against the room status
const BOOKING_CHIP: Record<string, string> = {
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800 hover:bg-amber-200',
  APPROVED: 'bg-green-100 text-green-800 hover:bg-green-200',
  IN_PROGRESS: 'bg-blue-100 text-blue-800 hover:bg-blue-200',
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_MS = 86_400_000;

// The office runs on Asia/Yangon (UTC+6:30, no DST) — Plan v3.0 §2 locale.
const TZ = 'Asia/Yangon';
function yangonParts(date: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute) };
}
function yangonDayKey(date: Date): string {
  const { y, m, d } = yangonParts(date);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** datetime-local value (Yangon wall clock) of an instant */
function yangonLocalInput(date: Date): string {
  const { y, m, d, hh, mm } = yangonParts(date);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
function timeLabel(iso: string): string {
  const { hh, mm } = yangonParts(new Date(iso));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
/** UTC instant of a Yangon wall-clock time (offset +06:30, no DST) */
function yangonToUtc(dateKey: string, hh: number, mm = 0): Date {
  return new Date(`${dateKey}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+06:30`);
}

/** bookings overlapping the given Yangon day (multi-day meetings appear on each day) */
function bookingsOn(room: CalRoom, dayKeyStr: string): CalBooking[] {
  const dayStart = yangonToUtc(dayKeyStr, 0).getTime();
  const dayEnd = dayStart + DAY_MS;
  return room.bookings.filter((b) => new Date(b.startTime).getTime() < dayEnd && new Date(b.endTime).getTime() > dayStart);
}

/**
 * Monthly availability calendar (Plan §7): days × rooms grid for one month,
 * Asia/Yangon working days. Weekends and public holidays are tinted and
 * named; clicking a free day opens the request form pre-filled for that
 * room/day. Cell chips are colored by booking status and the room column
 * carries its live status badge.
 */
export function MeetingMonthCalendar({ onBookSlot }: { onBookSlot?: (slot: PrefillSlot) => void }) {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth()); // 0-11
  const [data, setData] = useState<MonthData | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  // focus on one room ('' = all rooms)
  const [roomFilter, setRoomFilter] = useState('');
  const visibleRooms = useMemo(
    () => (data && roomFilter ? data.rooms.filter((r) => r.id === roomFilter) : data?.rooms) ?? [],
    [data, roomFilter],
  );

  const load = useCallback(() => {
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 1));
    api<MonthData>(`/meeting-rooms/availability/month?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load calendar'));
    api<Holiday[]>(`/settings/holidays/${year}`).then(setHolidays).catch(() => setHolidays([]));
  }, [year, month]);
  useEffect(load, [load]);

  const holidayMap = useMemo(() => Object.fromEntries(holidays.map((h) => [h.date, h.name])), [holidays]);

  const days = useMemo(() => {
    const first = new Date(Date.UTC(year, month, 1));
    const lead = (first.getUTCDay() + 6) % 7; // Monday-first grid
    const cells: { key: string; day: number; inMonth: boolean }[] = [];
    for (let i = 0; i < lead; i++) cells.push({ key: `lead-${i}`, day: 0, inMonth: false });
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (let d = 1; d <= daysInMonth; d++) cells.push({ key: `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, day: d, inMonth: true });
    return cells;
  }, [year, month]);

  const monthName = new Date(Date.UTC(year, month, 1)).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const todayKey = yangonDayKey(now);
  const isCurrentMonth = year === now.getUTCFullYear() && month === now.getUTCMonth();

  const prevMonth = () => (month === 0 ? (setYear(year - 1), setMonth(11)) : setMonth(month - 1));
  const nextMonth = () => (month === 11 ? (setYear(year + 1), setMonth(0)) : setMonth(month + 1));
  const thisMonth = () => {
    setYear(now.getUTCFullYear());
    setMonth(now.getUTCMonth());
  };

  /** weekend or public holiday — tinted in the grid */
  const nonWorkingDay = (key: string): 'weekend' | 'holiday' | null => {
    const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return holidayMap[key] ? 'holiday' : 'weekend';
    if (holidayMap[key]) return 'holiday';
    return null;
  };

  const clickCell = (key: string) => {
    const next = selected === key ? null : key;
    setSelected(next);
    if (!next || !onBookSlot || !data) return;
    // click-to-book: offer the first bookable room (AVAILABLE/IN_USE), prefill 09:00→10:00 Yangon
    const pool = visibleRooms.length > 0 ? visibleRooms : data.rooms;
    const room = pool.find((r) => r.status === 'AVAILABLE' || r.status === 'IN_USE') ?? pool[0];
    if (!room) return;
    onBookSlot({ dateKey: key, roomId: room.id, roomName: room.name, startLocal: yangonLocalInput(yangonToUtc(key, 9)), endLocal: yangonLocalInput(yangonToUtc(key, 10)) });
  };

  const selectedDayBookings = useMemo(() => {
    if (!data || !selected) return [];
    return visibleRooms.map((r) => ({ room: r, items: bookingsOn(r, selected) })).filter((x) => x.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selected, visibleRooms]);
  const selectedDayHoliday = selected ? holidayMap[selected] : undefined;

  return (
    <Card className="mb-5 p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">Monthly availability</h2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={prevMonth}>←</Button>
          <span className="text-sm font-medium text-gray-700 w-36 text-center">{monthName}</span>
          <Button variant="ghost" onClick={nextMonth}>→</Button>
          {!isCurrentMonth && <Button variant="ghost" onClick={thisMonth}>Today</Button>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <p className="text-xs text-gray-400">
          Times in Myanmar (Yangon). Chip color by request status:
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-200 mx-1 align-middle" /> pending
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-200 mx-1 align-middle" /> approved
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-200 mx-1 align-middle" /> in use.
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-orange-100 border border-orange-200 mx-1 ml-2 align-middle" /> weekend
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-100 border border-red-200 mx-1 align-middle" /> public holiday.
          Click a day to inspect — on a free day, the request form opens pre-filled.
        </p>
        <label className="flex items-center gap-2 text-xs text-gray-500 shrink-0">
          Room
          <select
            className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/60"
            value={roomFilter}
            onChange={(e) => setRoomFilter(e.target.value)}
          >
            <option value="">All rooms</option>
            {(data?.rooms ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
      </div>

      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {!data ? (
        <div className="text-sm text-gray-400 py-6 text-center">Loading calendar…</div>
      ) : data.rooms.length === 0 ? (
        <div className="text-sm text-gray-400 py-6 text-center">No meeting rooms configured yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="border-separate border-spacing-px">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-white min-w-[130px] text-left text-xs text-gray-500 uppercase tracking-wide px-2 pb-2">Room</th>
                {WEEKDAYS.map((w) => (
                  <th key={w} className="text-xs text-gray-500 uppercase tracking-wide px-1 pb-2">{w}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: Math.ceil(days.length / 7) }, (_, week) => (
                <tr key={week}>
                  {week === 0 && (
                    <td rowSpan={Math.ceil(days.length / 7)} className="sticky left-0 z-10 bg-white align-top pr-2">
                      <div className="flex flex-col gap-2">
                        {visibleRooms.map((r) => (
                          <div key={r.id} className="flex items-center gap-1.5 h-20">
                            <Badge color={ROOM_STATUS[r.status] ?? 'gray'}>{r.name}</Badge>
                          </div>
                        ))}
                        {visibleRooms.length === 0 && <span className="text-xs text-gray-400">—</span>}
                      </div>
                    </td>
                  )}
                  {days.slice(week * 7, week * 7 + 7).map((c) => {
                    if (!c.inMonth) return <td key={c.key} className="min-w-[92px] h-20 bg-gray-50 rounded" />;
                    const nwd = nonWorkingDay(c.key);
                    const cellBg =
                      c.key === todayKey ? 'bg-yellow-50' : nwd === 'holiday' ? 'bg-red-50' : nwd === 'weekend' ? 'bg-orange-50' : 'bg-white';
                    return (
                      <td
                        key={c.key}
                        title={nwd === 'holiday' ? `Public holiday — ${holidayMap[c.key]}` : nwd === 'weekend' ? 'Weekend' : undefined}
                        className={`min-w-[92px] h-20 align-top border rounded cursor-pointer ${
                          selected === c.key ? 'border-blue-400 ring-1 ring-blue-300' : 'border-gray-200'
                        } ${cellBg} hover:bg-gray-50`}
                        onClick={() => clickCell(c.key)}
                      >
                        <div className="text-[10px] leading-none px-1 pt-0.5 flex items-center justify-between">
                          <span className={nwd ? (nwd === 'holiday' ? 'text-red-500 font-semibold' : 'text-orange-500 font-semibold') : 'text-gray-400'}>
                            {c.day}
                          </span>
                          {c.key === todayKey && <span className="text-yellow-600 font-semibold">•</span>}
                        </div>
                        {nwd === 'holiday' && (
                          <div className="text-[9px] text-red-500 px-1 pt-0.5 leading-tight truncate" title={holidayMap[c.key]}>
                            {holidayMap[c.key]}
                          </div>
                        )}
                        <div className="px-1 pt-1 space-y-0.5">
                          {visibleRooms.flatMap((r) =>
                            bookingsOn(r, c.key)
                              .slice(0, 2)
                              .map((b) => (
                                <div
                                  key={r.id + b.requestId}
                                  className={`truncate text-[10px] leading-tight rounded px-1 py-0.5 ${BOOKING_CHIP[b.status] ?? 'bg-gray-100 text-gray-600'}`}
                                  title={`${r.name} — ${b.title ?? b.docNumber} ${timeLabel(b.startTime)}→${timeLabel(b.endTime)}`}
                                >
                                  {timeLabel(b.startTime)} {b.docNumber ?? b.title}
                                </div>
                              )),
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && data && (
        <div className="border-t border-gray-100 pt-3 mt-3">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">
            {new Date(`${selected}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}
          </div>
          {selectedDayHoliday && (
            <div className="mb-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1 inline-block">
              🎉 Public holiday — {selectedDayHoliday}. Avoid scheduling meetings on this day.
            </div>
          )}
          {selectedDayBookings.length === 0 ? (
            <div className="text-sm text-green-700">No bookings — all rooms free on this day ✅</div>
          ) : (
            <div className="space-y-2">
              {selectedDayBookings.map(({ room, items }) => (
                <div key={room.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge color={ROOM_STATUS[room.status] ?? 'gray'}>{room.name}</Badge>
                  {items.map((b) => (
                    <span key={b.requestId} className={`rounded px-2 py-0.5 text-xs ${BOOKING_CHIP[b.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      <a href={`/requests/${b.requestId}`} className="font-medium hover:underline">
                        {b.docNumber ?? '—'}
                      </a>{' '}
                      {timeLabel(b.startTime)} → {timeLabel(b.endTime)} · {b.title}
                      {b.requester ? ` · ${b.requester}` : ''}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
