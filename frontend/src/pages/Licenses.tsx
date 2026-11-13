import { ComponentProps, useCallback, useEffect, useMemo, useState } from 'react';
import { api, hasPermission } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LicenseImages } from '../components/LicenseImages';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';
import { Badge, Button, Empty, Input, PageHeader, Select, Table, Textarea } from '../components/ui';
import { fmtDate } from '../util/yangonTime';

interface License {
  id: string;
  name: string;
  registrationNo: string | null;
  companyLimited: string | null;
  myanmarName: string | null;
  startDate: string | null;
  dueDate: string | null;
  email: string | null;
  emailPassword?: string | null;
  tradenetPassword?: string | null;
  hasEmailPassword?: boolean;
  hasTradenetPassword?: boolean;
  status: string;
  note: string | null;
  updatedAt: string;
  _count?: { images: number };
}

interface FormState {
  id?: string;
  name: string;
  registrationNo: string;
  companyLimited: string;
  myanmarName: string;
  startDate: string;
  dueDate: string;
  email: string;
  emailPassword: string;
  tradenetPassword: string;
  status: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  registrationNo: '',
  companyLimited: '',
  myanmarName: '',
  startDate: '',
  dueDate: '',
  email: '',
  emailPassword: '',
  tradenetPassword: '',
  status: 'Updated',
  note: '',
};

const FILTERS = [
  { value: 'all', label: 'All licenses' },
  { value: 'soon', label: 'Due within 60 days' },
  { value: 'expired', label: 'Expired' },
  { value: 'none', label: 'No due date' },
];

/** `input type="date"` value — the API sends a date-only ISO string. */
const dayValue = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

/** Days until the due date (negative = already expired). */
function daysLeft(due: string | null, today: string): number | null {
  if (!due) return null;
  const dueMs = Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(dueMs) || Number.isNaN(todayMs)) return null;
  return Math.round((dueMs - todayMs) / 86_400_000);
}

function DueBadge({ due, today }: { due: string | null; today: string }) {
  const days = daysLeft(due, today);
  if (!due || days === null) return <span className="text-xs text-gray-400">No due date</span>;
  const color = days < 0 ? 'red' : days <= 60 ? 'orange' : days <= 180 ? 'yellow' : 'green';
  const label = days < 0 ? `Expired ${Math.abs(days)} d ago` : days === 0 ? 'Expires today' : `${days} d left`;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-gray-800">{fmtDate(due)}</span>
      <Badge color={color}>{label}</Badge>
    </div>
  );
}

export default function Licenses() {
  const canManage = hasPermission('licenses.manage');
  const [rows, setRows] = useState<License[] | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [detail, setDetail] = useState<License | null>(null);
  const [deleting, setDeleting] = useState<License | null>(null);
  const [modalError, setModalError] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);
  // Yangon calendar day — expiry badges must not flip at the browser's midnight.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Yangon' });

  const load = useCallback(() => {
    api<License[]>(`/licenses${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)
      .then((data) => {
        setRows(data);
        setError('');
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Could not load licenses');
        setRows([]);
      });
  }, [q]);

  // typing in the search box reloads after a short pause, not on every key
  useEffect(() => {
    const timer = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  const visible = useMemo(() => {
    const list = rows ?? [];
    if (filter === 'all') return list;
    return list.filter((row) => {
      if (filter === 'none') return !row.dueDate;
      const days = daysLeft(row.dueDate, today);
      if (days === null) return false;
      return filter === 'expired' ? days < 0 : days >= 0 && days <= 60;
    });
  }, [rows, filter, today]);

  const openCreate = () => {
    setModalError('');
    setForm({ ...EMPTY_FORM });
  };

  /** Editing starts from the stored row — managers also load the saved logins. */
  const openEdit = async (row: License) => {
    setModalError('');
    setForm({
      id: row.id,
      name: row.name,
      registrationNo: row.registrationNo ?? '',
      companyLimited: row.companyLimited ?? '',
      myanmarName: row.myanmarName ?? '',
      startDate: dayValue(row.startDate),
      dueDate: dayValue(row.dueDate),
      email: row.email ?? '',
      emailPassword: row.emailPassword ?? '',
      tradenetPassword: row.tradenetPassword ?? '',
      status: row.status,
      note: row.note ?? '',
    });
    if (canManage) {
      try {
        const full = await api<License>(`/licenses/${row.id}`);
        setForm((current) => (current && current.id === row.id
          ? { ...current, emailPassword: full.emailPassword ?? '', tradenetPassword: full.tradenetPassword ?? '' }
          : current));
      } catch {
        /* keep the masked form — saving still updates the other fields */
      }
    }
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      setModalError('Company name is required');
      return;
    }
    setModalError('');
    const body = {
      name: form.name,
      registrationNo: form.registrationNo,
      companyLimited: form.companyLimited,
      myanmarName: form.myanmarName,
      startDate: form.startDate || null,
      dueDate: form.dueDate || null,
      email: form.email,
      emailPassword: form.emailPassword,
      tradenetPassword: form.tradenetPassword,
      status: form.status,
      note: form.note,
    };
    try {
      if (form.id) {
        await api(`/licenses/${form.id}`, { method: 'PATCH', body });
        toast('License updated');
      } else {
        await api('/licenses', { method: 'POST', body });
        toast('License added');
      }
      setForm(null);
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const remove = async (row: License) => {
    await api(`/licenses/${row.id}`, { method: 'DELETE' });
    toast('License deleted');
    setDeleting(null);
    setDetail(null);
    load();
  };

  const openDetail = async (row: License) => {
    setShowSecrets(false);
    setDetail(row);
    try {
      setDetail(await api<License>(`/licenses/${row.id}`));
    } catch {
      /* the row we already have is enough to show the register fields */
    }
  };

  const field = (key: keyof FormState, label: string, extra: ComponentProps<typeof Input> = {}) => (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      <Input
        value={String(form?.[key] ?? '')}
        onChange={(e) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f))}
        {...extra}
      />
    </label>
  );

  return (
    <div>
      <PageHeader
        title="Import / Export Licenses"
        subtitle="Company licenses, registration dates and the scanned certificate pictures"
        actions={canManage ? <Button onClick={openCreate}>+ Add license</Button> : undefined}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="block w-full sm:w-72">
          <span className="mb-1 block text-xs font-medium text-gray-600">Search</span>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company, registration no. or email" />
        </label>
        <label className="block w-full sm:w-56">
          <span className="mb-1 block text-xs font-medium text-gray-600">Show</span>
          <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </Select>
        </label>
        {rows && <span className="pb-2 text-xs text-gray-500">{visible.length} of {rows.length}</span>}
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {rows === null ? (
        <Empty label="Loading licenses…" />
      ) : visible.length === 0 ? (
        <Empty label={rows.length === 0 ? 'No license yet — use “+ Add license”' : 'No license matches this filter'} />
      ) : (
        <Table head={['COMPANY', 'REGISTRATION NO.', 'START', 'DUE', 'PICTURES', 'ACTIONS']}>
          {visible.map((row) => (
            <tr key={row.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 first:pl-5">
                <button type="button" onClick={() => void openDetail(row)} className="text-left font-medium text-gray-800 hover:underline">
                  {row.name}
                </button>
                {row.myanmarName && <div className="text-xs text-gray-500">{row.myanmarName}</div>}
              </td>
              <td className="px-4 py-3 text-gray-700">{row.registrationNo || '—'}</td>
              <td className="px-4 py-3 text-gray-600">{fmtDate(row.startDate)}</td>
              <td className="px-4 py-3"><DueBadge due={row.dueDate} today={today} /></td>
              <td className="px-4 py-3 text-center text-gray-700">{row._count?.images ?? 0}/5</td>
              <td className="px-4 py-3">
                {canManage ? (
                  <div className="flex justify-center gap-2">
                    <Button variant="ghost" onClick={() => void openEdit(row)}>Edit</Button>
                    <Button variant="danger" onClick={() => setDeleting(row)}>Delete</Button>
                  </div>
                ) : (
                  <span className="block text-center text-gray-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {/* ---------------- create / edit ---------------- */}
      {form && (
        <Modal
          title={form.id ? `Edit license — ${form.name}` : 'Add license'}
          onClose={() => setForm(null)}
          error={modalError}
          wide
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {field('name', 'Company name *', { autoFocus: true })}
            {field('companyLimited', 'Company Limited')}
            {field('myanmarName', 'Myanmar name')}
            {field('registrationNo', 'Registration No.')}
            {field('startDate', 'Start date', { type: 'date' })}
            {field('dueDate', 'Due date', { type: 'date' })}
            {field('email', 'Email address', { type: 'email' })}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">Status</span>
              <Select value={form.status} onChange={(e) => setForm((f) => (f ? { ...f, status: e.target.value } : f))}>
                {['Updated', 'Renewing', 'Pending', 'Expired'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </Select>
            </label>
            {field('emailPassword', 'E-mail password', { autoComplete: 'new-password' })}
            {field('tradenetPassword', 'TradeNet password', { autoComplete: 'new-password' })}
          </div>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium text-gray-600">Note</span>
            <Textarea rows={2} value={form.note} onChange={(e) => setForm((f) => (f ? { ...f, note: e.target.value } : f))} />
          </label>
          <p className="mt-3 text-[11px] leading-snug text-gray-500">
            🔒 The e-mail and TradeNet logins are only returned to users who may edit this register. Pictures are added from
            the license card (up to 5).
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button onClick={() => void save()}>{form.id ? 'Save changes' : 'Add license'}</Button>
          </div>
        </Modal>
      )}

      {/* ---------------- detail ---------------- */}
      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)} wide>
          <div className="space-y-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              {[
                ['Registration No.', detail.registrationNo || '—'],
                ['Company Limited', detail.companyLimited || '—'],
                ['Myanmar name', detail.myanmarName || '—'],
                ['Status', detail.status],
                ['Start date', fmtDate(detail.startDate)],
                ['Due date', fmtDate(detail.dueDate)],
                ['Email address', detail.email || '—'],
                ['Updated', fmtDate(detail.updatedAt)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</dt>
                  <dd className="text-gray-800">{value}</dd>
                </div>
              ))}
            </dl>

            {(detail.emailPassword || detail.tradenetPassword || detail.hasEmailPassword || detail.hasTradenetPassword) && (
              <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-800">🔐 Portal logins</h3>
                  {canManage && (
                    <Button variant="ghost" onClick={() => setShowSecrets((v) => !v)}>
                      {showSecrets ? 'Hide' : 'Show'}
                    </Button>
                  )}
                </div>
                <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">E-mail password</dt>
                    <dd className="font-mono text-gray-800">
                      {canManage
                        ? showSecrets
                          ? detail.emailPassword || '—'
                          : '••••••••'
                        : detail.hasEmailPassword
                          ? 'Stored (hidden)'
                          : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">TradeNet password</dt>
                    <dd className="font-mono text-gray-800">
                      {canManage
                        ? showSecrets
                          ? detail.tradenetPassword || '—'
                          : '••••••••'
                        : detail.hasTradenetPassword
                          ? 'Stored (hidden)'
                          : '—'}
                    </dd>
                  </div>
                </dl>
                {!canManage && <p className="mt-2 text-[11px] text-gray-500">Only users who manage licenses can reveal these.</p>}
              </div>
            )}

            {detail.note && <p className="mt-4 whitespace-pre-line text-sm text-gray-700">{detail.note}</p>}

            <div className="mt-5">
              <LicenseImages licenseId={detail.id} canManage={canManage} onChanged={load} />
            </div>

            <div className="mt-5 flex justify-end gap-2">
              {canManage && <Button variant="ghost" onClick={() => { const row = detail; setDetail(null); void openEdit(row); }}>Edit</Button>}
              <Button variant="ghost" onClick={() => setDetail(null)}>Close</Button>
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          description="The license record and its stored pictures are removed. This cannot be undone."
          confirmLabel="Delete license"
          variant="danger"
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
