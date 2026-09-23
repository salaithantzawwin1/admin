import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { Badge, Button, Card, Input, Select } from './ui';

interface MeetingRequest {
  id: string;
  title: string;
  attendees: number;
  startTime: string;
  endTime: string;
  status: string;
  meetingType?: string;
  externalCompanies?: string;
  attendeeNames?: string;
  itAssist?: boolean;
  reservedDriver?: boolean;
  services?: string;
  room?: { id: string; name: string; location?: string; capacity: number } | null;
}

interface Room {
  id: string;
  name: string;
  location?: string;
  capacity: number;
  status: string;
}

export function MeetingRoomPanel({
  requestId,
  status,
}: {
  requestId: string;
  status: string;
}) {
  const [mr, setMr] = useState<MeetingRequest | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [error, setError] = useState('');
  const [assignRoomId, setAssignRoomId] = useState('');
  const [shiftForm, setShiftForm] = useState({ startTime: '', endTime: '' });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [confirmShift, setConfirmShift] = useState(false);
  const canAssign = hasPermission('meeting-rooms.assign');

  const load = useCallback(() => {
    api<MeetingRequest | null>(`/meeting-rooms/requests/${requestId}`)
      .then(setMr)
      .catch(() => setMr(null));
    if (hasPermission('meeting-rooms.assign')) {
      api<Room[]>('/meeting-rooms/rooms-overview').then((r) => setRooms(r as unknown as Room[])).catch(() => {});
    }
  }, [requestId]);

  useEffect(load, [load]);

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

  if (!mr) return null;

  // Administration plan-change controls on live requests
  const showAdminControls = canAssign && ['APPROVED', 'PENDING_APPROVAL', 'IN_PROGRESS'].includes(status);
  const showAssign = canAssign && status === 'APPROVED' && !mr.room;
  const showComplete = canAssign && status === 'IN_PROGRESS';

  return (
    <Card className="p-5 mb-5">
      <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Meeting Request Details</h2>
      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mb-4">
        <div><div className="text-gray-400 text-xs uppercase">Meeting</div><div className="mt-1 font-medium">{mr.title}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">Attendees</div><div className="mt-1">{mr.attendees}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">Start</div><div className="mt-1">{new Date(mr.startTime).toLocaleString()}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">End</div><div className="mt-1">{new Date(mr.endTime).toLocaleString()}</div></div>
        {mr.meetingType && (
          <div><div className="text-gray-400 text-xs uppercase">Meeting type</div><div className="mt-1">{mr.meetingType}</div></div>
        )}
        {mr.meetingType === 'EXTERNAL' && mr.externalCompanies && (
          <div><div className="text-gray-400 text-xs uppercase">External company / person</div><div className="mt-1">{mr.externalCompanies}</div></div>
        )}
        {mr.attendeeNames && (
          <div className="sm:col-span-2"><div className="text-gray-400 text-xs uppercase">Attendee names</div><div className="mt-1">{mr.attendeeNames}</div></div>
        )}
        <div><div className="text-gray-400 text-xs uppercase">IT assist</div><div className="mt-1">{mr.itAssist ? 'Yes' : 'No'}</div></div>
        <div><div className="text-gray-400 text-xs uppercase">Reserved driver</div><div className="mt-1">{mr.reservedDriver ? 'Yes' : 'No'}</div></div>
        {mr.services && (
          <div className="sm:col-span-2"><div className="text-gray-400 text-xs uppercase">Services</div><div className="mt-1">{mr.services}</div></div>
        )}
        <div>
          <div className="text-gray-400 text-xs uppercase">Assigned room</div>
          <div className="mt-1">
            {mr.room ? (
              <>
                <Badge color="blue">{mr.room.name}</Badge>
                {mr.room.location && <div className="text-xs text-gray-500 mt-1">{mr.room.location} · seats {mr.room.capacity}</div>}
              </>
            ) : (
              <span className="text-gray-400">Not yet</span>
            )}
          </div>
        </div>
      </div>

      {showAdminControls && (
        <div className="border-t border-gray-100 pt-4 mt-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Administration — plan change</div>
          <div className="flex flex-wrap gap-2 items-center">
            <Input type="datetime-local" className="!w-56" value={shiftForm.startTime} onChange={(e) => setShiftForm({ ...shiftForm, startTime: e.target.value })} />
            <Input type="datetime-local" className="!w-56" value={shiftForm.endTime} onChange={(e) => setShiftForm({ ...shiftForm, endTime: e.target.value })} />
            <Button
              variant="ghost"
              disabled={!shiftForm.startTime || !shiftForm.endTime}
              onClick={() => setConfirmShift(true)}
            >
              Shift time
            </Button>
            {showComplete && <Button onClick={() => setConfirmComplete(true)}>Mark Completed</Button>}
            <Button variant="danger" onClick={() => setConfirmCancel(true)}>
              Cancel request
            </Button>
          </div>
          <p className="text-xs text-gray-400 mt-1.5">Shift time moves the meeting (room availability is checked). Mark Completed closes the meeting and frees the room. Cancel frees the room and notifies the requester.</p>
        </div>
      )}

      {confirmShift && (
        <ConfirmDialog
          title="Shift time?"
          description={
            <>Move this meeting to <b>{new Date(shiftForm.startTime).toLocaleString()}</b> → <b>{new Date(shiftForm.endTime).toLocaleString()}</b>. Room availability is checked; the requester will be notified.</>
          }
          confirmLabel="Shift time"
          withNote
          onConfirm={async (note) => {
            const ok = await act(() => api(`/meeting-rooms/requests/${requestId}/admin-shift`, {
              method: 'PATCH',
              body: { startTime: new Date(shiftForm.startTime).toISOString(), endTime: new Date(shiftForm.endTime).toISOString(), comment: note || undefined },
            }));
            if (ok) setConfirmShift(false);
          }}
          onClose={() => setConfirmShift(false)}
        />
      )}

      {confirmComplete && (
        <ConfirmDialog
          title="Mark this meeting as completed?"
          description="The assigned room (if any) will be freed, and the requester will be notified."
          confirmLabel="Mark Completed"
          onConfirm={async () => {
            const ok = await act(() => api(`/meeting-rooms/requests/${requestId}/complete`, { method: 'POST' }));
            if (ok) setConfirmComplete(false);
          }}
          onClose={() => setConfirmComplete(false)}
        />
      )}

      {confirmCancel && (
        <ConfirmDialog
          title="Cancel this meeting request?"
          description="The assigned room (if any) will be freed, and the requester will be notified."
          confirmLabel="Cancel request"
          variant="danger"
          withNote
          onConfirm={async (note) => {
            const ok = await act(() => api(`/meeting-rooms/requests/${requestId}/admin-cancel`, { method: 'POST', body: { comment: note || undefined } }));
            if (ok) setConfirmCancel(false);
          }}
          onClose={() => setConfirmCancel(false)}
        />
      )}

      {showAssign && (
        <div className="border-t border-gray-100 pt-4 mt-4">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Assign room (Administration)</div>
          <div className="flex flex-wrap gap-2 items-center">
            <Select className="!w-64" value={assignRoomId} onChange={(e) => setAssignRoomId(e.target.value)}>
              <option value="">— Room —</option>
              {rooms.filter((r) => r.status === 'AVAILABLE' || r.status === 'IN_USE').map((r) => (
                <option key={r.id} value={r.id}>{r.name} — seats {r.capacity} ({r.status})</option>
              ))}
            </Select>
            <Button
              disabled={!assignRoomId}
              onClick={() => act(() => api(`/meeting-rooms/requests/${requestId}/assign`, { method: 'POST', body: { roomId: assignRoomId } }))}
            >
              Assign
            </Button>
          </div>
        </div>
      )}

      {!mr.room && !canAssign && (
        <div className="mt-2 text-xs text-gray-400">Room assignment appears here after Administration assigns a room (requires APPROVED status).</div>
      )}
    </Card>
  );
}
