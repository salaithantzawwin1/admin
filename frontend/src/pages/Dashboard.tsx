import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getUser, hasPermission } from '../api';
import { Card } from '../components/ui';

interface AnnouncementItem {
  id: string; code: string; title: string; priority: string;
  requiresAck: boolean; read?: boolean; acked?: string | null;
}

const PRIORITY_BADGE: Record<string, string> = {
  IMPORTANT: 'bg-blue-100 text-blue-700',
  URGENT: 'bg-orange-100 text-orange-700',
  EMERGENCY: 'bg-red-100 text-red-700',
};

export default function Dashboard() {
  const user = getUser();
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  const [carQueueCount, setCarQueueCount] = useState<number | null>(null);
  const [roomQueueCount, setRoomQueueCount] = useState<number | null>(null);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);

  const load = useCallback(() => {
    if (hasPermission('approvals.act')) {
      api<{ total: number }>('/requests/inbox?pageSize=1')
        .then((r) => setInboxCount(r.total))
        .catch(() => setInboxCount(null));
    }
    if (hasPermission('cars.assign')) {
      api<unknown[]>('/cars/requests/approved-unassigned')
        .then((r) => setCarQueueCount(r.length))
        .catch(() => setCarQueueCount(null));
    }
    if (hasPermission('meeting-rooms.assign')) {
      api<unknown[]>('/meeting-rooms/requests/approved-unassigned')
        .then((r) => setRoomQueueCount(r.length))
        .catch(() => setRoomQueueCount(null));
    }
    if (hasPermission('announcements.read')) {
      api<AnnouncementItem[]>('/announcements/mine')
        .then((r) => setAnnouncements(r.slice(0, 5)))
        .catch(() => setAnnouncements([]));
    }
  }, []);

  useEffect(load, [load]);

  // auto-refresh: queue counts stay current without manual reload
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const isApprover = hasPermission('approvals.act');
  const canAssign = hasPermission('cars.assign');
  const canAssignRooms = hasPermission('meeting-rooms.assign');

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-800 mb-1">
        Welcome, {user?.fullName ?? 'User'}
      </h1>
      <p className="text-sm text-gray-500 mb-6">Choose an action from the menu on the left.</p>

      {/* Role queues — only for people who act on requests */}
      {(isApprover || canAssign || canAssignRooms) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {isApprover && (
            <Link to="/approvals" className="block">
              <Card className="p-5 hover:border-blue-300 transition-colors h-full">
                <div className="text-sm text-gray-500">Pending Approvals</div>
                <div className="text-2xl font-bold text-gray-800 mt-1">{inboxCount ?? '—'}</div>
                <div className="text-xs text-gray-400 mt-2">Requests waiting for your action →</div>
              </Card>
            </Link>
          )}
          {canAssign && (
            <Link to="/car-requests" className="block">
              <Card className="p-5 hover:border-blue-300 transition-colors h-full">
                <div className="text-sm text-gray-500">Cars to Assign</div>
                <div className="text-2xl font-bold text-gray-800 mt-1">{carQueueCount ?? '—'}</div>
                <div className="text-xs text-gray-400 mt-2">Approved — waiting for vehicle →</div>
              </Card>
            </Link>
          )}
          {hasPermission('meeting-rooms.assign') && (
            <Link to="/meeting-rooms" className="block">
              <Card className="p-5 hover:border-blue-300 transition-colors h-full">
                <div className="text-sm text-gray-500">Rooms to Assign</div>
                <div className="text-2xl font-bold text-gray-800 mt-1">{roomQueueCount ?? '—'}</div>
                <div className="text-xs text-gray-400 mt-2">Approved — waiting for room →</div>
              </Card>
            </Link>
          )}
        </div>
      )}

      {/* Quick links to the two everyday actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Link to="/car-requests" className="block">
          <Card className="p-5 hover:border-blue-300 transition-colors h-full">
            <div className="font-semibold text-gray-800">🚗 Car Requests</div>
            <div className="text-xs text-gray-400 mt-1">Request a company vehicle and follow its status</div>
          </Card>
        </Link>
        <Link to="/meeting-rooms" className="block">
          <Card className="p-5 hover:border-blue-300 transition-colors h-full">
            <div className="font-semibold text-gray-800">Meeting Rooms</div>
            <div className="text-xs text-gray-400 mt-1">Request a meeting room and follow its status</div>
          </Card>
        </Link>
        {hasPermission('requests.read.own') && (
          <Link to="/requests" className="block">
            <Card className="p-5 hover:border-blue-300 transition-colors h-full">
              <div className="font-semibold text-gray-800">📄 My Requests</div>
              <div className="text-xs text-gray-400 mt-1">All requests you have created, with statuses</div>
            </Card>
          </Link>
        )}
      </div>

      {/* Announcements (Plan §18) — visible to anyone with announcements.read */}
      {hasPermission('announcements.read') && announcements.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">📢 Announcements</h2>
            <Link to="/announcements" className="text-xs text-blue-600 hover:underline">View all →</Link>
          </div>
          <div className="space-y-2">
            {announcements.map((a) => (
              <Link key={a.id} to="/announcements" className="block">
                <Card className={`px-4 py-3 hover:border-blue-300 transition-colors ${!a.read ? 'border-l-4 border-l-blue-500' : ''}`}>
                  <div className="flex items-center gap-2">
                    {a.priority !== 'NORMAL' && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${PRIORITY_BADGE[a.priority] ?? ''}`}>{a.priority}</span>
                    )}
                    <span className={`text-sm truncate ${a.read ? 'text-gray-500' : 'font-semibold text-gray-800'}`}>{a.title}</span>
                    {a.requiresAck && !a.acked && <span className="text-xs text-orange-500 shrink-0">ack needed</span>}
                    {!a.read && <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
