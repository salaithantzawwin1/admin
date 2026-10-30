import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { Badge, Button, Card, Empty, Input, Select } from './ui';
import { toast } from './Toast';
import { useLiveReload } from '../hooks/useLiveReload';
import { fmtDateTime, fmtTime } from '../util/yangonTime';

interface CarRequest {
  id: string;
  destination: string;
  purpose?: string;
  startDate: string;
  endDate: string;
  timeSlot: string;
  pickupLocation?: string;
  specialRequest?: string | null;
  passengers: number;
  status: string;
  vehicleTypeRequired?: string;
  managerAckAt?: string | null;
  managerAckBy?: { fullName: string } | null;
  vehicle?: { id: string; vehicleNo: string; brandModel: string } | null;
  driver?: { id: string; name: string } | null;
  sharedTripId?: string | null;
  sharedRiders?: { requestId: string; docNumber: string; requester: string }[];
  /** the car the shared group rode, when this member's own vehicle link was cleared
   *  (the group's driver taps count for this member too — same car, same driver) */
  sharedRide?: {
    docNumber: string;
    vehicleNo: string | null;
    brandModel: string | null;
    driverName: string | null;
    notedAt?: string | null;
    arrivedAt?: string | null;
    backAtOfficeAt?: string | null;
  } | null;
  assignment?: {
    id: string;
    assignedAt: string;
    /** set = the assignment was handed back (release / janitor auto-release) */
    releasedAt?: string | null;
    driverNotedAt?: string | null;
    driverArrivedAt?: string | null;
    driverBackAtOfficeAt?: string | null;
    estimatedReturnAt?: string | null;
    trip?: { id: string; status: string; startMileage?: number; endMileage?: number } | null;
  } | null;
}

interface Vehicle {
  id: string;
  vehicleNo: string;
  brandModel: string;
  status: string;
}
interface Driver {
  id: string;
  name: string;
  status: string;
  absences?: { startsAt: string; endsAt: string; reason?: string | null }[];
}

/** Driver ids on an overlapping IN_PROGRESS trip (server truth, not just status label).
 *  Rules of Hooks: call this ONCE, unconditionally, from the component top level —
 *  pass enabled=false to skip the fetch instead of conditionally mounting the hook. */
function useBusyDrivers(tripStart: Date, tripEnd: Date, enabled: boolean): string[] {
  const [busy, setBusy] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled || !(tripStart instanceof Date) || Number.isNaN(tripStart.getTime())) return;
    api<string[]>(`/fleet/drivers/busy?start=${tripStart.toISOString()}&end=${tripEnd.toISOString()}`)
      .then(setBusy)
      .catch(() => setBusy([]));
  }, [enabled, tripStart.toISOString(), tripEnd.toISOString()]);
  return busy;
}
interface Expense {
  id: string;
  type: string;
  amount: string;
  description?: string;
  expenseDate: string;
}

export function CarPanel({
  requestId,
  status,
  isOwner,
  canView = true,
}: {
  requestId: string;
  status: string;
  isOwner: boolean;
  canView?: boolean;
}) {
  const [car, setCar] = useState<CarRequest | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [error, setError] = useState('');
  const [assignForm, setAssignForm] = useState({ vehicleId: '', driverId: '' });
  // shared-trip opt-in: allow assigning the same car+driver as an overlapping request
  const [share, setShare] = useState(false);
  const [shiftForm, setShiftForm] = useState({ startDate: '', endDate: '' });
  const [tripForm, setTripForm] = useState({ startMileage: '', endMileage: '', remarks: '' });
  const [expenseForm, setExpenseForm] = useState({ type: 'FUEL', amount: '', description: '' });
  // in-app dialogs (replace browser confirm/prompt)
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmShift, setConfirmShift] = useState(false);
  // ⌛ past-window guard: assigning a trip whose window already ended gets an
  // explicit warning (approval/assign of stale windows is allowed but must be deliberate)
  const [confirmAssign, setConfirmAssign] = useState(false);
  // change vehicle/driver of a live assignment (fleet plan change)
  const [reassignForm, setReassignForm] = useState({ vehicleId: '', driverId: '' });
  const [confirmReassign, setConfirmReassign] = useState(false);
  // Administration ⏰ ETA override (driver reported a delay by phone — record it)
  const [etaBusy, setEtaBusy] = useState(false);
  const [etaMinutes, setEtaMinutes] = useState('30');
  // optional manager ack (Department Head FYI — never blocks)
  const [canManagerAck, setCanManagerAck] = useState(false);
  // requester corrections (destination / passengers / pickup …) while the request
  // is still awaiting approval — the create flow submits immediately, so this is
  // the only moment a request can actually be corrected
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<{
    destination: string; purpose: string; passengers: string; pickupLocation: string; specialRequest: string;
  } | null>(null);
  const canAssign = hasPermission('cars.assign');
  // fleet.read guards /fleet/vehicles + /fleet/drivers server-side. Without it,
  // every employee opening a request fires two calls that only come back 403 —
  // the selects are rendered for Administration only, so skip the fetch entirely.
  const canSeeFleet = hasPermission('fleet.read');

  const load = useCallback(() => {
    api<CarRequest | null>(`/cars/requests/${requestId}`)
      .then((c) => {
        setCar(c);
        if (c?.assignment) api<Expense[]>(`/cars/requests/${requestId}/expenses`).then(setExpenses).catch(() => {});
      })
      .catch(() => setCar(null));
    if (canSeeFleet) {
      api<Vehicle[]>('/fleet/vehicles').then(setVehicles).catch(() => {});
      api<Driver[]>('/fleet/drivers').then(setDrivers).catch(() => {});
    }
  }, [requestId, canSeeFleet]);

  useEffect(load, [load]);

  // live push: driver Telegram taps (Noted/Ready/Back at Office), re-assignments
  // and request-level transitions (approve / shift / cancel) refresh this panel
  // instantly; the 15s polling elsewhere stays as fallback
  useLiveReload(['assignment.updated', 'driver.updated', 'request.updated'], (e) => {
    // only refetch when the signal concerns this request (or fleet-wide driver state)
    if (!e.requestId || e.requestId === requestId) load();
  });

  // manager-ack visibility: ask the backend whether I am an eligible department manager
  useEffect(() => {
    api<unknown[]>('/cars/manager-acks/pending')
      .then((rows) => setCanManagerAck(rows.some((r) => (r as { id: string }).id === requestId)))
      .catch(() => setCanManagerAck(false));
  }, [requestId]);

  // a re-assign after a conflict alert needs the shared-trip toggle again.
  // Rules of Hooks: must live ABOVE the early returns — a hook after `if (!car)
  // return null` fired "fewer hooks than the previous render" (React #310)
  // the moment the car data loaded/disappeared.
  useEffect(() => { setShare(false); }, [status, car?.assignment?.id]);

  // trip window of the current request (fallbacks keep the hook call stable while loading)
  const tripStart = car ? new Date(car.startDate) : new Date(0);
  const tripEnd = car ? new Date(car.endDate) : new Date(8640000000000000);
  // Rules of Hooks: ONE unconditional call — the assign/reassign blocks below only
  // consume the result. Calling the hook inside those conditional blocks crashed the
  // page (fewer hooks than the previous render) when the form appeared/disappeared.
  const busyDrivers = useBusyDrivers(tripStart, tripEnd, canAssign && !!car);

  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError('');
    try {
      await fn();
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      return false;
    }
  };

  if (!car) return null;
  if (!canView) {
    return (
      <Card className="p-5 mb-5 text-sm text-gray-500">
        Car details are visible to the requester and the Administration team.
      </Card>
    );
  }

  const assignment = car.assignment;
  const trip = assignment?.trip;
  // A RELEASED assignment row is history, not a live booking: release() and the
  // auto-release janitor put the request back into the APPROVED unassigned queue
  // with vehicleId cleared while the row keeps releasedAt set. Keying these flags
  // on `assignment` alone hid the Assign form for the whole 24h before the stale
  // request is expired (the queue still lists it — vehicleId is null) and showed
  // Start trip / Change assignment for a car that is already back in the pool.
  const liveAssignment = assignment && !assignment.releasedAt ? assignment : null;
  const showAssign = canAssign && status === 'APPROVED' && !liveAssignment;
  const canStart = canAssign && !!liveAssignment && !trip;
  // change vehicle/driver on a live assignment (before the trip starts)
  const canReassign = canAssign && !!liveAssignment && !trip;
  const canComplete = canAssign && trip?.status === 'STARTED';
  // Administration fleet-plan controls: cancel or shift time on live requests
  const showAdminControls = canAssign && ['APPROVED', 'PENDING_APPROVAL', 'IN_PROGRESS'].includes(status);

  // the requester may correct their own request until it is approved — after
  // that the booking belongs to Administration (assign / shift / driver notice)
  const canEdit = isOwner && (status === 'DRAFT' || status === 'PENDING_APPROVAL');

  const openEdit = () => {
    setEditForm({
      destination: car.destination,
      purpose: car.purpose ?? '',
      passengers: String(car.passengers ?? 1),
      pickupLocation: car.pickupLocation ?? '',
      specialRequest: car.specialRequest ?? '',
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!editForm) return;
    const ok = await act(() => api(`/cars/requests/${requestId}`, {
      method: 'PATCH',
      body: {
        destination: editForm.destination.trim(),
        purpose: editForm.purpose.trim() || undefined,
        // clamp instead of trusting the raw box: an empty/partial input must not
        // reach the DTO as 0 (Min(1)) and blow up the save
        passengers: Math.max(1, Math.floor(Number(editForm.passengers) || 1)),
        pickupLocation: editForm.pickupLocation.trim() || undefined,
        specialRequest: editForm.specialRequest.trim() || undefined,
      },
    }));
    if (ok) setEditing(false);
  };

  return (
    <Card className="p-5 mb-5">
      <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Car Request Details</h2>
      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mb-4">
        {/* every field sits in the same rounded box (label above, value below) so the
            row reads as one consistent set — Assigned is the tinted variant of it */}
        <div className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <div className="text-gray-400 text-xs uppercase tracking-wide">Destination</div>
          <div className="mt-1 font-medium text-gray-800">{car.destination}</div>
        </div>
        <div className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <div className="text-gray-400 text-xs uppercase tracking-wide">Start</div>
          <div className="mt-1 text-gray-800">{fmtDateTime(car.startDate)}</div>
        </div>
        <div className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <div className="text-gray-400 text-xs uppercase tracking-wide">End</div>
          <div className="mt-1 text-gray-800">{fmtDateTime(car.endDate)}</div>
        </div>
        <div className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <div className="text-gray-400 text-xs uppercase tracking-wide">Passengers</div>
          <div className="mt-1 text-gray-800">{car.passengers}</div>
        </div>
        <div className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <div className="text-gray-400 text-xs uppercase tracking-wide">Time slot</div>
          <div className="mt-1 text-gray-800">{car.timeSlot}</div>
        </div>
        <div className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <div className="text-gray-400 text-xs uppercase tracking-wide">Pickup</div>
          <div className="mt-1 text-gray-800">{car.pickupLocation ?? '—'}</div>
        </div>
        <div className="col-span-2 sm:col-span-4 rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <div className="text-gray-400 text-xs uppercase tracking-wide">Special request</div>
          <div className="mt-1">{car.specialRequest ? <Badge color="yellow">⭐ {car.specialRequest}</Badge> : <span className="text-gray-400">—</span>}</div>
        </div>
        <div className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2">
          <div className="text-gray-400 text-xs uppercase tracking-wide">Vehicle required</div>
          <div className="mt-1 text-gray-800">{car.vehicleTypeRequired ?? 'Any'}</div>
        </div>
        {/* Approval and assignment are Administration's steps; Noted / Ready /
            Back at office are the driver's. They fail independently, so they get
            separate lanes — "approved but no car" must not look like "driver
            never tapped Noted". */}
        <TripProgress status={status} car={car} />
        {/* Assigned takes the rest of the row: plate, driver, ack timeline and the
            ETA controls all live here — a 1/4-width column used to cram them into an
            unreadable stack. The tinted box reads as "this ride has a car". */}
        <div
          className={`col-span-2 sm:col-span-3 rounded-lg border px-3 py-2 ${
            car.vehicle ? 'border-blue-100 bg-blue-50/50' : 'border-dashed border-gray-200 bg-gray-50/50'
          }`}
        >
          <div className="text-gray-400 text-xs uppercase tracking-wide">Assigned</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {car.vehicle ? (
                <>
                  <Badge color="blue">🚗 {car.vehicle.vehicleNo}</Badge>
                  {car.vehicle.brandModel && <span className="text-xs text-gray-500">{car.vehicle.brandModel}</span>}
                </>
              ) : car.sharedRide?.vehicleNo ? (
                // shared ride: this member rode the group's car even though its own
                // vehicle link is gone — "no vehicle was assigned" would be a lie
                <>
                  <Badge color="blue">🚗 {car.sharedRide.vehicleNo}</Badge>
                  {car.sharedRide.brandModel && <span className="text-xs text-gray-500">{car.sharedRide.brandModel}</span>}
                  <span className="text-xs text-gray-500">🤝 shared with {car.sharedRide.docNumber}</span>
                </>
              ) : (
                <span className="text-sm text-gray-400">No vehicle picked yet</span>
              )}
              {(car.driver ?? car.sharedRide?.driverName) && (
                <span className="text-xs font-medium text-gray-700">👤 {car.driver?.name ?? car.sharedRide?.driverName}</span>
              )}
            </div>
          {/* ⏰ driver-reported ETA (Telegram ⏰ Delay) — red when it passes the planned end */}
          {assignment?.estimatedReturnAt && (
            <div className="mt-1">
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                  new Date(assignment.estimatedReturnAt) > new Date(car.endDate)
                    ? 'bg-red-50 border-red-200 text-red-700'
                    : 'bg-blue-50 border-blue-200 text-blue-700'
                }`}
              >
                ⏰ ETA {fmtTime(assignment.estimatedReturnAt)}
                {new Date(assignment.estimatedReturnAt) > new Date(car.endDate) ? ' · late' : ''}
              </span>
            </div>
          )}
          {/* Administration ⏰ ETA control — record a delay the driver reported by phone */}            {canAssign && liveAssignment && !assignment?.driverBackAtOfficeAt && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-500">
                <span className="font-medium text-gray-600">⏰ Set ETA</span>
                {[
                  { label: '+30 မ', m: 30 },
                  { label: '+1 န', m: 60 },
                  { label: '+3 န', m: 180 },
                ].map((q) => (
                  <button
                    key={q.m}
                    title={`Driver returns ${q.m} minutes from now`}
                    className="px-2 py-0.5 rounded-full border border-gray-200 text-gray-600 hover:border-gold hover:text-yellow-800 hover:bg-yellow-50 disabled:opacity-40 transition-colors"
                    disabled={etaBusy}
                  onClick={async () => {
                    setEtaBusy(true); setError('');
                    try {
                      await api(`/cars/requests/${requestId}/eta`, { method: 'POST', body: { minutes: q.m } });
                      toast(`ETA set to ${q.label} from now`);
                      load();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Failed to set ETA');
                    } finally {
                      setEtaBusy(false);
                    }
                  }}
                >
                  {q.label}
                </button>
              ))}
              <span className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={1}
                  max={4320}
                  value={etaMinutes}
                  onChange={(e) => setEtaMinutes(e.target.value)}
                  className="!w-16 !py-0.5 !text-xs"
                  placeholder="min"
                  aria-label="ETA minutes from now"
                />
                <Button
                variant="ghost"
                disabled={etaBusy || !Number(etaMinutes)}
                onClick={async () => {
                  setEtaBusy(true); setError('');
                  try {
                    await api(`/cars/requests/${requestId}/eta`, { method: 'POST', body: { minutes: Number(etaMinutes) } });
                    toast('ETA saved — Administration & requester notified');
                    setEtaMinutes('30');
                    load();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Failed to set ETA');
                  } finally {
                    setEtaBusy(false);
                  }
                }}
              >
                Save
              </Button>
              </span>
            </div>
          )}
          {car.sharedTripId && car.sharedRiders && car.sharedRiders.length > 0 && (
            <div className="mt-1 text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded px-2 py-1">
              🧑‍🤝‍🧑 Shared trip with {car.sharedRiders.map((r) => `${r.docNumber} (${r.requester})`).join(', ')}
            </div>
          )}
        </div>
      </div>

      {/* requester corrections — destination / passengers / pickup while the request
          is still awaiting approval. There was no edit path at all: the backend
          PATCH only accepted DRAFT, but the create flow submits immediately, so
          every request a user can open was already PENDING_APPROVAL. */}
      {canEdit && !editing && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-500">Need to change the destination, passenger count or pickup?</span>
          <Button variant="ghost" onClick={openEdit}>✏️ Edit request</Button>
        </div>
      )}

      {editing && editForm && (
        <div className="border-t border-gray-100 pt-4 mt-4 mb-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Edit request — still awaiting approval</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="car-edit-destination" className="block text-xs text-gray-500 mb-1">Destination *</label>
              <Input id="car-edit-destination" value={editForm.destination} onChange={(e) => setEditForm({ ...editForm, destination: e.target.value })} />
            </div>
            <div>
              <label htmlFor="car-edit-passengers" className="block text-xs text-gray-500 mb-1">Passengers</label>
              <Input
                id="car-edit-passengers"
                type="number"
                min={1}
                max={60}
                value={editForm.passengers}
                onChange={(e) => setEditForm({ ...editForm, passengers: e.target.value })}
                onBlur={() => setEditForm((f) => (f ? { ...f, passengers: String(Math.max(1, Math.floor(Number(f.passengers) || 1))) } : f))}
                describe="1–60 — this is what the vehicle picker shows Administration"
              />
            </div>
            <div>
              <label htmlFor="car-edit-purpose" className="block text-xs text-gray-500 mb-1">Purpose</label>
              <Input id="car-edit-purpose" value={editForm.purpose} onChange={(e) => setEditForm({ ...editForm, purpose: e.target.value })} />
            </div>
            <div>
              <label htmlFor="car-edit-pickup" className="block text-xs text-gray-500 mb-1">Pickup location</label>
              <Input id="car-edit-pickup" value={editForm.pickupLocation} onChange={(e) => setEditForm({ ...editForm, pickupLocation: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="car-edit-special" className="block text-xs text-gray-500 mb-1">Special request</label>
              <Input id="car-edit-special" value={editForm.specialRequest} onChange={(e) => setEditForm({ ...editForm, specialRequest: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button disabled={!editForm.destination.trim()} onClick={() => void saveEdit()}>Save</Button>
          </div>
          <p className="text-xs text-gray-400 mt-1.5">
            Times and slots are changed by Administration (Shift time). Once the request is approved it can no longer be edited here.
          </p>
        </div>
      )}

      {/* optional manager acknowledgement (Department Head) — never blocks */}
      {status !== 'DRAFT' && (car.managerAckAt || canManagerAck) && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          {car.managerAckAt ? (
            <span className="text-green-700">✅ Manager acknowledged{car.managerAckBy ? ` — ${car.managerAckBy.fullName}` : ''} · {fmtDateTime(car.managerAckAt)}</span>
          ) : (
            <>
              <span className="text-gray-500">Department manager has not acknowledged yet (optional — does not delay the trip).</span>
              <Button
                variant="ghost"
                onClick={() => act(() => api(`/cars/requests/${requestId}/manager-ack`, { method: 'POST' }))}
              >
                👍 Acknowledge
              </Button>
            </>
          )}
        </div>
      )}

      {showAdminControls && (
        <div className="border-t border-gray-100 pt-4 mt-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Administration — plan change</div>
          <div className="flex flex-wrap gap-2 items-center">
            <Input type="datetime-local" className="!w-56" value={shiftForm.startDate} onChange={(e) => setShiftForm({ ...shiftForm, startDate: e.target.value })} placeholder="New start" />
            <Input type="datetime-local" className="!w-56" value={shiftForm.endDate} onChange={(e) => setShiftForm({ ...shiftForm, endDate: e.target.value })} placeholder="End (optional — keeps duration)" title="Leave empty to keep the trip duration — only the start moves" />
            <Button
              variant="ghost"
              disabled={!shiftForm.startDate}
              onClick={() => setConfirmShift(true)}
            >
              Shift time
            </Button>
            <Button
              variant="danger"
              onClick={() => setConfirmCancel(true)}
            >
              Cancel request
            </Button>
          </div>
          {/* Quick actions — push the WHOLE window forward by a fixed amount.
              Pre-fills the Shift-time fields; the actual move happens on the
              confirmed Shift (availability is checked server-side there, and
              the requester + driver get the change notices). */}
          <div className="flex flex-wrap gap-1.5 items-center mt-2">
            <span className="text-xs text-gray-400 mr-1">Push trip by:</span>
            {[
              { mins: 30, label: '+30 min' },
              { mins: 60, label: '+1 hour' },
              { mins: 180, label: '+3 hours' },
            ].map((q) => (
              <button
                key={q.mins}
                onClick={() => {
                  const s = new Date(car.startDate);
                  const e = new Date(car.endDate);
                  s.setMinutes(s.getMinutes() + q.mins);
                  e.setMinutes(e.getMinutes() + q.mins);
                  const loc = (d: Date) => {
                    const p = (n: number) => String(n).padStart(2, '0');
                    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
                  };
                  setShiftForm({ startDate: loc(s), endDate: loc(e) });
                }}
                className="px-2 py-1 text-xs rounded-full border border-gray-300 bg-white text-gray-600 hover:bg-gold/10 hover:border-gold transition-colors"
              >
                {q.label}
              </button>
            ))}
            <span className="text-xs text-gray-400 ml-1">→ fills the Shift-time fields above, then press Shift time to confirm</span>
          </div>
          <p className="text-xs text-gray-400 mt-1.5">Shift time moves the window (vehicle availability is checked). Cancel frees the car and notifies the requester.</p>
        </div>
      )}

      {confirmShift && (
        <ConfirmDialog
          title="Shift time?"
          description={
            <>
              Move this car request to <b>{fmtDateTime(shiftForm.startDate)}</b>
              {shiftForm.endDate
                ? <> → <b>{fmtDateTime(shiftForm.endDate)}</b></>
                : <> (end keeps the original trip duration)</>}. Vehicle availability is checked; the requester will be notified.
            </>
          }
          confirmLabel="Shift time"
          withNote
          onConfirm={async (note) => {
            const ok = await act(() => api(`/cars/requests/${requestId}/admin-shift`, {
              method: 'PATCH',
              body: {
                startDate: new Date(shiftForm.startDate).toISOString(),
                // End optional — empty means "keep the original duration" (server-side)
                ...(shiftForm.endDate ? { endDate: new Date(shiftForm.endDate).toISOString() } : {}),
                comment: note || undefined,
              },
            }));
            if (ok) setConfirmShift(false);
          }}
          onClose={() => setConfirmShift(false)}
        />
      )}

      {confirmCancel && (
        <ConfirmDialog
          title="Cancel this car request?"
          description="The assigned vehicle and driver (if any) will be released, and the requester will be notified."
          confirmLabel="Cancel request"
          variant="danger"
          withNote
          onConfirm={async (note) => {
            const ok = await act(() => api(`/cars/requests/${requestId}/admin-cancel`, { method: 'POST', body: { comment: note || undefined } }));
            if (ok) setConfirmCancel(false);
          }}
          onClose={() => setConfirmCancel(false)}
        />
      )}

      {showAssign && (() => {
        // tripStart/tripEnd/busyDrivers come from the unconditional top-level hook call
        return (
        <div className="border-t border-gray-100 pt-4 mt-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Assign vehicle (Administration)</div>
          <div className="flex flex-wrap gap-2 items-center">
            <Select className="!w-56" value={assignForm.vehicleId} onChange={(e) => setAssignForm({ ...assignForm, vehicleId: e.target.value })}>
              <option value="">— Vehicle —</option>
              {vehicles.filter((v) => v.status === 'AVAILABLE' || v.status === 'IN_USE').map((v) => (
                <option key={v.id} value={v.id}>{v.vehicleNo} — {v.brandModel} ({v.status})</option>
              ))}
            </Select>
            <Select className="!w-48" value={assignForm.driverId} onChange={(e) => setAssignForm({ ...assignForm, driverId: e.target.value })}>
              <option value="">— Driver (optional) —</option>
              {drivers.map((d) => {
                const absent = d.absences?.some((a) => new Date(a.startsAt) < tripEnd && new Date(a.endsAt) > tripStart);
                const onTrip = busyDrivers.includes(d.id);
                return (
                  <option key={d.id} value={d.id} disabled={absent || (!share && onTrip)}>
                    {d.name}{onTrip ? ' · on the way (busy)' : absent ? ' · on planned absence' : ''}
                  </option>
                );
              })}
            </Select>
            <Button
              disabled={!assignForm.vehicleId}
              onClick={() => {
                // ⌛ window already ended → warn first (the ride must have happened,
                // otherwise the request should be cancelled/expired, not assigned)
                if (tripEnd.getTime() < Date.now()) {
                  setConfirmAssign(true);
                  return;
                }
                void act(() => api(`/cars/requests/${requestId}/assign`, { method: 'POST', body: { ...assignForm, share, driverId: assignForm.driverId || undefined } }));
              }}
            >
              Assign
            </Button>
          </div>
          {/* Shared trip (convoy): same car+driver as an overlapping request.
              The overlap error only appears WITHOUT the flag — with it, the
              group is stamped server-side and the driver sees both riders. */}
          <label className="flex items-center gap-2 mt-2 text-xs text-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={share}
              onChange={(e) => setShare(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-gray-300 text-gold focus:ring-gold/50"
            />
            Same car &amp; driver as another trip (shared ride — pick the vehicle and the driver of the trip you are joining)
          </label>
        </div>
        );
      })()}

      {confirmAssign && (
        <ConfirmDialog
          title="Trip window already ended"
          description={
            <>
              The trip window <b>{fmtDateTime(tripStart)} → {fmtDateTime(tripEnd)}</b> is already in the past.
              Assign anyway only if the ride really happened (or will still happen as planned) — otherwise cancel it
              or let the24-hour auto-expire close it.
            </>
          }
          confirmLabel="Assign anyway"
          onConfirm={async () => {
            const ok = await act(() => api(`/cars/requests/${requestId}/assign`, { method: 'POST', body: { ...assignForm, share, driverId: assignForm.driverId || undefined } }));
            if (ok) setConfirmAssign(false);
          }}
          onClose={() => setConfirmAssign(false)}
        />
      )}

      {canReassign && (() => {
        // tripStart/tripEnd/busyDrivers come from the unconditional top-level hook call
        return (
        <div className="border-t border-gray-100 pt-4 mt-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Change vehicle / driver</div>
          <div className="flex flex-wrap gap-2 items-center">
            <Select className="!w-56" value={reassignForm.vehicleId} onChange={(e) => setReassignForm({ ...reassignForm, vehicleId: e.target.value, driverId: e.target.value === reassignForm.driverId ? '' : reassignForm.driverId })}>
              <option value="">— Vehicle —</option>
              {vehicles
                .filter((v) => v.status === 'AVAILABLE' || v.status === 'IN_USE' || v.id === car.vehicle?.id)
                .map((v) => (
                  <option key={v.id} value={v.id}>{v.vehicleNo} — {v.brandModel}{v.id === car.vehicle?.id ? ' (current)' : ''}</option>
                ))}
            </Select>
            <Select className="!w-48" value={reassignForm.driverId} onChange={(e) => setReassignForm({ ...reassignForm, driverId: e.target.value })}>
              <option value="">— Driver (optional) —</option>
              {drivers
                .filter((d) => d.status === 'AVAILABLE' || d.id === car.driver?.id)
                .map((d) => {
                  const onOtherTrip = busyDrivers.includes(d.id) && d.id !== car.driver?.id;
                  const absent = d.absences?.some((a) => new Date(a.startsAt) < tripEnd && new Date(a.endsAt) > tripStart) && d.id !== car.driver?.id;
                  return (
                    <option key={d.id} value={d.id} disabled={onOtherTrip || absent}>
                      {d.name}{d.id === car.driver?.id ? ' (current)' : onOtherTrip ? ' · on the way (busy)' : absent ? ' · on planned absence' : ''}
                    </option>
                  );
                })}
            </Select>
            <Button
              variant="ghost"
              disabled={!reassignForm.vehicleId || (reassignForm.vehicleId === car.vehicle?.id && (reassignForm.driverId || '') === (car.driver?.id || ''))}
              onClick={() => setConfirmReassign(true)}
            >
              Change assignment
            </Button>
          </div>
          <p className="text-xs text-gray-400 mt-1.5">
            The previous driver gets a Telegram notice that the trip is no longer theirs; the new driver gets the route message; the requester is notified.
          </p>
        </div>
        );
      })()}

      {confirmReassign && (
        <ConfirmDialog
          title="Change vehicle / driver?"
          description={
            <>
              Switch this trip to <b>{vehicles.find((v) => v.id === reassignForm.vehicleId)?.vehicleNo}</b>
              {reassignForm.driverId && <> with driver <b>{drivers.find((d) => d.id === reassignForm.driverId)?.name}</b></>}.
              The current driver{car.driver?.name ? ` (${car.driver.name})` : ''} will be notified on Telegram that the trip is no longer theirs, and the requester will be told about the change.
            </>
          }
          confirmLabel="Change assignment"
          withNote
          onConfirm={async (note) => {
            const ok = await act(() => api(`/cars/requests/${requestId}/reassign`, {
              method: 'POST',
              body: { vehicleId: reassignForm.vehicleId, driverId: reassignForm.driverId || undefined, comment: note || undefined },
            }));
            if (ok) {
              setConfirmReassign(false);
              setReassignForm({ vehicleId: '', driverId: '' });
            }
          }}
          onClose={() => setConfirmReassign(false)}
        />
      )}

      {canStart && (
        <div className="border-t border-gray-100 pt-4 mt-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Start trip</div>
          <div className="flex gap-2 items-center">
            <Input className="!w-48" type="number" min={0} placeholder="Start odometer (km)" value={tripForm.startMileage} onChange={(e) => setTripForm({ ...tripForm, startMileage: e.target.value })} />
            <Button disabled={!tripForm.startMileage} onClick={() => act(() => api(`/cars/requests/${requestId}/trip/start`, { method: 'POST', body: { startMileage: Number(tripForm.startMileage) } }))}>
              Start Trip
            </Button>
          </div>
        </div>
      )}

      {canComplete && (
        <div className="border-t border-gray-100 pt-4 mt-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Complete trip (started at {trip?.startMileage} km)</div>
          <div className="flex flex-wrap gap-2 items-center">
            <Input className="!w-48" type="number" min={0} placeholder="End odometer (km)" value={tripForm.endMileage} onChange={(e) => setTripForm({ ...tripForm, endMileage: e.target.value })} />
            <Input className="!w-64" placeholder="Remarks (optional)" value={tripForm.remarks} onChange={(e) => setTripForm({ ...tripForm, remarks: e.target.value })} />
            <Button
              disabled={!tripForm.endMileage}
              onClick={() => act(() => api(`/cars/requests/${requestId}/trip/complete`, { method: 'POST', body: { endMileage: Number(tripForm.endMileage), remarks: tripForm.remarks || undefined } }))}
            >
              Complete Trip
            </Button>
          </div>
        </div>
      )}

      {trip && (
        <div className="mt-4 text-sm text-gray-600 border-t border-gray-100 pt-3">
          Trip: <Badge color={trip.status === 'COMPLETED' ? 'green' : 'blue'}>{trip.status}</Badge>
          {trip.startMileage != null && <span className="ml-2">Start: {trip.startMileage.toLocaleString()} km</span>}
          {trip.endMileage != null && <span className="ml-2">End: {trip.endMileage.toLocaleString()} km</span>}
          {trip.startMileage != null && trip.endMileage != null && (
            <span className="ml-2 font-medium">Distance: {(trip.endMileage - trip.startMileage).toLocaleString()} km</span>
          )}
        </div>
      )}

      {/* expenses hang off the trip record — without one, Add Expense always fails
          with "Trip not started for this request" (released/stale rows included) */}
      {trip && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Expenses (fuel, toll, parking…)</div>
          {expenses.length === 0 && <div className="text-xs text-gray-400 mb-2">No expenses recorded.</div>}
          {expenses.length > 0 && (
            <ul className="mb-3 space-y-1 text-sm">
              {expenses.map((x) => (
                <li key={x.id} className="flex justify-between">
                  <span>{x.type}{x.description ? ` — ${x.description}` : ''}</span>
                  <span className="font-medium">{Number(x.amount).toLocaleString()} MMK</span>
                </li>
              ))}
            </ul>
          )}
          {(canAssign || isOwner) && (
            <div className="flex flex-wrap gap-2 items-center">
              <Select className="!w-32" value={expenseForm.type} onChange={(e) => setExpenseForm({ ...expenseForm, type: e.target.value })}>
                <option value="FUEL">Fuel</option>
                <option value="TOLL">Toll</option>
                <option value="PARKING">Parking</option>
                <option value="REPAIR">Repair</option>
                <option value="OTHER">Other</option>
              </Select>
              <Input className="!w-36" type="number" min={0} placeholder="Amount" value={expenseForm.amount} onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })} />
              <Input className="!w-52" placeholder="Description (optional)" value={expenseForm.description} onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })} />
              <Button
                variant="ghost"
                disabled={!expenseForm.amount}
                onClick={() => act(() => api(`/cars/requests/${requestId}/expenses`, { method: 'POST', body: { ...expenseForm, amount: Number(expenseForm.amount) } }))}
              >
                Add Expense
              </Button>
            </div>
          )}
        </div>
      )}

      {!liveAssignment && !canAssign && (
        <div className="mt-2 text-xs text-gray-400">Vehicle assignment appears here after Administration assigns a car (requires APPROVED status).</div>
      )}
    </Card>
  );
}

/** Driver acknowledgment stages — Noted (admin assign acknowledged) → Arrived
 *  (car ready) → Back at Office (vehicle free). Filled by the driver's Telegram
 *  buttons; Administration and the requester both see them here. */
/**
 * Two-lane lifecycle: Administration (approve → assign the car) and the driver
 * (Noted → Ready → Back at office). Deliberately split — an APPROVED request
 * with no car and an assigned car the driver never acknowledged are different
 * problems for different people, and one joined row hid which side was stuck.
 */
export function TripProgress({ status, car }: { status: string; car: CarRequest }) {
  const a = car.assignment;
  const approved = ['APPROVED', 'IN_PROGRESS', 'COMPLETED'].includes(status);
  const refused = ['REJECTED', 'CANCELLED', 'RETURNED'].includes(status);
  const assigned = !!(car.vehicle || a || car.sharedRide?.vehicleNo);
  const chip = (state: 'done' | 'pending' | 'off', text: string, at?: string | null) => (
    <span
      key={text}
      className={`px-2 py-0.5 rounded-full border text-xs whitespace-nowrap ${
        state === 'done'
          ? 'bg-green-50 border-green-200 text-green-700'
          : state === 'pending'
            ? 'bg-amber-50 border-amber-200 text-amber-700'
            : 'bg-gray-50 border-gray-200 text-gray-400'
      }`}
      title={at ? `${text} · ${fmtDateTime(at)}` : undefined}
    >
      {state === 'done' ? '✓' : state === 'pending' ? '⏳' : '–'} {text}
      {state === 'done' && at ? ` ${fmtTime(at)}` : ''}
    </span>
  );
  return (
    <div className="col-span-2 sm:col-span-4 rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2 space-y-1.5">
      <div className="text-gray-400 text-xs uppercase tracking-wide">Trip progress</div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 shrink-0 text-[11px] uppercase tracking-wide text-gray-400">Administration</span>
        {approved
          ? chip('done', 'Approved')
          : refused
            ? chip('off', status === 'REJECTED' ? 'Rejected' : 'Cancelled')
            : chip('pending', 'Awaiting approval')}
        {assigned
          ? chip('done', 'Car assigned')
          : approved
            ? chip('pending', 'Not assigned yet')
            : chip('off', 'Car assigned')}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 shrink-0 text-[11px] uppercase tracking-wide text-gray-400">Driver</span>
        {a || car.sharedRide?.notedAt || car.sharedRide?.backAtOfficeAt ? (
          <>
            {chip(a?.driverNotedAt || car.sharedRide?.notedAt ? 'done' : 'pending', 'Noted', a?.driverNotedAt ?? car.sharedRide?.notedAt)}
            {chip(a?.driverArrivedAt || car.sharedRide?.arrivedAt ? 'done' : 'pending', 'Ready', a?.driverArrivedAt ?? car.sharedRide?.arrivedAt)}
            {chip(a?.driverBackAtOfficeAt || car.sharedRide?.backAtOfficeAt ? 'done' : 'pending', 'Back at office', a?.driverBackAtOfficeAt ?? car.sharedRide?.backAtOfficeAt)}
          </>
        ) : (
          <span className="text-xs text-gray-400">No driver assigned yet</span>
        )}
      </div>
    </div>
  );
}

export function DriverAckStages({ a }: { a: NonNullable<CarRequest['assignment']> }) {
  const fmt = (iso?: string | null) => (iso ? fmtTime(iso) : '');
  const stages = [
    { key: 'noted', label: 'Noted', at: a.driverNotedAt, icon: '✓' },
    { key: 'arrived', label: 'Ready', at: a.driverArrivedAt, icon: '🚦' },
    { key: 'returned', label: 'Back at office', at: a.driverBackAtOfficeAt, icon: '🏁' },
  ];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {stages.map((s) => (
        <span
          key={s.key}
          className={`px-2 py-0.5 rounded-full border ${
            s.at
              ? 'bg-green-50 border-green-200 text-green-700'
              : 'bg-gray-50 border-gray-200 text-gray-400'
          }`}
          title={s.at ? `${s.label} at ${fmtDateTime(s.at)}` : `Waiting for driver — ${s.label}`}
        >
          {s.at ? `${s.icon} ${s.label} ${fmt(s.at)}` : `⏳ ${s.label}`}
        </span>
      ))}
    </div>
  );
}
