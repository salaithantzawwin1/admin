import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, hasPermission } from '../api';
import { Modal } from './Modal';
import { toast } from './Toast';
import { Badge, Button, Input, Select } from './ui';
import { fmtDate } from '../util/yangonTime';

/** Document type master (VMS §6.1) — served by /fleet/document-types. */
export interface FleetDocType {
  id: string;
  code: string;
  name: string;
  vehicleType?: string | null;
  mandatoryForDispatch: boolean;
  allowNoExpiry: boolean;
  warningDays: number[];
  active: boolean;
}

/** One document VERSION (VMS §6.2) + server-computed §6.3 status. */
export interface FleetDocRow {
  id: string;
  vehicleId: string;
  documentTypeId: string;
  documentNo?: string | null;
  issuingAuthority?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  renewalStatus: string;
  previousId?: string | null;
  supersededById?: string | null;
  notes?: string | null;
  attachmentId?: string | null;
  documentType: { id: string; code: string; name: string; mandatoryForDispatch: boolean; allowNoExpiry: boolean };
  attachment: { id: string; filename: string; mimeType: string; size: number } | null;
  /** false = superseded by a renewal (history row, immutable server-side) */
  current: boolean;
  status: 'EXPIRED' | 'DUE_TODAY' | 'UPCOMING' | 'VALID' | null;
  daysLeft: number | null;
}

export interface ComplianceViolation {
  kind: 'DOCUMENT' | 'DRIVER_LICENSE';
  docType?: string;
  reason: 'MISSING' | 'NO_EXPIRY_DATE' | 'EXPIRED';
  detail: string;
  daysLeft?: number;
}

const statusCls = (s?: string | null) =>
  s === 'EXPIRED' || s === 'DUE_TODAY' ? 'bg-red-50 text-red-700'
  : s === 'UPCOMING' ? 'bg-amber-50 text-amber-700'
  : 'bg-green-50 text-green-700';

const statusFlag = (s?: string | null) =>
  s === 'EXPIRED' ? ' ✕' : s === 'DUE_TODAY' ? ' TODAY' : s === 'UPCOMING' ? ' ⚠' : '';

const emptyForm = {
  documentTypeId: '', documentNo: '', issuingAuthority: '', issueDate: '', expiryDate: '',
  renewalStatus: 'NOT_STARTED', notes: '',
};

/**
 * Vehicle document register (VMS §6.2) — the panel Administration opens from
 * the Fleet table. Shows the §6.5 compliance verdict for THIS vehicle (the same
 * rules that block assign/dispatch), the current records + superseded history,
 * and add/edit/renew/delete with the renewal lineage handled server-side.
 */
export function FleetDocumentsModal({
  vehicle,
  onClose,
  onChanged,
}: {
  vehicle: { id: string; vehicleNo: string; brandModel: string };
  onClose: () => void;
  /** parent reloads the vehicle list (compliance chip changes with records) */
  onChanged: () => void;
}) {
  const canManage = hasPermission('fleet.manage');
  const [docs, setDocs] = useState<FleetDocRow[]>([]);
  const [violations, setViolations] = useState<ComplianceViolation[]>([]);
  const [types, setTypes] = useState<FleetDocType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'add' | 'edit' | 'renew' | null>(null);
  const [active, setActive] = useState<FleetDocRow | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const [d, c, t] = await Promise.all([
        api<FleetDocRow[]>(`/fleet/vehicles/${vehicle.id}/documents`),
        api<{ violations: ComplianceViolation[] }>(`/fleet/vehicles/${vehicle.id}/compliance`),
        api<FleetDocType[]>('/fleet/document-types'),
      ]);
      setDocs(d);
      setViolations(c.violations);
      setTypes(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load documents');
    }
  }, [vehicle.id]);

  useEffect(() => { reload(); }, [reload]);

  const openAdd = () => {
    setActive(null);
    setForm(emptyForm);
    setMode('add');
  };
  const openEdit = (d: FleetDocRow) => {
    setActive(d);
    setForm({
      documentTypeId: d.documentTypeId,
      documentNo: d.documentNo ?? '',
      issuingAuthority: d.issuingAuthority ?? '',
      issueDate: d.issueDate ? d.issueDate.slice(0, 10) : '',
      expiryDate: d.expiryDate ? d.expiryDate.slice(0, 10) : '',
      renewalStatus: d.renewalStatus,
      notes: d.notes ?? '',
    });
    setMode('edit');
  };
  const openRenew = (d: FleetDocRow) => {
    setActive(d);
    // renewal prefills the OLD record's reference data — only the new dates
    // and numbers change (the old row is never edited, spec §6.2)
    setForm({
      documentTypeId: d.documentTypeId,
      documentNo: d.documentNo ?? '',
      issuingAuthority: d.issuingAuthority ?? '',
      issueDate: '',
      expiryDate: '',
      renewalStatus: 'NOT_STARTED',
      notes: '',
    });
    setMode('renew');
  };

  const submit = async () => {
    setError(null);
    const opt = (v: string) => (v === '' ? undefined : v);
    try {
      if (mode === 'add') {
        await api(`/fleet/vehicles/${vehicle.id}/documents`, {
          method: 'POST',
          body: {
            documentTypeId: form.documentTypeId,
            documentNo: opt(form.documentNo),
            issuingAuthority: opt(form.issuingAuthority),
            issueDate: opt(form.issueDate),
            expiryDate: opt(form.expiryDate),
            renewalStatus: form.renewalStatus,
            notes: opt(form.notes),
          },
        });
        toast('Document added');
      } else if (mode === 'edit' && active) {
        await api(`/fleet/documents/${active.id}`, {
          method: 'PATCH',
          body: {
            documentNo: form.documentNo || null,
            issuingAuthority: form.issuingAuthority || null,
            issueDate: form.issueDate || null,
            // '' clears — the server rejects clearing a date the type requires
            expiryDate: form.expiryDate || null,
            renewalStatus: form.renewalStatus,
            notes: form.notes || null,
          },
        });
        toast('Document updated');
      } else if (mode === 'renew' && active) {
        await api(`/fleet/documents/${active.id}/renew`, {
          method: 'POST',
          body: {
            documentNo: opt(form.documentNo),
            issuingAuthority: opt(form.issuingAuthority),
            issueDate: opt(form.issueDate),
            expiryDate: opt(form.expiryDate),
            notes: opt(form.notes),
          },
        });
        toast('Renewed — new record supersedes the old one');
      }
      setMode(null);
      setActive(null);
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doDelete = async (id: string) => {
    setError(null);
    try {
      await api(`/fleet/documents/${id}`, { method: 'DELETE' });
      setConfirmDelete(null);
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  /** §6.2 attachment: upload the file, then point the record at it. */
  const attach = async (docId: string, file: File) => {
    setError(null);
    setUploading(docId);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const headers: Record<string, string> = {};
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch('/api/attachments/upload', { method: 'POST', headers, body: fd });
      const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok || !data.id) throw new Error(data.message ?? `Upload failed (${res.status})`);
      await api(`/fleet/documents/${docId}`, { method: 'PATCH', body: { attachmentId: data.id } });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const download = async (att: { id: string; filename: string }) => {
    try {
      const res = await fetch(`/api/attachments/${att.id}/download`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    }
  };

  // types still available for a NEW record (one current record per vehicle+type)
  const currentTypeIds = new Set(docs.filter((d) => d.current).map((d) => d.documentTypeId));
  const addableTypes = types.filter((t) => !currentTypeIds.has(t.id));
  const currentCount = docs.filter((d) => d.current).length;

  return (
    <Modal title={`Documents — ${vehicle.vehicleNo} ${vehicle.brandModel}`} onClose={onClose} error={error} wide>
      {/* §6.5 — the exact verdict that blocks assign/dispatch */}
      {violations.length > 0 && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
          <div className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">
            ⛔ Blocks assignment & dispatch
          </div>
          <ul className="text-sm text-red-700 space-y-0.5">
            {violations.map((v, i) => (
              <li key={i}>• {v.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {violations.length === 0 && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          ✓ Compliant — no mandatory document is missing or expired
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-500">
          {currentCount} current record{currentCount === 1 ? '' : 's'} · {docs.length - currentCount} in history
        </div>
        {canManage && mode === null && (
          <Button onClick={openAdd} disabled={addableTypes.length === 0} title={addableTypes.length === 0 ? 'Every configured document type already has a record — renew instead' : undefined}>
            + Add document
          </Button>
        )}
      </div>

      <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden mb-4">
        <thead>
          <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
            <th className="px-3 py-2 font-medium">Document</th>
            <th className="px-3 py-2 font-medium">Ref. no.</th>
            <th className="px-3 py-2 font-medium">Expiry</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 font-medium text-center">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {docs.length === 0 && (
            <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400 text-sm">No documents recorded yet</td></tr>
          )}
          {docs.map((d) => (
            <tr key={d.id} className={d.current ? 'hover:bg-gray-50' : 'bg-gray-50/60 text-gray-400'}>
              <td className="px-3 py-2">
                <div className="font-medium text-gray-800">
                  {d.current ? '' : '↳ '}{d.documentType.name}
                  {d.documentType.mandatoryForDispatch && (
                    <span className="ml-1.5 text-[10px] font-semibold text-red-600 border border-red-200 rounded px-1" title="Mandatory for dispatch (§6.5)">MANDATORY</span>
                  )}
                </div>
                {d.issuingAuthority && <div className="text-xs text-gray-400">{d.issuingAuthority}</div>}
                {!d.current && (
                  <div className="text-[10px] text-gray-400">
                    superseded · kept as history
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-xs">{d.documentNo ?? '—'}</td>
              <td className="px-3 py-2 whitespace-nowrap text-xs">
                {d.expiryDate ? (
                  <span className={`px-1.5 py-0.5 rounded-full font-medium ${d.current ? statusCls(d.status) : 'bg-gray-100 text-gray-500'}`}>
                    {fmtDate(d.expiryDate)}{d.current ? statusFlag(d.status) : ''}
                  </span>
                ) : (
                  <span className="text-gray-300">no expiry</span>
                )}
              </td>
              <td className="px-3 py-2">
                <Badge color={d.renewalStatus === 'RENEWED' ? 'gray' : d.renewalStatus === 'IN_PROGRESS' || d.renewalStatus === 'REQUESTED' ? 'yellow' : 'blue'}>
                  {d.renewalStatus.replace(/_/g, ' ')}
                </Badge>
                {d.attachment && (
                  <button className="block text-[11px] text-blue-600 hover:underline mt-1" onClick={() => download(d.attachment!)}>
                    📎 {d.attachment.filename}
                  </button>
                )}
              </td>
              <td className="px-3 py-2 text-center whitespace-nowrap text-xs">
                {canManage && d.current && mode === null && (
                  <>
                    <button className="text-blue-600 hover:underline mr-2" onClick={() => openEdit(d)}>Edit</button>
                    <button className="text-emerald-600 hover:underline mr-2" onClick={() => openRenew(d)}>Renew</button>
                    <button
                      className="text-amber-600 hover:underline mr-2"
                      onClick={() => fileRef.current && (fileRef.current.dataset.docId = d.id, fileRef.current.click())}
                      disabled={uploading === d.id}
                    >
                      {uploading === d.id ? '…' : '📎'}
                    </button>
                    {confirmDelete === d.id ? (
                      <span className="whitespace-nowrap">
                        <button className="text-red-700 font-semibold mr-1" onClick={() => doDelete(d.id)}>Sure?</button>
                        <button className="text-gray-400 mr-1" onClick={() => setConfirmDelete(null)}>no</button>
                      </span>
                    ) : (
                      <button className="text-red-600 hover:underline" onClick={() => setConfirmDelete(d.id)}>Delete</button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* hidden file picker — the 📎 button on a row targets that row's record */}
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const docId = e.target.dataset.docId;
          if (file && docId) attach(docId, file);
        }}
      />

      {mode && (
        <div className="border border-gray-200 rounded-lg p-4 bg-gray-50/60">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">
            {mode === 'add' ? 'Add document' : mode === 'edit' ? `Edit — ${active?.documentType.name}` : `Renew — ${active?.documentType.name}`}
          </h3>
          {mode === 'renew' && (
            <p className="text-xs text-gray-500 mb-3">
              A <b>new record</b> is created and the current one is kept as history (renewalStatus RENEWED) — the old expiry is never overwritten (spec §6.2).
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            {mode === 'add' && (
              <div className="col-span-2">
                <label htmlFor="fleet-doc-type" className="block text-xs text-gray-500 mb-1">Document type *</label>
                <Select id="fleet-doc-type" value={form.documentTypeId} onChange={(e) => setForm({ ...form, documentTypeId: e.target.value })}>
                  <option value="">— select type —</option>
                  {addableTypes.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}{t.vehicleType ? ` (${t.vehicleType})` : ''}</option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <label htmlFor="fleet-doc-no" className="block text-xs text-gray-500 mb-1">Reference no.</label>
              <Input id="fleet-doc-no" value={form.documentNo} onChange={(e) => setForm({ ...form, documentNo: e.target.value })} />
            </div>
            <div>
              <label htmlFor="fleet-doc-authority" className="block text-xs text-gray-500 mb-1">Issuing authority</label>
              <Input id="fleet-doc-authority" value={form.issuingAuthority} onChange={(e) => setForm({ ...form, issuingAuthority: e.target.value })} />
            </div>
            <div>
              <label htmlFor="fleet-doc-issue" className="block text-xs text-gray-500 mb-1">Issue date</label>
              <Input id="fleet-doc-issue" type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} />
            </div>
            <div>
              <label htmlFor="fleet-doc-expiry" className="block text-xs text-gray-500 mb-1">
                Expiry date {!currentTypeAllowsNoExpiry() && <span className="text-red-500">*</span>}
              </label>
              <Input id="fleet-doc-expiry" type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
            </div>
            {mode !== 'renew' && (
              <div>
                <label htmlFor="fleet-doc-state" className="block text-xs text-gray-500 mb-1">Renewal state</label>
                <Select id="fleet-doc-state" value={form.renewalStatus} onChange={(e) => setForm({ ...form, renewalStatus: e.target.value })}>
                  {['NOT_STARTED', 'REQUESTED', 'IN_PROGRESS', 'NOT_REQUIRED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </Select>
              </div>
            )}
            <div className="col-span-2">
              <label htmlFor="fleet-doc-notes" className="block text-xs text-gray-500 mb-1">Notes</label>
              <Input id="fleet-doc-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-3">
            <Button variant="ghost" onClick={() => { setMode(null); setActive(null); setError(null); }}>Cancel</Button>
            <Button
              onClick={submit}
              disabled={mode === 'add' && !form.documentTypeId}
            >
              {mode === 'renew' ? 'Renew (new record)' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );

  /** does the type being edited/added allow a blank expiry? (server enforces too) */
  function currentTypeAllowsNoExpiry(): boolean {
    const typeId = mode === 'add' ? form.documentTypeId : active?.documentTypeId;
    const t = types.find((x) => x.id === typeId);
    if (t) return t.allowNoExpiry;
    return active?.documentType.allowNoExpiry ?? false;
  }
}
