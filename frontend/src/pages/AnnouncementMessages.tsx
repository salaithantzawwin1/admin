import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Badge, Button, Empty, Input, PageLoader } from '../components/ui';
import { toast } from '../components/Toast';
import { useLiveReload } from '../hooks/useLiveReload';
import { fmtDateTime as fmtDateTimeYgn } from '../util/yangonTime';

/** One announcement thread (or the General bucket) as `GET /messages/threads` returns it. */
export interface ThreadRow {
  announcementId: string;
  code: string | null;
  title: string;
  status: string | null;
  publishAt: string | null;
  requiresAck: boolean;
  total: number;
  unread: number;
  lastAt: string | null;
}
export interface ThreadsResponse {
  general: { total: number; unread: number; lastAt: string | null };
  threads: ThreadRow[];
}

/** A subscriber message as `GET /messages` returns it. */
export interface MessageRow {
  id: string;
  chatId: string;
  messageId: string | null;
  replyToMessageId: string | null;
  mediaGroupId: string | null;
  sender: { userId: string | null; driverId: string | null; name: string | null; department: string | null; linked: boolean };
  kind: 'TEXT' | 'PHOTO' | 'DOCUMENT';
  text: string | null;
  photo: { fileId: string; width: number | null; height: number | null } | null;
  documentName: string | null;
  announcementId: string | null;
  handledBy: string;
  state: 'NEW' | 'READ';
  readAt: string | null;
  receivedAt: string;
  ackAt: string | null;
}
interface ListResponse { items: MessageRow[]; total: number; unread: number; page: number; pageSize: number }

const PAGE_SIZE = 50;

type Filter = 'ALL' | 'NEW' | 'REPLIES' | 'IN_PROGRESS' | 'NOT_ACKED';
const FILTERS: { key: Filter; label: string; hint: string }[] = [
  { key: 'ALL', label: 'All', hint: 'Every stored message' },
  { key: 'NEW', label: 'New', hint: 'Not read yet' },
  { key: 'REPLIES', label: 'Announcement replies', hint: 'Telegram Reply to a notice card' },
  { key: 'IN_PROGRESS', label: 'In progress', hint: 'The bot already answered these (odometer, car form, …)' },
  { key: 'NOT_ACKED', label: 'Not acked', hint: 'Sender has not acknowledged the notice' },
];

/** What the bot did with a message — shown so an admin knows it was answered. */
const HANDLED_LABEL: Record<string, string> = {
  CAR_FORM: 'car form',
  REJECT_REASON: 'reject reason',
  ODOMETER: 'odometer',
  ETA: 'eta',
  COMMAND: 'command',
};

/** "2h ago" with the full Yangon timestamp on hover. */
const relTime = (s: string | null) => {
  if (!s) return '';
  const min = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return fmtDateTimeYgn(s).split(',')[0];
};

const initial = (name: string | null) => (name?.trim()?.[0] ?? '?').toUpperCase();

/**
 * Subscriber messages tab (plan §9.3 / P6).
 *
 * Left: announcement threads + General. Right: the conversation, newest last, so
 * it reads like Telegram. Photos are shown as a marker (the bot stores the file
 * id, not the bytes), and each bubble says what the bot did with the message so
 * an admin can tell "answered by the trip flow" from "nobody has looked".
 *
 * The selected thread lives in `?tab=messages&ann=…`, so refresh, back and shared
 * links all land on the same conversation. Live updates arrive as a `message.new`
 * signal plus a 15 s poll — the event is only a hint to refetch, never data.
 */
export default function AnnouncementMessages({ canManage, onOpenAnnouncement }: {
  canManage: boolean;
  onOpenAnnouncement: (id: string) => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const ann = searchParams.get('ann'); // null = thread list only (mobile) / "All" (desktop)
  const selected = ann ?? 'all';
  const onMobileThread = !!ann;

  const [threads, setThreads] = useState<ThreadsResponse | null>(null);
  const [threadsError, setThreadsError] = useState('');
  const [threadSearch, setThreadSearch] = useState('');

  const [filter, setFilter] = useState<Filter>('ALL');
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false);

  const selectThread = (key: string) => {
    // `replace` keeps history clean while still making the URL shareable
    setSearchParams(key === 'all' ? { tab: 'messages' } : { tab: 'messages', ann: key }, { replace: false });
  };

  const loadThreads = useCallback(() => {
    api<ThreadsResponse>('/messages/threads')
      .then((r) => { setThreads(r); setThreadsError(''); })
      .catch((e) => setThreadsError(e instanceof Error ? e.message : 'Failed to load threads'));
  }, []);
  useEffect(loadThreads, [loadThreads]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (selected === 'general') p.set('announcementId', 'none');
    else if (selected !== 'all') p.set('announcementId', selected);
    if (filter === 'NEW') p.set('state', 'NEW');
    if (filter === 'REPLIES') p.set('handledBy', 'ANNOUNCEMENT_REPLY');
    if (filter === 'IN_PROGRESS') p.set('handledBy', 'IN_PROGRESS');
    if (filter === 'NOT_ACKED') p.set('ack', 'pending');
    p.set('pageSize', String(PAGE_SIZE));
    return p;
  }, [selected, filter]);

  const load = useCallback(
    (nextPage: number, mode: 'reset' | 'more' = 'reset') => {
      const p = new URLSearchParams(query);
      p.set('page', String(nextPage));
      if (mode === 'more') setLoadingMore(true);
      else setLoading(true);
      return api<ListResponse>(`/messages?${p.toString()}`)
        .then((r) => {
          setTotal(r.total);
          setPage(r.page);
          setRows((prev) => {
            if (mode === 'more') {
              const seen = new Set(prev.map((x) => x.id));
              return [...prev, ...r.items.filter((x) => !seen.has(x.id))];
            }
            return r.items;
          });
          setListError('');
        })
        .catch((e) => setListError(e instanceof Error ? e.message : 'Failed to load messages'))
        .finally(() => { setLoading(false); setLoadingMore(false); });
    },
    [query],
  );

  useEffect(() => { void load(1, 'reset'); }, [load]);

  // live: a new message, a read elsewhere — refetch the head and the thread counts
  const refresh = useCallback(() => {
    void load(1, 'reset');
    loadThreads();
  }, [load, loadThreads]);
  useLiveReload(['message.new'], refresh);

  useEffect(() => {
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const markAllRead = async () => {
    setBusy(true);
    try {
      const p = new URLSearchParams();
      if (selected === 'general') p.set('announcementId', 'none');
      else if (selected !== 'all') p.set('announcementId', selected);
      const r = await api<{ updated: number }>(`/messages/read-all?${p.toString()}`, { method: 'POST' });
      toast(r.updated > 0 ? `Marked ${r.updated} message${r.updated === 1 ? '' : 's'} read` : 'Nothing new to read');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const markOne = async (id: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, state: 'READ', readAt: new Date().toISOString() } : r)));
    try {
      await api(`/messages/${id}/read`, { method: 'POST' });
      loadThreads();
    } catch {
      // not fatal — the next refresh restores the real state
    }
  };

  const needAckByAnnouncement = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const t of threads?.threads ?? []) map.set(t.announcementId, t.requiresAck);
    return map;
  }, [threads]);

  const currentThread = threads?.threads.find((t) => t.announcementId === selected) ?? null;
  const threadRows = (threads?.threads ?? []).filter((t) => {
    if (!threadSearch) return true;
    const q = threadSearch.toLowerCase();
    return t.title.toLowerCase().includes(q) || (t.code ?? '').toLowerCase().includes(q);
  });
  const allUnread = (threads?.general.unread ?? 0) + (threads?.threads ?? []).reduce((n, t) => n + t.unread, 0);
  const allTotal = (threads?.general.total ?? 0) + (threads?.threads ?? []).reduce((n, t) => n + t.total, 0);

  const headerTitle =
    selected === 'all' ? 'All messages' : selected === 'general' ? 'General' : (currentThread?.title ?? 'Announcement');
  const headerSub =
    selected === 'all'
      ? `${allTotal} message${allTotal === 1 ? '' : 's'} from Telegram`
      : selected === 'general'
        ? 'Not linked to any announcement'
        : [currentThread?.code, currentThread?.publishAt ? fmtDateTimeYgn(currentThread.publishAt) : null]
            .filter(Boolean)
            .join(' · ');

  // oldest → newest, with album photos that arrived together rendered as one bubble
  const ordered = [...rows].reverse();

  return (
    <div className="flex flex-col md:flex-row gap-4 md:gap-5">
      {/* ---------- thread list ---------- */}
      <aside className={`md:w-72 shrink-0 ${onMobileThread ? 'hidden md:block' : ''}`}>
        <div className="mb-2">
          <Input
            value={threadSearch}
            onChange={(e) => setThreadSearch(e.target.value)}
            placeholder="Search threads…"
            aria-label="Search threads"
            className="text-xs py-1.5"
          />
        </div>
        <div className="border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100 max-h-[65vh] overflow-y-auto">
          <button
            onClick={() => selectThread('all')}
            className={`w-full text-left px-3 py-2.5 transition-colors ${selected === 'all' ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-800">All messages</span>
              {allUnread > 0 && <span className="ml-auto"><Badge color="blue">{allUnread} new</Badge></span>}
            </div>
            <div className="text-xs text-gray-400 mt-0.5">{allTotal} total</div>
          </button>

          <button
            onClick={() => selectThread('general')}
            className={`w-full text-left px-3 py-2.5 transition-colors ${selected === 'general' ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-800">💬 General</span>
              {(threads?.general.unread ?? 0) > 0 && (
                <span className="ml-auto"><Badge color="blue">{threads!.general.unread} new</Badge></span>
              )}
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {threads?.general.total ?? 0} message{(threads?.general.total ?? 0) === 1 ? '' : 's'} · not tied to a notice
            </div>
          </button>

          {threadRows.map((t) => (
            <button
              key={t.announcementId}
              onClick={() => selectThread(t.announcementId)}
              className={`w-full text-left px-3 py-2.5 transition-colors ${selected === t.announcementId ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-800 truncate" title={t.title}>{t.title}</span>
                {t.unread > 0 && <span className="ml-auto shrink-0"><Badge color="blue">{t.unread} new</Badge></span>}
              </div>
              <div className="text-xs text-gray-400 mt-0.5 truncate">
                {t.code ?? '—'} · {t.total} message{t.total === 1 ? '' : 's'}
                {t.lastAt ? ` · ${relTime(t.lastAt)}` : ''}
              </div>
              {t.requiresAck && (
                <div className="text-xs text-amber-600 mt-0.5">Needs acknowledgement — check “Not acked”</div>
              )}
            </button>
          ))}

          {threads && !threads.general.total && threads.threads.length === 0 && (
            <div className="px-3 py-6 text-xs text-gray-400 text-center">
              No messages yet — Telegram replies land here
            </div>
          )}
        </div>
        {threadsError && (
          <div className="mt-2 text-xs text-red-600">
            {threadsError}{' '}
            <button className="underline" onClick={loadThreads}>Retry</button>
          </div>
        )}
      </aside>

      {/* ---------- conversation ---------- */}
      <section className={`flex-1 min-w-0 ${onMobileThread ? '' : 'hidden md:block'}`}>
        <div className="border border-gray-200 rounded-xl">
          <header className="px-4 py-3 border-b border-gray-100 flex items-start gap-3 flex-wrap">
            <button
              className="md:hidden w-9 h-9 -ml-1 rounded-lg hover:bg-gray-100 text-gray-600 shrink-0"
              onClick={() => setSearchParams({ tab: 'messages' })}
              aria-label="Back to threads"
            >
              ←
            </button>
            <div className="min-w-0 flex-1 basis-full sm:basis-0">
              <div className="font-semibold text-gray-800 truncate">{headerTitle}</div>
              <div className="text-xs text-gray-400 truncate">{headerSub}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-auto">
              {canManage && currentThread && (
                <button
                  className="text-xs text-blue-600 hover:underline"
                  onClick={() => onOpenAnnouncement(currentThread.announcementId)}
                  title="Open the notice"
                >
                  Open notice →
                </button>
              )}
              <Button variant="ghost" onClick={markAllRead} disabled={busy}>
                {busy ? 'Marking…' : 'Mark all read'}
              </Button>
            </div>
          </header>

          <div className="px-4 py-2 border-b border-gray-100 flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                title={f.hint}
                aria-pressed={filter === f.key}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  filter === f.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="p-3 sm:p-4 min-h-[16rem]">
            {loading && rows.length === 0 && <PageLoader />}

            {!loading && listError && (
              <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {listError}{' '}
                <button className="underline" onClick={() => load(1, 'reset')}>Retry</button>
              </div>
            )}

            {!loading && !listError && rows.length === 0 && (
              <Empty label="No messages yet — Telegram replies land here" />
            )}

            {rows.length > 0 && (
              <div className="space-y-2" role="log" aria-label="Messages">
                {ordered.map((m, i) => {
                  const prev = ordered[i - 1];
                  const grouped = !!m.mediaGroupId && prev?.mediaGroupId === m.mediaGroupId;
                  const needsAck = !!m.announcementId && needAckByAnnouncement.get(m.announcementId) === true;
                  const handled = HANDLED_LABEL[m.handledBy];
                  return (
                    <div key={m.id} className={grouped ? 'pl-9 -mt-1' : ''}>
                      <button
                        type="button"
                        onClick={() => m.state === 'NEW' && markOne(m.id)}
                        className={`w-full text-left rounded-xl border px-3 py-2 transition-colors ${
                          m.state === 'NEW'
                            ? 'border-l-4 border-l-blue-500 border-gray-200 bg-white hover:bg-gray-50 cursor-pointer'
                            : 'border-gray-100 bg-gray-50/60'
                        }`}
                        aria-label={`Message from ${m.sender.name ?? 'unlinked chat'}`}
                      >
                        <div className="flex items-center gap-2 flex-wrap text-xs">
                          {!grouped && (
                            <span className="w-6 h-6 rounded-full bg-gray-200 text-gray-600 text-[11px] font-semibold flex items-center justify-center shrink-0">
                              {initial(m.sender.name)}
                            </span>
                          )}
                          <span className="font-medium text-gray-800">{m.sender.name ?? 'Unlinked chat'}</span>
                          {m.sender.department && <span className="text-gray-400">{m.sender.department}</span>}
                          {!m.sender.linked && <span className="text-amber-600" title="Chat not bound to an AMS user or driver">Not linked</span>}
                          <span className="text-gray-400" title={fmtDateTimeYgn(m.receivedAt)}>{relTime(m.receivedAt)}</span>
                          {m.state === 'NEW' && <span className="text-blue-600 font-medium">NEW</span>}
                          {needsAck && (
                            m.ackAt
                              ? <span className="text-green-600 font-medium">✓ acked</span>
                              : <span className="text-amber-600 font-medium">! not acked</span>
                          )}
                          {handled && (
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500" title="The bot already handled this message">
                              {handled}
                            </span>
                          )}
                        </div>
                        {m.text && (
                          <div className="text-sm text-gray-700 mt-1 whitespace-pre-wrap break-words pl-8">{m.text}</div>
                        )}
                        {m.photo && (
                          <div className="text-sm text-gray-500 mt-1 pl-8">
                            🖼 Photo{m.photo.width && m.photo.height ? ` · ${m.photo.width}×${m.photo.height}` : ''}
                          </div>
                        )}
                        {m.documentName && (
                          <div className="text-sm text-gray-500 mt-1 pl-8">📄 {m.documentName}</div>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {rows.length > 0 && rows.length < total && (
              <div className="mt-3 text-center">
                <Button variant="ghost" onClick={() => load(page + 1, 'more')} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Load older (${total - rows.length} left)`}
                </Button>
              </div>
            )}
          </div>
        </div>
        {selected !== 'all' && selected !== 'general' && canManage && currentThread?.requiresAck && (
          <p className="text-xs text-gray-400 mt-2">
            “Not acked” lists replies from senders who have not acknowledged this notice yet.
          </p>
        )}
      </section>
    </div>
  );
}
