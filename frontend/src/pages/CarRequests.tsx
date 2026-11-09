import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, getToken, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader } from '../components/ui';
import { Modal } from '../components/Modal';
import { CarRequestForm } from '../components/CarRequestForm';
import { DriverAckStages } from '../components/CarPanel';
import { toast } from '../components/Toast';
import { fmtDate, fmtDateTime, fmtShort, fmtTime } from '../util/yangonTime';

interface FleetVehicle {
  id: string;
  vehicleNo: string;
  brandModel: string;
  status: string;
  bookings: {
    docNumber?: string;
    startDate: string;
    endDate: string;
    estimatedReturnAt?: string | null;
    likelyFreeFrom?: string | null;
    /** assigned driver, when Administration has already picked one */
    driverName?: string | null;
  }[];
}

// Prisma VehicleStatus enum values + the derived BOOKED state (future-only
// bookings — orange, matching the booked-window chips below the card)
const VEHICLE_STATUS: Record<string, 'green' | 'blue' | 'yellow' | 'red' | 'gray' | 'orange'> = {
  AVAILABLE: 'green',
  BOOKED: 'orange',
  IN_USE: 'blue',
  UNDER_MAINTENANCE: 'yellow',
  OUT_OF_SERVICE: 'red',
};

interface RequestRow {
  id: string;
  docNumber: string;
  title: string;
  status: string;
  currentLevel: number;
  totalLevels: number;
  createdAt: string;
  requester?: { fullName?: string } | null;
  department?: { name?: string } | null;
  carRequest?: {
    endDate?: string;
    /** cleared on release too — null means "no car picked for this request" */
    vehicleId?: string | null;
    /** assigned driver — shown under the status pill in the list */
    driver?: { name?: string } | null;
    /** shared-trip group — every member shows the ONE ride's driver taps */
    sharedTripId?: string | null;
    /** the OTHER trips on this shared ride — rendered as the 🔗 Shared trip badge */
    sharedWith?: string[];
    sharedRide?: {
      docNumber?: string;
      notedAt?: string | null;
      arrivedAt?: string | null;
      backAtOfficeAt?: string | null;
    } | null;
    assignment?: {
      id: string;
      assignedAt: string;
      /** set when the janitor/Administration released the booking — a car WAS picked */
      releasedAt?: string | null;
      driverNotedAt?: string | null;
      driverArrivedAt?: string | null;
      driverBackAtOfficeAt?: string | null;
      estimatedReturnAt?: string | null;
      /** who the booking was for — kept so a released row still names them */
      vehicle?: { vehicleNo?: string } | null;
      driver?: { name?: string } | null;
    } | null;
  } | null;
}

/** One released/active booking row, as the request list and the queue see it. */
export type RowAssignment = NonNullable<NonNullable<RequestRow['carRequest']>['assignment']>;

interface QueueRow {
  id: string;
  docNumber: string;
  status: string;
  requester: { fullName: string };
  department?: { name: string } | null;
  carRequest?: {
    destination: string;
    startDate: string;
    endDate: string;
    vehicleTypeRequired?: string | null;
    passengers: number;
    /** present when a car+driver were dispatched and the booking was released */
    assignment?: RowAssignment | null;
  } | null;
}

/** Pending optional manager acks — rows the backend returns for MY department(s). */
interface ManagerAckRow {
  id: string;
  docNumber: string;
  title: string;
  status: string;
  requester: { fullName: string };
  department?: { name: string } | null;
  carRequest?: { destination: string; startDate: string; endDate: string } | null;
}

/** ⏰ chip for a live driver-reported ETA — red when it passes the planned end. */
function EtaChip({ eta, plannedEnd }: { eta: string; plannedEnd?: string }) {
  const late = plannedEnd ? new Date(eta) > new Date(plannedEnd) : false;
  return (
    <span
      className={`inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-xs font-medium border ${late ? 'bg-red-50 border-red-200 text-red-700' : 'bg-blue-50 border-blue-200 text-blue-700'}`}
      title={`Driver reported the car back at ${fmtDateTime(eta)}`}
    >
      ⏰ ETA {fmtTime(eta)}{late ? ' · late' : ''}
    </span>
  );
}



/** Shared head of the approved-unassigned queue tables. */
function QueueTableHead() {
  return (
    <thead>
      <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
        <th className="px-3 py-2 font-medium">Doc No.</th>
        <th className="px-3 py-2 font-medium">Requester</th>
        <th className="px-3 py-2 font-medium">Destination</th>
        <th className="px-3 py-2 font-medium">Schedule</th>
        <th className="px-3 py-2 font-medium">Type / Pax</th>
      </tr>
    </thead>
  );
}

/**
 * One row of the approved-unassigned queue.
 * `past` — the trip window already ended without a car: tinted red and tagged,
 * because it can no longer be served (it auto-closes 24h after the window).
 * A still-open window whose START time has passed gets a softer amber note —
 * the trip can still happen late, so it stays in the live group.
 */
function QueueRowView({ q, past }: { q: QueueRow; past: boolean }) {
  const startPassed = !past && !!q.carRequest && new Date(q.carRequest.startDate) < new Date();
  return (
    <tr className={`hover:bg-gray-50 ${past ? 'bg-red-50/40' : ''}`}>
      <td className="px-3 py-2 font-medium">
        <Link to={`/requests/${q.id}`} className="text-blue-600 hover:underline">{q.docNumber}</Link>
        {past && (
          <span className="block text-[11px] font-medium text-red-600 mt-0.5">⌛ window passed</span>
        )}
      </td>
      <td className="px-3 py-2">
        {q.requester?.fullName ?? '—'}
        <div className="text-xs text-gray-400">{q.department?.name ?? '—'}</div>
      </td>
      <td className="px-3 py-2">{q.carRequest?.destination ?? '—'}</td>
      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
        {q.carRequest && `${fmtDateTime(q.carRequest.startDate)} → ${fmtDateTime(q.carRequest.endDate)}`}
        {q.carRequest?.assignment ? (
          <ReleasedTripNote a={q.carRequest.assignment} />
        ) : (
          startPassed && (
            <div className="text-xs text-amber-600 mt-0.5">⚠ start time passed — still no vehicle</div>
          )
        )}
      </td>
      <td className="px-3 py-2 text-gray-500">
        {q.carRequest?.vehicleTypeRequired ?? 'Any'} · {q.carRequest?.passengers ?? 1} pax
      </td>
    </tr>
  );
}

/**
 * What happened to an assigned booking that is no longer live: who was
 * dispatched, and which driver confirmations never arrived. Administration DID
 * assign a car, so the row must say that — it used to read "vehicle not
 * assigned", the same words used for a request nobody ever picked a car for
 * (CAR-202611-0005).
 */
function ReleasedTripNote({ a }: { a: RowAssignment }) {
  const stages: Array<[string, string | null | undefined]> = [
    ['Noted', a.driverNotedAt],
    ['Ready', a.driverArrivedAt],
    ['Back', a.driverBackAtOfficeAt],
  ];
  const missing = stages.filter(([, at]) => !at).map(([name]) => name);
  return (
    <div
      className="mt-1"
      title={
        missing.length
          ? `Assigned to ${a.vehicle?.vehicleNo ?? 'a car'} / ${a.driver?.name ?? 'a driver'}, then released — the driver never tapped ${missing.join(', ')}`
          : 'Assigned and driven — the request closes on the driver’s return'
      }
    >
      <div className="text-xs text-slate-600 font-medium">
        🚗 {a.vehicle?.vehicleNo ?? 'vehicle'} · 👤 {a.driver?.name ?? 'no driver'}
      </div>
      <div className="text-[11px] font-medium">
        {stages.map(([name, at]) => (
          <span key={name} className={at ? 'text-teal-600' : 'text-red-600'}>
            {name} {at ? '✓' : '✗'}{' '}
          </span>
        ))}
        <span className="text-slate-400">· released</span>
      </div>
    </div>
  );
}

type CarTab = 'availability' | 'requests' | 'handover' | 'usage';
/** Rows per page in the Requests tab — the list used to fetch the newest 100 and
 *  render them all, so the page grew without limit as requests accumulated. */
const CAR_PAGE_SIZE = 10;

/** Shift-handover summary — Administration sees what the next shift inherits. */
interface Handover {
  onRoad: {
    requestId: string; docNumber: string; vehicle: string; driver?: string | null;
    destination: string; plannedEnd: string; estimatedReturnAt?: string | null;
    tripStarted: boolean; overdue: boolean;
  }[];
  delayedCount: number;
  today: {
    requestId: string; docNumber: string; status: string; startDate: string; endDate: string;
    destination: string; vehicle: string; driver?: string | null;
    notedAt?: string | null; readyAt?: string | null; backAt?: string | null; estimatedReturnAt?: string | null;
  }[];
  blocked: { vehicle: string; brandModel: string; startsAt: string; endsAt: string; reason: string }[];
  generatedAt: string;
}

export default function CarRequests() {
  // active tab lives in the URL (?tab=requests) so refresh / back / shared links keep it
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as CarTab | null;
  const tab: CarTab =
    tabParam === 'requests' || tabParam === 'handover' || tabParam === 'usage' ? tabParam : 'availability';
  const setTab = (t: CarTab) => setSearchParams(t === 'availability' ? {} : { tab: t }, { replace: false });
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [acks, setAcks] = useState<ManagerAckRow[]>([]);
  const [fleet, setFleet] = useState<FleetVehicle[]>([]);
  const [handover, setHandover] = useState<Handover | null>(null);
  const [showForm, setShowForm] = useState(false); // "New car request" dialog
  const [error, setError] = useState('');
  const [ackingId, setAckingId] = useState('');
  const navigate = useNavigate();
  const canAssign = hasPermission('cars.assign');

  const load = useCallback(() => {
    // cars.assign holders (Administration) see every car request; requesters see their own only
    api<{ items: RequestRow[]; total: number }>(
      `/requests?page=${page}&pageSize=${CAR_PAGE_SIZE}&docType=CAR_REQUEST${canAssign ? '' : '&scope=mine'}`,
    )
      .then((r) => {
        setRows(r.items);
        setTotal(r.total ?? r.items.length);
        // the last row of a page can disappear (cancel / complete elsewhere) — step back
        if (r.items.length === 0 && page > 1) setPage((p) => Math.max(1, p - 1));
      })
      .catch((e) => setError(e.message));
    api<FleetVehicle[]>('/cars/fleet-overview').then(setFleet).catch(() => setFleet([]));
    // optional manager ack — the backend returns rows only for the requester's
    // department manager, so an empty list renders nothing for everyone else
    api<ManagerAckRow[]>('/cars/manager-acks/pending').then(setAcks).catch(() => setAcks([]));
    if (hasPermission('cars.assign')) {
      api<QueueRow[]>('/cars/requests/approved-unassigned')
        .then(setQueue)
        .catch(() => setQueue([]));
      // shift-handover summary (next Administration shift picks up from here)
      api<Handover>('/cars/handover').then(setHandover).catch(() => setHandover(null));
    }
  }, [page, canAssign]);

  useEffect(load, [load]);

  // Split the Administration queue: trips that can still be served, versus trips
  // whose window already ended with no car ever assigned. The stale ones stay in
  // the API response until the +24h auto-expiry closes them, but they must not
  // masquerade as serve-able work in the live list — they get their own group.
  const now = Date.now();
  const liveQueue = queue.filter((q) => !q.carRequest || new Date(q.carRequest.endDate).getTime() >= now);
  const pastQueue = queue.filter((q) => q.carRequest && new Date(q.carRequest.endDate).getTime() < now);
  const pageCount = Math.max(1, Math.ceil(total / CAR_PAGE_SIZE));

  // auto-refresh: new requests/approvals/assignments appear without manual reload
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Car Requests"
        subtitle="Request a company vehicle (Plan §6)"
        actions={<button onClick={() => setShowForm(true)} className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700">+ New Car Request</button>}
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {/* ===== Optional manager acknowledgement (Department Head, never blocks) =====
          This list IS the entry point: without it a pure department head could not
          reach the ack at all — the request detail page only opens for the owner or
          a workflow approver, and nothing else surfaced these rows. */}
      {acks.length > 0 && (
        <Card className="mb-5 p-5">
          <h2 className="font-semibold text-gray-800 mb-1 text-sm uppercase tracking-wide">
            👍 Awaiting your acknowledgement ({acks.length})
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            Car requests from your department(s) — optional, never delays the trip.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 font-medium">Doc No.</th>
                <th className="px-3 py-2 font-medium">Requester</th>
                <th className="px-3 py-2 font-medium">Destination</th>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {acks.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium">
                    <Link to={`/requests/${a.id}`} className="text-blue-600 hover:underline">{a.docNumber}</Link>
                  </td>
                  <td className="px-3 py-2">
                    {a.requester?.fullName ?? '—'}
                    <div className="text-xs text-gray-400">{a.department?.name ?? '—'}</div>
                  </td>
                  <td className="px-3 py-2">{a.carRequest?.destination ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                    {a.carRequest && `${fmtDateTime(a.carRequest.startDate)} → ${fmtDateTime(a.carRequest.endDate)}`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      className="px-2.5 py-1 text-xs rounded-lg border border-green-200 text-green-700 hover:bg-green-50 disabled:opacity-50"
                      disabled={ackingId === a.id}
                      onClick={async () => {
                        setAckingId(a.id);
                        try {
                          await api(`/cars/requests/${a.id}/manager-ack`, { method: 'POST' });
                          toast('Acknowledged — thank you');
                          load();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : 'Failed to acknowledge');
                        } finally {
                          setAckingId('');
                        }
                      }}
                    >
                      {ackingId === a.id ? 'Saving…' : '👍 Acknowledge'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Tabs (URL-driven, same pattern as Inventory/Meeting Rooms) */}
      <div className="flex gap-1 border-b border-gray-200 mb-5">
        <button
          className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
            tab === 'availability'
              ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
          }`}
          onClick={() => setTab('availability')}
        >
          Fleet Availability
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
            tab === 'requests'
              ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
          }`}
          onClick={() => setTab('requests')}
        >
          Requests ({total || rows.length})
        </button>
        {canAssign && (
        <button
          className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
            tab === 'handover'
              ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
          }`}
          onClick={() => setTab('handover')}
        >
          🔄 Handover{handover && handover.delayedCount > 0 ? ` (⏰ ${handover.delayedCount})` : ''}
        </button>
        )}
        {canAssign && (
        <button
          className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
            tab === 'usage'
              ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
          }`}
          onClick={() => setTab('usage')}
        >
          🛣️ Usage
        </button>
        )}
      </div>

      {/* New car request — dialog (clash warnings + errors show inside) */}
      {showForm && (
        <Modal title="New car request" wide onClose={() => setShowForm(false)}>
          <CarRequestForm
            onCreated={(id) => {
              setShowForm(false);
              toast('Car request submitted');
              load();
              navigate(`/requests/${id}`);
            }}
          />
        </Modal>
      )}

      {/* ============ Tab: Fleet Availability ============ */}
      {tab === 'availability' && (
      <>
      {/* Fleet availability — informational only; Administration decides assignments */}
      <Card className="mb-5 p-5">
        <h2 className="font-semibold text-gray-800 mb-1 text-sm uppercase tracking-wide">Fleet availability (next 7 days)</h2>
        <p className="text-xs text-gray-400 mb-3">
          Information only — vehicles are assigned by the Administration Department. A "booked" window may still
          free up (or the fleet may get another car), so submit your request anyway if you need one.
        </p>
        {fleet.length === 0 ? (
          <Empty label="No vehicles in the fleet yet" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {fleet.map((v) => (
              <div key={v.id} className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-gray-800 text-sm">{v.vehicleNo}</div>
                  <Badge color={VEHICLE_STATUS[v.status] ?? 'gray'}>{v.status}</Badge>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">{v.brandModel}</div>
                {v.bookings.length === 0 ? (
                  <div className="text-xs text-green-700 mt-2">No bookings in the next 7 days</div>
                ) : (
                  <div className="mt-2 space-y-1">
                    <div className="text-xs text-gray-400 uppercase tracking-wide">Booked</div>
                    {v.bookings.map((b) => {
                      const blocked = (b.docNumber ?? '').startsWith('🛠');
                      return (
                        <div key={`${v.id}-${b.docNumber}-${b.startDate}`} className={`text-xs rounded px-2 py-1 ${blocked ? 'text-gray-600 bg-gray-100' : 'text-orange-700 bg-orange-50'}`}>
                          {b.docNumber ?? '—'}: {fmtShort(b.startDate)}
                          {' → '}
                          {fmtShort(b.endDate)}
                          {!blocked && b.driverName && (
                            <span className="text-sky-700 font-medium"> · 👤 {b.driverName}</span>
                          )}
                          {b.estimatedReturnAt && new Date(b.estimatedReturnAt) > new Date(b.endDate) && (
                            <span className="text-red-600 font-medium"> · ⏰ ETA {fmtShort(b.estimatedReturnAt)}</span>
                          )}
                          {!blocked && b.likelyFreeFrom && (
                            // teal = forecast (when we expect the car back), kept distinct
                            // from the orange window text and the red ⏰ ETA above it
                            <span className="text-teal-700 font-medium"> · likely free ~{fmtShort(b.likelyFreeFrom)}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {canAssign && (
        <Card className="mb-5 p-5">
          <h2 className="font-semibold text-gray-800 mb-1 text-sm uppercase tracking-wide">
            Approved — waiting for vehicle assignment ({liveQueue.length})
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            Approved requests that still need a car. Open one and assign a vehicle + driver in the Car panel.
            {pastQueue.length > 0 && ' Trips whose window has already passed are listed separately below.'}
          </p>
          {queue.length === 0 ? (
            <Empty label="No approved requests waiting — all caught up 🎉" />
          ) : (
            <>
              {liveQueue.length === 0 ? (
                <Empty label="Nothing serve-able waiting — only past-window requests below" />
              ) : (
                <table className="w-full text-sm">
                  <QueueTableHead />
                  <tbody className="divide-y divide-gray-100">
                    {liveQueue.map((q) => (
                      <QueueRowView key={q.id} q={q} past={false} />
                    ))}
                  </tbody>
                </table>
              )}

              {pastQueue.length > 0 && (
                <div className="mt-6 pt-4 border-t border-red-200">
                  <h3 className="font-semibold text-red-600 mb-1 text-sm uppercase tracking-wide">
                    ⌛ Window passed — never assigned, or released ({pastQueue.length})
                  </h3>
                  <p className="text-xs text-gray-400 mb-3">
                    The trip time is over and these can no longer be served. They are kept out of the live list
                    above; open one to cancel it, or leave it — it closes itself 2 hours after the window
                    ended (never assigned, or released without the driver's confirmation), and the requester is told.
                  </p>
                  <table className="w-full text-sm">
                    <QueueTableHead />
                    <tbody className="divide-y divide-gray-100">
                      {pastQueue.map((q) => (
                        <QueueRowView key={q.id} q={q} past />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      </>
      )}

      {/* ============ Tab: Requests (the list) ============ */}
      {tab === 'requests' && (
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Doc No.</th>
              {canAssign && <th className="px-4 py-3 font-medium">Requester</th>}
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium text-center">Status</th>
              <th className="px-4 py-3 font-medium">Level</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && <tr><td colSpan={canAssign ? 6 : 5}><Empty label="No car requests yet" /></td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">
                  <Link to={`/requests/${r.id}`} className="text-blue-600 hover:underline">{r.docNumber}</Link>
                </td>
                {canAssign && (
                  <td className="px-4 py-3">
                    {r.requester?.fullName ?? '—'}
                    <div className="text-xs text-gray-400">{r.department?.name ?? '—'}</div>
                  </td>
                )}
                <td className="px-4 py-3">
                  {r.title}
                  {r.carRequest?.sharedWith && r.carRequest.sharedWith.length > 0 && (
                    <div className="mt-1">
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-50 border border-purple-200 text-purple-700"
                        title={`One car and driver also serves ${r.carRequest.sharedWith.join(', ')}`}
                      >
                        🔗 Shared trip · {r.carRequest.sharedWith.join(', ')}
                      </span>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                    r.status === 'APPROVED' ? 'bg-green-100 text-green-700'
                    : r.status === 'REJECTED' ? 'bg-red-100 text-red-700'
                    : r.status === 'PENDING_APPROVAL' ? 'bg-yellow-100 text-yellow-700'
                    : r.status === 'IN_PROGRESS' ? 'bg-blue-100 text-blue-700'
                    : r.status === 'COMPLETED' ? 'bg-teal-100 text-teal-700'
                    : 'bg-gray-100 text-gray-600'
                  }`}>{r.status}</span>
                  {/* who has the car — same 👤 sky treatment as the fleet card */}
                  {r.carRequest?.driver?.name && (
                    <div className="text-xs text-sky-700 font-medium mt-1" title="Assigned driver">
                      👤 {r.carRequest.driver.name}
                    </div>
                  )}
                  {/* APPROVED but nobody picked a car — the status cell must say so,
                      otherwise a green APPROVED pill reads like a finished job */}
                  {/* APPROVED without a live car link means one of two very different
                      things: nobody assigned yet, or a car WAS assigned and the booking
                      was released again (window ended before the driver confirmed).
                      The second one used to read "vehicle not assigned" too, so a
                      dispatch that did happen looked like one that never did
                      (CAR-202611-0005). The released assignment row keeps the trail. */}
                  {r.status === 'APPROVED' && r.carRequest && !r.carRequest.vehicleId && (
                    r.carRequest.assignment ? (
                      <ReleasedTripNote a={r.carRequest.assignment} />
                    ) : (
                      <div className="text-xs text-amber-600 font-medium mt-1" title="No vehicle assigned yet">
                        🚗 vehicle not assigned
                      </div>
                    )
                  )}
                  {r.status === 'IN_PROGRESS' && (r.carRequest?.assignment || r.carRequest?.sharedRide) && (
                    <DriverAckStages a={r.carRequest?.assignment} sharedRide={r.carRequest?.sharedRide} />
                  )}
                  {r.status === 'IN_PROGRESS' && r.carRequest?.assignment?.estimatedReturnAt && (
                    <EtaChip eta={r.carRequest.assignment.estimatedReturnAt} plannedEnd={r.carRequest?.endDate} />
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500">{r.totalLevels ? `${r.currentLevel}/${r.totalLevels}` : '—'}</td>                      <td className="px-4 py-3 text-gray-500">{fmtDate(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-4 py-3 border-t border-gray-100 text-sm">
          <span className="text-gray-500">
            {total === 0
              ? 'No requests'
              : `Showing ${(page - 1) * CAR_PAGE_SIZE + 1}–${(page - 1) * CAR_PAGE_SIZE + rows.length} of ${total}`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ← Prev
            </button>
            <span className="text-gray-500">Page {page} of {pageCount}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
              className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        </div>
      </Card>
      )}

      {/* ============ Tab: Vehicle usage (kilometres per month) ============ */}
      {tab === 'usage' &&
        (canAssign ? <VehicleUsageTab /> : <Card className="p-5 text-sm text-gray-500">Vehicle usage is visible to Administration.</Card>)}

      {/* ============ Tab: Shift Handover (Administration) ============ */}
      {tab === 'handover' && canAssign && (
      <>
      <p className="text-xs text-gray-400 mb-3">
        What the next shift inherits — trips on the road (⏰ delays flagged), today's remaining trips and blocked
        vehicles. A Telegram copy is sent to Administration at 17:00 daily.
      </p>
      {!handover ? (
        <Empty label="Handover summary unavailable" />
      ) : (
      <>
      <Card className="mb-5 p-5">
        <h2 className="font-semibold text-gray-800 mb-1 text-sm uppercase tracking-wide">🚗 On the road right now ({handover.onRoad.length})</h2>
        {handover.delayedCount > 0 && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 mb-2 inline-block">
            ⏰ {handover.delayedCount} delayed — driver reported a later return
          </p>
        )}
        {handover.onRoad.length === 0 ? (
          <Empty label="Nothing on the road — the pool is quiet." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 font-medium">Doc No.</th>
                <th className="px-3 py-2 font-medium">Vehicle</th>
                <th className="px-3 py-2 font-medium">Driver</th>
                <th className="px-3 py-2 font-medium">Planned end</th>
                <th className="px-3 py-2 font-medium">ETA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {handover.onRoad.map((t) => {
                const late = !!(t.estimatedReturnAt && new Date(t.estimatedReturnAt) > new Date(t.plannedEnd));
                return (
                <tr key={t.requestId} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium">
                    <Link to={`/requests/${t.requestId}`} className="text-blue-600 hover:underline">{t.docNumber}</Link>
                  </td>
                  <td className="px-3 py-2">{t.vehicle}</td>
                  <td className="px-3 py-2">
                    {t.driver ? (
                      <span className="text-sky-700 font-medium">👤 {t.driver}</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className={`px-3 py-2 ${t.overdue ? 'text-red-600' : 'text-gray-500'}`}>{fmtDateTime(t.plannedEnd)}</td>
                  <td className="px-3 py-2">
                    {t.estimatedReturnAt ? (
                      <EtaChip eta={t.estimatedReturnAt} plannedEnd={t.plannedEnd} />
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="mb-5 p-5">
        <h2 className="font-semibold text-gray-800 mb-2 text-sm uppercase tracking-wide">📅 Still to come today ({handover.today.length})</h2>
        {handover.today.length === 0 ? (
          <Empty label="No more trips today — the plan is clear." />
        ) : (
          <div className="space-y-1">
            {handover.today.map((t) => (
              <div key={t.requestId} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-gray-500 w-32 whitespace-nowrap">{fmtDateTime(t.startDate)}</span>
                <Link to={`/requests/${t.requestId}`} className="text-blue-600 hover:underline font-medium">{t.docNumber}</Link>
                <Badge color={t.status === 'IN_PROGRESS' ? 'blue' : 'orange'}>{t.status}</Badge>
                <span className="text-gray-500">{t.vehicle} · {t.destination}</span>
                {t.driver && (
                  <span className="text-sky-700 font-medium" title="Assigned driver">👤 {t.driver}</span>
                )}
                {t.estimatedReturnAt && <EtaChip eta={t.estimatedReturnAt} plannedEnd={t.endDate} />}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mb-5 p-5">
        <h2 className="font-semibold text-gray-800 mb-2 text-sm uppercase tracking-wide">🛠 Blocked vehicles ({handover.blocked.length})</h2>
        {handover.blocked.length === 0 ? (
          <Empty label="No vehicles blocked — the whole pool is usable." />
        ) : (
          <div className="space-y-1">
            {handover.blocked.map((u) => (
              <div key={`${u.vehicle}-${u.endsAt}`} className="flex flex-wrap items-center gap-2 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1">
                <span className="font-medium">{u.vehicle}</span>
                <span>{u.brandModel}</span>
                <Badge color="yellow">{u.reason}</Badge>
                <span className="text-gray-500">until {fmtDateTime(u.endsAt)}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-gray-400">Generated {fmtDateTime(handover.generatedAt)} — not a decision tool; assignment decisions stay with Administration.</p>
      </Card>
      </>
      )}
      </>
      )}
    </div>
  );
}

/**
 * Monthly distance per vehicle, built from the odometer readings taken at the
 * driver's Ready (departure) and Back-at-office (return) taps. One trip = return
 * − departure; a vehicle's month = the sum of its completed trips. Trips that
 * opened but have no return reading are listed as pending, so a gap is visible
 * instead of silently shrinking the total.
 */
interface UsageTrip {
  assignmentId: string;
  docNumber: string;
  destination: string | null;
  startDate: string | null;
  driverName: string | null;
  startOdoKm: number | null;
  endOdoKm: number | null;
  startOdoAt: string | null;
  endOdoAt: string | null;
  usageKm: number | null;
  hasPhoto: boolean;
  complete: boolean;
  /** one car, several bookings — the distance is counted on one of them */
  shared: boolean;
  sharedDuplicate: boolean;
}
interface UsageVehicle {
  vehicleId: string;
  vehicleNo: string;
  brandModel: string | null;
  totalKm: number;
  tripCount: number;
  trips: UsageTrip[];
  /** fuel bought for this vehicle in the month, and what a kilometre cost */
  fuelCost: number;
  fuelCostPerKm: number | null;
}
interface UsageReport {
  month: string;
  grandTotalKm: number;
  grandTotalFuel: number;
  tripCount: number;
  pendingCount: number;
  vehicles: UsageVehicle[];
}

function thisMonth(): string {
  // the office books in Asia/Yangon
  const y = new Date(Date.now() + 6.5 * 3600 * 1000);
  return `${y.getUTCFullYear()}-${String(y.getUTCMonth() + 1).padStart(2, '0')}`;
}

function VehicleUsageTab() {
  const [month, setMonth] = useState(thisMonth);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError('');
    api<UsageReport>(`/cars/usage?month=${encodeURIComponent(month)}`)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load usage'));
    return () => {
      cancelled = true;
    };
  }, [month]);

  const km = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString()} km`);

  /** Spreadsheet copy of exactly what is on screen (same month, same numbers). */
  const downloadCsv = async () => {
    setExporting(true);
    setError('');
    try {
      const res = await fetch(`/api/cars/usage.csv?month=${encodeURIComponent(month)}`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `vehicle-usage-${month}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">🛣️ Vehicle usage</h2>
          <p className="text-xs text-gray-400 mt-1">
            Distance per trip from the odometer at Ready and Back at office — summed per vehicle for the month.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-44">
            <label htmlFor="usage-month" className="block text-xs text-gray-500 mb-1">Month</label>
            <Input id="usage-month" type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} />
          </div>
          <Button variant="ghost" onClick={() => void downloadCsv()} disabled={exporting}>
            {exporting ? 'Preparing…' : '⬇️ CSV'}
          </Button>
        </div>
      </div>

      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
      {!report ? (
        <Empty label="Loading usage…" />
      ) : report.vehicles.length === 0 ? (
        <Empty label="No odometer readings for this month yet" />
      ) : (
        <>
          <div className="flex flex-wrap gap-3 mb-4 text-sm">
            <span className="px-3 py-1 rounded-full bg-yellow-50 border border-yellow-200 text-yellow-800 font-medium">
              {report.grandTotalKm.toLocaleString()} km total · {report.tripCount} trip{report.tripCount === 1 ? '' : 's'}
            </span>
            {report.grandTotalFuel > 0 && (
              <span className="px-3 py-1 rounded-full bg-sky-50 border border-sky-200 text-sky-800">
                ⛽ {report.grandTotalFuel.toLocaleString()} MMK fuel
                {report.grandTotalKm > 0 ? ` · ${(report.grandTotalFuel / report.grandTotalKm).toLocaleString(undefined, { maximumFractionDigits: 2 })} MMK/km` : ''}
              </span>
            )}
            {report.pendingCount > 0 && (
              <span className="px-3 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800">
                ⏳ {report.pendingCount} trip{report.pendingCount === 1 ? '' : 's'} waiting for a return reading
              </span>
            )}
          </div>

          {/* Distance at a glance — plain bars, no chart library, same numbers
              as the table below. */}
          <div className="mb-5">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Distance by vehicle</h3>
            <div className="space-y-1.5">
              {report.vehicles.map((v) => {
                const max = Math.max(...report.vehicles.map((x) => x.totalKm), 1);
                return (
                  <div key={v.vehicleId} className="flex items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 truncate text-gray-600" title={v.vehicleNo}>🚗 {v.vehicleNo}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full bg-yellow-500/80"
                        style={{ width: `${Math.max(2, Math.round((v.totalKm / max) * 100))}%` }}
                        title={`${v.totalKm.toLocaleString()} km`}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right font-medium text-gray-700">{v.totalKm.toLocaleString()} km</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-3 py-2 font-medium">Vehicle</th>
                  <th className="px-3 py-2 font-medium">Trips</th>
                  <th className="px-3 py-2 font-medium">Distance</th>
                  <th className="px-3 py-2 font-medium">Fuel</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {report.vehicles.map((v) => {
                  const isOpen = open === v.vehicleId;
                  return (
                    <Fragment key={v.vehicleId}>
                      <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => setOpen(isOpen ? null : v.vehicleId)}>
                        <td className="px-3 py-2">
                          <span className="font-medium text-gray-800">🚗 {v.vehicleNo}</span>
                          {v.brandModel && <span className="text-xs text-gray-500"> {v.brandModel}</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{v.tripCount}</td>
                        <td className="px-3 py-2 font-medium text-gray-800">{km(v.totalKm)}</td>
                        <td className="px-3 py-2 text-gray-600">
                          {v.fuelCost > 0 ? (
                            <>
                              {v.fuelCost.toLocaleString()} MMK
                              {v.fuelCostPerKm != null && (
                                <div className="text-[11px] text-gray-400">{v.fuelCostPerKm.toLocaleString()} MMK/km</div>
                              )}
                            </>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-blue-600">{isOpen ? '▾ hide trips' : '▸ trips'}</td>
                      </tr>
                      {isOpen && (
                        <tr key={`${v.vehicleId}-detail`}>
                          <td colSpan={5} className="px-3 pb-3 bg-gray-50/60">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-gray-400 uppercase tracking-wide">
                                  <th className="px-2 py-1 font-medium">Doc No.</th>
                                  <th className="px-2 py-1 font-medium">Destination</th>
                                  <th className="px-2 py-1 font-medium">Driver</th>
                                  <th className="px-2 py-1 font-medium">Ready → Back</th>
                                  <th className="px-2 py-1 font-medium text-right">Distance</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100">
                                {v.trips.map((t) => (
                                  <tr key={t.assignmentId}>
                                    <td className="px-2 py-1">
                                      <span className="font-medium text-gray-700">{t.docNumber}</span>
                                      {t.hasPhoto && <span title="Odometer photo on file"> 📷</span>}
                                    </td>
                                    <td className="px-2 py-1 text-gray-600">{t.destination ?? '—'}</td>
                                    <td className="px-2 py-1 text-gray-600">{t.driverName ?? '—'}</td>
                                    <td className="px-2 py-1 text-gray-600">
                                      {km(t.startOdoKm)} → {km(t.endOdoKm)}
                                      {t.endOdoAt && <span className="text-gray-400"> · {fmtShort(t.endOdoAt)}</span>}
                                    </td>
                                    <td className="px-2 py-1 text-right font-medium text-gray-800">
                                      {!t.complete ? (
                                        <span className="text-amber-700">⏳ pending</span>
                                      ) : t.usageKm != null ? (
                                        km(t.usageKm)
                                      ) : (
                                        <span className="text-sky-700" title="Shared ride — the distance is counted on the partner booking">
                                          🤝 shared
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400 mt-3">
            A trip counts once both readings exist. Missing readings are entered in the request's Car panel (🛣️ Odometer),
            or by the driver right after the Telegram tap.
          </p>
        </>
      )}
    </Card>
  );
}
