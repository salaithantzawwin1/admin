import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';
import { Badge, Button, Card, Empty, Input, PageHeader, Select } from '../components/ui';

interface Driver {
  id: string;
  name: string;
  phone?: string;
  licenseNo?: string;
  status: string;
  vehicles?: { vehicleNo: string }[];
  telegramChatId?: string | null;
  telegramUsername?: string | null;
  employee?: { id: string; employeeNo: string; fullName: string } | null;
  absences?: { startsAt: string; endsAt: string; reason?: string | null }[];
}

interface Absence {
  id: string;
  driverId: string;
  driver?: { id: string; name: string };
  startsAt: string;
  endsAt: string;
  /** Leave model against the Company Time Table */
  dayType: 'FULL' | 'HALF';
  period: 'FULL_DAY' | 'MORNING' | 'EVENING';
  reason?: string | null;
  status: string;
  createdAt: string;
}

/** The Company Time Table (Settings → Company Time Table). */
interface Timetable {
  workStart: string;
  workEnd: string;
  halfDaySplit: string;
  workDays: number[];
}

/** One row of the correlated driver+employee assignment history. */
interface CorrRow {
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

/** Telegram binding state — fleet managers only (bind codes are linking secrets). */
interface TgBinding {
  id: string;
  telegramChatId: string | null;
  telegramBindCode: string | null;
}
interface Vehicle {
  id: string;
  vehicleNo: string;
  vehicleType: string;
  brandModel: string;
  capacity: number;
  currentMileage: number;
  status: string;
  driver?: { name: string } | null;
  driverId?: string | null;
}

const VEHICLE_STATUS: Record<string, 'green' | 'blue' | 'yellow' | 'red'> = {
  AVAILABLE: 'green',
  IN_USE: 'blue',
  UNDER_MAINTENANCE: 'yellow',
  OUT_OF_SERVICE: 'red',
};
const DRIVER_STATUS: Record<string, 'green' | 'blue' | 'yellow' | 'red' | 'gray'> = {
  AVAILABLE: 'green',
  ON_TRIP: 'blue',
  ON_LEAVE: 'yellow',
  INACTIVE: 'gray',
};

interface VehicleTypeRow {
  id: string;
  name: string;
  active: boolean;
}
const VEHICLE_STATUSES = ['AVAILABLE', 'IN_USE', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE'];
const DRIVER_STATUSES = ['AVAILABLE', 'ON_TRIP', 'ON_LEAVE', 'INACTIVE'];

const emptyVForm = { vehicleNo: '', vehicleType: '', brandModel: '', capacity: 4, driverId: '', status: 'AVAILABLE' };
const emptyDForm = { name: '', phone: '', licenseNo: '', status: 'AVAILABLE' };

export default function Fleet() {
  const [bindCodeFor, setBindCodeFor] = useState<string | null>(null);
  const [bindings, setBindings] = useState<Record<string, TgBinding>>({});
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modalError, setModalError] = useState(''); // submit errors show inside the dialog, not on the page
  const [vForm, setVForm] = useState(emptyVForm);
  const [dForm, setDForm] = useState(emptyDForm);
  const [showV, setShowV] = useState(false);
  const [showD, setShowD] = useState(false);
  const [editingV, setEditingV] = useState<Vehicle | null>(null);
  const [editingD, setEditingD] = useState<Driver | null>(null);
  const [deletingV, setDeletingV] = useState<Vehicle | null>(null);
  const [deletingD, setDeletingD] = useState<Driver | null>(null);
  const [deletingType, setDeletingType] = useState<VehicleTypeRow | null>(null);
  const [cancelingAbsence, setCancelingAbsence] = useState<Absence | null>(null);
  // employee link picker state (driverId → employeeId or '')
  const [empPick, setEmpPick] = useState<Record<string, string>>({});
  const [historyFor, setHistoryFor] = useState<Driver | null>(null);
  const [history, setHistory] = useState<{ driver: { id: string; name: string }; employee: { id: string; employeeNo: string; fullName: string } | null; assignments: CorrRow[] } | null>(null);
  const [empOptions, setEmpOptions] = useState<{ id: string; employeeNo: string; fullName: string; linkedDriver?: string | null }[]>([]);
  // planned absences (leave) — list + form state
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [absenceForm, setAbsenceForm] = useState<{ driverId: string; date: string; dayType: 'FULL' | 'HALF'; period: 'MORNING' | 'EVENING'; reason: string }>({
    driverId: '', date: '', dayType: 'FULL', period: 'MORNING', reason: '',
  });
  // editing an existing row (CRUD) — holds the absence being edited
  const [editingAbsence, setEditingAbsence] = useState<Absence | null>(null);
  const [deletingAbsence, setDeletingAbsence] = useState<Absence | null>(null);
  // Company Time Table — shown in the form hint, used for window display
  const [timetable, setTimetable] = useState<Timetable | null>(null);
  // edit-in-row form (absence CRUD)
  const [editForm, setEditForm] = useState<{ date: string; dayType: 'FULL' | 'HALF'; period: 'MORNING' | 'EVENING'; reason: string }>({
    date: '', dayType: 'FULL', period: 'MORNING', reason: '',
  });
  const canManage = hasPermission('fleet.manage');
  const canSetup = hasPermission('fleet.types.manage');

  // vehicle type master data (Plan §6) — no hard-coded lists
  const [types, setTypes] = useState<VehicleTypeRow[]>([]);
  const [newType, setNewType] = useState('');
  // fleet view lives in the URL (?tab=absences) so refresh / back / shared links keep it
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const fleetTab: 'main' | 'absences' | 'setup' = tabParam === 'absences' || tabParam === 'setup' ? tabParam : 'main';
  const setFleetTab = (t: 'main' | 'absences' | 'setup') => setSearchParams(t === 'main' ? {} : { tab: t }, { replace: false });

  const load = useCallback(() => {
    api<Vehicle[]>('/fleet/vehicles').then(setVehicles).catch((e) => setError(e.message));
    api<Driver[]>('/fleet/drivers').then(setDrivers).catch(() => {});
    api<Absence[]>('/fleet/absences').then(setAbsences).catch(() => {});
    api<VehicleTypeRow[]>('/fleet/vehicle-types').then(setTypes).catch(() => {});
    api<Timetable>('/settings/timetable').then(setTimetable).catch(() => {});
    if (hasPermission('fleet.manage')) {
      api<TgBinding[]>('/fleet/drivers/telegram-bindings')
        .then((list) => setBindings(Object.fromEntries(list.map((b) => [b.id, b]))))
        .catch(() => {});
      api<{ items?: { id: string; employeeNo: string; fullName: string }[] }>('/org/employees?pageSize=200')
        .then((r) => setEmpOptions(r.items ?? []))
        .catch(() => {});
    }
  }, []);

  useEffect(load, [load]);

  const flash = (msg: string) => {
    toast(msg);
  };

  const createVehicle = async () => {
    setModalError('');
    try {
      // note: `status` is not part of the create DTO (defaults to AVAILABLE server-side)
      const { status: _status, ...rest } = vForm;
      await api('/fleet/vehicles', {
        method: 'POST',
        body: { ...rest, capacity: Number(vForm.capacity), driverId: vForm.driverId || undefined },
      });
      setVForm(emptyVForm);
      setShowV(false);
      flash('Vehicle added');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const createDriver = async () => {
    setModalError('');
    try {
      // note: `status` is not part of the create DTO (defaults to AVAILABLE server-side)
      const { status: _status, ...rest } = dForm;
      await api('/fleet/drivers', { method: 'POST', body: rest });
      setDForm(emptyDForm);
      setShowD(false);
      flash('Driver added');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const saveVehicle = async () => {
    if (!editingV) return;
    setModalError('');
    try {
      await api(`/fleet/vehicles/${editingV.id}`, {
        method: 'PATCH',
        body: {
          brandModel: vForm.brandModel,
          capacity: Number(vForm.capacity),
          // null clears the default driver ("blank") — undefined would leave it unchanged
          driverId: vForm.driverId || null,
          status: vForm.status,
        },
      });
      setEditingV(null);
      setVForm(emptyVForm);
      flash('Vehicle updated');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const saveDriver = async () => {
    if (!editingD) return;
    setModalError('');
    try {
      await api(`/fleet/drivers/${editingD.id}`, {
        method: 'PATCH',
        // null clears the field ("blank") — undefined would leave it unchanged
        body: { name: dForm.name, phone: dForm.phone || null, licenseNo: dForm.licenseNo || null, status: dForm.status },
      });
      setEditingD(null);
      setDForm(emptyDForm);
      flash('Driver updated');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doDeleteVehicle = async (v: Vehicle) => {
    setError('');
    try {
      await api(`/fleet/vehicles/${v.id}`, { method: 'DELETE' });
      flash(`Vehicle ${v.vehicleNo} deleted`);
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
      return false;
    }
  };

  const doDeleteDriver = async (d: Driver) => {
    setError('');
    try {
      await api(`/fleet/drivers/${d.id}`, { method: 'DELETE' });
      flash(`Driver ${d.name} deleted`);
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
      return false;
    }
  };

  // ---------- vehicle type setup (Plan §6 master data) ----------
  const createType = async () => {
    if (!newType.trim()) return;
    setError('');
    try {
      await api('/fleet/vehicle-types', { method: 'POST', body: { name: newType.trim() } });
      setNewType('');
      flash('Vehicle type added');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add type');
    }
  };

  const toggleType = async (t: VehicleTypeRow) => {
    setError('');
    try {
      await api(`/fleet/vehicle-types/${t.id}`, { method: 'PATCH', body: { active: !t.active } });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update type');
    }
  };

  const deleteType = async (t: VehicleTypeRow) => {
    setError('');
    try {
      await api(`/fleet/vehicle-types/${t.id}`, { method: 'DELETE' });
      setDeletingType(null);
      flash(`Type ${t.name} deleted`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete type — deactivate it instead if vehicles use it');
      throw e; // ConfirmDialog keeps itself open and shows the error inside
    }
  };

  return (
    <div>
      <PageHeader
        title="Fleet — Vehicles & Drivers"
        subtitle="Vehicle and driver master data (Plan §6)"
        actions={
          canManage ? (
            <>
              <Button variant="ghost" onClick={() => { setShowD(!showD); setEditingD(null); if (!showD) setDForm(emptyDForm); }}>{showD ? 'Close' : '+ Driver'}</Button>
              <Button onClick={() => { setShowV(!showV); setEditingV(null); if (!showV) setVForm(emptyVForm); }}>{showV ? 'Close' : '+ Vehicle'}</Button>
            </>
          ) : undefined
        }
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
      {notice && <div className="mb-4 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{notice}</div>}

      {/* ---------- fleet tabs (URL-driven) ---------- */}
      <div className="flex gap-1 mb-4">
        {(['main', 'absences'] as const).map((t) => (
          <button
            key={t}
            className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
              fleetTab === t ? 'bg-yellow-50 border-yellow-300 text-yellow-800' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
            onClick={() => setFleetTab(t)}
          >
            {t === 'main' ? 'Vehicles & Drivers' : `🗓 Driver Absences (${absences.filter((a) => a.status === 'ACTIVE').length})`}
          </button>
        ))}
        {canSetup && (
          <button
            className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
              fleetTab === 'setup' ? 'bg-yellow-50 border-yellow-300 text-yellow-800' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
            onClick={() => setFleetTab('setup')}
          >
            ⚙ Setup
          </button>
        )}
      </div>

      {deletingV && (
        <ConfirmDialog
          title={`Delete vehicle ${deletingV.vehicleNo}?`}
          description="This removes the vehicle from the fleet. This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => {
            const ok = await doDeleteVehicle(deletingV);
            if (ok) setDeletingV(null);
          }}
          onClose={() => setDeletingV(null)}
        />
      )}

      {deletingD && (
        <ConfirmDialog
          title={`Delete driver ${deletingD.name}?`}
          description="This removes the driver from the fleet. This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => {
            const ok = await doDeleteDriver(deletingD);
            if (ok) setDeletingD(null);
          }}
          onClose={() => setDeletingD(null)}
        />
      )}

      {deletingType && (
        <ConfirmDialog
          title={`Delete vehicle type ${deletingType.name}?`}
          description="This removes the type from the master data. If vehicles still use it, delete fails — deactivate it instead."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => { await deleteType(deletingType); }}
          onClose={() => setDeletingType(null)}
        />
      )}

      {deletingAbsence && (
        <ConfirmDialog
          title={`Delete the absence record for ${deletingAbsence.driver?.name ?? '?'}?`}
          description="Unlike Cancel, the row is removed outright. If the leave window is current, the driver returns to AVAILABLE."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => {
            setError(''); setNotice('');
            try {
              await api(`/fleet/absences/${deletingAbsence.id}`, { method: 'DELETE' });
              toast('Absence record deleted.');
              setDeletingAbsence(null);
              load();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to delete absence');
              setDeletingAbsence(null);
            }
          }}
          onClose={() => setDeletingAbsence(null)}
        />
      )}

      {cancelingAbsence && (
        <ConfirmDialog
          title={`Cancel the absence for ${cancelingAbsence.driver?.name ?? '?'}?`}
          description="The driver becomes available again immediately."
          confirmLabel="Cancel absence"
          variant="danger"
          onConfirm={async () => {
            setError(''); setNotice('');
            try {
              await api(`/fleet/absences/${cancelingAbsence.id}/cancel`, { method: 'POST' });
              setCancelingAbsence(null);
              toast('Absence cancelled — driver is available again.');
              load();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Cancel failed');
              throw e; // dialog stays open, error shown inside
            }
          }}
          onClose={() => setCancelingAbsence(null)}
        />
      )}

      {showD && (
        <Modal title="Add driver" error={modalError} onClose={() => { setShowD(false); setModalError(''); }}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Driver name *</label>
              <Input placeholder="e.g. U Aung Kyaw" value={dForm.name} onChange={(e) => setDForm({ ...dForm, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Phone</label>
                <Input placeholder="09-xxx" value={dForm.phone} onChange={(e) => setDForm({ ...dForm, phone: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">License no.</label>
                <Input placeholder="DL-xxxx" value={dForm.licenseNo} onChange={(e) => setDForm({ ...dForm, licenseNo: e.target.value })} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setShowD(false)}>Cancel</Button>
              <Button onClick={createDriver} disabled={!dForm.name}>Add Driver</Button>
            </div>
          </div>
        </Modal>
      )}

      {showV && (
        <Modal title="Add vehicle" error={modalError} onClose={() => { setShowV(false); setModalError(''); }}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Vehicle no. *</label>
                <Input placeholder="YGN-1234" value={vForm.vehicleNo} onChange={(e) => setVForm({ ...vForm, vehicleNo: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Type</label>
                <Select value={vForm.vehicleType} onChange={(e) => setVForm({ ...vForm, vehicleType: e.target.value })}>
                  <option value="">— Type —</option>
                  {types.filter((t) => t.active || t.name === vForm.vehicleType).map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </Select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Brand / model *</label>
              <Input placeholder="Toyota Corolla" value={vForm.brandModel} onChange={(e) => setVForm({ ...vForm, brandModel: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Default driver</label>
                <Select value={vForm.driverId} onChange={(e) => setVForm({ ...vForm, driverId: e.target.value })}>
                  <option value="">— Driver —</option>
                  {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setShowV(false)}>Cancel</Button>
              <Button onClick={createVehicle} disabled={!vForm.vehicleNo || !vForm.brandModel || !vForm.vehicleType}>Add Vehicle</Button>
            </div>
          </div>
        </Modal>
      )}

      {editingV && (
        <Modal title={`Edit vehicle — ${editingV.vehicleNo}`} error={modalError} onClose={() => { setEditingV(null); setModalError(''); }}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Vehicle no.</label>
                <Input value={vForm.vehicleNo} disabled title="Vehicle number cannot be changed" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Type</label>
                <Select value={vForm.vehicleType} disabled>
                  <option value="">— Type —</option>
                  {types.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Brand / model *</label>
                <Input value={vForm.brandModel} onChange={(e) => setVForm({ ...vForm, brandModel: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Capacity</label>
                <Input type="number" min={1} max={60} value={vForm.capacity} onChange={(e) => setVForm({ ...vForm, capacity: Number(e.target.value) })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Default driver</label>
                <Select value={vForm.driverId} onChange={(e) => setVForm({ ...vForm, driverId: e.target.value })}>
                  <option value="">— Driver —</option>
                  {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Status</label>
                <Select value={vForm.status} onChange={(e) => setVForm({ ...vForm, status: e.target.value })}>
                  {VEHICLE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditingV(null)}>Cancel</Button>
              <Button onClick={saveVehicle} disabled={!vForm.brandModel}>Save</Button>
            </div>
          </div>
        </Modal>
      )}

      {editingD && (
        <Modal title={`Edit driver — ${editingD.name}`} error={modalError} onClose={() => { setEditingD(null); setModalError(''); }}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Driver name *</label>
              <Input value={dForm.name} onChange={(e) => setDForm({ ...dForm, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Phone</label>
                <Input placeholder="09-xxx" value={dForm.phone} onChange={(e) => setDForm({ ...dForm, phone: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">License no.</label>
                <Input placeholder="DL-xxxx" value={dForm.licenseNo} onChange={(e) => setDForm({ ...dForm, licenseNo: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Status</label>
              <Select value={dForm.status} onChange={(e) => setDForm({ ...dForm, status: e.target.value })}>
                {DRIVER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditingD(null)}>Cancel</Button>
              <Button onClick={saveDriver} disabled={!dForm.name}>Save</Button>
            </div>
          </div>
        </Modal>
      )}

      {fleetTab === 'main' && (
      <>
      <h2 className="font-semibold text-gray-700 mb-2">Vehicles</h2>
      <Card className="mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Vehicle No.</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Brand / Model</th>
              <th className="px-4 py-3 font-medium">Capacity</th>
              <th className="px-4 py-3 font-medium">Driver</th>
              <th className="px-4 py-3 font-medium">Status</th>
              {canManage && <th className="px-4 py-3 font-medium text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {vehicles.length === 0 && <tr><td colSpan={canManage ? 7 : 6}><Empty /></td></tr>}
            {vehicles.map((v) => (
              <tr key={v.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">{v.vehicleNo}</td>
                <td className="px-4 py-3">{v.vehicleType}</td>
                <td className="px-4 py-3">{v.brandModel}</td>
                <td className="px-4 py-3">{v.capacity}</td>
                <td className="px-4 py-3">{v.driver?.name ?? '—'}</td>
                <td className="px-4 py-3"><Badge color={VEHICLE_STATUS[v.status] ?? 'gray'}>{v.status}</Badge></td>
                {canManage && (
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      className="text-blue-600 hover:underline mr-3"
                      onClick={() => {
                        setEditingV(v);
                        setEditingD(null);
                        setShowV(false);
                        setShowD(false);
                        // prefill by driver id (not name — duplicate names would mismatch)
                        setVForm({ vehicleNo: v.vehicleNo, vehicleType: v.vehicleType, brandModel: v.brandModel, capacity: v.capacity, driverId: v.driverId ?? '', status: v.status });
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      Edit
                    </button>
                    <button className="text-red-600 hover:underline" onClick={() => setDeletingV(v)}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <h2 className="font-semibold text-gray-700 mb-2">Drivers</h2>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">License</th>
              <th className="px-4 py-3 font-medium">Vehicles</th>
              <th className="px-4 py-3 font-medium">Employee</th>
              <th className="px-4 py-3 font-medium">Telegram</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">History</th>
              {canManage && <th className="px-4 py-3 font-medium text-right">Actions</th>
              }
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {drivers.length === 0 && <tr><td colSpan={canManage ? 9 : 8}><Empty /></td></tr>}
            {drivers.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">{d.name}</td>
                <td className="px-4 py-3">{d.phone ?? '—'}</td>
                <td className="px-4 py-3">{d.licenseNo ?? '—'}</td>
                <td className="px-4 py-3 text-gray-500">{d.vehicles?.map((v) => v.vehicleNo).join(', ') || '—'}</td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {d.employee ? (
                    <span className="text-gray-700">{d.employee.fullName} <span className="text-gray-400">({d.employee.employeeNo})</span></span>
                  ) : canManage ? (
                    <div className="flex items-center gap-1">
                      <select
                        className="border border-gray-300 rounded-lg px-1.5 py-1 text-xs bg-white max-w-40"
                        value={empPick[d.id] || ''}
                        onChange={(e) => setEmpPick((p) => ({ ...p, [d.id]: e.target.value }))}
                      >
                        <option value="">— link employee —</option>
                        {empOptions.map((o) => <option key={o.id} value={o.id}>{o.fullName} ({o.employeeNo})</option>)}
                      </select>
                      <button
                        className="text-blue-600 hover:underline text-xs disabled:text-gray-300 disabled:no-underline"
                        disabled={!empPick[d.id]}
                        onClick={async () => {
                          setError('');
                          try {
                            await api(`/fleet/drivers/${d.id}/employee`, { method: 'PUT', body: { employeeId: empPick[d.id] } });
                            flash('Employee linked');
                            setEmpPick((p) => ({ ...p, [d.id]: '' }));
                            load();
                          } catch (e) { setError(e instanceof Error ? e.message : 'Link failed'); }
                        }}
                      >link</button>
                    </div>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {d.telegramChatId ? (
                    <span className="text-green-700" title={`chat ${d.telegramChatId}`}>✓ {d.telegramUsername ? `@${d.telegramUsername}` : 'Linked'}</span>
                  ) : bindings[d.id]?.telegramBindCode ? (
                    <span className="text-amber-700" title="Driver must send this code to the AMS bot via /start">⏳ Code: {bindings[d.id].telegramBindCode}</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge color={DRIVER_STATUS[d.status] ?? 'gray'}>{d.status}</Badge>
                  {d.absences?.some((a) => new Date(a.startsAt) <= new Date() && new Date(a.endsAt) > new Date()) && (
                    <span className="ml-1 text-[10px] text-yellow-800 bg-yellow-100 border border-yellow-200 rounded-full px-1.5 py-0.5" title={d.absences.map((a) => a.reason || 'absence').join(', ')}>on leave</span>
                  )}
                  {d.absences?.some((a) => new Date(a.startsAt) > new Date()) && (
                    <span className="ml-1 text-[10px] text-gray-600 bg-gray-100 border border-gray-200 rounded-full px-1.5 py-0.5" title={`From ${new Date(d.absences.find((a) => new Date(a.startsAt) > new Date())!.startsAt).toLocaleString()}`}>leave soon</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button
                    className="text-blue-600 hover:underline"
                    onClick={async () => {
                      setError('');
                      setHistoryFor(d);
                      setHistory(null);
                      try {
                        const h = await api<{ driver: { id: string; name: string }; employee: { id: string; employeeNo: string; fullName: string } | null; assignments: CorrRow[] }>(`/fleet/drivers/${d.id}/correlated-history`);
                        setHistory(h);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : 'History failed');
                        setHistoryFor(null);
                      }
                    }}
                  >History</button>
                </td>
                {canManage && (
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      className="text-blue-600 hover:underline mr-3"
                      onClick={() => {
                        setEditingD(d);
                        setEditingV(null);
                        setShowV(false);
                        setShowD(false);
                        setDForm({ name: d.name, phone: d.phone ?? '', licenseNo: d.licenseNo ?? '', status: d.status });
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="text-blue-600 hover:underline mr-3"
                      onClick={async () => {
                        try {
                          const res = await api<{ code: string }>(`/fleet/drivers/${d.id}/telegram-bind-code`, { method: 'POST' });
                          setBindCodeFor(`${d.name}|${res.code}`);
                          load();
                        } catch { /* surfaced by reload */ }
                      }}
                    >
                      {d.telegramChatId ? 'Re-link' : 'Link Telegram'}
                    </button>
                    <button className="text-red-600 hover:underline" onClick={() => setDeletingD(d)}>Delete</button>
                    {d.employee && (
                      <button
                        className="text-gray-500 hover:underline ml-3"
                        onClick={async () => {
                          setError('');
                          try {
                            await api(`/fleet/drivers/${d.id}/employee`, { method: 'DELETE' });
                            flash('Employee unlinked');
                            load();
                          } catch (e) { setError(e instanceof Error ? e.message : 'Unlink failed'); }
                        }}
                      >Unlink employee</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      </>
      )}

      {fleetTab === 'absences' && (
      <>
      {canManage ? (
      <Card className="mb-5 p-5">
        <div className="text-xs font-semibold text-gray-500 uppercase mb-1">Record driver leave — the driver is skipped in assign pickers and auto-set to ON_LEAVE</div>
        <div className="text-xs text-gray-400 mb-3">
          Leave windows follow the Company Time Table
          {timetable ? `: full day ${timetable.workStart}–${timetable.workEnd} · morning until ${timetable.halfDaySplit} · evening from ${timetable.halfDaySplit}` : ' (Settings → Company Time Table)'}.
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
          <Select value={absenceForm.driverId} onChange={(e) => setAbsenceForm({ ...absenceForm, driverId: e.target.value })}>
            <option value="">— Driver —</option>
            {drivers.filter((d) => d.status !== 'INACTIVE').map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </Select>
          <Input type="date" value={absenceForm.date} onChange={(e) => setAbsenceForm({ ...absenceForm, date: e.target.value })} />
          <Select value={absenceForm.dayType} onChange={(e) => setAbsenceForm({ ...absenceForm, dayType: e.target.value as 'FULL' | 'HALF' })}>
            <option value="FULL">Full day</option>
            <option value="HALF">Half day</option>
          </Select>
          <Select
            value={absenceForm.dayType === 'HALF' ? absenceForm.period : 'FULL_DAY'}
            disabled={absenceForm.dayType === 'FULL'}
            onChange={(e) => setAbsenceForm({ ...absenceForm, period: e.target.value as 'MORNING' | 'EVENING' })}
          >
            <option value="MORNING">Morning</option>
            <option value="EVENING">Evening</option>
          </Select>
          <Input placeholder="Reason (leave, training…)" value={absenceForm.reason} onChange={(e) => setAbsenceForm({ ...absenceForm, reason: e.target.value })} />
          <Button
            disabled={!absenceForm.driverId || !absenceForm.date}
            onClick={async () => {
              setError(''); setNotice('');
              try {
                const res = await api<{ clashes: string[] }>('/fleet/absences', {
                  method: 'POST',
                  body: {
                    driverId: absenceForm.driverId,
                    date: absenceForm.date,
                    dayType: absenceForm.dayType,
                    period: absenceForm.dayType === 'HALF' ? absenceForm.period : 'FULL_DAY',
                    reason: absenceForm.reason || undefined,
                  },
                });
                toast(res.clashes?.length ? `Leave recorded — ⚠️ ${res.clashes.length} assigned trip(s) fall inside this window (${res.clashes.join(', ')}) — re-assign them.` : 'Leave recorded — driver is skipped in pickers for that window.', res.clashes?.length ? 'info' : 'success');
                setAbsenceForm({ driverId: '', date: '', dayType: 'FULL', period: 'MORNING', reason: '' });
                load();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to record leave');
              }
            }}
          >
            Record absence
          </Button>
        </div>
      </Card>
      ) : (
        <Empty label="Only fleet managers can manage driver absences." />
      )}
      <Card>
        {absences.filter((a) => a.status === 'ACTIVE').length === 0 ? (
          <Empty label="No planned absences — drivers are assumed available." />
        ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Driver</th>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Leave</th>
              <th className="px-4 py-3 font-medium">Window</th>
              <th className="px-4 py-3 font-medium">Reason</th>
              {canManage && <th className="px-4 py-3 font-medium text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {absences.filter((a) => a.status === 'ACTIVE').map((a) => {
              const editing = editingAbsence?.id === a.id;
              return (
              <tr key={a.id} className={`hover:bg-gray-50 ${editing ? 'bg-yellow-50/60' : ''}`}>
                <td className="px-4 py-3 font-medium">{a.driver?.name ?? '?'}</td>
                {editing ? (
                <>
                  <td className="px-2 py-2">
                    <Input type="date" value={editForm.date} onChange={(e) => setEditForm({ ...editForm, date: e.target.value })} />
                  </td>
                  <td className="px-2 py-2 flex gap-1">
                    <Select value={editForm.dayType} onChange={(e) => setEditForm({ ...editForm, dayType: e.target.value as 'FULL' | 'HALF' })}>
                      <option value="FULL">Full</option>
                      <option value="HALF">Half</option>
                    </Select>
                    <Select
                      value={editForm.dayType === 'HALF' ? editForm.period : 'FULL_DAY'}
                      disabled={editForm.dayType === 'FULL'}
                      onChange={(e) => setEditForm({ ...editForm, period: e.target.value as 'MORNING' | 'EVENING' })}
                    >
                      <option value="MORNING">Morning</option>
                      <option value="EVENING">Evening</option>
                    </Select>
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-400">auto</td>
                  <td className="px-2 py-2">
                    <Input placeholder="Reason" value={editForm.reason} onChange={(e) => setEditForm({ ...editForm, reason: e.target.value })} />
                  </td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    <button
                      className="text-xs font-medium text-white bg-yellow-600 hover:bg-yellow-700 rounded-lg px-2.5 py-1 mr-2 transition-colors disabled:opacity-50"
                      disabled={!editForm.date}
                      onClick={async () => {
                        setError(''); setNotice('');
                        try {
                          await api(`/fleet/absences/${a.id}`, {
                            method: 'PATCH',
                            body: {
                              date: editForm.date,
                              dayType: editForm.dayType,
                              period: editForm.dayType === 'HALF' ? editForm.period : 'FULL_DAY',
                              reason: editForm.reason || undefined,
                            },
                          });
                          toast('Absence updated.');
                          setEditingAbsence(null);
                          load();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : 'Failed to update absence');
                        }
                      }}
                    >
                      Save
                    </button>
                    <button className="text-xs text-gray-500 hover:text-gray-700 underline" onClick={() => setEditingAbsence(null)}>Cancel</button>
                  </td>
                </>
                ) : (
                <>
                  <td className="px-4 py-3 text-gray-600">{new Date(a.startsAt).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</td>
                  <td className="px-4 py-3">
                    <Badge color={a.dayType === 'FULL' ? 'blue' : 'yellow'}>
                      {a.dayType === 'FULL' ? 'Full day' : a.period === 'MORNING' ? 'Half · Morning' : 'Half · Evening'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(a.startsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} – {new Date(a.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{a.reason || '—'}</td>
                  {canManage && (
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      className="text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg px-2.5 py-1 mr-2 transition-colors"
                      onClick={() => {
                        setError(''); setNotice('');
                        const local = new Date(a.startsAt);
                        // the stored window is office-local; rebuild the YYYY-MM-DD day from it
                        const day = new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
                        setEditingAbsence(a);
                        setEditForm({ date: day, dayType: a.dayType, period: a.period === 'FULL_DAY' ? 'MORNING' : a.period, reason: a.reason ?? '' });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg px-2.5 py-1 mr-2 transition-colors"
                      onClick={() => { setError(''); setNotice(''); setCancelingAbsence(a); }}
                    >
                      Cancel
                    </button>
                    <button
                      className="text-xs font-medium text-red-700 hover:text-red-800 underline"
                      title="Delete the record outright"
                      onClick={() => { setError(''); setNotice(''); setDeletingAbsence(a); }}
                    >
                      Delete
                    </button>
                  </td>
                  )}
                </>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </Card>
      </>
      )}{fleetTab === 'setup' && (canManage || canSetup) && (
        <Card className="mb-6 p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">Vehicle types</h2>
              <p className="text-xs text-gray-500 mt-0.5">Master data for the vehicle Type picker (Plan §6) — stored uppercase like SEDAN / SUV. A type that vehicles or requests already use cannot be deleted; deactivate it to hide it from pickers.</p>
            </div>
          </div>
          {canManage && (
            <div className="flex gap-2 mb-4">
              <Input
                placeholder="New type e.g. STAFF_BUS"
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createType(); }}
              />
              <Button onClick={createType} disabled={!newType.trim()}>Add type</Button>
            </div>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Status</th>
                {canManage && <th className="px-4 py-3 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {types.length === 0 && <tr><td colSpan={canManage ? 3 : 2}><Empty label="No vehicle types yet" /></td></tr>}
              {types.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-medium font-mono text-xs">{t.name}</td>
                  <td className="px-4 py-2.5"><Badge color={t.active ? 'green' : 'gray'}>{t.active ? 'ACTIVE' : 'HIDDEN'}</Badge></td>
                  {canManage && (
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button className="text-blue-600 hover:underline mr-3" onClick={() => toggleType(t)}>{t.active ? 'Hide' : 'Show'}</button>
                      <button className="text-red-600 hover:underline" onClick={() => setDeletingType(t)}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {historyFor && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setHistoryFor(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-800">
                Trip history — {historyFor.name}
                {history?.employee && <span className="text-gray-500 font-normal"> + {history.employee.fullName}</span>}
              </h3>
              <Button variant="ghost" onClick={() => setHistoryFor(null)}>✕</Button>
            </div>
            {!history?.employee && (
              <p className="text-xs text-gray-500 mb-3">This driver has no employee link — showing assignments where they were the assigned driver. Link an employee to also merge trips they took as a passenger-requester.</p>
            )}
            {history && history.assignments.length === 0 && <Empty label="No assignment history yet" />}
            {history && history.assignments.length > 0 && (
              <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-3 py-2 font-medium">Request</th>
                    <th className="px-3 py-2 font-medium">Vehicle</th>
                    <th className="px-3 py-2 font-medium">Requester</th>
                    <th className="px-3 py-2 font-medium">Assigned</th>
                    <th className="px-3 py-2 font-medium">Driver</th>
                    <th className="px-3 py-2 font-medium">Noted</th>
                    <th className="px-3 py-2 font-medium">Arrived</th>
                    <th className="px-3 py-2 font-medium">Back</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {history.assignments.map((a) => (
                    <tr key={a.id} className={a.viaEmployee ? 'bg-blue-50/40' : ''}>
                      <td className="px-3 py-2 font-medium">
                        {a.docNumber}
                        {a.viaEmployee && <span className="ml-1 text-[10px] text-blue-600" title="Via linked employee">via employee</span>}
                      </td>
                      <td className="px-3 py-2">{a.vehicle}{a.brandModel ? <span className="text-gray-400"> · {a.brandModel}</span> : null}</td>
                      <td className="px-3 py-2">{a.requester}</td>
                      <td className="px-3 py-2 text-gray-500">{new Date(a.assignedAt).toLocaleString()}</td>
                      <td className="px-3 py-2">{a.driver ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{a.driverNotedAt ? new Date(a.driverNotedAt).toLocaleTimeString() : '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{a.driverArrivedAt ? new Date(a.driverArrivedAt).toLocaleTimeString() : '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{a.driverBackAtOfficeAt ? new Date(a.driverBackAtOfficeAt).toLocaleTimeString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {bindCodeFor && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setBindCodeFor(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 mb-2">Telegram bind code</h3>
            <p className="text-sm text-gray-600 mb-3">
              Tell <b>{bindCodeFor.split('|')[0]}</b> to open the AMS bot in Telegram and send
              <code className="mx-1 px-1.5 py-0.5 bg-gray-100 rounded text-sm">/start {bindCodeFor.split('|')[1]}</code>
              — the chat links automatically and the code expires in 7 days.
            </p>
            <div className="text-center text-2xl font-mono font-bold tracking-widest text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-lg py-3 mb-4">
              {bindCodeFor.split('|')[1]}
            </div>
            <div className="flex justify-end">
              <Button onClick={() => setBindCodeFor(null)}>Done</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
