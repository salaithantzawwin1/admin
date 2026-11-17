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
 * The same three buckets the API exposes, side by side with the transcript:
 *   • All messages      — every stored subscriber message;
 *   • Direct messages   — what people wrote to the bot (no announcement);
 *   • Vehicle trips     — what a trip flow consumed (odometer, ETA, reject…);
 *   • one thread per notice that has replies.
 *
 * Read-only by design: the capture path writes these rows from Telegram, so this
 * page only lists them and sets the read flag. `Mark all read` clears the current
 * bucket through POST /messages/read-all, exactly like the tab does.
 */

type View =
  | { kind: 'all' }
  | { kind: 'direct' }
  | { kind: 'trips' }
  | { kind: 'thread'; id: string };

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

const PAGE_SIZE = 100; // the API's maximum — the transcript, not a paged table

/** "Today" / "Yesterday" / "17 Nov 2026", always in office time. */
const dayLabel = (iso: string) => {
  const d = fmtDate(iso);
  if (d === fmtDate(Date.now())) return 'Today';
  if (d === fmtDate(Date.now() - 864e5)) return 'Yesterday';
  return d;
};

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
    // an unknown sender still groups by chat, so one stranger is not one bubble-run per message
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

function Bubble({ m, unread }: { m: MessageRow; unread: boolean }) {
  const token = getToken();
  return (
    <div
      className={`border px-4 py-3.5 text-[14px] leading-relaxed text-slate-700 shadow-sm ${
        unread ? 'border-blue-100 bg-blue-50' : 'border-slate-200/80 bg-white'
      }`}
      style={{ borderRadius: '2px 16px 16px 16px' }}
    >
      {m.text && <p className="m-0 whitespace-pre-wrap break-words">{m.text}</p>}
      {m.kind === 'PHOTO' && (
        <a
          href={`/api/messages/${m.id}/photo?token=${token ?? ''}`}
          target="_blank"
          rel="noreferrer"
          className={`block max-w-[300px] overflow-hidden rounded-[10px] border border-slate-200 leading-none ${
            m.text ? 'mt-3' : ''
          }`}
          aria-label="Open photo"
        >
          <img
            src={`/api/messages/${m.id}/photo?token=${token ?? ''}`}
            alt={`Photo from ${m.sender.name ?? 'subscriber'}`}
            className="block w-full"
            loading="lazy"
          />
        </a>
      )}
      {m.kind === 'DOCUMENT' && (
        <a
          href={`/api/messages/${m.id}/photo?token=${token ?? ''}`}
          className="mt-2 inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700"
        >
          📄 {m.documentName ?? 'Document'}
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
  const [view, setView] = useState<View>({ kind: 'direct' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setError('');
    const params = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) });
    if (view.kind === 'direct') params.set('source', 'direct');
    if (view.kind === 'trips') params.set('source', 'trips');
    if (view.kind === 'thread') params.set('announcementId', view.id);
    try {
      const [heads, list] = await Promise.all([
        api<ThreadsResponse>('/messages/threads'),
        api<{ items: MessageRow[]; total: number; unread: number }>(`/messages?${params.toString()}`),
      ]);
      setThreads(heads);
      // the API answers newest-first; a transcript reads oldest-first
      setItems([...list.items].reverse());
      setTotal(list.total);
      setUnread(list.unread);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load messages');
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // a subscriber messaged the bot: refetch whichever bucket is open
  useLiveReload(['message.new'], () => void load());

  // a transcript belongs at its newest end
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const days = useMemo(() => buildDays(items), [items]);

  const counts = useMemo(() => {
    const g = threads?.general;
    const t = threads?.trips;
    const threadTotal = (threads?.threads ?? []).reduce((n, x) => n + x.total, 0);
    const threadUnread = (threads?.threads ?? []).reduce((n, x) => n + x.unread, 0);
    return {
      all: (g?.total ?? 0) + (t?.total ?? 0) + threadTotal,
      allUnread: (g?.unread ?? 0) + (t?.unread ?? 0) + threadUnread,
      direct: g?.total ?? 0,
      directUnread: g?.unread ?? 0,
      trips: t?.total ?? 0,
      tripsUnread: t?.unread ?? 0,
    };
  }, [threads]);

  const thread: ThreadRow | undefined =
    view.kind === 'thread' ? threads?.threads.find((t) => t.announcementId === view.id) : undefined;

  const title =
    view.kind === 'all' ? 'All Messages'
      : view.kind === 'direct' ? 'Direct Messages'
        : view.kind === 'trips' ? 'Vehicle Trips'
          : (thread?.title ?? 'Announcement thread');

  const subtitle =
    view.kind === 'all' ? 'Everything the bot has received'
      : view.kind === 'direct' ? 'Written to the bot — not tied to a notice or a trip'
        : view.kind === 'trips' ? 'Messages a trip flow consumed'
          : `${thread?.code ?? ''}${thread?.publishAt ? ` · ${fmtDate(thread.publishAt)}` : ''}`;

  const unacked = !!thread?.requiresAck && items.some((m) => !m.ackAt);

  const markAllRead = async () => {
    setBusy(true);
    try {
      const p = new URLSearchParams();
      if (view.kind === 'direct') p.set('source', 'direct');
      if (view.kind === 'trips') p.set('source', 'trips');
      if (view.kind === 'thread') p.set('announcementId', view.id);
      const r = await api<{ updated: number }>(`/messages/read-all?${p.toString()}`, { method: 'POST' });
      toast(r.updated > 0 ? `Marked ${r.updated} message${r.updated === 1 ? '' : 's'} read` : 'Nothing was unread');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not mark as read');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !threads) return <PageLoader />;

  const bucket = (key: 'all' | 'direct' | 'trips', label: string, desc: string, count: number, dot: number, icon: string) => {
    const active = view.kind === key;
    return (
      <button
        type="button"
        onClick={() => setView({ kind: key })}
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
          <path d={icon} />
        </svg>
        <span className="flex min-w-0 flex-col">
          <span className={`text-sm font-semibold ${active ? 'text-blue-600' : 'text-slate-900'}`}>{label}</span>
          <span className={`mt-0.5 text-xs ${active ? 'text-blue-500' : 'text-slate-500'}`}>{desc}</span>
        </span>
        {dot > 0 && <UnreadDot />}
        <span
          className={`ml-auto min-w-[26px] rounded-full px-2 py-0.5 text-center text-xs font-semibold ${
            active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {count}
        </span>
      </button>
    );
  };

  return (
    // two columns only once the app nav AND a 300px bucket rail both fit;
    // below that the rail stacks on top and the transcript keeps the full width
    <div className="flex min-h-0 flex-col gap-4 xl:h-[calc(100vh-7rem)] xl:flex-row xl:gap-6">
      {/* ---------------- buckets + threads ---------------- */}
      <aside className="flex w-full flex-col gap-1.5 rounded-xl border border-slate-200 bg-white p-3 shadow-sm xl:w-[300px] xl:flex-none xl:overflow-y-auto">
        <p className="px-2.5 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Inbox</p>

        {bucket(
          'all',
          'All messages',
          'Everything in your inbox',
          counts.all,
          counts.allUnread,
          'M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5zM3.6 6.2 12 12.6l8.4-6.4',
        )}
        {bucket(
          'direct',
          'Direct messages',
          'Written to the bot',
          counts.direct,
          counts.directUnread,
          'M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.9-.8L3 21l1.9-4.6a8.2 8.2 0 0 1-1-3.9 8.4 8.4 0 0 1 8.4-8.4h.5A8.4 8.4 0 0 1 21 11.5z',
        )}
        {bucket(
          'trips',
          'Vehicle trips',
          'Answered by the trip flow',
          counts.trips,
          counts.tripsUnread,
          'M5 17h14l-1.6-2.4V9a5.4 5.4 0 0 0-10.8 0v5.6zM5 17a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2M9.5 19.5h5',
        )}

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
        <header className="flex items-start gap-4 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold tracking-tight text-slate-900">{title}</h1>
            <p className="mt-0.5 truncate text-sm text-slate-500">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={busy || unread === 0}
            className={`ml-auto inline-flex shrink-0 items-center gap-2 rounded-[10px] border px-3.5 py-2 text-[13px] font-semibold leading-none transition-colors ${
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
            <span>{unread === 0 ? 'All read' : `Mark all read${unread ? ` (${unread})` : ''}`}</span>
          </button>
        </header>

        {error && <div className="border-b border-red-100 bg-red-50 px-6 py-2 text-sm text-red-600">{error}</div>}

        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 [scrollbar-color:#cbd5e1_transparent] [scrollbar-width:thin] sm:p-6"
        >
          {total > items.length && (
            <p className="mb-4 rounded-lg bg-white px-3 py-2 text-center text-xs text-slate-500">
              Showing the newest {items.length} of {total} messages.
            </p>
          )}

          {view.kind === 'thread' && unacked && (
            <div className="mb-4 flex items-center gap-2.5 rounded-[10px] border border-amber-200 border-l-4 border-l-amber-500 bg-amber-50 px-3.5 py-2.5">
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
              <div className="flex flex-1 flex-wrap items-baseline gap-x-2.5">
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
            </div>
          )}

          {days.length === 0 && !loading && (
            <p className="py-16 text-center text-sm text-slate-500">No messages in this bucket yet.</p>
          )}

          {days.map((day) => (
            <div key={day.key}>
              <div className="mb-5 mt-1 flex items-center gap-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                <span className="h-px flex-1 bg-slate-200" />
                {day.label}
                <span className="h-px flex-1 bg-slate-200" />
              </div>

              {day.groups.map((group, gi) => {
                const anyUnread = group.messages.some((m) => m.state === 'NEW');
                const name = group.sender.name ?? 'Unknown sender';
                const last = group.messages[group.messages.length - 1];
                return (
                  <article key={`${group.key}-${gi}`} className="mb-7 flex gap-3">
                    <span
                      className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full text-[13px] font-semibold ${avatarColor(name)}`}
                      aria-hidden="true"
                    >
                      {initial(group.sender.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="mb-2.5 flex flex-wrap items-center gap-2 text-[13px]">
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
                        <span className="ml-auto text-xs text-slate-400" title={fmtTime(last.receivedAt)}>
                          {fmtTime(last.receivedAt)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {group.messages.map((m) => (
                          <Bubble key={m.id} m={m} unread={m.state === 'NEW'} />
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
