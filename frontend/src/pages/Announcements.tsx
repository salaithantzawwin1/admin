import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, getToken, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select } from '../components/ui';
import { RichTextEditor } from '../components/RichTextEditor';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AnnouncementCalendar } from '../components/AnnouncementCalendar';
import { toast } from '../components/Toast';
import { fmtDate as fmtDateYgn, fmtDateTime as fmtDateTimeYgn, fmtDateTimeInput } from '../util/yangonTime';
import { useLiveReload } from '../hooks/useLiveReload';
import AnnouncementMessages, { ThreadsResponse } from './AnnouncementMessages';

const CATEGORIES = ['GENERAL', 'OFFICE', 'FACILITY', 'TRANSPORT', 'MEETING_ROOM', 'MAINTENANCE', 'SAFETY', 'HOLIDAY', 'IT', 'EMERGENCY', 'OTHER'];
const PRIORITIES = ['NORMAL', 'IMPORTANT', 'URGENT', 'EMERGENCY'];

/** Audience kinds that can be combined in one notice (a department + 3 people). */
type Kind = 'DEPARTMENT' | 'BRANCH' | 'ROLE' | 'EMPLOYEE';
const KINDS: { key: Kind; label: string }[] = [
  { key: 'DEPARTMENT', label: 'Departments' },
  { key: 'BRANCH', label: 'Branches' },
  { key: 'ROLE', label: 'Roles' },
  { key: 'EMPLOYEE', label: 'Employees' },
];
const ROLES = ['ADMINISTRATION', 'MANAGEMENT', 'DEPARTMENT_HEAD', 'EMPLOYEE', 'MAINTENANCE_COORDINATOR', 'SYSTEM_ADMIN'];

interface Picks { ALL: boolean; DEPARTMENT: string[]; BRANCH: string[]; ROLE: string[]; EMPLOYEE: string[] }
const emptyPicks = (): Picks => ({ ALL: false, DEPARTMENT: [], BRANCH: [], ROLE: [], EMPLOYEE: [] });
const countPicks = (p: Picks) =>
  (p.ALL ? 1 : 0) + p.DEPARTMENT.length + p.BRANCH.length + p.ROLE.length + p.EMPLOYEE.length;


/** A picked file's type — browsers sometimes hand it over empty, and the PDF
 * viewer will not open a blob it cannot identify. */
function fileMime(f: File): string {
  if (f.type) return f.type;
  const ext = (f.name.toLowerCase().split('.').pop() ?? '').trim();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

/** A PDF drawn onto canvases. The browser's built-in viewer is refused by our
 * CSP on some machines and renders blank on others, so we do it ourselves. */
function PdfPreview({ file, name }: { file: File; name: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let pdf: { destroy: () => Promise<void> } | null = null;
    const drawn: HTMLCanvasElement[] = [];

    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        // read the bytes here: pdf.js fetching the blob URL is refused by connect-src
        const data = await file.arrayBuffer();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
        pdf = doc;
        const width = Math.max(280, host.current?.clientWidth || 640);
        for (let n = 1; n <= doc.numPages && !cancelled; n += 1) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.className = 'mb-2 h-auto w-full rounded-lg bg-white ring-1 ring-gray-200';
          const context = canvas.getContext('2d');
          if (!context) throw new Error('this browser cannot draw the page');
          host.current?.appendChild(canvas);
          drawn.push(canvas);
          await page.render({ canvasContext: context, viewport }).promise;
        }
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'could not read the file');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      drawn.forEach((canvas) => canvas.remove());
      void pdf?.destroy();
    };
  }, [file]);

  return (
    <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-2">
      {loading && !error && <p className="py-8 text-center text-sm text-gray-400">Opening {name}…</p>}
      {error && (
        <p className="py-8 text-center text-sm text-red-500">Could not open this PDF — {error}</p>
      )}
      <div ref={host} />
    </div>
  );
}

/** The one thing still missing before this notice can be created (empty = ready). */
function missingRequirement(title: string, body: string, editing: boolean, picks: Picks): string {
  if (!title.trim()) return 'Add a title first';
  if (!body.trim()) return 'Add a message first';
  if (!editing && countPicks(picks) === 0) return 'Pick at least one recipient on the Audience tab';
  return '';
}
/** Picks → the target array the API takes (one row per tick). */
const picksToTargets = (p: Picks): { targetType: string; targetId?: string }[] => [
  ...(p.ALL ? [{ targetType: 'ALL' }] : []),
  ...p.DEPARTMENT.map((id) => ({ targetType: 'DEPARTMENT', targetId: id })),
  ...p.BRANCH.map((id) => ({ targetType: 'BRANCH', targetId: id })),
  ...p.ROLE.map((r) => ({ targetType: 'ROLE', targetId: r })),
  ...p.EMPLOYEE.map((id) => ({ targetType: 'EMPLOYEE', targetId: id })),
];

const PRIORITY_STYLE: Record<string, string> = {
  NORMAL: 'bg-gray-100 text-gray-600',
  IMPORTANT: 'bg-blue-100 text-blue-700',
  URGENT: 'bg-orange-100 text-orange-700',
  EMERGENCY: 'bg-red-100 text-red-700',
};

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  SCHEDULED: 'bg-purple-100 text-purple-700',
  PUBLISHED: 'bg-green-100 text-green-700',
  EXPIRED: 'bg-gray-100 text-gray-400',
};

interface Target { targetType: string; targetId: string | null; targetLabel: string; memberCount?: number | null }
interface Announcement {
  id: string; code: string; title: string; content: string;
  category: string; priority: string; status: string;
  publishAt: string | null; endAt: string | null; requiresAck: boolean;
  pinnedAt?: string | null;
  createdBy?: string; targets?: Target[];
  read?: boolean; acked?: string | null;
  readCount?: number;
  /** admin list enrichment */
  audienceCount?: number;
  /** how many of the audience explicitly acknowledged (IMPORTANT+) */
  ackCount?: number;
  targetsWithCounts?: Target[];
  /** photo thumbnails included in /mine responses (first 4) */
  photos?: Attachment[];
  createdAt: string;
}
interface Attachment { id: string; filename: string; size: number; mimeType: string }
interface DeptReadRow { departmentId: string | null; name: string; target: number; read: number; acked: number }
interface ReadPerson { userId: string; name: string; username: string; department: string | null; readAt: string | null; ackAt: string | null }
interface ReadStats {
  target: number; read: number; unread: number; acked: number; requiresAck: boolean;
  departments?: DeptReadRow[];
  /** every target with their own read/ack time — the chase list (F3) */
  people?: ReadPerson[];
}

/** Same sentences the API uses — the client shows them under the date field. */
const SEND_RULE = 'End date must be after the send date';
const LIVE_RULE = 'A live notice cannot expire in the past — unpublish it instead';

/** The server refuses anything larger; checking here keeps it visible. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const isImage = (mime: string) => mime.startsWith('image/');

/** Enum → human label (raw codes like EMERGENCY read harsh and shouty). */
const FRIENDLY: Record<string, string> = {
  GENERAL: 'General', OFFICE: 'Office', FACILITY: 'Facility', TRANSPORT: 'Transport',
  MEETING_ROOM: 'Meeting room', MAINTENANCE: 'Maintenance', SAFETY: 'Safety',
  HOLIDAY: 'Holiday', IT: 'IT', EMERGENCY: 'Emergency', OTHER: 'Other',
  NORMAL: 'Normal', IMPORTANT: 'Important', URGENT: 'Urgent',
  PUBLISHED: 'Published', DRAFT: 'Draft', SCHEDULED: 'Scheduled', EXPIRED: 'Expired',
  ALL: 'Everyone', DEPARTMENT: 'Department', BRANCH: 'Branch', ROLE: 'Role', EMPLOYEE: 'Employee',
};
const nice = (s: string) => FRIENDLY[s] ?? s;

/** "2h ago" relative time (full date on hover via title). */
const relTime = (s: string | null) => {
  if (!s) return '';
  const min = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return fmtDateYgn(s).split(' ').slice(0, 2).join(' '); // "2 Oct" — Yangon-anchored via util/yangonTime
};

/** Priority card accent — emergencies must be unmissable when scanning. */
const PRIORITY_ACCENT: Record<string, string> = {
  EMERGENCY: 'border-l-4 border-l-red-500 bg-red-50/40',
  URGENT: 'border-l-4 border-l-orange-400 bg-orange-50/40',
  IMPORTANT: 'border-l-4 border-l-amber-300',
  NORMAL: '',
};

/** Strip tags for one-line previews (content itself is sanitized server-side). */
const plain = (html: string) =>
  (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const splitFiles = (files: Attachment[]) => ({
  photos: files.filter((f) => isImage(f.mimeType)),
  docs: files.filter((f) => !isImage(f.mimeType)),
});

/** Full-screen photo viewer — arrows, keyboard, counter, download link. */
function Lightbox({ photos, index, onClose, onIndex }: { photos: Attachment[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const f = photos[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && index < photos.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, photos.length, onClose, onIndex]);
  if (!f) return null;
  const src = `/api/attachments/${f.id}/download?token=${encodeURIComponent(getToken() ?? '')}`;
  return (
    <div className="fixed inset-0 z-[60] bg-black/90 flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between px-4 py-3 text-white/90 text-sm" onClick={(e) => e.stopPropagation()}>
        <span className="font-mono text-xs truncate">{f.filename}</span>
        <div className="flex items-center gap-3">
          <span>{index + 1} / {photos.length}</span>
          <a href={src} download className="hover:text-white" title="Download">⬇</a>
          <button onClick={onClose} className="hover:text-white text-lg leading-none" title="Close (Esc)">×</button>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center min-h-0 relative px-14">
        {index > 0 && (
          <button
            className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/25 text-white text-xl transition-colors"
            onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }}
            title="Previous (←)"
          >‹</button>
        )}
        <img
          src={src}
          alt={f.filename}
          className="max-w-full max-h-full object-contain rounded shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
        {index < photos.length - 1 && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/25 text-white text-xl transition-colors"
            onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }}
            title="Next (→)"
          >›</button>
        )}
      </div>
      <div className="h-16 shrink-0 flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
        {photos.map((p, i) => (
          <img
            key={p.id}
            src={`/api/attachments/${p.id}/download?token=${encodeURIComponent(getToken() ?? '')}`}
            alt=""
            onClick={() => onIndex(i)}
            className={`h-10 w-14 object-cover rounded cursor-pointer transition-all ${i === index ? 'ring-2 ring-white opacity-100' : 'opacity-50 hover:opacity-80'}`}
          />
        ))}
      </div>
    </div>
  );
}

/** Photos first (grid), then text, then document links — Plan §18 attachments. */
function AttachmentSections({ files, className = '' }: { files: Attachment[]; className?: string }) {
  const { photos, docs } = splitFiles(files);
  const [lightbox, setLightbox] = useState<number | null>(null);
  if (files.length === 0) return null;
  return (
    <div className={className}>
      {photos.length > 0 && (
        <div className="ann-gallery mt-3">
          {photos.map((f, i) => (
            <img
              key={f.id}
              src={`/api/attachments/${f.id}/download?token=${encodeURIComponent(getToken() ?? '')}`}
              alt={f.filename}
              onClick={() => setLightbox(i)}
            />
          ))}
        </div>
      )}
      {docs.length > 0 && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Attachments</div>
          <div className="space-y-1">
            {docs.map((f) => (
              <a
                key={f.id}
                href={`/api/attachments/${f.id}/download?token=${encodeURIComponent(getToken() ?? '')}`}
                className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
              >
                📎 {f.filename} <span className="text-xs text-gray-400">({fmtSize(f.size)})</span>
              </a>
            ))}
          </div>
        </div>
      )}
      {lightbox != null && <Lightbox photos={photos} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/** Copy the announcement's deep link (?ann=<id> reopens it) to the clipboard. */
function ShareButton({ id, code }: { id: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const url = `${location.origin}/announcements?ann=${id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API can be blocked (http LAN) — fall back to the old way
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <button
      onClick={copy}
      className={`text-xs px-2 py-1 rounded-md border transition-colors ${copied ? 'bg-green-50 border-green-300 text-green-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
      title={`Copy a link to ${code}`}
    >
      {copied ? '✓ Link copied' : '🔗 Share'}
    </button>
  );
}

/** Open an announcement straight from a shared ?ann=<id> link (once items arrive). */
function useDeepLink(items: Announcement[], open: (a: Announcement) => void) {
  const done = useRef('');
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('ann');
    if (!id || done.current === id || items.length === 0) return;
    const a = items.find((x) => x.id === id);
    if (a) {
      done.current = id;
      open(a);
      // drop the consumed ?ann= but keep the rest of the query (?tab=) intact
      const url = new URL(location.href);
      url.searchParams.delete('ann');
      history.replaceState(null, '', url.pathname + url.search);
    }
  }, [items, open]);
}

const fmtDate = (s: string | null) => fmtDateTimeYgn(s); // "2 Oct 2026, 09:00" — Yangon-anchored

/** Miniature photo strip for list cards — inline, lazy, click-through to the detail view. */
function PhotoStrip({ photos, onOpen, dim }: { photos: Attachment[]; onOpen: () => void; dim?: boolean }) {
  if (photos.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="flex gap-1">
        {photos.slice(0, 4).map((f) => (
          <img
            key={f.id}
            src={`/api/attachments/${f.id}/download?token=${encodeURIComponent(getToken() ?? '')}`}
            alt={f.filename}
            loading="lazy"
            className={`w-14 h-14 object-cover rounded-lg border border-gray-200 cursor-pointer transition-opacity ${dim ? 'opacity-60' : 'hover:opacity-80'}`}
            onClick={onOpen}
          />
        ))}
      </div>
      {photos.length > 4 && <span className="text-xs text-gray-400">+{photos.length - 4} more</span>}
    </div>
  );
}

/** ============ Employee view ============ */
type EmpTab = 'ALL' | 'UNREAD' | 'ACK';

type FormTab = 'content' | 'audience' | 'delivery';

/** One step of the compose dialog. A red dot marks a still-missing requirement. */
function FormTabButton({
  id,
  controls,
  label,
  active,
  warn,
  onClick,
}: {
  id: string;
  controls: string;
  label: string;
  active: boolean;
  warn?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      }`}
    >
      {label}
      {warn && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" title={warn} aria-label={warn} />}
    </button>
  );
}

function EmployeeAnnouncements({ items, reload }: { items: Announcement[]; reload: () => void }) {
  const [open, setOpen] = useState<Announcement | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [tab, setTab] = useState<EmpTab>('ALL');

  useDeepLink(items, (a) => { void openDetail(a); });

  const needsAck = items.filter((a) => a.requiresAck && !a.acked);
  const unread = items.filter((a) => !a.read);
  const shown = tab === 'UNREAD' ? unread : tab === 'ACK' ? needsAck : items;

  const openDetail = async (a: Announcement) => {
    setOpen(a);
    setFiles([]);
    if (!a.read) {
      try { await api(`/announcements/${a.id}/read`, { method: 'POST' }); } catch { /* best-effort */ }
      reload();
    }
    try {
      setFiles(await api<Attachment[]>(`/attachments/announcement/${a.id}`));
    } catch { /* files are supplementary */ }
  };

  const ack = async (a: Announcement) => {
    try {
      await api(`/announcements/${a.id}/ack`, { method: 'POST' });
      toast('Acknowledged — thank you!');
      setOpen(null);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed');
    }
  };

  if (items.length === 0) return <Empty label="No announcements right now" />;

  const tabs: { key: EmpTab; label: string; count?: number }[] = [
    { key: 'ALL', label: 'All', count: items.length },
    { key: 'UNREAD', label: 'Unread', count: unread.length },
    { key: 'ACK', label: 'Needs ack', count: needsAck.length },
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              tab === t.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t.label}{t.count != null && t.count > 0 && ` · ${t.count}`}
          </button>
        ))}
      </div>
      {shown.length === 0 && <Empty label={tab === 'ACK' ? 'Nothing waiting for acknowledgement 🎉' : 'Nothing here'} />}
      {/* F8 — an unread notice is marked in EVERY priority: NORMAL gets the blue
          left border, the accent-coloured ones keep their colour and get a ring
          (the border is already spoken for by the priority). */}
      {shown.map((a) => (
        <Card
          key={a.id}
          className={`p-4 ${!a.read && a.priority === 'NORMAL' ? 'border-l-4 border-l-blue-500' : ''} ${!a.read && a.priority !== 'NORMAL' ? 'ring-1 ring-inset ring-blue-300' : ''} ${PRIORITY_ACCENT[a.priority] ?? ''} ${a.acked ? 'opacity-75' : ''}`}
        >
          <div className="flex flex-col gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {a.priority !== 'NORMAL' && <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[a.priority]}`}>{nice(a.priority)}</span>}
                {nice(a.category) !== nice(a.priority) && <span className="text-xs text-gray-400">{nice(a.category)}</span>}
                <span className="text-xs text-gray-300 font-mono">{a.code}</span>
              </div>
              <button
                className="mt-1 inline-flex items-center gap-1 text-left text-[15px] font-semibold leading-snug text-gray-900 hover:text-blue-700 group sm:text-base"
                onClick={() => openDetail(a)}
                title="Open announcement"
              >
                {a.title}
                <span className="text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">→</span>
              </button>
              <div className="text-xs text-gray-400 mt-0.5">
                {a.createdBy} · <span title={fmtDate(a.publishAt)}>{relTime(a.publishAt)}</span>
                {a.endAt ? ` → until ${fmtDate(a.endAt)}` : ''}
                {a.requiresAck && !a.acked && <span className="text-orange-500 font-medium"> · acknowledgement needed</span>}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              {!a.read && <Badge color="blue">NEW</Badge>}
              {a.requiresAck && (a.acked
                ? <Badge color="green">✓ Acked</Badge>
                // F6 — acknowledging is recorded against the reader's name and cannot
                // be taken back, so the card opens the notice first; the confirm lives
                // in the detail view ("I acknowledge this notice").
                : <Button onClick={() => openDetail(a)} title="Read the notice, then acknowledge it">Acknowledge…</Button>)}
            </div>
          </div>
          <p className={`text-sm text-gray-600 mt-2 ${a.read ? 'line-clamp-2' : 'line-clamp-3'}`}>{plain(a.content)}</p>
          <PhotoStrip photos={a.photos ?? []} dim={!!a.acked} onOpen={() => openDetail(a)} />
        </Card>
      ))}

      {open && (
        <Modal title={`${open.code} — ${open.title}`} onClose={() => setOpen(null)}>
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[open.priority]}`}>{nice(open.priority)}</span>
            {nice(open.category) !== nice(open.priority) && <span className="text-xs text-gray-500">{nice(open.category)}</span>}
            <span className="text-xs text-gray-400">{fmtDate(open.publishAt)}</span>
            <span className="ml-auto"><ShareButton id={open.id} code={open.code} /></span>
          </div>
          <div className="text-sm text-gray-700 whitespace-pre-wrap rich-content" dangerouslySetInnerHTML={{ __html: open.content }} />
          <AttachmentSections files={files} />
          {open.requiresAck && !open.acked && (
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-3">
              <span className="text-xs text-gray-500 mr-auto">
                Acknowledging is recorded against your name and cannot be undone.
              </span>
              <Button onClick={() => ack(open)}>✓ I acknowledge this notice</Button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/**
 * Multi-select employee picker: the audience field used to take one person per
 * announcement, which meant the same notice had to be sent again for each
 * colleague. Ticking is now additive — each tick becomes its own EMPLOYEE
 * target, and the server de-duplicates people across targets.
 */
function EmployeePicker({
  users,
  value,
  onChange,
}: {
  users: { id: string; fullName: string; username: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? users.filter((u) => `${u.fullName} ${u.username}`.toLowerCase().includes(needle))
    : users;
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const chosen = users.filter((u) => value.includes(u.id));

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-2.5 py-2">
        <span className="text-xs font-medium text-gray-700">
          Employees{value.length > 0 && <span className="text-gray-400"> · {value.length} selected</span>}
        </span>
        <div className="flex items-center gap-1.5">
          {shown.length > 0 && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50"
              onClick={() => onChange([...new Set([...value, ...shown.map((u) => u.id)])])}
            >
              Select all{needle ? ' shown' : ''}
            </button>
          )}
          {value.length > 0 && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100"
              onClick={() => onChange([])}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="px-2.5 py-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or username…"
          aria-label="Search employees"
          className="text-xs py-1.5"
        />
      </div>

      <div className="max-h-52 overflow-y-auto border-t border-gray-100 px-1 py-1">
        {shown.length === 0 && <div className="px-2 py-3 text-xs text-gray-400">No employee matches</div>}
        {shown.map((u) => (
          <label
            key={u.id}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50"
          >
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              checked={value.includes(u.id)}
              onChange={() => toggle(u.id)}
            />
            <span className="min-w-0 truncate text-gray-800">{u.fullName}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-gray-400">{u.username}</span>
          </label>
        ))}
      </div>

      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-gray-100 px-2.5 py-2">
          {chosen.map((u) => (
            <span
              key={u.id}
              className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700"
            >
              {u.fullName}
              <button
                type="button"
                onClick={() => toggle(u.id)}
                className="text-blue-400 hover:text-blue-700"
                aria-label={`Remove ${u.fullName}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compact multi-select for departments, branches and roles — the same list
 * pattern as the employee picker, without the chips (the summary line below the
 * audience block already spells the selection out).
 */
function Picker({
  items,
  value,
  onChange,
  empty = 'Nothing to pick',
}: {
  items: { id: string; label: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  empty?: string;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => i.label.toLowerCase().includes(needle)) : items;
  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-2.5 py-2">
        <span className="text-xs font-medium text-gray-700">
          Selected{value.length > 0 && <span className="text-gray-400"> · {value.length}</span>}
        </span>
        {value.length > 0 && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100"
            onClick={() => onChange([])}
          >
            Clear
          </button>
        )}
      </div>
      {items.length > 4 && (
        <div className="px-2.5 py-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            aria-label="Search this list"
            className="text-xs py-1.5"
          />
        </div>
      )}
      <div className="max-h-44 overflow-y-auto border-t border-gray-100 px-1 py-1">
        {shown.length === 0 && <div className="px-2 py-3 text-xs text-gray-400">{empty}</div>}
        {shown.map((i) => (
          <label key={i.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              checked={value.includes(i.id)}
              onChange={() => onChange(value.includes(i.id) ? value.filter((x) => x !== i.id) : [...value, i.id])}
            />
            <span className="min-w-0 truncate text-gray-800">{i.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** "3 selections: Administration, 2 employees" — the audience in one line. */
function audienceSummary(
  p: Picks,
  org: { departments: { id: string; name: string }[]; branches: { id: string; name: string }[] },
) {
  const parts: string[] = [];
  if (p.ALL) parts.push('Everyone');
  const depts = p.DEPARTMENT.map((id) => org.departments.find((d) => d.id === id)?.name).filter(Boolean) as string[];
  if (depts.length) parts.push(depts.join(', '));
  const branches = p.BRANCH.map((id) => org.branches.find((b) => b.id === id)?.name).filter(Boolean) as string[];
  if (branches.length) parts.push(branches.join(', '));
  if (p.ROLE.length) parts.push(p.ROLE.map(nice).join(', '));
  if (p.EMPLOYEE.length) parts.push(`${p.EMPLOYEE.length} employee${p.EMPLOYEE.length === 1 ? '' : 's'}`);
  const n = countPicks(p);
  return `${n} selection${n === 1 ? '' : 's'}: ${parts.join(' · ')}`;
}

/** ============ Administration manage view ============ */
function AdminAnnouncements({ items, reload, replyCounts, onOpenMessages }: {
  items: Announcement[];
  reload: () => void;
  /** announcementId → stored subscriber messages (absent = none) */
  replyCounts: Record<string, number>;
  onOpenMessages: (announcementId: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);

  // which step of the compose dialog is showing — a fresh form starts on Content
  const [formTab, setFormTab] = useState<FormTab>('content');


  // a picked-but-not-yet-uploaded file, opened in a preview dialog
  const [pendingPreview, setPendingPreview] = useState<{ file: File; url: string; name: string; type: string } | null>(null);

  useEffect(() => {
    if (formOpen) setFormTab('content');
  }, [formOpen]);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [deleteFor, setDeleteFor] = useState<Announcement | null>(null);
  const [publishFor, setPublishFor] = useState<Announcement | null>(null);
  const [statsFor, setStatsFor] = useState<Announcement | null>(null);
  const [stats, setStats] = useState<ReadStats | null>(null);
  const [statsError, setStatsError] = useState('');
  /** code from the last rejected save — see endAtFieldError */
  const [errorCode, setErrorCode] = useState('');
  const [peopleFilter, setPeopleFilter] = useState<'ALL' | 'NOT_ACKED' | 'UNREAD'>('ALL');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // list controls — status chips, priority filter, search
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PUBLISHED' | 'DRAFT' | 'SCHEDULED' | 'EXPIRED'>('ALL');
  const [priorityFilter, setPriorityFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'list' | 'calendar'>('list');

  const [form, setForm] = useState({
    title: '', content: '', category: 'GENERAL', priority: 'NORMAL',
    publishAt: '', endAt: '',
    picks: emptyPicks(),
  });
  // which audience list is expanded (the selections live in `form.picks`)
  const [openKind, setOpenKind] = useState<Kind | null>('EMPLOYEE');
  // live head-count of the current picks (union, duplicates removed)
  const [preview, setPreview] = useState<{ total: number; groups: { label: string; count: number }[]; duplicates: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  // Ask the server who the current picks reach — it is the only place that knows
  // department memberships and roles, and it removes the overlaps for us.
  useEffect(() => {
    if (editing) return;
    const targets = picksToTargets(form.picks);
    if (targets.length === 0) {
      setPreview(null);
      setPreviewBusy(false);
      return;
    }
    let dead = false;
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      api<{ total: number; groups: { label: string; count: number }[]; duplicates: number }>(
        '/announcements/audience/preview',
        { method: 'POST', body: { targets } },
      )
        .then((r) => {
          if (!dead) setPreview(r);
        })
        .catch(() => {
          if (!dead) setPreview(null);
        })
        .finally(() => {
          if (!dead) setPreviewBusy(false);
        });
    }, 350);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [form.picks, editing]);

  const [org, setOrg] = useState<{ departments: { id: string; name: string }[]; branches: { id: string; name: string }[]; users: { id: string; fullName: string; username: string }[] }>({
    departments: [], branches: [], users: [],
  });
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadIds, setUploadIds] = useState<Announcement['id'][]>([]);
  // files already on the announcement (edit modal) / detail view
  const [existingFiles, setExistingFiles] = useState<Attachment[]>([]);
  const [detailFor, setDetailFor] = useState<Announcement | null>(null);
  const [detailFiles, setDetailFiles] = useState<Attachment[]>([]);

  const loadFiles = (id: string) =>
    api<Attachment[]>(`/attachments/announcement/${id}`).then(setDetailFiles).catch(() => setDetailFiles([]));

  const loadOrg = useCallback(() => {
    // org lists live under /org/* — /departments was a 404 that silently emptied the pickers.
    // Pickers load only for announcement managers: the /org/* read endpoints are
    // gated by departments.read/employees.read, which non-managers may not hold.
    if (!hasPermission('announcements.manage')) return;
    api<{ id: string; name: string }[]>('/org/departments').then((r) => setOrg((o) => ({ ...o, departments: r }))).catch(() => {});
    api<{ id: string; name: string }[]>('/org/branches').then((r) => setOrg((o) => ({ ...o, branches: r }))).catch(() => {});
    api<{ items: { id: string; fullName: string; username: string }[] }>('/users?pageSize=500')
      .then((r) => setOrg((o) => ({ ...o, users: r.items ?? [] }))).catch(() => {});
  }, []);
  useEffect(loadOrg, [loadOrg]);

  const openCreate = () => {
    setEditing(null);
    setPreview(null);
    setForm({ title: '', content: '', category: 'GENERAL', priority: 'NORMAL', publishAt: '', endAt: '', picks: emptyPicks() });
    setPendingFiles([]);
    setExistingFiles([]);
    setError('');
    setErrorCode('');
    setFormOpen(true);
  };

  /** Upload files for a created/edited announcement (best-effort — name+content already saved). */
  const uploadFiles = async (announcementId: string) => {
    // the notice is already saved, so a failed upload must be reported by name —
    // otherwise the admin believes the photo went out with it
    const failed: string[] = [];
    for (const f of pendingFiles) {
      const fd = new FormData();
      fd.append('file', f);
      try {
        const res = await fetch(`/api/attachments/upload?announcementId=${announcementId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd,
        });
        if (!res.ok) failed.push(f.name);
      } catch {
        failed.push(f.name);
      }
    }
    setPendingFiles([]);
    if (failed.length > 0) {
      toast(
        `Announcement saved, but ${failed.length} file${failed.length === 1 ? '' : 's'} could not be uploaded: ${failed.join(', ')}`,
      );
    }
  };

  const openEdit = (a: Announcement) => {
    setEditing(a);
    setPreview(null);
    setForm({
      title: a.title, content: a.content, category: a.category, priority: a.priority,
      // keep both in Yangon wall clock — the expiry is compared against publishAt
      publishAt: fmtDateTimeInput(a.publishAt), endAt: fmtDateTimeInput(a.endAt),
      picks: emptyPicks(),
    });
    setPendingFiles([]);
    setExistingFiles([]);
    api<Attachment[]>(`/attachments/announcement/${a.id}`).then(setExistingFiles).catch(() => {});
    setError('');
    setErrorCode('');
    setFormOpen(true);
  };

  /** Admin detail view — same layout as the employee one (photos first). */
  const openDetail = (a: Announcement) => {
    setDetailFor(a);
    setDetailFiles([]);
    loadFiles(a.id);
  };

  // the shared ?ann=<id> link is copied from this very list, so it has to open here
  useDeepLink(items, (a) => openDetail(a));

  // The end date is judged by one rule on each side and both compare timestamps:
  // endRule() mirrors assertEndDate() on the server. A rejection the local rule
  // cannot see — a clock, or a status that moved since the list was loaded — arrives
  // as an error code and stays on the field until one of the dates is edited.
  // An expiry the admin did not touch is not re-sent, so it must not be judged.
  const SERVER_RULE: Record<string, string> = { END_BEFORE_SEND: SEND_RULE, END_IN_PAST: LIVE_RULE };
  const endAtUnchanged = !!editing && form.endAt === fmtDateTimeInput(editing.endAt);
  const endRule = (endAt: string, publishAt: string, live: boolean): string | undefined => {
    if (!endAt) return undefined;
    const end = new Date(endAt).getTime();
    if (Number.isNaN(end)) return 'That is not a valid date';
    if (publishAt && end <= new Date(publishAt).getTime()) return SEND_RULE;
    if (live && end <= Date.now()) return LIVE_RULE;
    return undefined;
  };
  const endAtFieldError =
    endRule(form.endAt, form.publishAt, editing?.status === 'PUBLISHED' && !endAtUnchanged)
    ?? SERVER_RULE[errorCode];
  // a date edit is the answer to a rejected date, so its code and banner go with it
  const clearDateError = () => { setErrorCode(''); setError(''); };

  const submit = async () => {
    // the button is already disabled for this — belt and braces, since a PATCH
    // used to reach the server with an end date before the send date
    if (endAtFieldError) {
      setError(endAtFieldError);
      return;
    }
    setBusy(true); setError(''); setErrorCode('');
    try {
      const body: Record<string, unknown> = {
        title: form.title, content: form.content, category: form.category, priority: form.priority,
        // publishAt is fixed once the notice exists: the PATCH does not accept it
        ...(!editing && form.publishAt ? { publishAt: new Date(form.publishAt).toISOString() } : {}),
        ...(form.endAt ? { endAt: new Date(form.endAt).toISOString() } : {}),
      };
      if (!editing) {
        // Every kind becomes its own target row — a department plus a few people
        // is one notice with a union audience (the server de-duplicates them).
        body.targets = picksToTargets(form.picks);
        const created = await api<{ id: string }>('/announcements', { method: 'POST', body });
        setUploadIds([created.id]);
        await uploadFiles(created.id);
      } else {
        if (form.endAt === '' && editing.endAt) body.endAt = null; // explicit clear
        else if (endAtUnchanged) delete body.endAt; // untouched — leave the stored one alone
        await api(`/announcements/${editing.id}`, { method: 'PATCH', body });
      }
      toast(editing ? 'Announcement updated' : 'Announcement created (draft — publish when ready)');
      setFormOpen(false);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setErrorCode(e instanceof ApiError ? String((e.details as { code?: string })?.code ?? '') : '');
    } finally {
      setBusy(false);
    }
  };

  /** Publish is irreversible for the audience — always confirm first (F4). */
  const publish = async (a: Announcement) => {
    await api(`/announcements/${a.id}/publish`, { method: 'POST' });
    toast(`Published — audience notified`);
    setPublishFor(null);
    reload();
  };

  const unpublish = async (a: Announcement) => {
    try {
      await api(`/announcements/${a.id}/unpublish`, { method: 'POST' });
      toast(`Unpublished — ${a.code} is back to draft`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doDelete = async () => {
    if (!deleteFor) return;
    try {
      await api(`/announcements/${deleteFor.id}`, { method: 'DELETE' });
      toast('Deleted');
      // anything still showing this notice must go with it
      if (detailFor?.id === deleteFor.id) setDetailFor(null);
      if (statsFor?.id === deleteFor.id) setStatsFor(null);
      setDeleteFor(null);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed');
      setDeleteFor(null);
    }
  };

  const showStats = async (a: Announcement) => {
    setStatsFor(a);
    setStats(null);
    setStatsError('');
    setPeopleFilter('ALL');
    try {
      setStats(await api<ReadStats>(`/announcements/${a.id}/read-stats`));
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : 'Could not load the read stats');
    }
  };

  const togglePin = async (a: Announcement) => {
    try {
      await api(`/announcements/${a.id}/pin`, { method: 'POST' });
      toast(a.pinnedAt ? 'Unpinned' : '📌 Pinned — it will stay at the top of every list');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed');
    }
  };

  /** Template: same text, classification and audience, saved as a fresh draft. */
  const duplicate = async (a: Announcement) => {
    try {
      const copy = await api<{ code: string }>(`/announcements/${a.id}/duplicate`, { method: 'POST' });
      toast(`Copied to draft ${copy.code} — edit and publish when ready`);
      setStatusFilter('DRAFT');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not duplicate');
    }
  };

  const filtered = items.filter((a) => {
    if (statusFilter !== 'ALL' && a.status !== statusFilter) return false;
    if (priorityFilter !== 'ALL' && a.priority !== priorityFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(a.title.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) || plain(a.content).toLowerCase().includes(q))) return false;
    }
    return true;
  });

  // the chase list in the stats modal: everyone / never opened / never acked
  const visiblePeople = (stats?.people ?? []).filter((p) =>
    peopleFilter === 'ALL' ? true : peopleFilter === 'UNREAD' ? !p.readAt : !p.ackAt,
  );

  const statusChips: { key: typeof statusFilter; label: string; count: number }[] = [
    { key: 'ALL', label: 'All', count: items.length },
    { key: 'PUBLISHED', label: 'Published', count: items.filter((a) => a.status === 'PUBLISHED').length },
    { key: 'DRAFT', label: 'Drafts', count: items.filter((a) => a.status === 'DRAFT').length },
    { key: 'SCHEDULED', label: 'Scheduled', count: items.filter((a) => a.status === 'SCHEDULED').length },
    { key: 'EXPIRED', label: 'Expired', count: items.filter((a) => a.status === 'EXPIRED').length },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          {items.length === 0
            ? 'No notices yet'
            : `${items.length} notice${items.length === 1 ? '' : 's'} · ${items.filter((a) => a.status === 'PUBLISHED').length} live · ${items.filter((a) => a.status === 'DRAFT').length} draft`}
        </p>
        <Button onClick={openCreate}>+ New announcement</Button>
      </div>

      {items.length === 0 && <Empty label="No announcements yet" />}

      {items.length > 0 && (
        <div className="mb-4 rounded-xl border border-gray-200/80 bg-white p-1.5 shadow-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            {statusChips.map((c) => (
              <button
                key={c.key}
                onClick={() => setStatusFilter(c.key)}
                aria-pressed={statusFilter === c.key}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  statusFilter === c.key ? 'bg-gray-900 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {c.label}
                <span className={`ml-1.5 tabular-nums ${statusFilter === c.key ? 'text-white/60' : 'text-gray-400'}`}>{c.count}</span>
              </button>
            ))}
            <span className="mx-1 hidden h-5 w-px bg-gray-200 sm:block" aria-hidden="true" />
            <Select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              aria-label="Filter by priority"
              className="!w-auto text-xs py-1.5"
            >
              <option value="ALL">All priorities</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{nice(p)}</option>)}
            </Select>
            <Input
              placeholder="Search title or text…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search announcements"
              className="ml-auto w-full text-xs py-1.5 sm:!w-56"
            />
            <div className="flex items-center rounded-lg bg-gray-100 p-0.5" role="group" aria-label="View">
              {(['list', 'calendar'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    view === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {v === 'list' ? '☰ List' : '▦ Schedule'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {items.length > 0 && filtered.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-10 text-center">
          <div className="text-sm font-medium text-gray-700">No announcement matches</div>
          <div className="mt-1 text-xs text-gray-400">
            {search ? `Nothing for “${search}”` : 'Nothing in this status'} — try another filter.
          </div>
          <button
            className="mt-3 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            onClick={() => { setStatusFilter('ALL'); setPriorityFilter('ALL'); setSearch(''); }}
          >
            Clear filters
          </button>
        </div>
      )}

      {view === 'calendar' ? (
        <AnnouncementCalendar
          items={filtered}
          onOpen={(hit) => {
            const full = filtered.find((x) => x.id === hit.id);
            if (full) openDetail(full);
          }}
        />
      ) : (
      <div className="space-y-3">
        {filtered.map((a) => {
          const audience = a.audienceCount ?? 0;
          const pct = audience > 0 ? Math.round(((a.readCount ?? 0) / audience) * 100) : 0;
          const emptyDept = (a.targetsWithCounts ?? []).find((t) => t.memberCount === 0);
          const labels = (a.targets ?? []).map((t) => t.targetLabel);
          return (
          <Card key={a.id} className={`px-4 py-3.5 sm:px-5 ${PRIORITY_ACCENT[a.priority] ?? ''} ${a.status === 'EXPIRED' ? 'opacity-70' : ''}`}>
            <div className="flex flex-col gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {a.pinnedAt && <span title="Pinned" className="text-xs">📌</span>}
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_STYLE[a.status]}`}>{nice(a.status)}</span>
                  {a.priority !== 'NORMAL' && <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[a.priority]}`}>{nice(a.priority)}</span>}
                  {nice(a.category) !== nice(a.priority) && <span className="text-xs text-gray-400">{nice(a.category)}</span>}
                  <span className="ml-auto font-mono text-[11px] text-gray-300">{a.code}</span>
                </div>
                <button
                  className="mt-1 inline-flex items-center gap-1 text-left text-[15px] font-semibold leading-snug text-gray-900 hover:text-blue-700 group sm:text-base"
                  onClick={() => openDetail(a)}
                  title="Open announcement"
                >
                  {a.title}
                  <span className="text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                </button>
                <p className="mt-1 line-clamp-2 text-sm text-gray-600">{plain(a.content)}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                  <span className="inline-flex min-w-0 items-center gap-1" title={labels.join(', ') || 'No target'}>
                    👥 {audience > 0 ? `${audience} ${audience === 1 ? 'person' : 'people'}` : 'no audience'}
                    {labels.length > 0 && (
                      <span className="truncate text-gray-500">
                        · {labels.slice(0, 2).join(', ')}
                        {labels.length > 2 ? ` +${labels.length - 2}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1" title={fmtDate(a.publishAt)}>
                    🗓 {a.status === 'SCHEDULED' ? 'goes out ' : ''}{relTime(a.publishAt) || 'not published'}
                  </span>
                  {a.endAt && <span className="inline-flex items-center gap-1">⏳ until {fmtDate(a.endAt)}</span>}
                </div>
                {emptyDept && (
                  <div className="text-xs text-orange-600 bg-orange-50 rounded px-2 py-1 mt-1.5 inline-block">
                    ⚠ "{emptyDept.targetLabel}" has no members — nobody will receive this
                  </div>
                )}
                {audience > 0 && (
                  <button className="flex items-center gap-2 mt-2 group/stats" onClick={() => showStats(a)} title="Open read stats">
                    <div className="w-28 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${pct >= 80 ? 'bg-green-500' : pct >= 40 ? 'bg-blue-500' : 'bg-orange-400'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-400 group-hover/stats:text-blue-600 transition-colors">
                      {a.readCount ?? 0}/{audience} read
                    </span>
                  </button>
                )}
                {/* F2 — acknowledgement is the number that matters for IMPORTANT+ */}
                {a.requiresAck && audience > 0 && (
                  <button
                    className="flex items-center gap-2 mt-1 group/ack"
                    onClick={() => showStats(a)}
                    title="Open who acknowledged"
                  >
                    <div className="w-28 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${(a.ackCount ?? 0) >= audience ? 'bg-green-500' : 'bg-amber-400'}`}
                        style={{ width: `${Math.min(100, Math.round(((a.ackCount ?? 0) / audience) * 100))}%` }}
                      />
                    </div>
                    <span className={`text-xs group-hover/ack:underline ${(a.ackCount ?? 0) >= audience ? 'text-green-600' : 'text-amber-600'}`}>
                      Acked {a.ackCount ?? 0}/{audience}
                    </span>
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5 border-t border-gray-100 pt-2.5">
                {(a.status === 'DRAFT' || a.status === 'SCHEDULED') && <Button onClick={() => setPublishFor(a)}>Publish</Button>}
                {a.status === 'PUBLISHED' && (
                  <Button variant="ghost" onClick={() => unpublish(a)}>Unpublish</Button>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  {(replyCounts[a.id] ?? 0) > 0 && (
                    <>
                      <button
                        className="text-xs text-blue-600 hover:underline"
                        onClick={() => onOpenMessages(a.id)}
                        title={`${replyCounts[a.id]} subscriber message(s) — open the Messages tab`}
                      >
                        💬 {replyCounts[a.id]}
                      </button>
                      <span className="text-gray-200">·</span>
                    </>
                  )}
                  <button
                    className="text-xs text-gray-500 hover:underline"
                    onClick={() => duplicate(a)}
                    title="Copy this notice into a new draft (text and audience)"
                  >
                    ⧉ Duplicate
                  </button>
                  <span className="text-gray-200">·</span>
                  <button
                    className={`text-xs hover:underline ${a.pinnedAt ? 'text-gray-900 font-semibold' : 'text-gray-400 hover:text-gray-700'}`}
                    onClick={() => togglePin(a)}
                    title={a.pinnedAt ? 'Unpin' : 'Pin to top'}
                  >
                    {a.pinnedAt ? '📌 Unpin' : '📌 Pin'}
                  </button>
                  {a.status !== 'EXPIRED' && <span className="text-gray-200">·</span>}
                  {a.status !== 'EXPIRED' && <button className="text-xs text-blue-600 hover:underline" onClick={() => openEdit(a)}>Edit</button>}
                  <span className="text-gray-200">·</span>
                  <button className="text-xs text-blue-600 hover:underline" onClick={() => showStats(a)}>Read stats</button>
                  {(a.status === 'DRAFT' || a.status === 'SCHEDULED') && (
                    <>
                      <span className="text-gray-200">·</span>
                      <button className="text-xs text-red-600 hover:underline" onClick={() => setDeleteFor(a)}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </Card>
          );
        })}
      </div>
      )}

      {/* create / edit modal */}
      {formOpen && (
        <Modal
          title={editing ? `Edit ${editing.code}` : 'New announcement'}
          onClose={() => setFormOpen(false)}
          error={error && !endAtFieldError ? error : null}
          xl
        >
                    {/* three steps instead of one tall scroll — the audience picker and its
              head-count sat between the message and the schedule, so nobody
              could see what they were writing and who would get it at once */}
          <div role="tablist" aria-label="Announcement sections" className="mb-4 flex flex-wrap gap-1.5">
            <FormTabButton
              id="ann-tab-content"
              controls="ann-panel-content"
              label="Content"
              active={formTab === 'content'}
              warn={!form.title || !plain(form.content) ? 'Title and message are required' : undefined}
              onClick={() => setFormTab('content')}
            />
            {!editing && (
              <FormTabButton
                id="ann-tab-audience"
                controls="ann-panel-audience"
                label="Audience"
                active={formTab === 'audience'}
                warn={countPicks(form.picks) === 0 ? 'Pick at least one recipient' : undefined}
                onClick={() => setFormTab('audience')}
              />
            )}
            <FormTabButton
              id="ann-tab-delivery"
              controls="ann-panel-delivery"
              label="Schedule & files"
              active={formTab === 'delivery'}
              onClick={() => setFormTab('delivery')}
            />
          </div>

          {/* editing has no audience step — never leave the dialog on an empty panel */}
          {(formTab === 'content' || (formTab === 'audience' && !!editing)) && (
            <div role="tabpanel" id="ann-panel-content" aria-labelledby="ann-tab-content" className="space-y-4">
              <div>
                <label htmlFor="announcement-title" className="mb-1 block text-xs font-medium text-gray-600">Title *</label>
                <Input
                  id="announcement-title"
                  placeholder="e.g. Office closed on Friday afternoon"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Message *</div>
                <RichTextEditor value={form.content} onChange={(html) => setForm((f) => ({ ...f, content: html }))} />
                <div className="text-xs text-gray-400 mt-1">Bold, italic, underline, headings, lists, and alignment are supported — Telegram shows plain text.</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{nice(c)}</option>)}
                </Select>
                <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{nice(p)}{p !== 'NORMAL' ? ' — requires ack' : ''}</option>)}
                </Select>
              </div>
            </div>
          )}

          {formTab === 'audience' && !editing && (
            <div role="tabpanel" id="ann-panel-audience" aria-labelledby="ann-tab-audience">
              <div className="mb-1 flex flex-wrap items-baseline gap-2">
                <span className="text-xs font-medium text-gray-600">Target audience</span>
                <span className="text-[11px] text-gray-400">who receives it, and gets the Telegram card</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={form.picks.ALL}
                  onClick={() => setForm((f) => ({ ...f, picks: { ...f.picks, ALL: !f.picks.ALL } }))}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    form.picks.ALL ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  Everyone
                </button>
                {KINDS.map((k) => {
                  const n = form.picks[k.key].length;
                  return (
                    <button
                      key={k.key}
                      type="button"
                      aria-pressed={n > 0}
                      aria-expanded={openKind === k.key}
                      onClick={() => setOpenKind(openKind === k.key ? null : k.key)}
                      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                        n > 0 ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {k.label}
                      {n > 0 && <span className="ml-1 text-white/70">{n}</span>}
                      <span className="ml-1 text-[10px] opacity-70">{openKind === k.key ? '▴' : '▾'}</span>
                    </button>
                  );
                })}
              </div>

              {form.picks.ALL && (
                <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  Everyone — every active employee, plus anyone already in the audience.
                </p>
              )}

              {openKind === 'DEPARTMENT' && (
                <div className="mt-2">
                  <Picker
                    items={org.departments.map((d) => ({ id: d.id, label: d.name }))}
                    value={form.picks.DEPARTMENT}
                    onChange={(ids) => setForm((f) => ({ ...f, picks: { ...f.picks, DEPARTMENT: ids } }))}
                    empty="No department loaded"
                  />
                </div>
              )}
              {openKind === 'BRANCH' && (
                <div className="mt-2">
                  <Picker
                    items={org.branches.map((b) => ({ id: b.id, label: b.name }))}
                    value={form.picks.BRANCH}
                    onChange={(ids) => setForm((f) => ({ ...f, picks: { ...f.picks, BRANCH: ids } }))}
                    empty="No branch loaded"
                  />
                </div>
              )}
              {openKind === 'ROLE' && (
                <div className="mt-2">
                  <Picker
                    items={ROLES.map((r) => ({ id: r, label: nice(r) }))}
                    value={form.picks.ROLE}
                    onChange={(ids) => setForm((f) => ({ ...f, picks: { ...f.picks, ROLE: ids } }))}
                  />
                </div>
              )}
              {openKind === 'EMPLOYEE' && (
                <div className="mt-2">
                  <EmployeePicker
                    users={org.users}
                    value={form.picks.EMPLOYEE}
                    onChange={(ids) => setForm((f) => ({ ...f, picks: { ...f.picks, EMPLOYEE: ids } }))}
                  />
                </div>
              )}

              <p className={`mt-1.5 text-[11px] ${countPicks(form.picks) === 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                {countPicks(form.picks) === 0
                  ? 'Pick at least one group or employee — a notice with no audience cannot be published.'
                  : audienceSummary(form.picks, org)}
              </p>

              {/* the real head-count, before anything is sent */}
              <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-900" aria-live="polite">
                {countPicks(form.picks) === 0 ? (
                  <span className="text-blue-700/70">Pick a group or employee to see how many people this reaches.</span>
                ) : preview ? (
                  <>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span>
                        👥 <strong className="text-sm">{preview.total}</strong>{' '}
                        {preview.total === 1 ? 'person' : 'people'} will receive this
                      </span>
                      {preview.duplicates > 0 && (
                        <span className="text-[11px] text-blue-700/80">
                          · {preview.duplicates} duplicate{preview.duplicates === 1 ? '' : 's'} removed
                        </span>
                      )}
                      {previewBusy && <span className="text-[11px] text-blue-700/60">updating…</span>}
                    </div>
                    {preview.groups.length > 0 && (
                      <div className="mt-0.5 text-[11px] text-blue-700/80">
                        {preview.groups.map((g) => `${g.label} (${g.count})`).join(' · ')}
                      </div>
                    )}
                    {preview.total === 0 && (
                      <div className="mt-0.5 text-[11px] text-amber-700">
                        Nobody matches these picks — check the department has members.
                      </div>
                    )}
                  </>
                ) : (
                  <span className="text-blue-700/70">Counting recipients…</span>
                )}
              </div>
            </div>
          )}

          {formTab === 'delivery' && (
            <div role="tabpanel" id="ann-panel-delivery" aria-labelledby="ann-tab-delivery" className="space-y-4">
              {editing && (
                <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  {editing.status === 'SCHEDULED' ? (
                    <>Scheduled to go out {fmtDate(editing.publishAt)} — “Publish now” sends it immediately.</>
                  ) : editing.status === 'PUBLISHED' ? (
                    <>Published {fmtDate(editing.publishAt)} — the send date cannot be moved afterwards.</>
                  ) : (
                    <>Still a draft — publish it from the list when you are ready.</>
                  )}
                </div>
              )}
              {editing && (
                <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  Audience is fixed after creation:{' '}
                  <span className="font-medium">
                    {(editing.targets ?? []).map((t) => t.targetLabel).join(', ') || 'no target'}
                  </span>{' '}
                  — duplicate the notice to send it to someone else.
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                {!editing && (
                  <div>
                    <label htmlFor="announcements-publish-at-empty-draft" className="text-xs text-gray-500">Publish at (empty = draft)</label>
                    <Input id="announcements-publish-at-empty-draft" type="datetime-local" value={form.publishAt} onChange={(e) => { setForm({ ...form, publishAt: e.target.value }); clearDateError(); }} />
                  </div>
                )}
                <div>
                  <label htmlFor="announcements-expires-at" className="text-xs text-gray-500">Expires at</label>
                  <Input id="announcements-expires-at" type="datetime-local" error={endAtFieldError} value={form.endAt} onChange={(e) => { setForm({ ...form, endAt: e.target.value }); clearDateError(); }} />
                </div>
              </div>
              {!editing && (
                <div>
                  <label className="text-xs text-gray-500">Photos &amp; documents (optional, up to 10 — images show in the announcement, PDFs ride along as download cards; max 10 MB each)</label>
                  <input
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
                    className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-gray-100 file:text-gray-700 file:cursor-pointer hover:file:bg-gray-200"
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
                      if (tooBig.length > 0) {
                        toast(`Max 10 MB each — skipped ${tooBig.map((f) => f.name).join(', ')}`);
                      }
                      const fits = picked.filter((f) => f.size <= MAX_FILE_BYTES);
                      if (fits.length + pendingFiles.length > 10) {
                        toast('Up to 10 files per announcement');
                        return;
                      }
                      if (fits.length > 0) setPendingFiles((prev) => [...prev, ...fits]);
                    }}
                  />
                  {pendingFiles.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {pendingFiles.map((f, i) => (
                        <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-xs bg-gray-50 rounded px-2 py-1">
                          <span className="truncate">{isImage(f.type) ? '🖼' : '📄'} {f.name} <span className="text-gray-400">({fmtSize(f.size)})</span></span>
                          <span className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            className="text-blue-600 hover:underline"
                            onClick={() => {
                              const type = fileMime(f);
                              const url = URL.createObjectURL(new Blob([f], { type }));
                              setPendingPreview({ file: f, url, name: f.name, type });
                            }}
                          >
                            preview
                          </button>
                          <button
                            type="button"
                            className="text-red-500 hover:underline"
                            onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                          >
                            remove
                          </button>
                        </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {editing && existingFiles.length > 0 && (
                <AttachmentSections files={existingFiles} className="border-t border-gray-100 pt-3" />
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-3">
            <span className="mr-auto text-[11px] text-amber-600">{missingRequirement(form.title, plain(form.content), !!editing, form.picks)}</span>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button
              disabled={busy || !form.title || !plain(form.content) || (!editing && countPicks(form.picks) === 0) || !!endAtFieldError}
              onClick={submit}
            >
              {editing ? 'Save' : 'Create'}
            </Button>
          </div>
</Modal>
      )}

      {/* a picked file, before it is uploaded */}
      {pendingPreview && (
        <Modal
          title={pendingPreview.name}
          onClose={() => {
            URL.revokeObjectURL(pendingPreview.url);
            setPendingPreview(null);
          }}
          wide
        >
          {pendingPreview.type.startsWith('image/') ? (
            <img
              src={pendingPreview.url}
              alt={pendingPreview.name}
              className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg ring-1 ring-gray-200"
            />
          ) : (
            <PdfPreview file={pendingPreview.file} name={pendingPreview.name} />
          )}
        </Modal>
      )}

      {/* admin detail modal — photos first, then text, then docs (same as employee view) */}
      {detailFor && (
        <Modal title={`${detailFor.code} — ${detailFor.title}`} onClose={() => setDetailFor(null)}>
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_STYLE[detailFor.status]}`}>{nice(detailFor.status)}</span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[detailFor.priority]}`}>{nice(detailFor.priority)}</span>
            {nice(detailFor.category) !== nice(detailFor.priority) && <span className="text-xs text-gray-500">{nice(detailFor.category)}</span>}
            <span className="text-xs text-gray-400">{fmtDate(detailFor.publishAt)}</span>
            <span className="ml-auto"><ShareButton id={detailFor.id} code={detailFor.code} /></span>
          </div>
          <div className="text-sm text-gray-700 whitespace-pre-wrap rich-content" dangerouslySetInnerHTML={{ __html: detailFor.content }} />
          <AttachmentSections files={detailFiles} />
        </Modal>
      )}

      {/* read stats modal — totals + per-department breakdown */}
      {statsFor && (
        <Modal title={`Read stats — ${statsFor.code}`} onClose={() => setStatsFor(null)}>
          {stats ? (
            <div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                <div><div className="text-2xl font-bold text-gray-800">{stats.target}</div><div className="text-xs text-gray-400">Target</div></div>
                <div><div className="text-2xl font-bold text-blue-600">{stats.read}</div><div className="text-xs text-gray-400">Read</div></div>
                <div><div className="text-2xl font-bold text-gray-500">{stats.unread}</div><div className="text-xs text-gray-400">Unread</div></div>
                <div><div className="text-2xl font-bold text-green-600">{stats.acked}</div><div className="text-xs text-gray-400">Acked</div></div>
              </div>
              {(stats.people?.length ?? 0) > 0 && (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">People</div>
                    <div className="ml-auto flex gap-1">
                      {(['ALL', 'UNREAD', 'NOT_ACKED'] as const)
                        .filter((f) => f !== 'NOT_ACKED' || stats.requiresAck)
                        .map((f) => (
                          <button
                            key={f}
                            onClick={() => setPeopleFilter(f)}
                            aria-pressed={peopleFilter === f}
                            className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                              peopleFilter === f ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                          >
                            {f === 'ALL' ? `All (${stats.people!.length})` : f === 'UNREAD' ? `Unread (${stats.unread})` : `Not acked (${Math.max(0, stats.target - stats.acked)})`}
                          </button>
                        ))}
                      <button
                        className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
                        onClick={() => {
                          const names = visiblePeople.map((p) => `${p.name}${p.department ? ` (${p.department})` : ''}`).join('\n');
                          const done = () => toast(`${visiblePeople.length} name${visiblePeople.length === 1 ? '' : 's'} copied`);
                          // the app is served over plain HTTP on the LAN, where
                          // navigator.clipboard is undefined (secure context only)
                          const fallback = () => {
                            const ta = document.createElement('textarea');
                            ta.value = names;
                            ta.setAttribute('readonly', '');
                            ta.style.position = 'fixed';
                            ta.style.opacity = '0';
                            document.body.appendChild(ta);
                            ta.select();
                            let ok = false;
                            try { ok = document.execCommand('copy'); } catch { ok = false; }
                            document.body.removeChild(ta);
                            if (ok) done();
                            else toast('Could not copy — the list is selectable');
                          };
                          if (!navigator.clipboard?.writeText) return fallback();
                          navigator.clipboard.writeText(names).then(done, fallback);
                        }}
                        title="Copy the visible names, one per line"
                      >
                        Copy list
                      </button>
                    </div>
                  </div>
                  <div className="max-h-64 overflow-y-auto -mx-1">
                    <table className="w-full text-xs">
                      <thead className="text-gray-400 sticky top-0 bg-white">
                        <tr>
                          <th className="text-left font-medium px-1 py-1">Name</th>
                          <th className="text-left font-medium px-1 py-1">Department</th>
                          <th className="text-left font-medium px-1 py-1">Read</th>
                          {stats.requiresAck && <th className="text-left font-medium px-1 py-1">Acked</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {visiblePeople.map((p) => (
                          <tr key={p.userId} className="border-t border-gray-50">
                            <td className="px-1 py-1 text-gray-800">{p.name}</td>
                            <td className="px-1 py-1 text-gray-500">{p.department ?? '—'}</td>
                            <td className="px-1 py-1 text-gray-500">{p.readAt ? fmtDate(p.readAt) : <span className="text-gray-300">not read</span>}</td>
                            {stats.requiresAck && (
                              <td className={`px-1 py-1 ${p.ackAt ? 'text-green-600' : 'text-amber-600'}`}>
                                {p.ackAt ? fmtDate(p.ackAt) : 'not acked'}
                              </td>
                            )}
                          </tr>
                        ))}
                        {visiblePeople.length === 0 && (
                          <tr><td colSpan={stats.requiresAck ? 4 : 3} className="px-1 py-3 text-center text-gray-400">Nobody in this filter</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {(stats.departments?.length ?? 0) > 0 && (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">By department</div>
                  <div className="space-y-2">
                    {stats.departments!.map((d) => {
                      const pct = d.target > 0 ? Math.round((d.read / d.target) * 100) : 0;
                      return (
                        <div key={d.departmentId ?? 'none'}>
                          <div className="flex items-center justify-between text-sm mb-0.5">
                            <span className="font-medium text-gray-700">{d.name}</span>
                            <span className="text-xs text-gray-400">{d.read}/{d.target} read · {pct}%{stats.requiresAck ? ` · ${d.acked} acked` : ''}</span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${pct >= 80 ? 'bg-green-500' : pct >= 40 ? 'bg-blue-500' : 'bg-orange-400'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : statsError ? (
            <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {statsError}{' '}
              <button className="underline" onClick={() => statsFor && showStats(statsFor)}>
                Retry
              </button>
            </div>
          ) : (
            <div className="text-sm text-gray-400">Loading…</div>
          )}
        </Modal>
      )}

      {/* publish is one click away from reaching everyone — show what it will do (F4) */}
      {publishFor && (
        <ConfirmDialog
          title={publishFor.status === 'SCHEDULED' ? `Publish ${publishFor.code} now?` : `Publish ${publishFor.code}?`}
          description={
            <div className="space-y-2">
              <div className="font-medium text-gray-800">{publishFor.title}</div>
              <div>
                Goes to <strong>{publishFor.audienceCount ?? 0}</strong> {
                  (publishFor.audienceCount ?? 0) === 1 ? 'person' : 'people'
                }{' '}
                ({(publishFor.targets ?? []).map((t) => t.targetLabel).join(', ') || 'no target'}) — in-app notification
                plus a Telegram card to every bound chat.
              </div>
              {publishFor.requiresAck ? (
                <div className="text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                  Subscribers must <strong>acknowledge</strong> this notice ({nice(publishFor.priority)}).
                </div>
              ) : (
                <div className="text-gray-500">Everyone can read it; no acknowledgement is asked for.</div>
              )}
              {publishFor.status === 'SCHEDULED' && (
                <div className="text-gray-500">It was scheduled for {fmtDate(publishFor.publishAt)} — publishing now sends it immediately.</div>
              )}
            </div>
          }
          confirmLabel="Publish now"
          onConfirm={async () => { await publish(publishFor); }}
          onClose={() => setPublishFor(null)}
        />
      )}

      {deleteFor && (
        <ConfirmDialog
          title="Delete announcement"
          description={`Delete draft ${deleteFor.code} "${deleteFor.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={doDelete}
          onClose={() => setDeleteFor(null)}
        />
      )}
    </>
  );
}

export default function Announcements() {
  const canManage = hasPermission('announcements.manage');
  const canMessages = hasPermission('messages.read');
  // the active tab lives in the URL (?tab=messages) so refresh/back/shared links
  // keep it — and `?ann=` then names the conversation instead of a detail view
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: 'announcements' | 'messages' =
    canMessages && searchParams.get('tab') === 'messages' ? 'messages' : 'announcements';
  const showTab = (t: 'announcements' | 'messages') =>
    setSearchParams(t === 'messages' ? { tab: 'messages' } : {}, { replace: false });

  const [items, setItems] = useState<Announcement[]>([]);
  const [mine, setMine] = useState<Announcement[]>([]);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(0);
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});

  /** Tab badge + per-notice reply counts (they share one call). */
  const loadThreads = useCallback(() => {
    if (!canMessages) return;
    api<ThreadsResponse>('/messages/threads')
      .then((r) => {
        setUnread(r.general.unread + r.trips.unread + r.threads.reduce((n, t) => n + t.unread, 0));
        setReplyCounts(Object.fromEntries(r.threads.map((t) => [t.announcementId, t.total])));
      })
      .catch(() => { /* the tab still works; the list shows its own error */ });
  }, [canMessages]);
  useEffect(loadThreads, [loadThreads]);
  useLiveReload(['message.new'], loadThreads);
  useEffect(() => {
    if (!canMessages) return;
    const t = setInterval(loadThreads, 15000); // fallback while the stream is down
    return () => clearInterval(t);
  }, [canMessages, loadThreads]);

  const load = useCallback(() => {
    if (canManage) {
      api<Announcement[]>('/announcements')
        .then((r) => setItems((r as unknown as Array<Announcement & { _count?: { reads: number } }>).map((x) => ({ ...x, readCount: x._count?.reads }))))
        .catch((e) => setError(e.message));
    } else {
      api<Announcement[]>('/announcements/mine')
        .then(setMine)
        .catch((e) => setError(e.message));
    }
  }, [canManage]);
  useEffect(load, [load]);

  return (
    <div>
      <PageHeader title="Announcements" subtitle="Company and office notices (Plan §18)" />

      {canMessages && (
        <div className="flex gap-1 border-b border-gray-200 mb-5" role="tablist" aria-label="Announcements sections">
          <button
            role="tab"
            aria-selected={tab === 'announcements'}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
              tab === 'announcements'
                ? 'border-blue-600 text-blue-700 bg-blue-50/60'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
            onClick={() => showTab('announcements')}
          >
            Announcements
          </button>
          <button
            role="tab"
            aria-selected={tab === 'messages'}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
              tab === 'messages'
                ? 'border-blue-600 text-blue-700 bg-blue-50/60'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
            onClick={() => showTab('messages')}
          >
            💬 Messages{unread > 0 ? ` (${unread})` : ''}
          </button>
          {/* screen readers hear the badge change when a reply arrives */}
          <span className="sr-only" aria-live="polite">
            {unread > 0 ? `${unread} unread subscriber message${unread === 1 ? '' : 's'}` : 'No unread subscriber messages'}
          </span>
        </div>
      )}

      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">{error}</div>}

      {tab === 'messages' && canMessages ? (
        <AnnouncementMessages canManage={canManage} />
      ) : canManage ? (
        <AdminAnnouncements items={items} reload={load} replyCounts={replyCounts} onOpenMessages={(id) => setSearchParams({ tab: 'messages', ann: id })} />
      ) : (
        <EmployeeAnnouncements items={mine} reload={load} />
      )}
    </div>
  );
}
