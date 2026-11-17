import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken } from '../api';
import { PageLoader } from '../components/ui';
import { toast } from '../components/Toast';
import { useLiveReload } from '../hooks/useLiveReload';
import { fmtDate, fmtTime } from '../util/yangonTime';
// The tab inside Announcements already declares the API shapes — importing them
// (type-only, erased at build) is one less place for the payload to drift.
import type { MessageRow, ThreadRow, ThreadsResponse } from './AnnouncementMessages';

/**
 * The Messages inbox (plan §7–§8 / P5), as a page of its own.
 *
 * The three buckets the API exposes, side by side with the transcript:
 *   • All messages    — every stored subscriber message;
 *   • Direct messages — what people wrote to the bot (no announcement);
 *   • Vehicle trips   — what a trip flow consumed (odometer, ETA, reject…);
 * plus one thread per notice that has replies.
 *
 * Read-only by design: the capture path writes these rows from Telegram, so this
 * page only lists them and sets the read flag. `Mark all read` clears the current
 * bucket through POST /messages/read-all, exactly like the tab does.
 */

const BUCKETS = [
  {
    key: 'all',
    label: 'All messages',
    desc: 'Everything in your inbox',
    icon: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5zM3.6 6.2 12 12.6l8.4-6.4',
  },
  {
    key: 'direct',
    label: 'Direct messages',
    desc: 'Written to the bot',
    icon: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.9-.8L3 21l1.9-4.6a8.2 8.2 0 0 1-1-3.9 8.4 8.4 0 0 1 8.4-8.4h.5A8.4 8.4 0 0 1 21 11.5z',
  },
  {
    key: 'trips',
    label: 'Vehicle trips',
    desc: 'Answered by the trip flow',
    icon: 'M5 17h14l-1.6-2.4V9a5.4 5.4 0 0 0-10.8 0v5.6zM5 17a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2M9.5 19.5h5',
  },
] as const;

type BucketKey = (typeof BUCKETS)[number]['key'];
type View = { kind: 'bucket'; key: BucketKey } | { kind: 'thread'; id: string };

const HEADINGS: Record<BucketKey, { title: string; sub: string }> = {
  all: { title: 'All Messages', sub: 'Everything the bot has received' },
  direct: { title: 'Direct Messages', sub: 'Written to the bot — not tied to a notice or a trip' },
  trips: { title: 'Vehicle Trips', sub: 'Messages a trip flow consumed' },
};

const PAGE_SIZE = 100; // the API's maximum — a transcript, not a paged table

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

function Bubble({ m, unread, token }: { m: MessageRow; unread: boolean; token: string }) {
  const photoUrl = `/api/messages/${m.id}/photo?token=${encodeURIComponent(token)}`;
  return (
    <div
      className={`border px-4 py-3.5 text-[14px] leading-relaxed break-words text-slate-700 shadow-sm ${
        unread ? 'border-blue-100 bg-blue-50' : 'border-slate-200/80 bg-white'
      }`}
      style={{ borderRadius: '2px 16px 16px 16px' }}
    >
      {m.text && <p className="m-0 whitespace-pre-wrap break-words">{m.text}</p>}
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
  const [threads, setThreads] = useState<ThreadsResponse | null>(null);
  const [items, setItems] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [view, setView] = useState<View>({ kind: 'bucket', key: 'direct' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const token = getToken() ?? '';

  // One key for the open view: the effect refetches when it changes and not when
  // a click re-selects the bucket already showing.
  const viewKey = view.kind === 'bucket' ? `bucket:${view.key}` : `thread:${view.id}`;
  const reload = useCallback(() => setTick((t) => t + 1), []);

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

    const p = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) });
    if (viewKey.startsWith('thread:')) p.set('announcementId', viewKey.slice('thread:'.length));
    else if (viewKey !== 'bucket:all') p.set('source', viewKey.slice('bucket:'.length));

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
  }, [viewKey, tick]);

  // a subscriber messaged the bot: refetch whichever bucket is open
  useLiveReload(['message.new'], reload);

  // a transcript belongs at its newest end
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const days = useMemo(() => buildDays(items), [items]);

  const counts = useMemo(() => {
    const sum = (pick: (b: { total: number; unread: number }) => number) =>
      pick(threads?.general ?? { total: 0, unread: 0 }) +
      pick(threads?.trips ?? { total: 0, unread: 0 }) +
      (threads?.threads ?? []).reduce((n, t) => n + pick(t), 0);
    return { all: sum((b) => b.total), allUnread: sum((b) => b.unread) };
  }, [threads]);

  const thread: ThreadRow | undefined =
    view.kind === 'thread' ? threads?.threads.find((t) => t.announcementId === view.id) : undefined;

  const heading =
    view.kind === 'bucket'
      ? HEADINGS[view.key]
      : {
          title: thread?.title ?? 'Announcement thread',
          sub: [thread?.code, thread?.publishAt ? fmtDate(thread.publishAt) : null].filter(Boolean).join(' · '),
        };

  const unacked = !!thread?.requiresAck && items.some((m) => !m.ackAt);

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

  return (
    // two columns only once the app nav AND a 300px bucket rail both fit;
    // below that the rail stacks on top and the transcript keeps the full width
    <div className="flex min-h-0 flex-col gap-4 xl:h-[calc(100vh-7rem)] xl:flex-row xl:gap-6">
      {/* ---------------- buckets + threads ---------------- */}
      <aside className="flex w-full flex-col gap-1.5 rounded-xl border border-slate-200 bg-white p-3 shadow-sm xl:w-[300px] xl:flex-none xl:overflow-y-auto">
        <p className="px-2.5 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Inbox</p>

        {BUCKETS.map((b) => {
          const active = view.kind === 'bucket' && view.key === b.key;
          const count = b.key === 'all' ? counts.all : threads?.[b.key === 'direct' ? 'general' : 'trips']?.total ?? 0;
          const dot = b.key === 'all' ? counts.allUnread : threads?.[b.key === 'direct' ? 'general' : 'trips']?.unread ?? 0;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => setView({ kind: 'bucket', key: b.key })}
              aria-current={active ? 'page' : undefined}
              className={`flex w-full items-center gap-3 rounded-[10px] border px-3 py-3 text-left transition-colors ${
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
                <span className={`text-sm font-semibold ${active ? 'text-blue-600' : 'text-slate-900'}`}>{b.label}</span>
                <span className={`mt-0.5 text-xs ${active ? 'text-blue-500' : 'text-slate-500'}`}>{b.desc}</span>
              </span>
              {dot > 0 && <UnreadDot />}
              <span
                className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold ${
                  active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}

        {(threads?.threads.length ?? 0) > 0 && (
          <>
            <p className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
              Announcement replies
            </p>
            <div className="flex flex-col gap-1">
              {threads!.threads.map((t) => {
                const active = view.kind === 'thread' && view.id === t.announcementId;
                return (
                  <button
                    key={t.announcementId}
                    type="button"
                    onClick={() => setView({ kind: 'thread', id: t.announcementId })}
                    aria-current={active ? 'page' : undefined}
                    className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                      active ? 'border-blue-200 bg-blue-50' : 'border-transparent hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className={`text-[11px] font-semibold ${active ? 'text-blue-600' : 'text-slate-500'}`}>
                        {t.code ?? '—'}
                      </span>
                      <span className="truncate text-xs text-slate-700">{t.title}</span>
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
            disabled={busy || unread === 0}
            className={`ml-auto inline-flex shrink-0 items-center gap-2 rounded-[10px] border px-3 py-2 text-[13px] font-semibold leading-none transition-colors ${
              unread === 0
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

        {error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600 sm:px-6">{error}</div>}

        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-50 p-3 [scrollbar-color:#cbd5e1_transparent] [scrollbar-width:thin] sm:p-6"
        >
          {total > items.length && (
            <p className="mb-4 rounded-lg bg-white px-3 py-2 text-center text-xs text-slate-500">
              Showing the newest {items.length} of {total} messages.
            </p>
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
                href={`/announcements?tab=announcements&ann=${view.id}`}
                className="ml-auto whitespace-nowrap text-[12.5px] font-semibold text-amber-700 hover:underline"
              >
                Open announcement →
              </a>
            </div>
          )}

          {loading && <p className="py-12 text-center text-sm text-slate-500">Loading messages…</p>}

          {!loading && days.length === 0 && (
            <p className="py-16 text-center text-sm text-slate-500">No messages in this bucket yet.</p>
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
                        <span className="ml-auto text-xs text-slate-400">{fmtTime(last.receivedAt)}</span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {group.messages.map((m) => (
                          <Bubble key={m.id} m={m} unread={m.state === 'NEW'} token={token} />
                        ))}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
