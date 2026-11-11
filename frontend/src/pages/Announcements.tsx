import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, getToken, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select } from '../components/ui';
import { RichTextEditor } from '../components/RichTextEditor';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';
import { fmtDate as fmtDateYgn, fmtDateTime as fmtDateTimeYgn } from '../util/yangonTime';
import { useLiveReload } from '../hooks/useLiveReload';
import AnnouncementMessages, { ThreadsResponse } from './AnnouncementMessages';

const CATEGORIES = ['GENERAL', 'OFFICE', 'FACILITY', 'TRANSPORT', 'MEETING_ROOM', 'MAINTENANCE', 'SAFETY', 'HOLIDAY', 'IT', 'EMERGENCY', 'OTHER'];
const PRIORITIES = ['NORMAL', 'IMPORTANT', 'URGENT', 'EMERGENCY'];

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
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {a.priority !== 'NORMAL' && <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[a.priority]}`}>{nice(a.priority)}</span>}
                {nice(a.category) !== nice(a.priority) && <span className="text-xs text-gray-400">{nice(a.category)}</span>}
                <span className="text-xs text-gray-300 font-mono">{a.code}</span>
              </div>
              <button
                className="text-left font-semibold text-gray-800 mt-1 hover:text-blue-700 group inline-flex items-center gap-1"
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
            <div className="flex flex-col gap-2 items-end shrink-0">
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

/** ============ Administration manage view ============ */
function AdminAnnouncements({ items, reload, replyCounts, onOpenMessages }: {
  items: Announcement[];
  reload: () => void;
  /** announcementId → stored subscriber messages (absent = none) */
  replyCounts: Record<string, number>;
  onOpenMessages: (announcementId: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [deleteFor, setDeleteFor] = useState<Announcement | null>(null);
  const [publishFor, setPublishFor] = useState<Announcement | null>(null);
  const [statsFor, setStatsFor] = useState<Announcement | null>(null);
  const [stats, setStats] = useState<ReadStats | null>(null);
  const [peopleFilter, setPeopleFilter] = useState<'ALL' | 'NOT_ACKED' | 'UNREAD'>('ALL');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // list controls — status chips, priority filter, search
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PUBLISHED' | 'DRAFT' | 'SCHEDULED' | 'EXPIRED'>('ALL');
  const [priorityFilter, setPriorityFilter] = useState('ALL');
  const [search, setSearch] = useState('');

  const [form, setForm] = useState({
    title: '', content: '', category: 'GENERAL', priority: 'NORMAL',
    publishAt: '', endAt: '',
    targetType: 'ALL' as 'ALL' | 'DEPARTMENT' | 'ROLE' | 'EMPLOYEE' | 'BRANCH',
    departmentId: '', roleId: 'EMPLOYEE', userId: '', branchId: '',
  });

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
    setForm({ title: '', content: '', category: 'GENERAL', priority: 'NORMAL', publishAt: '', endAt: '', targetType: 'ALL', departmentId: '', roleId: 'EMPLOYEE', userId: '', branchId: '' });
    setPendingFiles([]);
    setExistingFiles([]);
    setError('');
    setFormOpen(true);
  };

  /** Upload files for a created/edited announcement (best-effort — name+content already saved). */
  const uploadFiles = async (announcementId: string) => {
    for (const f of pendingFiles) {
      const fd = new FormData();
      fd.append('file', f);
      try {
        await fetch(`/api/attachments/upload?announcementId=${announcementId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd,
        });
      } catch { /* surface nothing — the announcement itself is saved */ }
    }
    setPendingFiles([]);
  };

  const openEdit = (a: Announcement) => {
    setEditing(a);
    setForm({
      title: a.title, content: a.content, category: a.category, priority: a.priority,
      publishAt: '', endAt: a.endAt ? a.endAt.slice(0, 16) : '',
      targetType: 'ALL', departmentId: '', roleId: 'EMPLOYEE', userId: '', branchId: '',
    });
    setPendingFiles([]);
    setExistingFiles([]);
    api<Attachment[]>(`/attachments/announcement/${a.id}`).then(setExistingFiles).catch(() => {});
    setError('');
    setFormOpen(true);
  };

  /** Admin detail view — same layout as the employee one (photos first). */
  const openDetail = (a: Announcement) => {
    setDetailFor(a);
    setDetailFiles([]);
    loadFiles(a.id);
  };

  // end-before-publish is mirrored client-side so the To field flags instantly;
  // the same server message is attributed to the field when the API rejects it
  const endAtFieldError =
    (form.publishAt && form.endAt && form.endAt <= form.publishAt) || error === 'End date must be after the publish date'
      ? 'End date must be after the publish date'
      : undefined;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const body: Record<string, unknown> = {
        title: form.title, content: form.content, category: form.category, priority: form.priority,
        ...(form.publishAt ? { publishAt: new Date(form.publishAt).toISOString() } : {}),
        ...(form.endAt ? { endAt: new Date(form.endAt).toISOString() } : {}),
      };
      if (!editing) {
        const target: TargetInput = form.targetType === 'ALL'
          ? { targetType: 'ALL' }
          : form.targetType === 'DEPARTMENT'
            ? { targetType: 'DEPARTMENT', targetId: form.departmentId }
            : form.targetType === 'BRANCH'
              ? { targetType: 'BRANCH', targetId: form.branchId }
              : form.targetType === 'ROLE'
                ? { targetType: 'ROLE', targetId: form.roleId }
                : { targetType: 'EMPLOYEE', targetId: form.userId };
        body.targets = [target];
        const created = await api<{ id: string }>('/announcements', { method: 'POST', body });
        setUploadIds([created.id]);
        await uploadFiles(created.id);
      } else {
        if (form.endAt === '' && editing.endAt) body.endAt = null; // explicit clear
        await api(`/announcements/${editing.id}`, { method: 'PATCH', body });
      }
      toast(editing ? 'Announcement updated' : 'Announcement created (draft — publish when ready)');
      setFormOpen(false);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
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
    setPeopleFilter('ALL');
    try {
      setStats(await api<ReadStats>(`/announcements/${a.id}/read-stats`));
    } catch { /* modal shows null state */ }
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
      <div className="flex justify-between items-center mb-4">
        <div />
        <Button onClick={openCreate}>+ New Announcement</Button>
      </div>

      {items.length === 0 && <Empty label="No announcements yet" />}

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {statusChips.map((c) => (
            <button
              key={c.key}
              onClick={() => setStatusFilter(c.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                statusFilter === c.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {c.label} · {c.count}
            </button>
          ))}
          <div className="ml-auto flex gap-2">
            <Select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className="!w-auto text-xs py-1.5">
              <option value="ALL">All priorities</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{nice(p)}</option>)}
            </Select>
            <Input
              placeholder="Search title or text…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="!w-52 text-xs py-1.5"
            />
          </div>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((a) => {
          const audience = a.audienceCount ?? 0;
          const pct = audience > 0 ? Math.round(((a.readCount ?? 0) / audience) * 100) : 0;
          const emptyDept = (a.targetsWithCounts ?? []).find((t) => t.memberCount === 0);
          return (
          <Card key={a.id} className={`p-4 ${PRIORITY_ACCENT[a.priority] ?? ''} ${a.status === 'EXPIRED' ? 'opacity-70' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {a.pinnedAt && <span title="Pinned" className="text-xs">📌</span>}
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_STYLE[a.status]}`}>{nice(a.status)}</span>
                  {a.priority !== 'NORMAL' && <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[a.priority]}`}>{nice(a.priority)}</span>}
                  {nice(a.category) !== nice(a.priority) && <span className="text-xs text-gray-400">{nice(a.category)}</span>}
                  <span className="text-xs text-gray-300 font-mono">{a.code}</span>
                </div>
                <button
                  className="text-left font-semibold text-gray-800 mt-1 hover:text-blue-700 group inline-flex items-center gap-1"
                  onClick={() => openDetail(a)}
                  title="Open announcement"
                >
                  {a.title}
                  <span className="text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                </button>
                <p className="text-sm text-gray-500 mt-1 line-clamp-2">{plain(a.content)}</p>
                <div className="text-xs text-gray-400 mt-1">
                  {(a.targets ?? []).map((t) => t.targetLabel).join(', ') || 'No target'}
                  {' · '}<span title={fmtDate(a.publishAt)}>{relTime(a.publishAt)}</span>
                  {a.endAt ? ` → ${fmtDate(a.endAt)}` : ''}
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
              <div className="flex flex-col gap-1 items-end shrink-0">
                {(a.status === 'DRAFT' || a.status === 'SCHEDULED') && <Button onClick={() => setPublishFor(a)}>Publish</Button>}
                {a.status === 'PUBLISHED' && (
                  <Button variant="ghost" onClick={() => unpublish(a)}>Unpublish</Button>
                )}
                <div className="flex gap-1 items-center">
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

      {/* create / edit modal */}
      {formOpen && (
        <Modal title={editing ? `Edit ${editing.code}` : 'New announcement'} onClose={() => setFormOpen(false)} error={error && !endAtFieldError ? error : null}>
          <div className="space-y-3">
            <Input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
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
            {!editing && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Target audience</div>
                <div className="grid grid-cols-2 gap-2">
                  <Select value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value as never })}>
                    <option value="ALL">Everyone</option>
                    <option value="DEPARTMENT">Department</option>
                    <option value="BRANCH">Branch</option>
                    <option value="ROLE">Role</option>
                    <option value="EMPLOYEE">Specific employee</option>
                  </Select>
                  {form.targetType === 'DEPARTMENT' && (
                    <Select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                      <option value="">— choose —</option>
                      {org.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                  )}
                  {form.targetType === 'BRANCH' && (
                    <Select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                      <option value="">— choose —</option>
                      {org.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </Select>
                  )}
                  {form.targetType === 'ROLE' && (
                    <Select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
                      {['ADMINISTRATION', 'MANAGEMENT', 'DEPARTMENT_HEAD', 'EMPLOYEE', 'MAINTENANCE_COORDINATOR', 'SYSTEM_ADMIN'].map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase())}</option>)}
                    </Select>
                  )}
                  {form.targetType === 'EMPLOYEE' && (
                    <Select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                      <option value="">— choose —</option>
                      {org.users.map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.username})</option>)}
                    </Select>
                  )}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {!editing && (
                <div>
                  <label htmlFor="announcements-publish-at-empty-draft" className="text-xs text-gray-500">Publish at (empty = draft)</label>
                  <Input id="announcements-publish-at-empty-draft" type="datetime-local" value={form.publishAt} onChange={(e) => setForm({ ...form, publishAt: e.target.value })} />
                </div>
              )}
              <div>
                <label htmlFor="announcements-expires-at" className="text-xs text-gray-500">Expires at</label>
                <Input id="announcements-expires-at" type="datetime-local" error={endAtFieldError} value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })} />
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
                    if (picked.length + pendingFiles.length > 10) {
                      toast('Up to 10 files per announcement');
                      e.target.value = '';
                      return;
                    }
                    setPendingFiles((prev) => [...prev, ...picked]);
                    e.target.value = '';
                  }}
                />
                {pendingFiles.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {pendingFiles.map((f, i) => (
                      <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-xs bg-gray-50 rounded px-2 py-1">
                        <span className="truncate">{isImage(f.type) ? '🖼' : '📄'} {f.name} <span className="text-gray-400">({fmtSize(f.size)})</span></span>
                        <button type="button" className="text-red-500 hover:underline shrink-0" onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}>remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {editing && existingFiles.length > 0 && (
              <AttachmentSections files={existingFiles} className="border-t border-gray-100 pt-3" />
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setFormOpen(false)}>Cancel</Button>
              <Button disabled={busy || !form.title || !plain(form.content)} onClick={submit}>{editing ? 'Save' : 'Create'}</Button>
            </div>
          </div>
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

interface TargetInput { targetType: string; targetId?: string }

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
        setUnread(r.general.unread + r.threads.reduce((n, t) => n + t.unread, 0));
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
        <AnnouncementMessages
          canManage={canManage}
          onOpenAnnouncement={(id) => setSearchParams({ ann: id }, { replace: false })}
        />
      ) : canManage ? (
        <AdminAnnouncements items={items} reload={load} replyCounts={replyCounts} onOpenMessages={(id) => setSearchParams({ tab: 'messages', ann: id })} />
      ) : (
        <EmployeeAnnouncements items={mine} reload={load} />
      )}
    </div>
  );
}
