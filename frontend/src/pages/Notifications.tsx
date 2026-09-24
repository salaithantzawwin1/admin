import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { typeMeta, relTime } from '../components/NotificationBell';

interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  readStatus: string;
  createdAt: string;
}

const PAGE_SIZE = 25;

export default function Notifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(
    (p: number, append: boolean, onlyUnread: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      api<{ items: Notification[]; total: number; unread: number }>(
        `/notifications?page=${p}&pageSize=${PAGE_SIZE}&unreadOnly=${onlyUnread}`,
      )
        .then((r) => {
          setItems((arr) => (append ? [...arr, ...r.items] : r.items));
          setTotal(r.total);
          setUnread(r.unread);
        })
        .catch(() => {})
        .finally(() => {
          setLoading(false);
          setLoadingMore(false);
        });
    },
    [],
  );

  useEffect(() => {
    load(1, false, unreadOnly);
  }, [unreadOnly, load]);

  const openNotification = async (n: Notification) => {
    if (n.readStatus === 'UNREAD') {
      api(`/notifications/${n.id}/read`, { method: 'PATCH' })
        .then(() => setUnread((u) => Math.max(0, u - 1)))
        .catch(() => {});
      setItems((arr) => arr.map((x) => (x.id === n.id ? { ...x, readStatus: 'READ' } : x)));
    }
    if (n.link) navigate(n.link);
  };

  const markAll = async () => {
    await api('/notifications/read-all', { method: 'POST' }).catch(() => {});
    setUnread(0);
    setItems((arr) => arr.map((x) => ({ ...x, readStatus: 'READ' })));
  };

  const hasMore = items.length < total;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Notifications</h1>
          <p className="text-sm text-gray-500">All your workflow, meeting, car and office alerts</p>
        </div>
        <button
          onClick={markAll}
          disabled={unread === 0}
          className="px-3 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ✓ Mark all read{unread > 0 ? ` (${unread})` : ''}
        </button>
      </div>

      <div className="flex items-center gap-2">
        {[
          { key: 'all', label: `All${total > 0 ? ` · ${total}` : ''}`, active: !unreadOnly },
          { key: 'unread', label: `Unread${unread > 0 ? ` · ${unread}` : ''}`, active: unreadOnly },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setUnreadOnly(t.key === 'unread')}
            className={`px-3.5 py-1.5 text-sm rounded-full border transition-colors ${
              t.active ? 'bg-gray-900 border-gray-900 text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="text-center text-sm text-gray-400 py-16">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-center text-sm text-gray-400 py-16">
            {unreadOnly ? '🎉 All caught up — no unread notifications' : 'No notifications yet'}
          </div>
        ) : (
          items.map((n) => {
            const meta = typeMeta(n.type);
            const isUnread = n.readStatus === 'UNREAD';
            return (
              <button
                key={n.id}
                onClick={() => openNotification(n)}
                className={`w-full text-left px-4 py-3.5 border-b border-gray-50 last:border-0 hover:bg-blue-50/40 transition-colors ${
                  isUnread ? 'bg-blue-50/50' : ''
                }`}
              >
                <div className="flex gap-3">
                  <span className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-base ${meta.cls}`} aria-hidden>
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between gap-3">
                      <span className={`text-sm leading-snug ${isUnread ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>{n.title}</span>
                      <span className="text-xs text-gray-400 whitespace-nowrap pt-0.5" title={new Date(n.createdAt).toLocaleString()}>
                        {relTime(n.createdAt)}
                      </span>
                    </div>
                    {n.body && <div className="text-sm text-gray-500 mt-0.5 line-clamp-2">{n.body}</div>}
                    {n.link && <div className="text-[11px] text-blue-600 mt-1">Open related page →</div>}
                  </div>
                  {isUnread && <span className="shrink-0 w-2 h-2 rounded-full bg-blue-500 mt-2" aria-label="Unread" />}
                </div>
              </button>
            );
          })
        )}
        {hasMore && (
          <div className="border-t border-gray-100 p-3 text-center">
            <button
              onClick={() => {
                const next = page + 1;
                setPage(next);
                load(next, true, unreadOnly);
              }}
              disabled={loadingMore}
              className="text-sm text-blue-600 hover:underline disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : `Load more (${items.length} / ${total})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
