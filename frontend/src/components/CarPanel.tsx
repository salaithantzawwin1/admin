import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { Badge, Button, Card, Empty, Input, Select } from './ui';
import { useLiveReload } from '../hooks/useLiveReload';

interface CarRequest {
  id: string;
  destination: string;
  purpose?: string;
  startDate: string;
  endDate: string;
  timeSlot: string;
  pickupLocation?: string;
  passengers: number;
  status: string;
  vehicleTypeRequired?: string;
  managerAckAt?: string | null;
  managerAckBy?: { fullName: string } | null;
  vehicle?: { id: string; vehicleNo: string; brandModel: string } | null;
  driver?: { id: string; name: string } | null;
  assignment?: {
    id: string;
    assignedAt: string;
    driverNotedAt?: string | null;
    driverArrivedAt?: string | null;
    driverBackAtOfficeAt?: string | null;
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
  const [shiftForm, setShiftForm] = useState({ startDate: '', endDate: '' });
  const [tripForm, setTripForm] = useState({ startMileage: '', endMileage: '', remarks: '' });
  const [expenseForm, setExpenseForm] = useState({ type: 'FUEL', amount: '', description: '' });
  // in-app dialogs (replace browser confirm/prompt)
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmShift, setConfirmShift] = useState(false);
  // change vehicle/driver of a live assignment (fleet plan change)
  const [reassignForm, setReassignForm] = useState({ vehicleId: '', driverId: '' });
  const [confirmReassign, setConfirmReassign] = useState(false);
  // optional manager ack (Department Head FYI — never blocks)
  const [canManagerAck, setCanManagerAck] = useState(false);
  const canAssign = hasPermission('cars.assign');

  const load = useCallback(() => {
    api<CarRequest | null>(`/cars/requests/${requestId}`)
      .then((c) => {
        setCar(c);
        if (c?.assignment) api<Expense[]>(`/cars/requests/${requestId}/expenses`).then(setExpenses).catch(() => {});
      })
      .catch(() => setCar(null));
    api<Vehicle[]>('/fleet/vehicles').then(setVehicles).catch(() => {});
    api<Driver[]>('/fleet/drivers').then(setDrivers).catch(() => {});
  }, [requestId]);

  useEffect(load, [load]);

  // live push: driver Telegram taps (Noted/Ready/Back at Office) and re-assignments
  // refresh this panel instantly; the 15s polling elsewhere stays as fallback
  useLiveReload(['assignment.updated', 'driver.updated'], (e) => {
    // only refetch when the signal concerns this request (or fleet-wide driver state)
    if (!e.requestId || e.requestId === requestId) load();
  });

  // manager-ack visibility: ask the backend whether I am an eligible department manager
  useEffect(() => {
    api<unknown[]>('/cars/manager-acks/pending')
      .then((rows) => setCanManagerAck(rows.some((r) => (r as { id: string }).id === requestId)))
      .catch(() => setCanManagerAck(false));
  }, [requestId]);

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
  const showAssign = canAssign && status === 'APPROVED' && !assignment;
  const canStart = canAssign && assignment && !trip;
  // change vehicle/driver on a live assignment (before the trip starts)
  const canReassign = canAssign && assignment && !trip;
  const canComplete = canAssign && trip?.status === 'STARTED';
  // Administration fleet-plan controls: cancel or shift time on live requests
  const showAdminControls = canAssign && ['APPROVED', 'PENDING_APPROVAL', 'IN_PROGRESS'].includes(status);

  return (
    <Card className="p-5 mb-5">
      <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Car Request Details</h2>
      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mb-4">
        <div><div className="text-gray-400 text-xs uppercase">Destination</div><div className="mt-1 font-medium">{car.destination}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">Start</div><div className="mt-1">{new Date(car.startDate).toLocaleString()}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">End</div><div className="mt-1">{new Date(car.endDate).toLocaleString()}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">Passengers</div><div className="mt-1">{car.passengers}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">Time slot</div><div className="mt-1">{car.timeSlot}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">Pickup</div><div className="mt-1">{car.pickupLocation ?? '—'}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">Vehicle required</div><div className="mt-1">{car.vehicleTypeRequired ?? 'Any'}</div></div>
        <div>
          <div className="text-gray-400 text-xs uppercase">Assigned</div>
          <div className="mt-1">
            {car.vehicle ? <Badge color="blue">{car.vehicle.vehicleNo}</Badge> : <span className="text-gray-400">Not yet</span>}
            {car.driver && <div className="text-xs text-gray-500 mt-1">Driver: {car.driver.name}</div>}
          </div>
          {assignment && <DriverAckStages a={assignment} />}
        </div>
      </div>

      {/* optional manager acknowledgement (Department Head) — never blocks */}
      {status !== 'DRAFT' && (car.managerAckAt || canManagerAck) && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          {car.managerAckAt ? (
            <span className="text-green-700">✅ Manager acknowledged{car.managerAckBy ? ` — ${car.managerAckBy.fullName}` : ''} · {new Date(car.managerAckAt).toLocaleString()}</span>
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
            <Input type="datetime-local" className="!w-56" value={shiftForm.startDate} onChange={(e) => setShiftForm({ ...shiftForm, startDate: e.target.value })} />
            <Input type="datetime-local" className="!w-56" value={shiftForm.endDate} onChange={(e) => setShiftForm({ ...shiftForm, endDate: e.target.value })} />
            <Button
              variant="ghost"
              disabled={!shiftForm.startDate || !shiftForm.endDate}
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
          <p className="text-xs text-gray-400 mt-1.5">Shift time moves the window (vehicle availability is checked). Cancel frees the car and notifies the requester.</p>
        </div>
      )}

      {confirmShift && (
        <ConfirmDialog
          title="Shift time?"
          description={
            <>Move this car request to <b>{new Date(shiftForm.startDate).toLocaleString()}</b> → <b>{new Date(shiftForm.endDate).toLocaleString()}</b>. Vehicle availability is checked; the requester will be notified.</>
          }
          confirmLabel="Shift time"
          withNote
          onConfirm={async (note) => {
            const ok = await act(() => api(`/cars/requests/${requestId}/admin-shift`, {
              method: 'PATCH',
              body: { startDate: new Date(shiftForm.startDate).toISOString(), endDate: new Date(shiftForm.endDate).toISOString(), comment: note || undefined },
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
              {drivers.filter((d) => d.status === 'AVAILABLE').map((d) => {
                const absent = d.absences?.some((a) => new Date(a.startsAt) < tripEnd && new Date(a.endsAt) > tripStart);
                const onTrip = busyDrivers.includes(d.id);
                return (
                  <option key={d.id} value={d.id} disabled={absent || onTrip}>
                    {d.name}{onTrip ? ' · on the way (busy)' : absent ? ' · on planned absence' : ''}
                  </option>
                );
              })}
            </Select>
            <Button
              disabled={!assignForm.vehicleId}
              onClick={() => act(() => api(`/cars/requests/${requestId}/assign`, { method: 'POST', body: { ...assignForm, driverId: assignForm.driverId || undefined } }))}
            >
              Assign
            </Button>
          </div>
        </div>
        );
      })()}

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

      {assignment && (
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

      {!assignment && !canAssign && (
        <div className="mt-2 text-xs text-gray-400">Vehicle assignment appears here after Administration assigns a car (requires APPROVED status).</div>
      )}
    </Card>
  );
}

/** Driver acknowledgment stages — Noted (admin assign acknowledged) → Arrived
 *  (car ready) → Back at Office (vehicle free). Filled by the driver's Telegram
 *  buttons; Administration and the requester both see them here. */
export function DriverAckStages({ a }: { a: NonNullable<CarRequest['assignment']> }) {
  const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
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
          title={s.at ? `${s.label} at ${new Date(s.at).toLocaleString()}` : `Waiting for driver — ${s.label}`}
        >
          {s.at ? `${s.icon} ${s.label} ${fmt(s.at)}` : `⏳ ${s.label}`}
        </span>
      ))}
    </div>
  );
}
