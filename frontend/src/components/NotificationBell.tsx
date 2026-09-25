import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useLiveReload } from '../hooks/useLiveReload';

interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  readStatus: string;
  createdAt: string;
}

const BASE_TITLE = 'AMS — Administration Management System';

const TYPE_META: Record<string, { icon: string; cls: string }> = {
  // workflow
  SUBMITTED: { icon: '📤', cls: 'bg-blue-100 text-blue-600' },
  APPROVED: { icon: '✅', cls: 'bg-green-100 text-green-600' },
  FINAL_APPROVED: { icon: '🎉', cls: 'bg-green-100 text-green-700' },
  REJECTED: { icon: '❌', cls: 'bg-red-100 text-red-600' },
  RETURNED: { icon: '↩️', cls: 'bg-amber-100 text-amber-600' },
  DELEGATED: { icon: '👤', cls: 'bg-purple-100 text-purple-600' },
  ESCALATED: { icon: '⬆️', cls: 'bg-orange-100 text-orange-600' },
  CANCELLED: { icon: '🚫', cls: 'bg-gray-100 text-gray-600' },
  // cars / trips
  CAR_ASSIGNED: { icon: '🚗', cls: 'bg-blue-100 text-blue-600' },
  TRIP_STARTED: { icon: '🛣️', cls: 'bg-indigo-100 text-indigo-600' },
  TRIP_COMPLETED: { icon: '🏁', cls: 'bg-green-100 text-green-600' },
  CAR_DRIVER_NOTED: { icon: '👁️', cls: 'bg-gray-100 text-gray-600' },
  CAR_DRIVER_ARRIVED: { icon: '📍', cls: 'bg-blue-100 text-blue-600' },
  CAR_DRIVER_RETURNED: { icon: '🔄', cls: 'bg-gray-100 text-gray-600' },
  // meetings
  MEETING_ROOM_ASSIGNED: { icon: '🏢', cls: 'bg-blue-100 text-blue-600' },
  MEETING_COMPLETED: { icon: '📝', cls: 'bg-gray-100 text-gray-600' },
  // inventory
  LOW_STOCK: { icon: '📦', cls: 'bg-amber-100 text-amber-600' },
  // telegram / announcements
  TELEGRAM_JOIN_REQUESTED: { icon: '📨', cls: 'bg-purple-100 text-purple-600' },
  ANNOUNCEMENT: { icon: '📣', cls: 'bg-amber-100 text-amber-700' },
  REMINDER: { icon: '⏰', cls: 'bg-amber-100 text-amber-600' },
};

export function typeMeta(type: string) {
  return TYPE_META[type] || { icon: '🔔', cls: 'bg-gray-100 text-gray-600' };
}

export function relTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  // highest createdAt among current list — a count increase alone can't tell us
  // WHICH rows are new (read-all / deletes move the count), a newer timestamp can.
  const newestRef = useRef<string | null>(null);
  // previous badge count, for the "×N new" pulse line
  const prevCountRef = useRef(0);
  // desktop notifications — undefined on insecure origins (plain http), guarded
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  // newest createdAt already surfaced as a desktop notification
  const lastShownRef = useRef<string | null>(null);
  const prevUnreadRef = useRef<number | null>(null);
  const openRef = useRef(false);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // (N) badge in the browser tab title
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
  }, [unread]);

  /** Badge poll — lightweight (single COUNT), runs every 15s even when closed. */
  const pollBadge = useCallback(() => {
    api<{ unread: number }>('/notifications/unread-count')
      .then((r) => setUnread(r.unread))
      .catch(() => {});
  }, []);

  /** Full list — fetched when opening the dropdown and refreshed while it is open. */
  const load = useCallback(
    (onlyUnread: boolean) => {
      api<{ items: Notification[]; unread: number }>(`/notifications?pageSize=15&unreadOnly=${onlyUnread}`)
        .then((r) => {
          setItems(r.items);
          setUnread(r.unread);
          const newest = r.items[0]?.createdAt ?? null;
          if (r.items.length > 0 && newestRef.current && newest && newest > newestRef.current) {
            prevCountRef.current = 0; // marker below renders instead of a number
          }
          newestRef.current = newest;
          // rows seen while the dropdown is open must not fire desktop alerts later
          if (newest && (openRef.current || !lastShownRef.current)) lastShownRef.current = newest;
        })
        .catch(() => {});
    },
    [],
  );

  // Badge: initial + 15s polling, paused when the tab is hidden.
  // Dropdown-open polling is faster (5s) so new arrivals pop in live.
  useEffect(() => {
    pollBadge();
    const t = setInterval(() => {
      if (!document.hidden) pollBadge();
    }, 15000);
    return () => clearInterval(t);
  }, [pollBadge]);

  // Live push: server SSE signals refresh the badge instantly (polling above stays as fallback).
  useLiveReload(['notification'], () => {
    if (!document.hidden) pollBadge();
    if (openRef.current) load(unreadOnly);
  });

  // While the dropdown is open: refresh the visible list every 5s.
  useEffect(() => {
    if (!open) return;
    load(unreadOnly);
    const t = setInterval(() => {
      if (!document.hidden) load(unreadOnly);
    }, 5000);
    return () => clearInterval(t);
  }, [open, unreadOnly, load]);

  // Fetching the page from another tab (e.g. after read-all elsewhere) also
  // refreshes here via the badge delta — plus a refresh when the tab regains focus.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) pollBadge();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [pollBadge]);

  // Desktop-alert baseline: newest notification at login must not alert later.
  useEffect(() => {
    if (perm !== 'granted') return;
    api<{ items: Notification[] }>('/notifications?pageSize=1')
      .then((r) => {
        if (!lastShownRef.current) lastShownRef.current = r.items[0]?.createdAt ?? null;
      })
      .catch(() => {});
  }, [perm]);

  // Unread count went up → fire desktop alerts for rows newer than the baseline
  // (only when the tab is NOT focused — the in-tab bell already covers focus).
  useEffect(() => {
    const prev = prevUnreadRef.current;
    prevUnreadRef.current = unread;
    if (prev === null || unread <= prev) return;
    if (perm !== 'granted' || document.hasFocus()) return;
    api<{ items: Notification[] }>('/notifications?pageSize=5')
      .then((r) => {
        const fresh = r.items.filter((n) => !lastShownRef.current || n.createdAt > lastShownRef.current);
        if (r.items[0]?.createdAt) lastShownRef.current = r.items[0].createdAt;
        for (const n of fresh.slice(0, 3)) {
          try {
            const d = new Notification(n.title, { body: n.body || undefined, tag: n.id, icon: '/GLG.png' });
            d.onclick = () => {
              window.focus();
              d.close();
              if (n.link) navigate(n.link);
            };
          } catch {
            break; // insecure context or blocked — stay silent
          }
        }
      })
      .catch(() => {});
  }, [unread, perm, navigate]);

  const requestPerm = () => {
    if (typeof Notification === 'undefined') return;
    Notification.requestPermission().then((p) => setPerm(p));
  };

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const openNotification = async (n: Notification) => {
    if (n.readStatus === 'UNREAD') {
      api(`/notifications/${n.id}/read`, { method: 'PATCH' })
        .then(() => setUnread((u) => Math.max(0, u - 1)))
        .catch(() => {});
    }
    setItems((arr) => arr.map((x) => (x.id === n.id ? { ...x, readStatus: 'READ' } : x)));
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const markAll = async () => {
    await api('/notifications/read-all', { method: 'POST' }).catch(() => {});
    setUnread(0);
    setItems((arr) => arr.map((x) => ({ ...x, readStatus: 'READ' })));
  };

  const pulse = unread > prevCountRef.current && prevCountRef.current !== 0;
  // count delta this poll; shows as "×N new" line once, then baseline resets
  const pulseDelta = pulse ? unread - prevCountRef.current : 0;

  // keep the baseline in sync without re-render loops
  useEffect(() => {
    const t = setTimeout(() => {
      prevCountRef.current = unread;
    }, 4000);
    return () => clearTimeout(t);
  }, [unread]);

  const hasNewInList =
    newestRef.current !== null && items.some((n) => n.readStatus === 'UNREAD' && n.createdAt > newestRef.current! && prevCountRef.current === 0);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`relative p-2 rounded-lg hover:bg-gray-100 transition-colors ${open ? 'bg-gray-100' : ''}`}
        title="Notifications"
      >
        <svg className={`w-5 h-5 transition-colors ${unread > 0 ? 'text-gray-800' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3A6 6 0 006 11v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span
            className={`absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow ${pulse ? 'animate-ping-once' : ''}`}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-96 bg-white border border-gray-200 rounded-xl shadow-xl z-50 max-h-[520px] overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-gray-800">Notifications</span>
              {unread > 0 && (
                <span className="text-[10px] font-bold bg-red-500 text-white rounded-full px-1.5 py-0.5">{unread}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {perm === 'default' && (
                <button
                  className="text-xs text-amber-600 hover:text-amber-700 hover:underline transition-colors"
                  onClick={requestPerm}
                  title="Get desktop alerts when the tab is in the background"
                >
                  🔔 Enable desktop alerts
                </button>
              )}
              <button className="text-xs text-gray-500 hover:text-blue-600 transition-colors disabled:opacity-40" onClick={markAll} disabled={unread === 0}>
                Mark all read
              </button>
            </div>
          </div>

          {/* Unread-only toggle */}
          <div className="px-4 pt-2 pb-1">
            <button
              onClick={() => setUnreadOnly(!unreadOnly)}
              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                unreadOnly ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${unreadOnly ? 'bg-white' : 'bg-blue-500'}`} />
              Unread only
            </button>
          </div>

          <div className="overflow-y-auto">
            {items.length === 0 && (
              <div className="text-center text-sm text-gray-400 py-12">
                {unreadOnly ? '🎉 All caught up — no unread notifications' : 'No notifications'}
              </div>
            )}
            {pulseDelta > 0 && hasNewInList && (
              <div className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-4 py-1">
                ×{pulseDelta} new
              </div>
            )}
            {items.map((n) => {
              const meta = typeMeta(n.type);
              const isUnread = n.readStatus === 'UNREAD';
              return (
                <button
                  key={n.id}
                  onClick={() => openNotification(n)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-blue-50/40 transition-colors ${
                    isUnread ? 'bg-blue-50/60' : 'opacity-80'
                  }`}
                >
                  <div className="flex gap-2.5">
                    <span className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-sm ${meta.cls}`} aria-hidden>
                      {meta.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2">
                        <span className={`text-sm leading-snug ${isUnread ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{n.title}</span>
                        <span className="text-[10px] text-gray-400 whitespace-nowrap pt-0.5" title={new Date(n.createdAt).toLocaleString()}>
                          {relTime(n.createdAt)}
                        </span>
                      </div>
                      {n.body && <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{n.body}</div>}
                    </div>
                    {isUnread && <span className="shrink-0 w-2 h-2 rounded-full bg-blue-500 mt-1.5" aria-label="Unread" />}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="border-t border-gray-100 px-4 py-2 text-center">
            <button
              className="text-xs text-blue-600 hover:underline"
              onClick={() => {
                setOpen(false);
                navigate('/notifications');
              }}
            >
              View all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
