import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Modal } from './Modal';
import { toast } from './Toast';
import { Button, Empty } from './ui';
import { fmtDate, fmtDateTime, fmtTime } from '../util/yangonTime';

/** One row of the correlated driver+employee assignment history. */
export interface TripRow {
  id: string;
  assignedAt: string;
  docNumber: string;
  requester: string;
  vehicle: string;
  brandModel: string;
  status: string;
  driver?: string | null;
  driverNotedAt: string | null;
  driverArrivedAt: string | null;
  driverBackAtOfficeAt: string | null;
  viaEmployee: boolean;
}

interface History {
  driver: { id: string; name: string };
  employee: { id: string; employeeNo: string; fullName: string } | null;
  assignments: TripRow[];
}

const PAGE = 10;

const STATUS_DOT: Record<string, string> = {
  COMPLETED: 'bg-teal-500',
  CANCELLED: 'bg-gray-300',
  IN_PROGRESS: 'bg-blue-500',
  APPROVED: 'bg-green-500',
  PENDING_APPROVAL: 'bg-amber-400',
  SUBMITTED: 'bg-amber-400',
};

/** CSV cell — quoted, inner quotes doubled; the writer adds an Excel BOM. */
const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * Timestamp for a spreadsheet: Yangon wall-clock (what the table shows) in
 * sortable "2026-11-17 15:51" form rather than the raw UTC ISO string.
 */
const stamp = (v: string | null) =>
  v ? new Date(v).toLocaleString('sv-SE', { timeZone: 'Asia/Yangon' }).slice(0, 16) : '';

/**
 * Trip history of one driver, for the fleet desk's History link.
 *
 * The rows are correlated server-side: everything this driver drove, plus — when
 * the driver is linked to an employee — the trips that employee requested as a
 * passenger. Ten at a time, and the export writes every row, not the page.
 */
export function DriverTripHistoryModal({
  driver,
  onClose,
}: {
  driver: { id: string; name: string };
  onClose: () => void;
}) {
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setPage(0);
    setData(null);
    api<History>(`/fleet/drivers/${driver.id}/correlated-history`)
      .then((h) => {
        if (!cancelled) setData(h);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [driver.id, reloadKey]);

  const rows = data?.assignments ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const from = current * PAGE;
  const shown = rows.slice(from, from + PAGE);
  const completed = rows.filter((r) => r.status === 'COMPLETED').length;
  const viaEmployee = rows.filter((r) => r.viaEmployee).length;

  const exportCsv = () => {
    const header = [
      'Request',
      'Status',
      'Vehicle',
      'Brand / model',
      'Requester',
      'Driver',
      'Assigned',
      'Noted',
      'Arrived',
      'Back at office',
      'Via employee link',
    ];
    const line = (r: TripRow) =>
      [
        r.docNumber,
        r.status,
        r.vehicle,
        r.brandModel,
        r.requester,
        r.driver ?? '',
        stamp(r.assignedAt),
        stamp(r.driverNotedAt),
        stamp(r.driverArrivedAt),
        stamp(r.driverBackAtOfficeAt),
        r.viaEmployee ? 'yes' : 'no',
      ]
        .map(cell)
        .join(',');
    // the BOM keeps Excel from mangling Burmese names, CRLF is what it expects
    const csv = `\uFEFF${[header.map(cell).join(','), ...rows.map(line)].join('\r\n')}\r\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug =
      driver.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'driver';
    a.href = url;
    a.download = `trip-history-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${rows.length} trip${rows.length === 1 ? '' : 's'} exported to CSV`);
  };

  return (
    <Modal title={`Trip history — ${driver.name}`} onClose={onClose} xl>
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
          <button
            type="button"
            className="ml-2 font-medium underline"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-gray-500">
            {data?.employee ? (
              <span>
                Merged with{' '}
                <b className="font-medium text-gray-700">{data.employee.fullName}</b>{' '}
                <span className="text-gray-400">({data.employee.employeeNo})</span>
                {viaEmployee > 0 && (
                  <span className="ml-1 text-blue-600">· {viaEmployee} as passenger</span>
                )}
              </span>
            ) : (
              <span className="text-gray-400">
                No employee link — only trips driven by this person. Link an employee to also
                merge the trips they requested.
              </span>
            )}
            <span className="ml-auto flex items-center gap-3">
              <span>
                {rows.length} trip{rows.length === 1 ? '' : 's'}
                {completed > 0 && <span className="text-gray-400"> · {completed} completed</span>}
              </span>
              <Button
                variant="ghost"
                onClick={exportCsv}
                disabled={!rows.length}
                title="Export every trip to CSV (all pages)"
              >
                ⭳ CSV
              </Button>
            </span>
          </div>

          {loading && <Empty label="Loading trip history…" />}
          {!loading && rows.length === 0 && <Empty label="No assignment history yet" />}

          {!loading && rows.length > 0 && (
            <>
              <div className="overflow-hidden rounded-lg border border-gray-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
                      <th className="px-3 py-2 font-medium">Request</th>
                      <th className="px-3 py-2 font-medium">Vehicle</th>
                      <th className="px-3 py-2 font-medium">Requester</th>
                      <th className="px-3 py-2 font-medium">Assigned</th>
                      <th className="px-3 py-2 font-medium">Driver</th>
                      <th className="px-3 py-2 font-medium text-center">Noted</th>
                      <th className="px-3 py-2 font-medium text-center">Arrived</th>
                      <th className="px-3 py-2 font-medium text-center">Back</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {shown.map((r) => (
                      <tr key={r.id} className={r.viaEmployee ? 'bg-blue-50/40' : 'hover:bg-gray-50/60'}>
                        <td className="whitespace-nowrap px-3 py-2">
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[r.status] ?? 'bg-gray-300'}`}
                              title={r.status.replace(/_/g, ' ')}
                              aria-label={r.status.replace(/_/g, ' ')}
                              role="img"
                            />
                            <Link
                              to={`/car-requests/${r.id}`}
                              className="font-medium text-blue-600 hover:underline"
                              title={`Open ${r.docNumber}`}
                            >
                              {r.docNumber}
                            </Link>
                          </span>
                          {r.viaEmployee && (
                            <span
                              className="ml-1 align-middle text-[10px] text-blue-600"
                              title="Taken as a passenger — this driver was the requester's employee link"
                            >
                              ·
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-medium text-gray-800">{r.vehicle}</span>
                          {r.brandModel && (
                            <span className="block text-[11px] leading-tight text-gray-400">
                              {r.brandModel}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-700">{r.requester}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                          {fmtDate(r.assignedAt)}
                          <span className="block text-[11px] leading-tight text-gray-400">
                            {fmtTime(r.assignedAt)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-700">{r.driver ?? '—'}</td>
                        <td className="px-3 py-2 text-center text-gray-500" title={r.driverNotedAt ? fmtDateTime(r.driverNotedAt) : ''}>
                          {r.driverNotedAt ? fmtTime(r.driverNotedAt) : '—'}
                        </td>
                        <td className="px-3 py-2 text-center text-gray-500" title={r.driverArrivedAt ? fmtDateTime(r.driverArrivedAt) : ''}>
                          {r.driverArrivedAt ? fmtTime(r.driverArrivedAt) : '—'}
                        </td>
                        <td
                          className="px-3 py-2 text-center text-gray-500"
                          title={r.driverBackAtOfficeAt ? fmtDateTime(r.driverBackAtOfficeAt) : ''}
                        >
                          {r.driverBackAtOfficeAt ? fmtTime(r.driverBackAtOfficeAt) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                <span>
                  Showing {from + 1}–{Math.min(rows.length, from + PAGE)} of {rows.length}
                </span>
                {pages > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded-lg border border-gray-200 px-2 py-1 font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                      onClick={() => setPage(current - 1)}
                      disabled={current === 0}
                      aria-label="Previous page"
                    >
                      ‹ Prev
                    </button>
                    {Array.from({ length: pages }, (_, n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setPage(n)}
                        aria-current={n === current ? 'page' : undefined}
                        className={`h-7 min-w-7 rounded-lg px-2 font-medium ${
                          n === current
                            ? 'bg-gray-900 text-white'
                            : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {n + 1}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="rounded-lg border border-gray-200 px-2 py-1 font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                      onClick={() => setPage(current + 1)}
                      disabled={current >= pages - 1}
                      aria-label="Next page"
                    >
                      Next ›
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
