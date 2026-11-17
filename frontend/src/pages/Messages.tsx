import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, hasPermission, refreshSession } from '../api';
import { PageLoader } from '../components/ui';
import { toast } from '../components/Toast';
import { useLiveReload } from '../hooks/useLiveReload';
import { fmtDate, fmtTime } from '../util/yangonTime';

/**
 * The Messages inbox (plan §7–§8 / P5) — the only inbox in the app.
 *
 * Three buckets the API exposes, side by side with the transcript:
 *   • All messages    — every stored subscriber message;
 *   • Direct messages — what people wrote to the bot (no announcement);
 *   • Vehicle trips   — what a trip flow consumed (odometer, ETA, reject…);
 * plus one thread per notice that has replies, reachable by `?ann=<id>`.
 *
 * The caption path writes rows from Telegram; this page lists them, sets the read
 * flag, and — for a direct message or an announcement thread — answers them.
 * Vehicle trips stay read-only: an armed flow is waiting for the driver's next
 * answer in that chat, so an admin reply there would be read as one.
 */

/** One announcement thread (or a bucket) as `GET /messages/threads` returns it. */
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
  /** IN = the subscriber wrote it; OUT = an admin answered from this page */
  direction?: 'IN' | 'OUT';
  readAt: string | null;
  receivedAt: string;
  ackAt: string | null;
}

const BUCKETS = [
  {
    key: 'all',
    label: 'All messages',
    desc: 'Everything in your inbox',
    title: 'All Messages',
    sub: 'Everything the bot has received',
    icon: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5zM3.6 6.2 12 12.6l8.4-6.4',
  },
  {
    key: 'direct',
    label: 'Direct messages',
    desc: 'Written to the bot',
    title: 'Direct Messages',
    sub: 'Written to the bot — not tied to a notice or a trip',
    icon: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.9-.8L3 21l1.9-4.6a8.2 8.2 0 0 1-1-3.9 8.4 8.4 0 0 1 8.4-8.4h.5A8.4 8.4 0 0 1 21 11.5z',
  },
  {
    key: 'trips',
    label: 'Vehicle trips',
    desc: 'Answered by the trip flow',
    title: 'Vehicle Trips',
    sub: 'Messages a trip flow consumed',
    icon: 'M5 17h14l-1.6-2.4V9a5.4 5.4 0 0 0-10.8 0v5.6zM5 17a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2M9.5 19.5h5',
  },
] as const;

type BucketKey = (typeof BUCKETS)[number]['key'];
type View = { kind: 'bucket'; key: BucketKey } | { kind: 'thread'; id: string };

/** The inbox slices the old Announcements tab offered, now as one chip row. */
type Filter = 'ALL' | 'NEW' | 'NOT_ACKED' | 'REPLIES';
const FILTERS: { key: Filter; label: string; hint: string }[] = [
  { key: 'ALL', label: 'All', hint: 'Every stored message in this view' },
  { key: 'NEW', label: 'New', hint: 'Not read yet' },
  { key: 'NOT_ACKED', label: 'Not acked', hint: 'Sender has not acknowledged the notice' },
  { key: 'REPLIES', label: 'Announcement replies', hint: 'Sent with Telegram Reply to a notice card' },
];

// One page of a transcript, not a whole mailbox: "Load older" asks for the next
// slice, so a chat with thousands of rows still opens fast.
const PAGE_SIZE = 50;

interface Group {
  key: string;
  sender: MessageRow['sender'];
  messages: MessageRow[];
}
interface Day {
  key: string;
  label: string;
  groups: Group[];
}

/** "Today" / "Yesterday" / "17 Nov 2026", always in office time. */
function dayLabel(iso: string): string {
  const d = fmtDate(iso);
  if (d === fmtDate(Date.now())) return 'Today';
  if (d === fmtDate(Date.now() - 864e5)) return 'Yesterday';
  return d;
}

/** Oldest first, split by calendar day, then by a run of one sender. */
function buildDays(items: MessageRow[]): Day[] {
  const days: Day[] = [];
  for (const m of items) {
    const dateKey = fmtDate(m.receivedAt);
    let day = days[days.length - 1];
    if (!day || day.key !== dateKey) {
      day = { key: dateKey, label: dayLabel(m.receivedAt), groups: [] };
      days.push(day);
    }
    // an unknown sender still groups by chat, so one stranger is one run, not one per message
    const senderKey = m.sender.userId ?? m.sender.driverId ?? m.sender.name ?? m.chatId;
    let group = day.groups[day.groups.length - 1];
    if (!group || group.key !== senderKey) {
      group = { key: senderKey, sender: m.sender, messages: [] };
      day.groups.push(group);
    }
    group.messages.push(m);
  }
  return days;
}

const AVATAR_COLORS = [
  'bg-rose-100 text-rose-700',
  'bg-emerald-100 text-emerald-700',
  'bg-sky-100 text-sky-700',
  'bg-amber-100 text-amber-700',
  'bg-violet-100 text-violet-700',
  'bg-slate-200 text-slate-600',
];

/** Stable colour per person — the same sender keeps the same avatar all day. */
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

const initial = (name: string | null) => (name?.trim()?.[0] ?? '?').toUpperCase();

function UnreadDot() {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-blue-600" aria-hidden="true" />;
}

function Bubble({ m, unread, onRead }: { m: MessageRow; unread: boolean; onRead: (m: MessageRow) => void }) {
  // the proxy accepts ?token= because an <img> cannot send a header
  const photoUrl = `/api/messages/${m.id}/photo?token=${encodeURIComponent(localStorage.getItem('ams_token') ?? '')}`;
  const out = m.direction === 'OUT';
  return (
    <div
      className={`border px-4 py-3.5 text-[14px] leading-relaxed break-words shadow-sm ${
        out
          ? 'border-blue-600 bg-blue-600 text-white'
          : unread
            ? 'border-blue-100 bg-blue-50 text-slate-700'
            : 'border-slate-200/80 bg-white text-slate-700'
      } ${unread ? 'cursor-pointer' : ''}`}
      style={{ borderRadius: out ? '16px 2px 16px 16px' : '2px 16px 16px 16px' }}
      // one click reads this message only — the bucket-wide clear keeps its own button
      onClick={unread ? () => onRead(m) : undefined}
      onKeyDown={
        unread
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onRead(m);
              }
            }
          : undefined
      }
      role={unread ? 'button' : undefined}
      tabIndex={unread ? 0 : undefined}
      title={unread ? 'Mark this message read' : undefined}
    >
      {m.text && <p className="m-0 whitespace-pre-wrap break-words">{m.text}</p>}
      {out && (
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-blue-100">
          sent
        </span>
      )}
      {m.kind === 'PHOTO' && (
        <a
          href={photoUrl}
          target="_blank"
          rel="noreferrer"
          className={`block w-full max-w-[300px] overflow-hidden rounded-[10px] border border-slate-200 leading-none ${
            m.text ? 'mt-3' : ''
          }`}
          aria-label="Open photo"
        >
          <img
            src={photoUrl}
            alt={`Photo from ${m.sender.name ?? 'subscriber'}`}
            className="block h-auto w-full"
            loading="lazy"
          />
        </a>
      )}
      {m.kind === 'DOCUMENT' && (
        <a
          href={photoUrl}
          className="mt-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
        >
          <span aria-hidden="true">📄</span>
          <span className="truncate">{m.documentName ?? 'Document'}</span>
        </a>
      )}
      {m.handledBy !== 'GENERAL' && m.handledBy !== 'ANNOUNCEMENT_REPLY' && (
        <span className="mt-2 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
          {m.handledBy.toLowerCase().replace(/_/g, ' ')}
        </span>
      )}
    </div>
  );
}

export default function Messages() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const annParam = searchParams.get('ann');

  const [threads, setThreads] = useState<ThreadsResponse | null>(null);
  const [items, setItems] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [view, setView] = useState<View>(annParam ? { kind: 'thread', id: annParam } : { kind: 'bucket', key: 'direct' });
  const [filter, setFilter] = useState<Filter>('ALL');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [page, setPage] = useState(1);
  const [olderBusy, setOlderBusy] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  // the message the admin picked to answer — never inferred from the list order
  const [replyTarget, setReplyTarget] = useState<MessageRow | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const [canReply, setCanReply] = useState(() => hasPermission('messages.reply'));
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // set before "load older" so the extra slice does not yank the transcript to the end
  const keepScroll = useRef<{ height: number; top: number } | null>(null);

  // One key for the open view: the effect refetches when it changes and not when
  // a click re-selects the bucket already showing.
  const viewKey = view.kind === 'bucket' ? `bucket:${view.key}` : `thread:${view.id}`;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  // a thread is shareable and survives a reload
  useEffect(() => {
    const want = view.kind === 'thread' ? `?ann=${encodeURIComponent(view.id)}` : '';
    if (window.location.search !== want) navigate({ pathname: '/messages', search: want }, { replace: true });
  }, [view, navigate]);

  useEffect(() => {
    // The previous bucket's rows must not linger under the new heading, and a
    // slow answer for a bucket the admin already left must not win: clear on
    // entry, and drop anything that arrives after the view changed.
    let live = true;
    setLoading(true);
    setItems([]);
    setTotal(0);
    setUnread(0);
    setError('');
    setPage(1);

    const p = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) });
    if (viewKey.startsWith('thread:')) p.set('announcementId', viewKey.slice('thread:'.length));
    else if (viewKey !== 'bucket:all') p.set('source', viewKey.slice('bucket:'.length));
    if (filter === 'NEW') p.set('state', 'NEW');
    if (filter === 'NOT_ACKED') p.set('ack', 'pending');
    if (filter === 'REPLIES') p.set('handledBy', 'ANNOUNCEMENT_REPLY');

    Promise.all([
      api<ThreadsResponse>('/messages/threads'),
      api<{ items: MessageRow[]; total: number; unread: number }>(`/messages?${p.toString()}`),
    ])
      .then(([heads, list]) => {
        if (!live) return;
        setThreads(heads);
        setItems([...list.items].reverse()); // the API answers newest-first; a transcript reads oldest-first
        setTotal(list.total);
        setUnread(list.unread);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : 'Could not load messages');
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
    };
  }, [viewKey, filter, tick]);

  // a subscriber messaged the bot: refetch whichever slice is open
  useLiveReload(['message.new'], reload);

  // an existing session carries the permissions it logged in with, so a freshly
  // granted messages.reply would stay invisible until the next sign-in
  useEffect(() => {
    void refreshSession();
    const sync = () => setCanReply(hasPermission('messages.reply'));
    window.addEventListener('ams_session', sync);
    return () => window.removeEventListener('ams_session', sync);
  }, []);

  // a transcript belongs at its newest end — unless a slice was just prepended
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const keep = keepScroll.current;
    if (keep) {
      el.scrollTop = keep.top + (el.scrollHeight - keep.height);
      keepScroll.current = null;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  const days = useMemo(() => buildDays(items), [items]);

  const totalAll =
    (threads?.general.total ?? 0) +
    (threads?.trips.total ?? 0) +
    (threads?.threads ?? []).reduce((n, t) => n + t.total, 0);
  const unreadAll =
    (threads?.general.unread ?? 0) +
    (threads?.trips.unread ?? 0) +
    (threads?.threads ?? []).reduce((n, t) => n + t.unread, 0);

  const thread: ThreadRow | undefined =
    view.kind === 'thread' ? threads?.threads.find((t) => t.announcementId === view.id) : undefined;

  const heading =
    view.kind === 'bucket'
      ? BUCKETS.find((b) => b.key === view.key)!
      : {
          title: thread?.title ?? 'Announcement thread',
          sub: [thread?.code, thread?.publishAt ? fmtDate(thread.publishAt) : null].filter(Boolean).join(' · '),
        };

  const unacked = !!thread?.requiresAck && items.some((m) => !m.ackAt && m.direction !== 'OUT');

  // Vehicle trips are never answerable, and "All messages" mixes them in, so the
  // composer only appears where a reply cannot collide with an armed flow.
  const composerFor: 'direct' | 'thread' | null =
    view.kind === 'thread' ? 'thread' : view.kind === 'bucket' && view.key === 'direct' ? 'direct' : null;
  const canAnswer = !!composerFor && canReply;

  // The composer answers the message the admin clicked, so a subscriber writing in
  // — or a filter change — can never move an unanswered draft to someone else.
  const replyTo = replyTarget;
  // The choice outlives a list reload — a new message, a live refresh, or the
  // refetch after sending all keep it. Only leaving the bucket/thread, changing
  // the filter, or pressing ✕ drops it. (Watching `items` here would wipe it on
  // every reload, because the list is emptied before each refetch.)
  useEffect(() => {
    setReplyTarget(null);
  }, [viewKey, filter]);

  /** Pick this message as the one the composer answers. */
  const pickReply = (m: MessageRow) => {
    setReplyTarget(m);
    requestAnimationFrame(() => replyRef.current?.focus());
  };

  const filters = (p: URLSearchParams) => {
    if (filter === 'NEW') p.set('state', 'NEW');
    if (filter === 'NOT_ACKED') p.set('ack', 'pending');
    if (filter === 'REPLIES') p.set('handledBy', 'ANNOUNCEMENT_REPLY');
    return p;
  };

  /** Ask for the next-oldest page and put it above what is already shown. */
  const loadOlder = async () => {
    const el = bodyRef.current;
    if (el) keepScroll.current = { height: el.scrollHeight, top: el.scrollTop };
    setOlderBusy(true);
    try {
      const p = filters(new URLSearchParams({ page: String(page + 1), pageSize: String(PAGE_SIZE) }));
      if (viewKey.startsWith('thread:')) p.set('announcementId', viewKey.slice('thread:'.length));
      else if (viewKey !== 'bucket:all') p.set('source', viewKey.slice('bucket:'.length));
      const list = await api<{ items: MessageRow[]; total: number }>(`/messages?${p.toString()}`);
      setItems((prev) => {
        const have = new Set(prev.map((m) => m.id));
        const older = [...list.items].reverse().filter((m) => !have.has(m.id));
        return [...older, ...prev];
      });
      setPage((n) => n + 1);
      setTotal(list.total);
    } catch (e) {
      keepScroll.current = null;
      toast(e instanceof Error ? e.message : 'Could not load older messages');
    } finally {
      setOlderBusy(false);
    }
  };

  /**
   * Read this one message. The list already has the wire shape, so the flag flips
   * here first and is put back if the API refuses — no full refetch, which would
   * also jump a scrolled transcript.
   */
  const readOne = async (m: MessageRow) => {
    if (m.state !== 'NEW') return;
    setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, state: 'READ' as const, readAt: new Date().toISOString() } : x)));
    setUnread((n) => Math.max(0, n - 1));
    setThreads((t) => {
      if (!t) return t;
      if (m.announcementId) {
        return {
          ...t,
          threads: t.threads.map((x) =>
            x.announcementId === m.announcementId ? { ...x, unread: Math.max(0, x.unread - 1) } : x,
          ),
        };
      }
      const dec = (b: Bucket) => ({ ...b, unread: Math.max(0, b.unread - 1) });
      return m.handledBy === 'GENERAL' ? { ...t, general: dec(t.general) } : { ...t, trips: dec(t.trips) };
    });
    try {
      await api(`/messages/${m.id}/read`, { method: 'POST' });
    } catch (e) {
      setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, state: 'NEW' as const, readAt: null } : x)));
      setUnread((n) => n + 1);
      toast(e instanceof Error ? e.message : 'Could not mark the message read');
    }
  };

  /** Send the composer's text to the subscriber this transcript belongs to. */
  const sendReply = async () => {
    const text = replyText.trim();
    if (!text || !replyTo) return;
    setSending(true);
    try {
      await api(`/messages/${replyTo.id}/reply`, { method: 'POST', body: { text } });
      setReplyText('');
      toast('Reply sent on Telegram');
      reload(); // brings the new outbound row in from the server, newest end visible
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the reply');
    } finally {
      setSending(false);
    }
  };

  const markAllRead = async () => {
    setBusy(true);
    try {
      const p = new URLSearchParams();
      if (view.kind === 'bucket' && view.key !== 'all') p.set('source', view.key);
      if (view.kind === 'thread') p.set('announcementId', view.id);
      const r = await api<{ updated: number }>(`/messages/read-all?${p.toString()}`, { method: 'POST' });
      toast(r.updated > 0 ? `Marked ${r.updated} message${r.updated === 1 ? '' : 's'} read` : 'Nothing was unread');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not mark as read');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !threads) return <PageLoader />;

  // read-all only knows a bucket, not a filter, so it must not claim to clear a slice
  const canMarkAll = filter === 'ALL';

  return (
    // two columns only once the app nav AND a 300px bucket rail both fit;
    // below that the rail stacks on top and the transcript keeps the full width
    <div className="flex min-h-0 flex-col gap-4 xl:h-[calc(100vh-7rem)]">
      {/* ---------------- buckets + threads ---------------- */}
      <aside className="flex w-full flex-col gap-1.5 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        {/* The three buckets are filters of one inbox, not separate pages, so they
            stay a horizontal strip at every width: a vertical rail only took room
            away from the transcript and left the trips feed half empty. */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
        {BUCKETS.map((b) => {
          const active = view.kind === 'bucket' && view.key === b.key;
          const stats = b.key === 'all' ? null : threads?.[b.key === 'direct' ? 'general' : 'trips'];
          const count = stats ? stats.total : totalAll;
          const dot = stats ? stats.unread : unreadAll;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => setView({ kind: 'bucket', key: b.key })}
              aria-current={active ? 'page' : undefined}
              title={b.desc}
              className={`flex shrink-0 items-center gap-2 rounded-[10px] border px-3 py-2.5 text-left transition-colors ${
                active ? 'border-blue-200 bg-blue-50' : 'border-transparent hover:bg-slate-100'
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className={`h-5 w-5 shrink-0 ${active ? 'text-blue-600' : 'text-slate-400'}`}
              >
                <path d={b.icon} />
              </svg>
              <span className="flex min-w-0 flex-col">
                <span
                  className={`whitespace-nowrap text-sm font-semibold ${active ? 'text-blue-600' : 'text-slate-900'}`}
                >
                  {b.label}
                </span>
              </span>
              {dot > 0 && <UnreadDot />}
              <span
                className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold ${
                  active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
        </div>

        {(threads?.threads.length ?? 0) > 0 && (
          <>
            <p className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
              Announcement replies
            </p>
            <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
              {threads!.threads.map((t) => {
                const active = view.kind === 'thread' && view.id === t.announcementId;
                return (
                  <button
                    key={t.announcementId}
                    type="button"
                    onClick={() => setView({ kind: 'thread', id: t.announcementId })}
                    aria-current={active ? 'page' : undefined}
                    className={`flex shrink-0 items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                      active ? 'border-blue-200 bg-blue-50' : 'border-transparent hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className={`text-[11px] font-semibold ${active ? 'text-blue-600' : 'text-slate-500'}`}>
                        {t.code ?? '—'}
                      </span>
                      <span className="max-w-[190px] truncate text-xs text-slate-700">{t.title}</span>
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-slate-500">
                      {t.unread > 0 && <UnreadDot />}
                      {t.total}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </aside>

      {/* ---------------- transcript ---------------- */}
      <section className="flex min-h-[70vh] flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl xl:min-h-0">
        <header className="flex items-start gap-3 border-b border-slate-200 px-4 py-3 sm:px-6 sm:py-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold tracking-tight text-slate-900 sm:text-lg">{heading.title}</h1>
            <p className="mt-0.5 truncate text-xs text-slate-500 sm:text-sm">{heading.sub}</p>
          </div>
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={busy || unread === 0 || !canMarkAll}
            title={canMarkAll ? undefined : 'Filtered view — clear the filter to mark everything read'}
            className={`ml-auto inline-flex shrink-0 items-center gap-2 rounded-[10px] border px-3 py-2 text-[13px] font-semibold leading-none transition-colors ${
              unread === 0 && canMarkAll
                ? 'cursor-default border-green-200 bg-green-50 text-green-700'
                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
            } disabled:cursor-default`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-4 w-4"
            >
              <path d="M20 6 9.5 16.5 4 11" />
            </svg>
            <span className="whitespace-nowrap">{unread === 0 ? 'All read' : `Mark all read${unread ? ` (${unread})` : ''}`}</span>
          </button>
        </header>

        <div className="flex flex-wrap gap-1.5 border-b border-slate-200 px-4 py-2 sm:px-6" role="group" aria-label="Filter messages">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={active}
                title={f.hint}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600 sm:px-6">{error}</div>}

        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-50 p-3 [scrollbar-color:#cbd5e1_transparent] [scrollbar-width:thin] sm:p-6"
        >
          {total > items.length && (
            <div className="mb-4 flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={olderBusy}
                className="rounded-full border border-slate-200 bg-white px-4 py-1.5 text-xs font-semibold text-slate-600 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-default disabled:text-slate-400"
              >
                {olderBusy ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - items.length)} older`}
              </button>
              <p className="text-[11px] text-slate-400">
                Showing {items.length} of {total}
              </p>
            </div>
          )}

          {view.kind === 'thread' && unacked && (
            <div className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[10px] border border-amber-200 border-l-4 border-l-amber-500 bg-amber-50 px-3.5 py-2.5">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="h-[18px] w-[18px] shrink-0 text-amber-500"
              >
                <path d="M10.3 3.9 2.4 17a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" />
              </svg>
              <span className="text-[13.5px] font-semibold text-amber-800">
                Acknowledgement pending — {thread?.code}
              </span>
              <a
                href={`/announcements?ann=${view.id}`}
                className="ml-auto whitespace-nowrap text-[12.5px] font-semibold text-amber-700 hover:underline"
              >
                Open announcement →
              </a>
            </div>
          )}

          {loading && <p className="py-12 text-center text-sm text-slate-500">Loading messages…</p>}

          {!loading && !error && days.length === 0 && (
            <p className="py-16 text-center text-sm text-slate-500">
              {filter === 'ALL' ? 'No messages in this bucket yet.' : 'Nothing matches this filter.'}
            </p>
          )}

          {days.map((day) => (
            <div key={day.key}>
              <div className="mb-5 mt-1 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                <span className="h-px min-w-4 flex-1 bg-slate-200" />
                <span className="whitespace-nowrap">{day.label}</span>
                <span className="h-px min-w-4 flex-1 bg-slate-200" />
              </div>

              {day.groups.map((group, gi) => {
                const anyUnread = group.messages.some((m) => m.state === 'NEW');
                const name = group.sender.name ?? 'Unknown sender';
                const last = group.messages[group.messages.length - 1];
                // only what the subscriber wrote can be answered
                const lastIn = [...group.messages].reverse().find((m) => m.direction !== 'OUT');
                return (
                  <article key={`${group.key}-${gi}`} className="mb-7 flex gap-2.5 sm:gap-3">
                    <span
                      className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full text-[13px] font-semibold ${avatarColor(name)}`}
                      aria-hidden="true"
                    >
                      {initial(group.sender.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                        {anyUnread && <UnreadDot />}
                        <span className={`font-semibold ${anyUnread ? 'text-blue-700' : 'text-slate-900'}`}>{name}</span>
                        {!group.sender.linked && (
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                            not linked
                          </span>
                        )}
                        {group.sender.department && (
                          <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                            {group.sender.department}
                          </span>
                        )}
                        {group.messages[0].direction === 'OUT' && (
                          <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                            reply
                          </span>
                        )}
                        <span className="ml-auto text-xs text-slate-400">{fmtTime(last.receivedAt)}</span>
                        {canAnswer && lastIn && (
                          <button
                            type="button"
                            onClick={() => pickReply(lastIn)}
                            aria-pressed={replyTarget?.id === lastIn.id}
                            title={`Reply to ${name}`}
                            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                              replyTarget?.id === lastIn.id
                                ? 'border-blue-600 bg-blue-600 text-white'
                                : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700'
                            }`}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                              className="h-3 w-3"
                            >
                              <path d="M9 14 4 9l5-5M4 9h9a7 7 0 0 1 7 7v3" />
                            </svg>
                            {replyTarget?.id === lastIn.id ? 'Replying' : 'Reply'}
                          </button>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {group.messages.map((m) => (
                          <Bubble key={m.id} m={m} unread={m.state === 'NEW'} onRead={readOne} />
                        ))}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ))}
        </div>

        {/* Vehicle trips and "All messages" never get a composer: a reply there
            would land in a chat a trip flow is still holding for an answer. */}
        {composerFor && canReply && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendReply();
            }}
            className="border-t border-slate-200 bg-white px-3 py-2.5 sm:px-6 sm:py-3"
          >
            <label htmlFor="reply-text" className="sr-only">
              {replyTo ? `Reply to ${replyTo.sender.name ?? 'this subscriber'} on Telegram` : 'Pick a message to reply to'}
            </label>
            {/* who this reply reaches, in words — the composer used to answer
                whichever message happened to be last in the list */}
            {replyTo && (
              <div className="mb-2 flex items-start gap-2 rounded-[10px] border border-blue-200 bg-blue-50 px-2.5 py-2">
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${avatarColor(
                    replyTo.sender.name ?? 'Unknown sender',
                  )}`}
                  aria-hidden="true"
                >
                  {initial(replyTo.sender.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-semibold text-blue-900">
                    Replying to {replyTo.sender.name ?? 'Unknown sender'}
                    {replyTo.sender.department && (
                      <span className="font-normal text-blue-600"> · {replyTo.sender.department}</span>
                    )}
                  </p>
                  <p className="truncate text-[11.5px] text-blue-700/80">
                    {replyTo.text ? replyTo.text.replace(/\s+/g, ' ').slice(0, 140) : (replyTo.documentName ?? 'Photo')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyTarget(null)}
                  aria-label="Cancel reply"
                  title="Cancel reply"
                  className="shrink-0 rounded-full px-1.5 text-sm leading-none text-blue-500 transition-colors hover:text-blue-800"
                >
                  ✕
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={replyRef}
                id="reply-text"
                rows={1}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendReply();
                  }
                }}
                disabled={sending || !replyTo}
                placeholder={
                  replyTo
                    ? `Reply to ${replyTo.sender.name ?? 'this subscriber'} on Telegram…  (Enter sends, Shift+Enter adds a line)`
                    : 'Pick a message above to reply to'
                }
                className="max-h-32 min-h-[42px] flex-1 resize-y rounded-[10px] border border-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none transition-colors focus:border-blue-400 disabled:bg-slate-50"
              />
              <button
                type="submit"
                disabled={sending || !replyTo || !replyText.trim()}
                className="inline-flex h-[42px] shrink-0 items-center gap-1.5 rounded-[10px] bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-default disabled:bg-slate-200 disabled:text-slate-400"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              {replyTo ? (
                <>
                  Delivered to <span className="font-semibold text-slate-500">{replyTo.sender.name ?? 'this subscriber'}</span>{' '}
                  on Telegram{composerFor === 'thread' ? ' inside this notice thread.' : ' as a direct message.'}
                </>
              ) : (
                'Choose the message you are answering — the reply reaches that sender only.'
              )}
            </p>
          </form>
        )}
      </section>
    </div>
  );
}
