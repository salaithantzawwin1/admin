import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, getToken } from '../api';
import { Badge, Button, Empty, Input, PageLoader } from '../components/ui';
import { toast } from '../components/Toast';
import { useLiveReload } from '../hooks/useLiveReload';
import { useFocusTrap, useScrollLock } from '../components/Modal';
import { fmtDate, fmtDateTime as fmtDateTimeYgn } from '../util/yangonTime';

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
export interface Bucket {
  total: number;
  unread: number;
  lastAt: string | null;
}
export interface ThreadsResponse {
  /** messages the subscriber wrote to the bot, not tied to a notice */
  general: Bucket;
  /** messages a vehicle-trip flow consumed (odometer, ETA, reject reason, …) */
  trips: Bucket;
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

type Filter = 'ALL' | 'NEW' | 'REPLIES' | 'NOT_ACKED';
const FILTERS: { key: Filter; label: string; hint: string }[] = [
  { key: 'ALL', label: 'All', hint: 'Every stored message' },
  { key: 'NEW', label: 'New', hint: 'Not read yet' },
  { key: 'REPLIES', label: 'Announcement replies', hint: 'Telegram Reply to a notice card' },
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

/** ENUM_VALUE → "Enum value": a badge should read like a word, not a database dump. */
const titleCase = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** What the bot did with a message, in words — a reply to a notice has no bot action of its own. */
const handledText = (handledBy: string) =>
  HANDLED_LABEL[handledBy] ?? (handledBy === 'ANNOUNCEMENT_REPLY' ? 'reply to a notice' : 'nothing yet');

/** Priority → badge colour; an EMERGENCY must never look like a NORMAL. */
const PRIORITY_COLOR: Record<string, 'gray' | 'blue' | 'orange' | 'red'> = {
  NORMAL: 'gray',
  IMPORTANT: 'blue',
  URGENT: 'orange',
  EMERGENCY: 'red',
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

/** One label/value pair in the preview's fact grid. */
function PreviewFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className={`mt-0.5 break-words ${mono ? 'font-mono text-[11px] text-gray-500' : 'text-xs text-gray-700'}`}>
        {value}
      </dd>
    </div>
  );
}

/** A Telegram photo, proxied by the API — the inbound log keeps only a file id. */
function MessagePhoto({
  id,
  width,
  height,
  className = '',
}: {
  id: string;
  width: number | null;
  height: number | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className={`flex items-center justify-center rounded-lg bg-white text-gray-400 ring-1 ring-gray-200 ${className}`}
        aria-hidden="true"
      >
        🖼
      </span>
    );
  }
  return (
    <img
      src={`/api/messages/${id}/photo?token=${encodeURIComponent(getToken() ?? '')}`}
      alt={width && height ? `Telegram photo, ${width}×${height}` : 'Telegram photo'}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`rounded-lg bg-white object-cover ring-1 ring-gray-200 ${className}`}
    />
  );
}

/** "Today" / "Yesterday" / "12 Nov 2026", Yangon-anchored like every other date. */
function dayLabel(iso: string): string {
  const day = fmtDate(iso);
  if (day === fmtDate(new Date())) return 'Today';
  if (day === fmtDate(new Date(Date.now() - 86_400_000))) return 'Yesterday';
  return day;
}

/** Odometer movement since the previous numeric reading in the same thread. */
function odometerDelta(ordered: MessageRow[], index: number): { previous: number; since: number } | null {
  const current = Number((ordered[index]?.text ?? '').replace(/[,\s]/g, ''));
  if (index < 0 || !ordered[index].text || !Number.isFinite(current)) return null;
  for (let i = index - 1; i >= 0; i--) {
    const raw = (ordered[i].text ?? '').replace(/[,\s]/g, '');
    if (!/^\d+$/.test(raw)) continue;
    const previous = Number(raw);
    if (previous === current) continue;
    return { previous, since: current - previous };
  }
  return null;
}

/**
 * The message itself. The value is what the admin opened the panel for, so a
 * short one (an odometer reading, an ETA, a reject code) is set large and
 * tabular; prose keeps the normal reading size.
 */
function MessageBody({ message }: { message: MessageRow }) {
  const text = message.text?.trim() ?? '';
  if (text) {
    const hero = text.length <= 24;
    return (
      <p
        className={
          hero
            ? 'whitespace-pre-wrap break-words text-2xl font-semibold leading-tight tracking-tight text-gray-900 tabular-nums'
            : 'whitespace-pre-wrap break-words text-[15px] leading-relaxed text-gray-800'
        }
      >
        {text}
      </p>
    );
  }
  if (message.photo) {
    // keyed by id: stepping between two photos must reset a previous load failure
    return (
      <MessagePhoto
        key={message.id}
        id={message.id}
        width={message.photo.width}
        height={message.photo.height}
        className="max-h-80 w-auto max-w-full"
      />
    );
  }
  if (message.documentName) {
    return (
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white text-lg ring-1 ring-gray-200"
          aria-hidden="true"
        >
          📄
        </span>
        <div className="min-w-0">
          <div className="break-words text-sm font-semibold text-gray-800">{message.documentName}</div>
          <div className="text-xs text-gray-400">the bot keeps the file reference, not the file</div>
        </div>
      </div>
    );
  }
  return <p className="text-sm text-gray-400">No text in this message.</p>;
}

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
/** The notice read in the side panel (GET /announcements/:id). */
interface NoticeDetail {
  id: string;
  code: string;
  title: string;
  content: string;
  category: string;
  priority: string;
  status: string;
  publishAt: string | null;
  endAt: string | null;
  createdBy: string | null;
  attachments?: { id: string; filename: string; mimeType: string; size: number }[];
}

export default function AnnouncementMessages({ canManage }: { canManage: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const ann = searchParams.get('ann'); // null = thread list only (mobile) / "All" (desktop)
  const bucket = searchParams.get('bucket'); // 'trips' — the vehicle-trip inbox
  const selected = ann ?? (bucket === 'trips' ? 'trips' : 'all');
  const onMobileThread = !!ann || selected === 'trips';

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
  // selected message → preview panel (clicking a bubble means "show me this")
  const [previewId, setPreviewId] = useState<string | null>(null);
  // both drawers behave like every other dialog in the app: page scroll locked
  // while either is open, Tab trapped inside, focus returned to its trigger
  const previewTrap = useFocusTrap<HTMLDivElement>(!!previewId);

  // ---- notice side panel: read the announcement without leaving the inbox
  const noticeId = searchParams.get('notice');

  const noticeTrap = useFocusTrap<HTMLDivElement>(!!noticeId);
  useScrollLock(!!previewId || !!noticeId);

  // newest first, like a chat; the odometer maths still needs the chronological order
  const ordered = rows;
  const chronological = [...rows].reverse();
  const previewMessage = rows.find((r) => r.id === previewId) ?? null;
  const previewPos = previewMessage ? rows.findIndex((x) => x.id === previewMessage.id) : -1;
  // ← steps up the list (newer), → steps down it (older)
  const prevPreview = previewPos > 0 ? rows[previewPos - 1] : null;
  const nextPreview = previewPos >= 0 && previewPos < rows.length - 1 ? rows[previewPos + 1] : null;
  const distance = odometerDelta(
    chronological,
    chronological.findIndex((x) => x.id === previewMessage?.id),
  );
  const [notice, setNotice] = useState<NoticeDetail | null>(null);
  const [noticeError, setNoticeError] = useState('');

  useEffect(() => {
    if (!noticeId) {
      setNotice(null);
      setNoticeError('');
      return;
    }
    let dead = false;
    const load = canManage
      ? api<NoticeDetail>(`/announcements/${noticeId}`)
      : api<NoticeDetail[]>('/announcements/mine').then((rows) => {
          const hit = rows.find((r) => r.id === noticeId);
          if (!hit) throw new Error('Notice not found');
          return hit;
        });
    load
      .then((r) => {
        if (dead) return;
        setNotice(r);
        setNoticeError('');
      })
      .catch((e) => {
        if (dead) return;
        setNotice(null);
        setNoticeError(e instanceof Error ? e.message : 'Could not load the notice');
      });
    return () => {
      dead = true;
    };
  }, [noticeId, canManage]);

  const openNotice = (id: string) => {
    const p = new URLSearchParams(searchParams);
    p.set('notice', id);
    setSearchParams(p, { replace: false });
  };
  const closeNotice = () => {
    const p = new URLSearchParams(searchParams);
    p.delete('notice');
    setSearchParams(p, { replace: false });
  };

  // Esc closes; ← / → walk the thread without reopening the modal
  useEffect(() => {
    if (!previewId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewId(null);
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? nextPreview : prevPreview;
      if (step) setPreviewId(step.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewId, nextPreview, prevPreview]);

  useEffect(() => {
    if (!noticeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNotice();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeId, searchParams]);

  const selectThread = (key: string) => {
    // `replace` keeps history clean while still making the URL shareable
    setSearchParams(
      key === 'all'
        ? { tab: 'messages' }
        : key === 'trips'
          ? { tab: 'messages', bucket: 'trips' }
          : { tab: 'messages', ann: key },
      { replace: false },
    );
  };

  const loadThreads = useCallback(() => {
    api<ThreadsResponse>('/messages/threads')
      .then((r) => { setThreads(r); setThreadsError(''); })
      .catch((e) => setThreadsError(e instanceof Error ? e.message : 'Failed to load threads'));
  }, []);
  useEffect(loadThreads, [loadThreads]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (selected === 'trips') p.set('source', 'trips');
    else if (selected === 'general') {
      p.set('announcementId', 'none');
      p.set('source', 'direct');
    } else if (selected !== 'all') p.set('announcementId', selected);
    if (filter === 'NEW') p.set('state', 'NEW');
    if (filter === 'REPLIES') p.set('handledBy', 'ANNOUNCEMENT_REPLY');
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
      if (selected === 'trips') p.set('source', 'trips');
      else if (selected === 'general') p.set('source', 'direct');
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
  const allUnread =
    (threads?.general.unread ?? 0) +
    (threads?.trips.unread ?? 0) +
    (threads?.threads ?? []).reduce((n, t) => n + t.unread, 0);
  const allTotal =
    (threads?.general.total ?? 0) +
    (threads?.trips.total ?? 0) +
    (threads?.threads ?? []).reduce((n, t) => n + t.total, 0);

  const headerTitle =
    selected === 'all'
      ? 'All messages'
      : selected === 'general'
        ? 'Direct messages'
        : selected === 'trips'
          ? 'Vehicle trips'
          : (currentThread?.title ?? 'Announcement');
  const headerSub =
    selected === 'all'
      ? `${allTotal} message${allTotal === 1 ? '' : 's'} from Telegram`
      : selected === 'general'
        ? 'Written to the bot — not tied to a notice or a trip'
        : selected === 'trips'
          ? 'Odometer, ETA, reject reasons and car-form replies from the trip flow'
          : [currentThread?.code, currentThread?.publishAt ? fmtDateTimeYgn(currentThread.publishAt) : null]
              .filter(Boolean)
              .join(' · ');

  // trip messages are not replies to a notice, so those filters would be empty
  const visibleFilters =
    selected === 'trips'
      ? FILTERS.filter((f) => f.key === 'ALL' || f.key === 'NEW')
      : selected === 'general'
        ? FILTERS.filter((f) => f.key !== 'NOT_ACKED')
        : FILTERS;

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
              <span className="text-sm font-medium text-gray-800">✉️ Direct messages</span>
              {(threads?.general.unread ?? 0) > 0 && (
                <span className="ml-auto"><Badge color="blue">{threads!.general.unread} new</Badge></span>
              )}
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {threads?.general.total ?? 0} message{(threads?.general.total ?? 0) === 1 ? '' : 's'} · written to the bot
            </div>
          </button>

          <button
            onClick={() => selectThread('trips')}
            className={`w-full text-left px-3 py-2.5 transition-colors ${selected === 'trips' ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-800">🚗 Vehicle trips</span>
              {(threads?.trips.unread ?? 0) > 0 && (
                <span className="ml-auto"><Badge color="blue">{threads!.trips.unread} new</Badge></span>
              )}
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {threads?.trips.total ?? 0} message{(threads?.trips.total ?? 0) === 1 ? '' : 's'} · answered by the trip flow
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

          {threads && !threads.general.total && !threads.trips.total && threads.threads.length === 0 && (
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
                  onClick={() => openNotice(currentThread.announcementId)}
                  title="Read the notice beside the conversation"
                >
                  Open notice ⇥
                </button>
              )}
              <Button variant="ghost" onClick={markAllRead} disabled={busy}>
                {busy ? 'Marking…' : 'Mark all read'}
              </Button>
            </div>
          </header>

          <div className="px-4 py-2 border-b border-gray-100 flex flex-wrap gap-1.5">
            {visibleFilters.map((f) => (
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
              <Empty
                label={
                  selected === 'trips'
                    ? 'No vehicle-trip messages in this window'
                    : 'No messages yet — Telegram replies land here'
                }
              />
            )}

            {rows.length > 0 && (
              <div className="space-y-2" role="log" aria-label="Messages">
                {ordered.map((m, i) => {
                  const prev = ordered[i - 1];
                  const startsDay = !prev || fmtDate(m.receivedAt) !== fmtDate(prev.receivedAt);
                  // one sender on one day is one group: avatar and name print once
                  const sameSender =
                    !startsDay &&
                    !!prev &&
                    prev.sender.name === m.sender.name &&
                    prev.sender.linked === m.sender.linked;
                  const album = !!m.mediaGroupId && prev?.mediaGroupId === m.mediaGroupId;
                  const grouped = sameSender || album;
                  const needsAck = !!m.announcementId && needAckByAnnouncement.get(m.announcementId) === true;
                  const handled = HANDLED_LABEL[m.handledBy];
                  return (
                    <div key={m.id}>
                      {startsDay && (
                        <div className="flex items-center gap-3 pb-1 pt-2">
                          <span className="h-px flex-1 bg-gray-100" />
                          <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                            {dayLabel(m.receivedAt)}
                          </span>
                          <span className="h-px flex-1 bg-gray-100" />
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setPreviewId(m.id);
                          if (m.state === 'NEW') void markOne(m.id);
                        }}
                        aria-pressed={previewId === m.id}
                        className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                          grouped ? '' : 'mt-1'
                        } ${
                          m.state === 'NEW'
                            ? 'border-l-4 border-l-blue-500 border-gray-200 bg-white hover:bg-gray-50'
                            : 'border-gray-100 bg-gray-50/60 hover:bg-gray-50'
                        } ${previewId === m.id ? 'ring-2 ring-blue-400' : ''}`}
                        aria-label={`Message from ${m.sender.name ?? 'unlinked chat'}`}
                      >
                        {!grouped && (
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[11px] font-semibold text-gray-600">
                              {initial(m.sender.name)}
                            </span>
                            <span className="font-medium text-gray-800">{m.sender.name ?? 'Unlinked chat'}</span>
                            {m.sender.department && <span className="text-gray-400">{m.sender.department}</span>}
                            {!m.sender.linked && (
                              <span className="text-amber-600" title="Chat not bound to an AMS user or driver">
                                Not linked
                              </span>
                            )}
                            <span className="text-gray-400" title={fmtDateTimeYgn(m.receivedAt)}>
                              {relTime(m.receivedAt)}
                            </span>
                            {needsAck &&
                              (m.ackAt ? (
                                <span className="font-medium text-green-600">✓ acked</span>
                              ) : (
                                <span className="font-medium text-amber-600">! not acked</span>
                              ))}
                            {handled && (
                              <span
                                className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500"
                                title="The bot already handled this message"
                              >
                                {handled}
                              </span>
                            )}
                          </div>
                        )}
                        <div className="flex items-start gap-3">
                          {m.photo && (
                            <MessagePhoto
                              id={m.id}
                              width={m.photo.width}
                              height={m.photo.height}
                              className="h-14 w-14 shrink-0"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            {m.state === 'NEW' && (
                              <span className="mr-1.5 align-middle text-[11px] font-medium text-blue-600">NEW</span>
                            )}
                            {m.text && (
                              <span className="whitespace-pre-wrap break-words align-middle text-sm text-gray-700">
                                {m.text}
                              </span>
                            )}
                            {m.documentName && (
                              <span className="text-sm text-gray-500">📄 {m.documentName}</span>
                            )}
                          </div>
                        </div>
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
        {selected !== 'all' && selected !== 'general' && selected !== 'trips' && canManage && currentThread?.requiresAck && (
          <p className="text-xs text-gray-400 mt-2">
            “Not acked” lists replies from senders who have not acknowledged this notice yet.
          </p>
        )}
      </section>

      {/* ---------- one message, in full ---------- */}
      {previewMessage && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3 sm:p-4"
          onMouseDown={() => setPreviewId(null)}
        >
          <div
            ref={previewTrap}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="message-preview-title"
            className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl outline-none animate-[modalIn_.15s_ease-out]"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="flex items-start gap-2 border-b border-gray-100 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Message preview</div>
                <h2 id="message-preview-title" className="truncate text-sm font-semibold text-gray-900">
                  {headerTitle}
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  className="h-9 w-9 rounded-lg text-lg leading-none text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 disabled:hover:bg-transparent"
                  onClick={() => prevPreview && setPreviewId(prevPreview.id)}
                  disabled={!prevPreview}
                  aria-label="Newer message"
                  title="Newer message (←)"
                >
                  ‹
                </button>
                <button
                  className="h-9 w-9 rounded-lg text-lg leading-none text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 disabled:hover:bg-transparent"
                  onClick={() => nextPreview && setPreviewId(nextPreview.id)}
                  disabled={!nextPreview}
                  aria-label="Older message"
                  title="Older message (→)"
                >
                  ›
                </button>
                <button
                  className="h-9 w-9 rounded-lg text-xl leading-none text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                  onClick={() => setPreviewId(null)}
                  aria-label="Close the preview"
                >
                  ×
                </button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-sm font-semibold text-gold-dark">
                  {initial(previewMessage.sender.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-gray-900">
                    {previewMessage.sender.name ?? 'Unlinked chat'}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                    <span>{previewMessage.sender.department ?? 'No department'}</span>
                    {!previewMessage.sender.linked && (
                      <Badge color="orange" title="This Telegram chat is not bound to an AMS user or driver">
                        Not linked
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Badge color="gray">{titleCase(previewMessage.kind)}</Badge>
                {previewMessage.state === 'NEW' ? <Badge color="blue">New</Badge> : <Badge color="gray">Read</Badge>}
                {previewMessage.ackAt && <Badge color="green">✓ Acknowledged</Badge>}
              </div>

              <div className="mt-3 rounded-xl border border-gray-200 border-l-4 border-l-gold bg-gray-50/70 px-4 py-3">
                <MessageBody message={previewMessage} />
                {distance && (
                  <div className="mt-2 border-t border-gray-200/70 pt-2 text-xs text-gray-500">
                    <span className="font-semibold tabular-nums text-gray-700">
                      {distance.since > 0 ? '+' : ''}
                      {distance.since.toLocaleString()}
                    </span>{' '}
                    since the previous reading ({distance.previous.toLocaleString()})
                  </div>
                )}
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                <PreviewFact
                  label="Received"
                  value={fmtDateTimeYgn(previewMessage.receivedAt)}
                />
                <PreviewFact
                  label="Read"
                  value={previewMessage.readAt ? fmtDateTimeYgn(previewMessage.readAt) : 'Not read yet'}
                />
                <PreviewFact label="Handled by" value={handledText(previewMessage.handledBy)} />
                {previewMessage.ackAt && (
                  <PreviewFact label="Acknowledged" value={fmtDateTimeYgn(previewMessage.ackAt)} />
                )}
                <PreviewFact label="Telegram chat" value={previewMessage.chatId} mono />
                {previewMessage.messageId && <PreviewFact label="Message id" value={previewMessage.messageId} mono />}
              </dl>
            </div>

            {(previewMessage.state === 'NEW' || (previewMessage.announcementId && canManage)) && (
              <footer className="flex flex-wrap gap-2 border-t border-gray-100 px-4 py-3 sm:px-5">
                {previewMessage.state === 'NEW' && (
                  <button
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                    onClick={() => void markOne(previewMessage.id)}
                  >
                    Mark as read
                  </button>
                )}
                {previewMessage.announcementId && canManage && (
                  <button
                    className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100"
                    onClick={() => openNotice(previewMessage.announcementId!)}
                  >
                    Open the notice ⇥
                  </button>
                )}
              </footer>
            )}
          </div>
        </div>
      )}

      {/* ---------- the notice, read without leaving the conversation ---------- */}
      {noticeId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-4"
          onMouseDown={closeNotice}
        >
          <div
            ref={noticeTrap}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="notice-title"
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl outline-none animate-[modalIn_.15s_ease-out]"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="flex items-start gap-2 border-b border-gray-100 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  {notice?.code ?? 'Announcement'}
                </div>
                <h2 id="notice-title" className="truncate text-sm font-semibold text-gray-900">
                  {notice?.title ?? 'Loading…'}
                </h2>
              </div>
              <button
                className="h-9 w-9 shrink-0 rounded-lg text-xl leading-none text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                onClick={closeNotice}
                aria-label="Close the notice"
              >
                ×
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
              {noticeError && (
                <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{noticeError}</div>
              )}
              {notice && (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    <Badge color={notice.status === 'PUBLISHED' ? 'green' : 'gray'}>{titleCase(notice.status)}</Badge>
                    <Badge color={PRIORITY_COLOR[notice.priority] ?? 'gray'}>{titleCase(notice.priority)}</Badge>
                    <span className="text-xs text-gray-400">{titleCase(notice.category)}</span>
                    {notice.publishAt && (
                      <span className="text-xs text-gray-400">· {fmtDateTimeYgn(notice.publishAt)}</span>
                    )}
                  </div>
                  <div
                    className="rich-content text-sm text-gray-700"
                    dangerouslySetInnerHTML={{ __html: notice.content }}
                  />
                  {(notice.attachments?.length ?? 0) > 0 && (
                    <div className="mt-3 border-t border-gray-100 pt-3">
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                        Attachments
                      </div>
                      {notice.attachments!.map((f) => (
                        <a
                          key={f.id}
                          href={`/api/attachments/${f.id}/download?token=${encodeURIComponent(getToken() ?? '')}`}
                          className="block truncate text-sm text-blue-600 hover:underline"
                        >
                          📎 {f.filename}
                        </a>
                      ))}
                    </div>
                  )}
                  {notice.createdBy && <div className="mt-3 text-[11px] text-gray-400">Sent by {notice.createdBy}</div>}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
