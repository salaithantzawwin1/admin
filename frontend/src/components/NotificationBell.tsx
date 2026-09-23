import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  readStatus: string;
  createdAt: string;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api<{ items: Notification[]; unread: number }>('/notifications?pageSize=10')
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000); // poll every 30s
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const openNotification = async (n: Notification) => {
    if (n.readStatus === 'UNREAD') {
      await api(`/notifications/${n.id}/read`, { method: 'PATCH' }).catch(() => {});
    }
    setOpen(false);
    load();
    if (n.link) navigate(n.link);
  };

  const markAll = async () => {
    await api('/notifications/read-all', { method: 'POST' }).catch(() => {});
    load();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg hover:bg-gray-100"
        title="Notifications"
      >
        <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3A6 6 0 006 11v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-96 bg-white border border-gray-200 rounded-xl shadow-lg z-50 max-h-[480px] overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <span className="font-semibold text-sm text-gray-800">Notifications</span>
            <button className="text-xs text-blue-600 hover:underline" onClick={markAll}>Mark all read</button>
          </div>
          <div className="overflow-y-auto">
            {items.length === 0 && <div className="text-center text-sm text-gray-400 py-10">No notifications</div>}
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => openNotification(n)}
                className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 ${n.readStatus === 'UNREAD' ? 'bg-blue-50/50' : ''}`}
              >
                <div className="flex justify-between gap-2">
                  <span className={`text-sm ${n.readStatus === 'UNREAD' ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{n.title}</span>
                  <span className="text-[10px] text-gray-400 whitespace-nowrap">{new Date(n.createdAt).toLocaleDateString()}</span>
                </div>
                {n.body && <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{n.body}</div>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
