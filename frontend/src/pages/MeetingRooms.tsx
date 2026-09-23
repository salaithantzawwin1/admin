import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';
import { MeetingMonthCalendar, Holiday, PrefillSlot } from '../components/MeetingMonthCalendar';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Textarea } from '../components/ui';

interface RoomInfo {
  id: string;
  name: string;
  location?: string;
  capacity: number;
  facilities?: string;
  status: string;
  bookings: { docNumber?: string; startTime: string; endTime: string }[];
}

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
  requester: { fullName: string };
  department?: { name: string } | null;
  meetingRequest?: { title: string; attendees: number; startTime: string; endTime: string } | null;
}

interface Clash {
  docNumber?: string;
  title: string;
  room?: { name: string } | null;
  startTime: string;
  endTime: string;
}

interface SetupRoom {
  id: string;
  name: string;
  location?: string;
  capacity: number;
  facilities?: string;
  status: string;
}

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = {
  DRAFT: 'gray',
  PENDING_APPROVAL: 'yellow',
  APPROVED: 'green',
  REJECTED: 'red',
  IN_PROGRESS: 'blue',
  COMPLETED: 'green',
  CLOSED: 'gray',
  CANCELLED: 'gray',
};

type Tab = 'requests' | 'calendar' | 'setup';

// local datetime-local value from a Date (no TZ shift)
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MeetingRooms() {
  // active tab lives in the URL (?tab=calendar) so refresh / back / shared links keep it
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as Tab | null;
  const tab: Tab = tabParam === 'calendar' || tabParam === 'setup' ? tabParam : 'requests';
  const setTab = (t: Tab) => setSearchParams(t === 'requests' ? {} : { tab: t }, { replace: false });
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [modalError, setModalError] = useState(''); // submit errors show inside the dialog, not on the page
  const [busy, setBusy] = useState(false);
  const canAssign = hasPermission('meeting-rooms.assign');

  const [form, setForm] = useState({
    title: '', description: '', attendees: 1, startTime: '', endTime: '',
    meetingType: 'INTERNAL', externalCompanies: '', attendeeNames: '',
    itAssist: false, reservedDriver: false, services: '',
  });
  const [clashes, setClashes] = useState<Clash[] | null>(null);

  // room setup CRUD state (Administration)
  const [setup, setSetup] = useState<SetupRoom[]>([]);
  const [showRoomForm, setShowRoomForm] = useState(false);
  const [roomForm, setRoomForm] = useState({ name: '', location: '', capacity: 8, facilities: '', status: 'AVAILABLE' });
  const [editingRoom, setEditingRoom] = useState<SetupRoom | null>(null);
  const [deletingRoom, setDeletingRoom] = useState<SetupRoom | null>(null);

  // public holidays for the selected start-date year (weekend/holiday warning)
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [slotHint, setSlotHint] = useState('');

  const loadSetup = useCallback(() => {
    if (!hasPermission('meeting-rooms.assign')) return;
    api<SetupRoom[]>('/meeting-rooms/setup').then(setSetup).catch(() => {});
  }, []);

  // when the form opens, prefill Start with the current date (next full hour) —
  // the requester only picks the time (mirrors the car request form)
  useEffect(() => {
    if (showForm && !form.startTime) {
      const now = new Date();
      const start = new Date(now.getTime() + 60 * 60 * 1000);
      start.setMinutes(0, 0, 0);
      setForm((f) => ({ ...f, startTime: toLocalInput(start), endTime: toLocalInput(new Date(start.getTime() + 60 * 60 * 1000)) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  // holidays for the year of the chosen start date
  const formYear = form.startTime ? Number(form.startTime.slice(0, 4)) : new Date().getFullYear();
  useEffect(() => {
    if (!Number.isInteger(formYear)) return;
    api<Holiday[]>(`/settings/holidays/${formYear}`).then(setHolidays).catch(() => setHolidays([]));
  }, [formYear]);

  const load = useCallback(() => {
    api<{ items: RequestRow[] }>(
      canAssign
        ? '/requests?pageSize=100&docType=MEETING_ROOM_REQUEST'
        : '/requests?scope=mine&pageSize=100&docType=MEETING_ROOM_REQUEST',
    )
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message));
    api<RoomInfo[]>('/meeting-rooms/rooms-overview').then(setRooms).catch(() => setRooms([]));
    if (canAssign) {
      api<QueueRow[]>('/meeting-rooms/requests/approved-unassigned')
        .then(setQueue)
        .catch(() => setQueue([]));
    }
  }, [canAssign]);

  useEffect(load, [load]);
  useEffect(loadSetup, [loadSetup]);

  // auto-refresh so new requests / approvals / assignments appear without manual reload
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  // clash preview once both times are picked
  useEffect(() => {
    if (!form.startTime || !form.endTime) return;
    const t = setTimeout(() => {
      api<{ conflicts: Clash[] }>(
        `/meeting-rooms/availability/conflicts?startTime=${encodeURIComponent(new Date(form.startTime).toISOString())}&endTime=${encodeURIComponent(new Date(form.endTime).toISOString())}`,
      )
        .then((r) => setClashes(r.conflicts))
        .catch(() => setClashes(null));
    }, 300);
    return () => clearTimeout(t);
  }, [form.startTime, form.endTime]);

  const valid = form.title.trim().length >= 3 && form.startTime && form.endTime && new Date(form.endTime) > new Date(form.startTime);

  // calendar click-to-book: prefill date/time for the suggested room
  const openSlot = (slot: PrefillSlot) => {
    setTab('requests');
    setShowForm(true);
    setSlotHint(`${slot.roomName} · ${slot.dateKey}`);
    setForm((f) => ({ ...f, startTime: slot.startLocal, endTime: slot.endLocal }));
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const created = await api<{ id?: string; request?: { id: string } }>('/meeting-rooms/requests', {
        method: 'POST',
        body: {
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          attendees: Number(form.attendees) || 1,
          startTime: new Date(form.startTime).toISOString(),
          endTime: new Date(form.endTime).toISOString(),
          meetingType: form.meetingType,
          externalCompanies: form.meetingType === 'EXTERNAL' && form.externalCompanies.trim() ? form.externalCompanies.trim() : undefined,
          attendeeNames: form.attendeeNames.trim() || undefined,
          itAssist: form.itAssist,
          reservedDriver: form.reservedDriver,
          services: form.services.trim() || undefined,
        },
      });
      const id = created.id ?? created.request?.id;
      if (id) await api(`/requests/${id}/submit`, { method: 'POST' });
      setForm({
        title: '', description: '', attendees: 1, startTime: '', endTime: '',
        meetingType: 'INTERNAL', externalCompanies: '', attendeeNames: '',
        itAssist: false, reservedDriver: false, services: '',
      });
      setClashes(null);
      setShowForm(false);
      setSlotHint('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  // ---------- weekend / public holiday warning for the chosen start date ----------
  const startKey = form.startTime ? form.startTime.slice(0, 10) : '';
  const startHoliday = startKey ? holidays.find((h) => h.date === startKey) : undefined;
  const startDow = startKey ? new Date(`${startKey}T00:00:00`).getDay() : -1;
  const startWeekend = startDow === 0 || startDow === 6;

  // ---------- room setup CRUD handlers ----------
  const createRoom = async () => {
    setModalError('');
    try {
      await api('/meeting-rooms/setup', {
        method: 'POST',
        body: { name: roomForm.name.trim(), location: roomForm.location.trim() || undefined, capacity: Number(roomForm.capacity) || 8, facilities: roomForm.facilities.trim() || undefined },
      });
      setRoomForm({ name: '', location: '', capacity: 8, facilities: '', status: 'AVAILABLE' });
      setShowRoomForm(false);
      toast('Room added');
      loadSetup();
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const saveRoom = async () => {
    if (!editingRoom) return;
    setModalError('');
    try {
      await api(`/meeting-rooms/setup/${editingRoom.id}`, {
        method: 'PATCH',
        body: {
          name: roomForm.name.trim(),
          location: roomForm.location.trim() || undefined,
          capacity: Number(roomForm.capacity) || 8,
          facilities: roomForm.facilities.trim() || undefined,
          status: roomForm.status,
        },
      });
      setEditingRoom(null);
      toast('Room updated');
      loadSetup();
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doDeleteRoom = async (room: SetupRoom): Promise<boolean> => {
    setError('');
    try {
      await api(`/meeting-rooms/setup/${room.id}`, { method: 'DELETE' });
      toast(`Room ${room.name} deleted`);
      loadSetup();
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
      return false;
    }
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: 'requests', label: 'Requests' },
    { key: 'calendar', label: 'Calendar' },
    ...(canAssign ? [{ key: 'setup' as Tab, label: 'Room setup' }] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Meeting Rooms"
        subtitle="Request a meeting room — Administration assigns the room (Plan §7)"
        actions={
          <Button
            onClick={() => {
              setShowForm(!showForm);
              setTab('requests');
            }}
          >
            {showForm && tab === 'requests' ? 'Close' : '+ New Meeting Request'}
          </Button>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
              tab === t.key
                ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {/* ---------- Tab: Requests ---------- */}
      {tab === 'requests' && (
        <>
          {showForm && (
            <Card className="mb-5 p-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* (v) Meeting subject */}
                <Input className="sm:col-span-2" placeholder="Meeting subject * (e.g. Weekly progress review)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                {/* (i) Meeting Date + (iii) Start time combined; (iv) End time (estimated) */}
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Meeting date & start time *</label>
                  <Input type="datetime-local" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">End time (estimated) — optional, default +1 hour</label>
                  <Input type="datetime-local" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
                </div>
                {/* (vi) Meeting type */}
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Meeting type</label>
                  <Select value={form.meetingType} onChange={(e) => setForm({ ...form, meetingType: e.target.value })}>
                    <option value="INTERNAL">Internal</option>
                    <option value="EXTERNAL">External</option>
                  </Select>
                </div>
                {/* (vii) Participants companies / Person if external */}
                {form.meetingType === 'EXTERNAL' && (
                  <Input className="sm:col-span-1" placeholder="External company / person (required for external)" value={form.externalCompanies} onChange={(e) => setForm({ ...form, externalCompanies: e.target.value })} />
                )}
                {/* (viii) Number of attendees */}
                <Input type="number" min={1} placeholder="Number of attendees" value={form.attendees} onChange={(e) => setForm({ ...form, attendees: Number(e.target.value) })} />
                {/* (ix) Name of attendees (optional) */}
                <Input placeholder="Attendee names (optional)" value={form.attendeeNames} onChange={(e) => setForm({ ...form, attendeeNames: e.target.value })} />
                {/* (x) IT assist */}
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" className="rounded" checked={form.itAssist} onChange={(e) => setForm({ ...form, itAssist: e.target.checked })} />
                  IT assist needed for presentation
                </label>
                {/* (xi) Reserved driver */}
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" className="rounded" checked={form.reservedDriver} onChange={(e) => setForm({ ...form, reservedDriver: e.target.checked })} />
                  Reserved driver needed
                </label>
                {/* (xii) Services */}
                <Input className="sm:col-span-2" placeholder="Services (Coffee, Tea, and so on)" value={form.services} onChange={(e) => setForm({ ...form, services: e.target.value })} />
                <Textarea className="sm:col-span-2" rows={2} placeholder="Agenda / notes (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>

              {slotHint && (
                <div className="mt-3 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  Suggested slot from calendar: <b>{slotHint}</b> — the final room is assigned by the Administration Department.
                </div>
              )}

              {(startHoliday || (startWeekend && !!startKey)) && (
                <div className={`mt-3 text-xs rounded-lg px-3 py-2 border ${
                  startHoliday ? 'text-red-700 bg-red-50 border-red-200' : 'text-orange-700 bg-orange-50 border-orange-200'
                }`}>
                  {startHoliday
                    ? `⚠️ ${startKey} is a public holiday — ${startHoliday.name}. You can still submit, but consider a working day.`
                    : '⚠️ The selected date falls on a weekend. You can still submit — Administration will check availability.'}
                </div>
              )}

              {clashes && clashes.length > 0 && (
                <div className="mt-3 text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  Heads-up: overlapping room bookings in this window —
                  {clashes.map((c, i) => (
                    <div key={i} className="mt-1">
                      {c.room?.name ?? 'Room TBD'} ({c.docNumber ?? '—'}): {new Date(c.startTime).toLocaleString()} → {new Date(c.endTime).toLocaleString()}
                    </div>
                  ))}
                  <div className="mt-1 text-orange-600">You can still submit — Administration will check room availability when assigning.</div>
                </div>
              )}

              <div className="mt-3">
                <Button onClick={submit} disabled={!valid || busy}>{busy ? 'Submitting…' : 'Submit Request'}</Button>
              </div>
            </Card>
          )}

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
                {rows.length === 0 && <tr><td colSpan={canAssign ? 6 : 5}><Empty label="No meeting requests yet" /></td></tr>}
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
                      <Badge color={STATUS_COLORS[r.status] ?? 'gray'}>{r.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{r.totalLevels ? `${r.currentLevel}/${r.totalLevels}` : '—'}</td>
                    <td className="px-4 py-3 text-gray-500">{new Date(r.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {canAssign && (
            <Card className="mt-5 p-5">
              <h2 className="font-semibold text-gray-800 mb-1 text-sm uppercase tracking-wide">
                Approved — waiting for room assignment ({queue.length})
              </h2>
              {queue.length === 0 ? (
                <Empty label="No approved requests waiting — all caught up 🎉" />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                      <th className="px-3 py-2 font-medium">Doc No.</th>
                      <th className="px-3 py-2 font-medium">Requester</th>
                      <th className="px-3 py-2 font-medium">Meeting</th>
                      <th className="px-3 py-2 font-medium">Schedule</th>
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
                        <td className="px-3 py-2">{q.meetingRequest?.title ?? '—'} · {q.meetingRequest?.attendees ?? 1} pax</td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                          {q.meetingRequest && `${new Date(q.meetingRequest.startTime).toLocaleString()} → ${new Date(q.meetingRequest.endTime).toLocaleString()}`}
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

      {/* ---------- Tab: Calendar ---------- */}
      {tab === 'calendar' && (
        <>
          <MeetingMonthCalendar onBookSlot={openSlot} />

          {/* Rooms availability — informational only; Administration decides assignments */}
          <Card className="mb-5 p-5">
            <h2 className="font-semibold text-gray-800 mb-1 text-sm uppercase tracking-wide">Rooms availability (next 7 days)</h2>
            <p className="text-xs text-gray-400 mb-3">
              Information only — rooms are assigned by the Administration Department. A "booked" window may still free up, so submit your request anyway if you need one.
            </p>
            {rooms.length === 0 ? (
              <Empty label="No meeting rooms configured yet" />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {rooms.map((r) => (
                  <div key={r.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-gray-800 text-sm">{r.name}</div>
                      <Badge color={ROOM_STATUS_BADGES[r.status] ?? 'gray'}>{r.status}</Badge>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {r.location ? `${r.location} · ` : ''}seats {r.capacity}
                      {r.facilities ? ` · ${r.facilities}` : ''}
                    </div>
                    {r.bookings.length === 0 ? (
                      <div className="text-xs text-green-700 mt-2">No bookings in the next 7 days</div>
                    ) : (
                      <div className="mt-2 space-y-1">
                        <div className="text-xs text-gray-400 uppercase tracking-wide">Booked</div>
                        {r.bookings.map((b, i) => (
                          <div key={i} className="text-xs text-orange-700 bg-orange-50 rounded px-2 py-1">
                            {b.docNumber ?? '—'}: {new Date(b.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            {' → '}
                            {new Date(b.endTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {/* ---------- Tab: Room setup (Administration only) ---------- */}
      {tab === 'setup' && canAssign && (
        <>
          <Card className="mb-5 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">Room setup</h2>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowRoomForm(!showRoomForm);
                  setEditingRoom(null);
                  setRoomForm({ name: '', location: '', capacity: 8, facilities: '', status: 'AVAILABLE' });
                }}
              >
                {showRoomForm ? 'Close' : '+ Add Room'}
              </Button>
            </div>

            {showRoomForm && (
              <Modal
                title={editingRoom ? `Edit room — ${editingRoom.name}` : 'Add room'}
                error={modalError}
                onClose={() => { setShowRoomForm(false); setEditingRoom(null); setModalError(''); }}
              >
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Room name *</label>
                    <Input placeholder="Room name *" value={roomForm.name} onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Location</label>
                      <Input placeholder="e.g. 2nd floor" value={roomForm.location} onChange={(e) => setRoomForm({ ...roomForm, location: e.target.value })} />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Capacity</label>
                      <Input type="number" min={1} placeholder="Capacity" value={roomForm.capacity} onChange={(e) => setRoomForm({ ...roomForm, capacity: Number(e.target.value) })} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Facilities</label>
                    <Input placeholder="TV, Whiteboard…" value={roomForm.facilities} onChange={(e) => setRoomForm({ ...roomForm, facilities: e.target.value })} />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="ghost" onClick={() => { setShowRoomForm(false); setEditingRoom(null); }}>Cancel</Button>
                    {editingRoom ? (
                      <Button onClick={saveRoom} disabled={!roomForm.name.trim()}>Save</Button>
                    ) : (
                      <Button onClick={createRoom} disabled={!roomForm.name.trim()}>Add Room</Button>
                    )}
                  </div>
                </div>
              </Modal>
            )}

            {setup.length === 0 ? (
              <Empty label="No rooms configured yet" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Location</th>
                    <th className="px-3 py-2 font-medium">Capacity</th>
                    <th className="px-3 py-2 font-medium">Facilities</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {setup.map((room) => (
                    <tr key={room.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium">{room.name}</td>
                      <td className="px-3 py-2">{room.location ?? '—'}</td>
                      <td className="px-3 py-2">{room.capacity}</td>
                      <td className="px-3 py-2 text-gray-500">{room.facilities ?? '—'}</td>
                      <td className="px-3 py-2"><Badge color={ROOM_STATUS_BADGES[room.status] ?? 'gray'}>{room.status}</Badge></td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          className="text-blue-600 hover:underline mr-3"
                          onClick={() => {
                            setEditingRoom(room);
                            setShowRoomForm(true);
                            setRoomForm({ name: room.name, location: room.location ?? '', capacity: room.capacity, facilities: room.facilities ?? '', status: room.status });
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                        >
                          Edit
                        </button>
                        <button className="text-red-600 hover:underline" onClick={() => setDeletingRoom(room)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {deletingRoom && (
            <ConfirmDialog
              title={`Delete room ${deletingRoom.name}?`}
              description="Rooms with active bookings cannot be deleted. This cannot be undone."
              confirmLabel="Delete"
              variant="danger"
              onConfirm={async () => {
                const ok = await doDeleteRoom(deletingRoom);
                if (ok) setDeletingRoom(null);
              }}
              onClose={() => setDeletingRoom(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

const ROOM_STATUS_BADGES: Record<string, 'green' | 'blue' | 'yellow' | 'red'> = {
  AVAILABLE: 'green',
  IN_USE: 'blue',
  UNDER_MAINTENANCE: 'yellow',
  OUT_OF_SERVICE: 'red',
};
