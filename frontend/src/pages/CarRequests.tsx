import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { Badge, Card, Empty, PageHeader } from '../components/ui';
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
  bookings: { docNumber?: string; startDate: string; endDate: string; estimatedReturnAt?: string | null; likelyFreeFrom?: string | null }[];
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
    assignment?: {
      id: string;
      assignedAt: string;
      driverNotedAt?: string | null;
      driverArrivedAt?: string | null;
      driverBackAtOfficeAt?: string | null;
      estimatedReturnAt?: string | null;
    } | null;
  } | null;
}

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
  } | null;
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



type CarTab = 'availability' | 'requests' | 'handover';

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
  const tab: CarTab = tabParam === 'requests' || tabParam === 'handover' ? tabParam : 'availability';
  const setTab = (t: CarTab) => setSearchParams(t === 'availability' ? {} : { tab: t }, { replace: false });
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [fleet, setFleet] = useState<FleetVehicle[]>([]);
  const [handover, setHandover] = useState<Handover | null>(null);
  const [showForm, setShowForm] = useState(false); // "New car request" dialog
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const canAssign = hasPermission('cars.assign');

  const load = useCallback(() => {
    // cars.assign holders (Administration) see every car request; requesters see their own only
    api<{ items: RequestRow[] }>(
      canAssign
        ? '/requests?pageSize=100&docType=CAR_REQUEST'
        : '/requests?scope=mine&pageSize=100&docType=CAR_REQUEST',
    )
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message));
    api<FleetVehicle[]>('/cars/fleet-overview').then(setFleet).catch(() => setFleet([]));
    if (hasPermission('cars.assign')) {
      api<QueueRow[]>('/cars/requests/approved-unassigned')
        .then(setQueue)
        .catch(() => setQueue([]));
      // shift-handover summary (next Administration shift picks up from here)
      api<Handover>('/cars/handover').then(setHandover).catch(() => setHandover(null));
    }
  }, []);

  useEffect(load, [load]);

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
          Requests ({rows.length})
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
                          {b.estimatedReturnAt && new Date(b.estimatedReturnAt) > new Date(b.endDate) && (
                            <span className="text-red-600 font-medium"> · ⏰ ETA {fmtShort(b.estimatedReturnAt)}</span>
                          )}
                          {!blocked && b.likelyFreeFrom && (
                            <span className="text-gray-500"> · likely free ~{fmtShort(b.likelyFreeFrom)}</span>
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
            Approved — waiting for vehicle assignment ({queue.length})
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            Approved requests that still need a car. Open one and assign a vehicle + driver in the Car panel.
          </p>
          {queue.length === 0 ? (
            <Empty label="No approved requests waiting — all caught up 🎉" />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-3 py-2 font-medium">Doc No.</th>
                  <th className="px-3 py-2 font-medium">Requester</th>
                  <th className="px-3 py-2 font-medium">Destination</th>
                  <th className="px-3 py-2 font-medium">Schedule</th>
                  <th className="px-3 py-2 font-medium">Type / Pax</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {queue.map((q) => (
                  <tr key={q.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium">
                      <Link to={`/requests/${q.id}`} className="text-blue-600 hover:underline">{q.docNumber}</Link>
                    </td>
                    <td className="px-3 py-2">
                      {q.requester?.fullName ?? '—'}
                      <div className="text-xs text-gray-400">{q.department?.name ?? '—'}</div>
                    </td>
                    <td className="px-3 py-2">{q.carRequest?.destination ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                      {q.carRequest && `${fmtDateTime(q.carRequest.startDate)} → ${fmtDateTime(q.carRequest.endDate)}`}
                    </td>
                    <td className="px-3 py-2 text-gray-500">
                      {q.carRequest?.vehicleTypeRequired ?? 'Any'} · {q.carRequest?.passengers ?? 1} pax
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
              <th className="px-4 py-3 font-medium">Status</th>
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
                <td className="px-4 py-3">{r.title}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                    r.status === 'APPROVED' ? 'bg-green-100 text-green-700'
                    : r.status === 'REJECTED' ? 'bg-red-100 text-red-700'
                    : r.status === 'PENDING_APPROVAL' ? 'bg-yellow-100 text-yellow-700'
                    : r.status === 'IN_PROGRESS' ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600'
                  }`}>{r.status}</span>
                  {r.status === 'IN_PROGRESS' && r.carRequest?.assignment && (
                    <DriverAckStages a={r.carRequest.assignment} />
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
      </Card>
      )}

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
                  <td className="px-3 py-2">{t.driver ?? '—'}</td>
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
                <span className="text-gray-500">{t.vehicle}{t.driver ? ` · ${t.driver}` : ''} · {t.destination}</span>
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
