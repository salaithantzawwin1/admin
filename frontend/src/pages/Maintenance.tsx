import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { PageHeader, Card, Button, Input, Select, Table, Empty, Badge } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';

/**
 * Maintenance (§13–§15) — two sub-tabs that both hang off the fixed-asset
 * register (an Aircon, a generator, a printer):
 *
 *   Records   — the permanent service history: what broke, what was done, who
 *               did it, what it cost, when the next service is due.
 *   Schedules — the preventive side: "every N months", with the due state the
 *               office actually works from (OVERDUE / DUE SOON / OK).
 *
 * Money is not stored twice: a record whose parts+labor+other totals more than
 * zero writes the same amount into the asset's cost ledger, so "what has this
 * Aircon cost us" already includes its servicing.
 */

interface AssetOption {
  id: string;
  assetCode: string;
  name: string;
}

interface VendorOption {
  id: string;
  name: string;
}

interface RecordRow {
  id: string;
  code: string;
  assetId: string;
  type: string;
  status: string;
  date: string;
  problem?: string | null;
  workDone?: string | null;
  vendorId?: string | null;
  technician?: string | null;
  /** Decimal columns arrive as strings from the API */
  costParts: string;
  costLabor: string;
  costOther: string;
  costTotal?: number;
  downtimeHours?: string | null;
  warrantyEndDate?: string | null;
  nextDueDate?: string | null;
  note?: string | null;
  asset?: { id: string; assetCode: string; name: string } | null;
  vendor?: { id: string; name: string } | null;
  createdBy?: { username: string } | null;
}

interface ScheduleRow {
  id: string;
  assetId: string;
  title: string;
  intervalMonths: number;
  lastDoneAt?: string | null;
  nextDueAt: string;
  active: boolean;
  note?: string | null;
  asset?: { id: string; assetCode: string; name: string } | null;
  dueState: 'OVERDUE' | 'DUE_SOON' | 'OK';
  daysLeft: number;
}

const TYPES = ['PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'WARRANTY_SERVICE', 'EMERGENCY'];
const STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

const DUE_COLORS: Record<string, 'red' | 'yellow' | 'green'> = {
  OVERDUE: 'red', DUE_SOON: 'yellow', OK: 'green',
};
const DUE_LABEL: Record<string, string> = {
  OVERDUE: 'Overdue', DUE_SOON: 'Due soon', OK: 'OK',
};

const today = () => new Date().toISOString().slice(0, 10);
const money = (v: unknown) => Number(v ?? 0).toLocaleString();
const day = (v?: string | null) => (v ? v.slice(0, 10) : '—');

const emptyRecord = {
  id: undefined as string | undefined,
  assetId: '',
  type: 'CORRECTIVE',
  status: 'COMPLETED',
  date: today(),
  problem: '',
  workDone: '',
  vendorId: '',
  technician: '',
  costParts: '',
  costLabor: '',
  costOther: '',
  downtimeHours: '',
  warrantyEndDate: '',
  nextDueDate: '',
  note: '',
};

const emptySchedule = {
  id: undefined as string | undefined,
  assetId: '',
  title: '',
  intervalMonths: '6',
  lastDoneAt: '',
  nextDueAt: '',
  note: '',
};

export default function Maintenance() {
  const canManage = hasPermission('maintenance.manage');
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'schedules' ? 'schedules' : 'records';
  const setTab = (t: 'records' | 'schedules') => setSearchParams(t === 'records' ? {} : { tab: t }, { replace: false });

  const [records, setRecords] = useState<RecordRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [assetFilter, setAssetFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [dueOnly, setDueOnly] = useState(false);

  const [recordForm, setRecordForm] = useState<typeof emptyRecord | null>(null);
  const [scheduleForm, setScheduleForm] = useState<typeof emptySchedule | null>(null);
  const [toDelete, setToDelete] = useState<{ kind: 'record' | 'schedule'; id: string; label: string } | null>(null);
  // "Mark done" writes a service record and rolls the due date forward, so it
  // asks first — a double click used to add two visits and skip two intervals.
  const [toDone, setToDone] = useState<ScheduleRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (assetFilter) params.set('assetId', assetFilter);
      if (typeFilter) params.set('type', typeFilter);
      const [recs, scheds] = await Promise.all([
        api<RecordRow[]>(`/maintenance/records?${params.toString()}`),
        api<ScheduleRow[]>(`/maintenance/schedules?${dueOnly ? 'dueOnly=1' : ''}${assetFilter ? `&assetId=${assetFilter}` : ''}`),
      ]);
      setRecords(recs);
      setSchedules(scheds);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load maintenance data');
    } finally {
      setLoading(false);
    }
  }, [assetFilter, typeFilter, dueOnly]);

  useEffect(() => { void load(); }, [load]);

  // pickers: assets (the units that can be maintained) and vendors
  useEffect(() => {
    (async () => {
      try {
        const [a, v] = await Promise.all([
          api<AssetOption[]>('/assets'),
          api<VendorOption[]>('/suppliers').catch(() => []),
        ]);
        setAssets(a);
        setVendors(v);
      } catch {
        // pickers degrade to empty — the page still lists history
      }
    })();
  }, []);

  const overdue = useMemo(() => schedules.filter((s) => s.dueState === 'OVERDUE').length, [schedules]);
  const dueSoon = useMemo(() => schedules.filter((s) => s.dueState === 'DUE_SOON').length, [schedules]);

  const saveRecord = async () => {
    if (!recordForm) return;
    setError(null);
    // On an existing record an emptied field must be cleared (null), not
    // skipped — `undefined` means "leave unchanged" to the API.
    const blankable = (v: string) => (recordForm.id ? (v.trim() || null) : (v.trim() || undefined));
    const body: Record<string, unknown> = {
      // the asset a service belongs to never changes: the update DTO rejects the
      // property, and sending it made every edit fail with
      // "property assetId should not exist" (400)
      ...(recordForm.id ? {} : { assetId: recordForm.assetId }),
      type: recordForm.type,
      status: recordForm.status,
      date: recordForm.date || undefined,
      problem: blankable(recordForm.problem),
      workDone: blankable(recordForm.workDone),
      vendorId: recordForm.id ? (recordForm.vendorId || null) : (recordForm.vendorId || undefined),
      technician: blankable(recordForm.technician),
      costParts: recordForm.costParts === '' ? 0 : Number(recordForm.costParts),
      costLabor: recordForm.costLabor === '' ? 0 : Number(recordForm.costLabor),
      costOther: recordForm.costOther === '' ? 0 : Number(recordForm.costOther),
      downtimeHours: recordForm.downtimeHours === '' ? undefined : Number(recordForm.downtimeHours),
      warrantyEndDate: recordForm.id ? (recordForm.warrantyEndDate || null) : (recordForm.warrantyEndDate || undefined),
      nextDueDate: recordForm.id ? (recordForm.nextDueDate || null) : (recordForm.nextDueDate || undefined),
      note: blankable(recordForm.note),
    };
    try {
      if (recordForm.id) await api(`/maintenance/records/${recordForm.id}`, { method: 'PATCH', body });
      else await api('/maintenance/records', { method: 'POST', body });
      setRecordForm(null);
      toast(recordForm.id ? 'Service record updated' : 'Service record saved');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the record');
    }
  };

  const saveSchedule = async () => {
    if (!scheduleForm) return;
    setError(null);
    const body: Record<string, unknown> = {
      // same rule as a service record: a schedule cannot be moved to another asset
      ...(scheduleForm.id ? {} : { assetId: scheduleForm.assetId }),
      title: scheduleForm.title.trim(),
      intervalMonths: Number(scheduleForm.intervalMonths),
      lastDoneAt: scheduleForm.lastDoneAt || undefined,
      nextDueAt: scheduleForm.nextDueAt || undefined,
      note: scheduleForm.note.trim() || undefined,
    };
    try {
      if (scheduleForm.id) await api(`/maintenance/schedules/${scheduleForm.id}`, { method: 'PATCH', body });
      else await api('/maintenance/schedules', { method: 'POST', body });
      setScheduleForm(null);
      toast(scheduleForm.id ? 'Schedule updated' : 'Schedule created');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the schedule');
    }
  };

  const markDone = async (row: ScheduleRow) => {
    try {
      const r = await api<{ record?: { code: string } }>(`/maintenance/schedules/${row.id}/done`, { method: 'POST', body: { doneAt: today() } });
      toast(r.record?.code ? `Service recorded (${r.record.code}) — schedule rolled forward` : 'Schedule rolled forward');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the schedule');
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    const path = toDelete.kind === 'record'
      ? `/maintenance/records/${toDelete.id}`
      : `/maintenance/schedules/${toDelete.id}`;
    try {
      await api(path, { method: 'DELETE' });
      setToDelete(null);
      toast('Deleted');
      await load();
    } catch (e) {
      setToDelete(null);
      setError(e instanceof Error ? e.message : 'Could not delete');
    }
  };

  const openRecord = (row?: RecordRow) => {
    if (row) {
      setRecordForm({
        id: row.id,
        assetId: row.assetId,
        type: row.type,
        status: row.status,
        date: row.date.slice(0, 10),
        problem: row.problem ?? '',
        workDone: row.workDone ?? '',
        vendorId: row.vendorId ?? '',
        technician: row.technician ?? '',
        costParts: row.costParts ?? '',
        costLabor: row.costLabor ?? '',
        costOther: row.costOther ?? '',
        downtimeHours: row.downtimeHours ?? '',
        warrantyEndDate: row.warrantyEndDate ? row.warrantyEndDate.slice(0, 10) : '',
        nextDueDate: row.nextDueDate ? row.nextDueDate.slice(0, 10) : '',
        note: row.note ?? '',
      });
    } else {
      setRecordForm({ ...emptyRecord, assetId: assetFilter || assets[0]?.id || '' });
    }
  };

  const openSchedule = (row?: ScheduleRow) => {
    if (row) {
      setScheduleForm({
        id: row.id,
        assetId: row.assetId,
        title: row.title,
        intervalMonths: String(row.intervalMonths),
        lastDoneAt: row.lastDoneAt ? row.lastDoneAt.slice(0, 10) : '',
        nextDueAt: row.nextDueAt.slice(0, 10),
        note: row.note ?? '',
      });
    } else {
      setScheduleForm({ ...emptySchedule, assetId: assetFilter || assets[0]?.id || '' });
    }
  };

  const tabs = (
    <div className="flex gap-1 mb-4">
      {(['records', 'schedules'] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => setTab(t)}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium ${tab === t ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
        >
          {t === 'records' ? 'Service Records' : 'Preventive Schedules'}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Maintenance"
        subtitle="Service history and preventive schedules for every maintainable asset"
        actions={canManage ? (
          <Button onClick={() => (tab === 'records' ? openRecord() : openSchedule())}>
            {tab === 'records' ? '+ Service record' : '+ Schedule'}
          </Button>
        ) : undefined}
      />

      {error && (
        <div className="mb-3 rounded-lg bg-red-50 text-red-700 text-sm px-3 py-2">{error}</div>
      )}

      {overdue > 0 && (
        <div className="mb-3 rounded-lg bg-red-50 text-red-700 text-sm px-3 py-2">
          {overdue} schedule{overdue === 1 ? '' : 's'} overdue{dueSoon ? ` · ${dueSoon} due soon` : ''}
        </div>
      )}

      {tabs}

      <Card className="p-3 mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)} className="!w-auto">
            <option value="">All assets</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.assetCode} · {a.name}</option>)}
          </Select>
          {tab === 'records' && (
            <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="!w-auto">
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </Select>
          )}
          {tab === 'schedules' && (
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} />
              Due only
            </label>
          )}
          <p className="text-xs text-gray-400 sm:ml-auto">
            {loading ? 'Loading…' : tab === 'records' ? `${records.length} record${records.length === 1 ? '' : 's'}` : `${schedules.length} schedule${schedules.length === 1 ? '' : 's'}`}
          </p>
        </div>
      </Card>

      {tab === 'records' ? (
        <Card>
          <Table head={['CODE', 'ASSET', 'TYPE', 'STATUS', 'DATE', 'VENDOR', 'COST (KS)', 'NEXT DUE', '']}>
            {loading ? (
              <tr><td colSpan={9}><Empty label="Loading…" /></td></tr>
            ) : records.length === 0 ? (
              <tr><td colSpan={9}><Empty label={canManage ? 'No service records yet — add the first one' : 'No service records yet'} /></td></tr>
            ) : records.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50/60">
                <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{r.code}</td>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-gray-900">{r.asset?.name ?? '—'}</div>
                  <div className="text-xs text-gray-400 font-mono">{r.asset?.assetCode ?? ''}</div>
                </td>
                <td className="px-4 py-2.5 text-xs">{r.type.replace('_', ' ')}</td>
                <td className="px-4 py-2.5">
                  <Badge color={r.status === 'OPEN' ? 'yellow' : r.status === 'IN_PROGRESS' ? 'blue' : r.status === 'CANCELLED' ? 'red' : 'green'}>
                    {r.status.replace('_', ' ')}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-gray-600">{day(r.date)}</td>
                <td className="px-4 py-2.5 text-gray-600">{r.vendor?.name ?? r.technician ?? '—'}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(r.costTotal ?? (Number(r.costParts) + Number(r.costLabor) + Number(r.costOther)))}</td>
                <td className="px-4 py-2.5 text-gray-600">{day(r.nextDueDate)}</td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {canManage && (
                    <>
                      <button type="button" className="text-xs text-gray-600 hover:underline mr-3" onClick={() => openRecord(r)}>Edit</button>
                      <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => setToDelete({ kind: 'record', id: r.id, label: r.code })}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : (
        <Card>
          <Table head={['ASSET', 'SCHEDULE', 'EVERY', 'LAST DONE', 'NEXT DUE', 'STATUS', '']}>
            {loading ? (
              <tr><td colSpan={7}><Empty label="Loading…" /></td></tr>
            ) : schedules.length === 0 ? (
              <tr><td colSpan={7}><Empty label={canManage ? 'No schedules yet — add the first one' : 'No schedules yet'} /></td></tr>
            ) : schedules.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50/60">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-gray-900">{s.asset?.name ?? '—'}</div>
                  <div className="text-xs text-gray-400 font-mono">{s.asset?.assetCode ?? ''}</div>
                </td>
                <td className="px-4 py-2.5 text-gray-800">{s.title}</td>
                <td className="px-4 py-2.5 text-gray-600">{s.intervalMonths} mo</td>
                <td className="px-4 py-2.5 text-gray-600">{day(s.lastDoneAt)}</td>
                <td className="px-4 py-2.5 text-gray-600">{day(s.nextDueAt)}</td>
                <td className="px-4 py-2.5">
                  <Badge color={DUE_COLORS[s.dueState] ?? 'gray'}>
                    {DUE_LABEL[s.dueState] ?? s.dueState}{s.dueState !== 'OK' ? ` · ${Math.abs(s.daysLeft)}d` : ''}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {canManage && (
                    <>
                      <button type="button" className="text-xs text-gray-600 hover:underline mr-3" onClick={() => setToDone(s)}>Mark done</button>
                      <button type="button" className="text-xs text-gray-600 hover:underline mr-3" onClick={() => openSchedule(s)}>Edit</button>
                      <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => setToDelete({ kind: 'schedule', id: s.id, label: s.title })}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {/* ---------- service record form ---------- */}
      {recordForm && (
        <Modal
          title={recordForm.id ? 'Edit service record' : 'New service record'}
          onClose={() => setRecordForm(null)}
          error={error}
          wide
        >
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Asset</label>
              <Select
                value={recordForm.assetId}
                disabled={!!recordForm.id}
                onChange={(e) => setRecordForm({ ...recordForm, assetId: e.target.value })}
              >
                <option value="">— choose —</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.assetCode} · {a.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
              <Select value={recordForm.type} onChange={(e) => setRecordForm({ ...recordForm, type: e.target.value })}>
                {TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Service date</label>
              <Input type="date" value={recordForm.date} onChange={(e) => setRecordForm({ ...recordForm, date: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
              <Select value={recordForm.status} onChange={(e) => setRecordForm({ ...recordForm, status: e.target.value })}>
                {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Vendor / service provider</label>
              <Select value={recordForm.vendorId} onChange={(e) => setRecordForm({ ...recordForm, vendorId: e.target.value })}>
                <option value="">— internal / none —</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Technician</label>
              <Input value={recordForm.technician} onChange={(e) => setRecordForm({ ...recordForm, technician: e.target.value })} placeholder="Who did the work" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Problem</label>
              <Input value={recordForm.problem} onChange={(e) => setRecordForm({ ...recordForm, problem: e.target.value })} placeholder="e.g. Not cooling, water leaking" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Work done</label>
              <Input value={recordForm.workDone} onChange={(e) => setRecordForm({ ...recordForm, workDone: e.target.value })} placeholder="e.g. Gas refill + compressor cleaning" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Parts (Ks)</label>
              <Input type="number" min={0} value={recordForm.costParts} onChange={(e) => setRecordForm({ ...recordForm, costParts: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Labor (Ks)</label>
              <Input type="number" min={0} value={recordForm.costLabor} onChange={(e) => setRecordForm({ ...recordForm, costLabor: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Other (Ks)</label>
              <Input type="number" min={0} value={recordForm.costOther} onChange={(e) => setRecordForm({ ...recordForm, costOther: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Downtime (hours)</label>
              <Input type="number" min={0} value={recordForm.downtimeHours} onChange={(e) => setRecordForm({ ...recordForm, downtimeHours: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Next service due</label>
              <Input type="date" value={recordForm.nextDueDate} onChange={(e) => setRecordForm({ ...recordForm, nextDueDate: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Warranty until</label>
              <Input type="date" value={recordForm.warrantyEndDate} onChange={(e) => setRecordForm({ ...recordForm, warrantyEndDate: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Note</label>
              <Input value={recordForm.note} onChange={(e) => setRecordForm({ ...recordForm, note: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Parts + labor + other is added to the asset's cost history automatically, so the unit's
            total spend already includes this service.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setRecordForm(null)}>Cancel</Button>
            <Button disabled={!recordForm.assetId} onClick={() => void saveRecord()}>Save</Button>
          </div>
        </Modal>
      )}

      {/* ---------- schedule form ---------- */}
      {scheduleForm && (
        <Modal
          title={scheduleForm.id ? 'Edit schedule' : 'New preventive schedule'}
          onClose={() => setScheduleForm(null)}
          error={error}
        >
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Asset</label>
              <Select
                value={scheduleForm.assetId}
                disabled={!!scheduleForm.id}
                onChange={(e) => setScheduleForm({ ...scheduleForm, assetId: e.target.value })}
              >
                <option value="">— choose —</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.assetCode} · {a.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">What is the schedule?</label>
              <Input value={scheduleForm.title} onChange={(e) => setScheduleForm({ ...scheduleForm, title: e.target.value })} placeholder="e.g. Aircon gas service" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Every (months)</label>
                <Input type="number" min={1} max={120} value={scheduleForm.intervalMonths} onChange={(e) => setScheduleForm({ ...scheduleForm, intervalMonths: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Last done</label>
                <Input type="date" value={scheduleForm.lastDoneAt} onChange={(e) => setScheduleForm({ ...scheduleForm, lastDoneAt: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Next due</label>
                <Input type="date" value={scheduleForm.nextDueAt} onChange={(e) => setScheduleForm({ ...scheduleForm, nextDueAt: e.target.value })} />
              </div>
            </div>
            <p className="text-xs text-gray-400">
              Leave "next due" empty and it is derived from the last service + the interval.
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Note</label>
              <Input value={scheduleForm.note} onChange={(e) => setScheduleForm({ ...scheduleForm, note: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setScheduleForm(null)}>Cancel</Button>
            <Button disabled={!scheduleForm.assetId || !scheduleForm.title.trim()} onClick={() => void saveSchedule()}>Save</Button>
          </div>
        </Modal>
      )}

      {toDone && (
        <ConfirmDialog
          title={`Mark "${toDone.title}" done today?`}
          description={`A PREVENTIVE service record is added to ${toDone.asset?.assetCode ?? 'the asset'}'s history and the next due date moves ${toDone.intervalMonths} month(s) forward.`}
          confirmLabel="Mark done"
          onClose={() => setToDone(null)}
          onConfirm={async () => {
            const row = toDone;
            setToDone(null);
            await markDone(row);
          }}
        />
      )}

      {toDelete && (
        <ConfirmDialog
          title={`Delete ${toDelete.label}?`}
          description={toDelete.kind === 'record'
            ? 'The service record and the cost it added to the asset history are both removed. To keep the history, edit it instead.'
            : 'The preventive schedule is removed; past service records stay untouched.'}
          variant="danger"
          confirmLabel="Delete"
          onClose={() => setToDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
