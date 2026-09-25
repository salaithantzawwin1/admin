import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { Badge, Card, Empty, PageHeader } from '../components/ui';
import { Modal } from '../components/Modal';
import { CarRequestForm } from '../components/CarRequestForm';
import { toast } from '../components/Toast';

interface FleetVehicle {
  id: string;
  vehicleNo: string;
  brandModel: string;
  status: string;
  bookings: { docNumber?: string; startDate: string; endDate: string }[];
}

// Prisma VehicleStatus enum values (ON_LEAVE is a DriverStatus, not a vehicle one)
const VEHICLE_STATUS: Record<string, 'green' | 'blue' | 'yellow' | 'red' | 'gray'> = {
  AVAILABLE: 'green',
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



type CarTab = 'availability' | 'requests';

export default function CarRequests() {
  // active tab lives in the URL (?tab=requests) so refresh / back / shared links keep it
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as CarTab | null;
  const tab: CarTab = tabParam === 'requests' ? 'requests' : 'availability';
  const setTab = (t: CarTab) => setSearchParams(t === 'availability' ? {} : { tab: t }, { replace: false });
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [fleet, setFleet] = useState<FleetVehicle[]>([]);
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
                    {v.bookings.map((b) => (
                      <div key={`${v.id}-${b.docNumber}-${b.startDate}`} className="text-xs text-orange-700 bg-orange-50 rounded px-2 py-1">
                        {b.docNumber ?? '—'}: {new Date(b.startDate).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        {' → '}
                        {new Date(b.endDate).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    ))}
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
                      {q.carRequest && `${new Date(q.carRequest.startDate).toLocaleString()} → ${new Date(q.carRequest.endDate).toLocaleString()}`}
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
                <td className="px-4 py-3"><span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                  r.status === 'APPROVED' ? 'bg-green-100 text-green-700'
                  : r.status === 'REJECTED' ? 'bg-red-100 text-red-700'
                  : r.status === 'PENDING_APPROVAL' ? 'bg-yellow-100 text-yellow-700'
                  : r.status === 'IN_PROGRESS' ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-600'
                }`}>{r.status}</span></td>
                <td className="px-4 py-3 text-gray-500">{r.totalLevels ? `${r.currentLevel}/${r.totalLevels}` : '—'}</td>
                <td className="px-4 py-3 text-gray-500">{new Date(r.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      )}
    </div>
  );
}
