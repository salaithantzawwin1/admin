import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Empty } from './ui';
import { fmtDate } from '../util/yangonTime';

type Range = 'week' | 'month' | 'year';

interface Row {
  id: string;
  name: string;
  department: string | null;
  trips: number;
  missedNoted: number;
  missedReady: number;
  missedBack: number;
  missedOdoStart: number;
  missedOdoEnd: number;
  missed: number;
}

interface Data {
  range: Range;
  from: string;
  totals: {
    trips: number;
    missedNoted: number;
    missedReady: number;
    missedBack: number;
    missedOdoStart: number;
    missedOdoEnd: number;
  };
  drivers: Row[];
}

const RANGES: { key: Range; label: string }[] = [
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'year', label: 'This year' },
];

/** A miss cell: zero is quiet, anything above it is the thing you came to see. */
function Cell({ n }: { n: number }) {
  if (!n) return <span className="text-gray-300">—</span>;
  return <span className="font-medium text-amber-700">{n}</span>;
}

/**
 * What the drivers forgot, by Yangon calendar week / month / year.
 *
 * Two questions the desk actually asks: did the driver tap Noted / Ready / Back
 * at office, and did the odometer (photo *and* kilo) come back for that trip.
 * Only finished trips count — a car still on the road has no Back yet, and
 * counting it would blame the driver for a trip that is not over.
 */
export function DriverDiscipline() {
  const [range, setRange] = useState<Range>('week');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (r: Range) => {
    setLoading(true);
    setError('');
    try {
      setData(await api<Data>(`/fleet/drivers/misses?range=${r}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [range, load]);

  const totals = data?.totals;
  const totalMissed = totals
    ? totals.missedNoted + totals.missedReady + totals.missedBack + totals.missedOdoStart + totals.missedOdoEnd
    : 0;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">Driver discipline</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Missed Telegram stamps and missing odometer submissions
            {data?.from && <> — since {fmtDate(data.from)}</>}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-lg bg-gray-100 p-0.5" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={range === r.key}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                range === r.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="m-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {loading && <Empty label="Counting…" />}
      {!loading && !error && data?.drivers.length === 0 && (
        <Empty label={`No finished trips ${range === 'week' ? 'this week' : range === 'month' ? 'this month' : 'this year'}`} />
      )}

      {!loading && !error && !!data?.drivers.length && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500">
              <th className="px-4 py-2 font-medium">Driver</th>
              <th className="px-4 py-2 font-medium">Department</th>
              <th className="px-3 py-2 text-right font-medium">Trips</th>
              <th className="px-3 py-2 text-center font-medium" title="Driver never tapped “Noted” on Telegram">
                No noted
              </th>
              <th className="px-3 py-2 text-center font-medium" title="Driver never tapped “Ready” — the car was never confirmed leaving">
                No ready
              </th>
              <th className="px-3 py-2 text-center font-medium" title="Driver never tapped “Back at office”">
                No back
              </th>
              <th className="px-3 py-2 text-center font-medium" title="Departure odometer photo or kilo missing">
                Odo out
              </th>
              <th className="px-3 py-2 text-center font-medium" title="Return odometer photo or kilo missing">
                Odo in
              </th>
              <th className="px-3 py-2 text-center font-medium">Missed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.drivers.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50/60">
                <td className="px-4 py-2 font-medium text-gray-800">{d.name}</td>
                <td className="px-4 py-2 text-gray-600">{d.department ?? <span className="text-gray-300">—</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">{d.trips}</td>
                <td className="px-3 py-2 text-center tabular-nums"><Cell n={d.missedNoted} /></td>
                <td className="px-3 py-2 text-center tabular-nums"><Cell n={d.missedReady} /></td>
                <td className="px-3 py-2 text-center tabular-nums"><Cell n={d.missedBack} /></td>
                <td className="px-3 py-2 text-center tabular-nums"><Cell n={d.missedOdoStart} /></td>
                <td className="px-3 py-2 text-center tabular-nums"><Cell n={d.missedOdoEnd} /></td>
                <td className="px-3 py-2 text-center font-semibold tabular-nums text-gray-900">{d.missed}</td>
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="border-t border-gray-200 bg-gray-50 text-xs">
                <td className="px-4 py-2 font-medium text-gray-600" colSpan={2}>
                  Total · {data.drivers.length} driver{data.drivers.length === 1 ? '' : 's'}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-gray-800">{totals.trips}</td>
                <td className="px-3 py-2 text-center font-semibold tabular-nums text-gray-800">{totals.missedNoted}</td>
                <td className="px-3 py-2 text-center font-semibold tabular-nums text-gray-800">{totals.missedReady}</td>
                <td className="px-3 py-2 text-center font-semibold tabular-nums text-gray-800">{totals.missedBack}</td>
                <td className="px-3 py-2 text-center font-semibold tabular-nums text-gray-800">{totals.missedOdoStart}</td>
                <td className="px-3 py-2 text-center font-semibold tabular-nums text-gray-800">{totals.missedOdoEnd}</td>
                <td className="px-3 py-2 text-center font-bold tabular-nums text-gray-900">{totalMissed}</td>
              </tr>
            </tfoot>
          )}
        </table>
      )}

      <p className="px-4 py-3 text-[11px] leading-relaxed text-gray-400">
        Counted on finished trips only (released, or the request completed) — a car that is still out has no
        “Back at office” to miss yet. An odometer column counts the trip when either the photo or the kilo is
        missing, because the reading is only evidence with both.
      </p>
    </Card>
  );
}
