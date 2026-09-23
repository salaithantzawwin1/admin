import { useCallback, useEffect, useState } from 'react';
import { api, getToken, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select } from '../components/ui';
import { RichTextEditor } from '../components/RichTextEditor';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';

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

interface Target { targetType: string; targetId: string | null; targetLabel: string }
interface Announcement {
  id: string; code: string; title: string; content: string;
  category: string; priority: string; status: string;
  publishAt: string | null; endAt: string | null; requiresAck: boolean;
  createdBy?: string; targets?: Target[];
  read?: boolean; acked?: string | null;
  readCount?: number;
  /** photo thumbnails included in /mine responses (first 4) */
  photos?: Attachment[];
  createdAt: string;
}
interface Attachment { id: string; filename: string; size: number; mimeType: string }
interface DeptReadRow { departmentId: string | null; name: string; target: number; read: number; acked: number }
interface ReadStats { target: number; read: number; unread: number; acked: number; requiresAck: boolean; departments?: DeptReadRow[] }

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const isImage = (mime: string) => mime.startsWith('image/');

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

/** Photos first (grid), then text, then document links — Plan §18 attachments. */
function AttachmentSections({ files, className = '' }: { files: Attachment[]; className?: string }) {
  const { photos, docs } = splitFiles(files);
  const [zoom, setZoom] = useState<Attachment | null>(null);
  if (files.length === 0) return null;
  return (
    <div className={className}>
      {photos.length > 0 && (
        <div className="ann-gallery mt-3">
          {photos.map((f) => (
            <img
              key={f.id}
              src={`/api/attachments/${f.id}/download?token=${encodeURIComponent(getToken() ?? '')}`}
              alt={f.filename}
              onClick={() => setZoom(f)}
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
      {zoom && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 cursor-zoom-out" onClick={() => setZoom(null)}>
          <img src={`/api/attachments/${zoom.id}/download?token=${encodeURIComponent(getToken() ?? '')}`} alt={zoom.filename} className="max-w-full max-h-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Miniature photo strip for list cards — inline, lazy, click-through to the detail view. */
function PhotoStrip({ photos, onOpen }: { photos: Attachment[]; onOpen: () => void }) {
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
            className="w-14 h-14 object-cover rounded-lg border border-gray-200 cursor-pointer hover:opacity-80"
            onClick={onOpen}
          />
        ))}
      </div>
      {photos.length > 4 && <span className="text-xs text-gray-400">+{photos.length - 4} more</span>}
    </div>
  );
}

/** ============ Employee view ============ */
function EmployeeAnnouncements({ items, reload }: { items: Announcement[]; reload: () => void }) {
  const [open, setOpen] = useState<Announcement | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);

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

  return (
    <div className="space-y-3">
      {items.map((a) => (
        <Card key={a.id} className={`p-4 ${!a.read ? 'border-l-4 border-l-blue-500' : ''}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[a.priority]}`}>{a.priority}</span>
                <span className="text-xs text-gray-400">{a.category}</span>
                <span className="text-xs text-gray-300 font-mono">{a.code}</span>
              </div>
              <button className="text-left font-semibold text-gray-800 mt-1 hover:text-blue-700" onClick={() => openDetail(a)}>
                {a.title}
              </button>
              <div className="text-xs text-gray-400 mt-0.5">
                {a.createdBy} · {fmtDate(a.publishAt)}{a.endAt ? ` → until ${fmtDate(a.endAt)}` : ''}
                {a.requiresAck && !a.acked && <span className="text-orange-500 font-medium"> · acknowledgement needed</span>}
              </div>
            </div>
            <div className="flex flex-col gap-2 items-end shrink-0">
              {!a.read && <Badge color="blue">NEW</Badge>}
              {a.requiresAck && (a.acked
                ? <Badge color="green">✓ Acked</Badge>
                : <Button onClick={() => ack(a)}>Acknowledge</Button>)}
            </div>
          </div>
          <p className="text-sm text-gray-600 mt-2 line-clamp-2">{plain(a.content)}</p>
          <PhotoStrip photos={a.photos ?? []} onOpen={() => openDetail(a)} />
        </Card>
      ))}

      {open && (
        <Modal title={`${open.code} — ${open.title}`} onClose={() => setOpen(null)}>
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[open.priority]}`}>{open.priority}</span>
            <span className="text-xs text-gray-500">{open.category}</span>
            <span className="text-xs text-gray-400">{fmtDate(open.publishAt)}</span>
          </div>
          <div className="text-sm text-gray-700 whitespace-pre-wrap rich-content" dangerouslySetInnerHTML={{ __html: open.content }} />
          <AttachmentSections files={files} />
          {open.requiresAck && !open.acked && (
            <div className="mt-4 flex justify-end">
              <Button onClick={() => ack(open)}>I acknowledge this notice</Button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/** ============ Administration manage view ============ */
function AdminAnnouncements({ items, reload }: { items: Announcement[]; reload: () => void }) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [deleteFor, setDeleteFor] = useState<Announcement | null>(null);
  const [statsFor, setStatsFor] = useState<Announcement | null>(null);
  const [stats, setStats] = useState<ReadStats | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    // org lists live under /org/* — /departments was a 404 that silently emptied the pickers
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

  const publish = async (a: Announcement) => {
    try {
      await api(`/announcements/${a.id}/publish`, { method: 'POST' });
      toast(`Published — audience notified`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed');
    }
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
    try {
      setStats(await api<ReadStats>(`/announcements/${a.id}/read-stats`));
    } catch { /* modal shows null state */ }
  };

  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <div />
        <Button onClick={openCreate}>+ New Announcement</Button>
      </div>

      {items.length === 0 && <Empty label="No announcements yet" />}

      <div className="space-y-3">
        {items.map((a) => (
          <Card key={a.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_STYLE[a.status]}`}>{a.status}</span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[a.priority]}`}>{a.priority}</span>
                  <span className="text-xs text-gray-400">{a.category}</span>
                  <span className="text-xs text-gray-300 font-mono">{a.code}</span>
                </div>
                <button className="text-left font-semibold text-gray-800 mt-1 hover:text-blue-700" onClick={() => openDetail(a)}>{a.title}</button>
                <p className="text-sm text-gray-500 mt-1 line-clamp-2">{plain(a.content)}</p>
                <div className="text-xs text-gray-400 mt-1">
                  {(a.targets ?? []).map((t) => t.targetLabel).join(', ') || 'No target'}
                  {' · '}{fmtDate(a.publishAt)}{a.endAt ? ` → ${fmtDate(a.endAt)}` : ''}
                  {a.readCount != null && ` · ${a.readCount} read`}
                </div>
              </div>
              <div className="flex flex-col gap-1 items-end shrink-0">
                {(a.status === 'DRAFT' || a.status === 'SCHEDULED') && <Button onClick={() => publish(a)}>Publish</Button>}
                {a.status === 'PUBLISHED' && (
                  <Button variant="ghost" onClick={() => unpublish(a)}>Unpublish</Button>
                )}
                <div className="flex gap-1">
                  {a.status !== 'EXPIRED' && <button className="text-xs text-blue-600 hover:underline" onClick={() => openEdit(a)}>Edit</button>}
                  <button className="text-xs text-blue-600 hover:underline" onClick={() => showStats(a)}>Read stats</button>
                  {(a.status === 'DRAFT' || a.status === 'SCHEDULED') && (
                    <button className="text-xs text-red-600 hover:underline" onClick={() => setDeleteFor(a)}>Delete</button>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* create / edit modal */}
      {formOpen && (
        <Modal title={editing ? `Edit ${editing.code}` : 'New announcement'} onClose={() => setFormOpen(false)} error={error}>
          <div className="space-y-3">
            <Input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <div>
              <div className="text-xs text-gray-500 mb-1">Message *</div>
              <RichTextEditor value={form.content} onChange={(html) => setForm((f) => ({ ...f, content: html }))} />
              <div className="text-xs text-gray-400 mt-1">Bold, italic, underline, headings, lists, and alignment are supported — Telegram shows plain text.</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
              <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
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
                      {['ADMINISTRATION', 'MANAGEMENT', 'DEPARTMENT_HEAD', 'EMPLOYEE', 'MAINTENANCE_COORDINATOR', 'SYSTEM_ADMIN'].map((r) => <option key={r} value={r}>{r}</option>)}
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
                  <label className="text-xs text-gray-500">Publish at (empty = draft)</label>
                  <Input type="datetime-local" value={form.publishAt} onChange={(e) => setForm({ ...form, publishAt: e.target.value })} />
                </div>
              )}
              <div>
                <label className="text-xs text-gray-500">Expires at</label>
                <Input type="datetime-local" value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })} />
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
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_STYLE[detailFor.status]}`}>{detailFor.status}</span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${PRIORITY_STYLE[detailFor.priority]}`}>{detailFor.priority}</span>
            <span className="text-xs text-gray-500">{detailFor.category}</span>
            <span className="text-xs text-gray-400">{fmtDate(detailFor.publishAt)}</span>
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
              <div className="grid grid-cols-4 gap-3 text-center">
                <div><div className="text-2xl font-bold text-gray-800">{stats.target}</div><div className="text-xs text-gray-400">Target</div></div>
                <div><div className="text-2xl font-bold text-blue-600">{stats.read}</div><div className="text-xs text-gray-400">Read</div></div>
                <div><div className="text-2xl font-bold text-gray-500">{stats.unread}</div><div className="text-xs text-gray-400">Unread</div></div>
                <div><div className="text-2xl font-bold text-green-600">{stats.acked}</div><div className="text-xs text-gray-400">Acked</div></div>
              </div>
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
  const [items, setItems] = useState<Announcement[]>([]);
  const [mine, setMine] = useState<Announcement[]>([]);
  const [error, setError] = useState('');

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
      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">{error}</div>}
      {canManage ? <AdminAnnouncements items={items} reload={load} /> : <EmployeeAnnouncements items={mine} reload={load} />}
    </div>
  );
}
