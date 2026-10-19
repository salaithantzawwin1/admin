import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, hasPermission, getToken } from '../api';
import { PageHeader, Card, Button, Input, Select, Table, Empty, Badge } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface AssetRow {
  id: string;
  assetCode: string;
  name: string;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  custodian?: string | null;
  purchaseDate?: string | null;
  purchaseCost?: string | null;
  status: 'ACTIVE' | 'IN_STORAGE' | 'MAINTENANCE' | 'DISPOSED';
  description?: string | null;
  category?: { id: string; name: string } | null;
  location?: { id: string; name: string } | null;
}

interface MovementRow {
  id: string;
  type: string;
  note?: string | null;
  createdAt: string;
  fromLocation?: { name: string } | null;
  toLocation?: { name: string } | null;
  createdBy?: { username: string } | null;
}

interface AssetDetail extends AssetRow {
  movements: MovementRow[];
  poItems: { purchaseOrder: { poNumber: string; supplier: { name: string } } }[];
}

interface Category { id: string; name: string }
interface Location { id: string; name: string }

const STATUS_COLORS: Record<string, 'green' | 'gray' | 'yellow' | 'red'> = {
  ACTIVE: 'green', IN_STORAGE: 'gray', MAINTENANCE: 'yellow', DISPOSED: 'red',
};

const emptyForm = {
  name: '', assetCode: '', categoryId: '', brand: '', model: '', serialNumber: '',
  custodian: '', locationId: '', purchaseDate: '', purchaseCost: '', description: '',
};

export default function Assets() {
  const canManage = hasPermission('assets.manage');
  const [rows, setRows] = useState<AssetRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // modals
  const [form, setForm] = useState<(typeof emptyForm & { id?: string }) | null>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [transfer, setTransfer] = useState<{ id: string; name: string; toLocationId: string; custodian: string; note: string } | null>(null);
  const [toDelete, setToDelete] = useState<AssetRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (categoryId) params.set('categoryId', categoryId);
      if (locationId) params.set('locationId', locationId);
      if (status) params.set('status', status);
      const data = await api<AssetRow[]>(`/assets?${params.toString()}`);
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load assets');
    } finally {
      setLoading(false);
    }
  }, [q, categoryId, locationId, status]);

  useEffect(() => { void load(); }, [load]);

  // pickers (once)
  useEffect(() => {
    void (async () => {
      try {
        const [cats, locs] = await Promise.all([
          api<Category[]>('/procurement/asset-categories'),
          api<Location[]>('/procurement/asset-locations'),
        ]);
        setCategories(cats);
        setLocations(locs);
      } catch {
        // pickers degrade to empty — the form still works without them
      }
    })();
  }, []);

  const openDetail = async (id: string) => {
    try {
      setDetail(await api<AssetDetail>(`/assets/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load asset');
    }
  };

  const submitForm = async () => {
    if (!form) return;
    const body: Record<string, unknown> = {
      name: form.name,
      assetCode: form.assetCode || undefined,
      categoryId: form.categoryId || undefined,
      brand: form.brand || undefined,
      model: form.model || undefined,
      serialNumber: form.serialNumber || undefined,
      custodian: form.custodian || undefined,
      locationId: form.locationId || undefined,
      purchaseDate: form.purchaseDate || undefined,
      purchaseCost: form.purchaseCost === '' ? undefined : Number(form.purchaseCost),
      description: form.description || undefined,
    };
    if (form.id) {
      await api(`/assets/${form.id}`, { method: 'PATCH', body });
    } else {
      await api('/assets', { method: 'POST', body });
    }
    setForm(null);
    await load();
  };

  const submitTransfer = async () => {
    if (!transfer) return;
    await api(`/assets/${transfer.id}/transfer`, {
      method: 'POST',
      body: {
        toLocationId: transfer.toLocationId || undefined,
        custodian: transfer.custodian || undefined,
        note: transfer.note || undefined,
      },
    });
    setTransfer(null);
    await load();
  };

  const downloadCsv = async () => {
    try {
      const res = await fetch('/api/assets/csv', { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `asset-register-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const statusBadge = (s: string) => <Badge color={STATUS_COLORS[s] ?? 'gray'}>{s}</Badge>;
  const totalCost = useMemo(
    () => rows.reduce((sum, r) => sum + (r.purchaseCost ? Number(r.purchaseCost) : 0), 0),
    [rows],
  );

  return (
    <div>
      <PageHeader
        title="Asset Register"
        subtitle={`${rows.length} asset(s) · book value MMK ${totalCost.toLocaleString()}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => void downloadCsv()}>⬇ CSV</Button>
            {canManage && <Button onClick={() => setForm({ ...emptyForm })}>+ New asset</Button>}
          </>
        }
      />

      {/* filters */}
      <Card className="p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Input placeholder="Search code / name / serial / custodian" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="IN_STORAGE">IN STORAGE</option>
            <option value="MAINTENANCE">MAINTENANCE</option>
            <option value="DISPOSED">DISPOSED</option>
          </Select>
        </div>
      </Card>

      {error && !form && !detail && !transfer && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>
      )}

      <Table head={['CODE', 'NAME', 'CATEGORY', 'SERIAL', 'CUSTODIAN', 'LOCATION', 'STATUS', 'COST (MMK)', 'ACTIONS']}>
        {loading ? (
          <tr><td colSpan={9}><Empty label="Loading…" /></td></tr>
        ) : rows.length === 0 ? (
          <tr><td colSpan={9}><Empty label="No assets match the filters" /></td></tr>
        ) : rows.map((a) => (
          <tr key={a.id} className="hover:bg-gray-50/60">
            <td className="px-4 py-2.5 font-medium text-gray-900">{a.assetCode}</td>
            <td className="px-4 py-2.5">{a.name}</td>
            <td className="px-4 py-2.5">{a.category?.name ?? '—'}</td>
            <td className="px-4 py-2.5 font-mono text-xs">{a.serialNumber ?? '—'}</td>
            <td className="px-4 py-2.5">{a.custodian ?? '—'}</td>
            <td className="px-4 py-2.5">{a.location?.name ?? '—'}</td>
            <td className="px-4 py-2.5">{statusBadge(a.status)}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{a.purchaseCost ? Number(a.purchaseCost).toLocaleString() : '—'}</td>
            <td className="px-4 py-2.5">
              <div className="flex flex-wrap gap-1.5">
                <Button variant="ghost" onClick={() => void openDetail(a.id)}>View</Button>
                {canManage && a.status !== 'DISPOSED' && (
                  <Button variant="ghost" onClick={() => setTransfer({ id: a.id, name: a.name, toLocationId: a.location?.id ?? '', custodian: a.custodian ?? '', note: '' })}>
                    Transfer
                  </Button>
                )}
                {canManage && (
                  <>
                    <Button variant="ghost" onClick={() => setForm({
                      ...emptyForm, id: a.id, name: a.name, assetCode: a.assetCode,
                      categoryId: a.category?.id ?? '', brand: a.brand ?? '', model: a.model ?? '',
                      serialNumber: a.serialNumber ?? '', custodian: a.custodian ?? '',
                      locationId: a.location?.id ?? '',
                      purchaseDate: a.purchaseDate ? a.purchaseDate.slice(0, 10) : '',
                      purchaseCost: a.purchaseCost ?? '', description: a.description ?? '',
                    })}>Edit</Button>
                    <Button variant="danger" onClick={() => setToDelete(a)}>Delete</Button>
                  </>
                )}
              </div>
            </td>
          </tr>
        ))}
      </Table>

      {/* create / edit */}
      {form && (
        <Modal title={form.id ? 'Edit asset' : 'New asset'} onClose={() => setForm(null)} error={error} wide>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Name *</label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Dell OptiPlex 7090" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Asset code</label>
              <Input value={form.assetCode} onChange={(e) => setForm({ ...form, assetCode: e.target.value })} placeholder="Leave blank → auto AST-…" describe="Custom code must be unique" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
              <Select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">— none —</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Location</label>
              <Select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                <option value="">— none —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Brand</label>
              <Input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Model</label>
              <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Serial number</label>
              <Input value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Custodian</label>
              <Input value={form.custodian} onChange={(e) => setForm({ ...form, custodian: e.target.value })} placeholder="Person / department" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Purchase date</label>
              <Input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Purchase cost (MMK)</label>
              <Input type="number" min={0} value={form.purchaseCost} onChange={(e) => setForm({ ...form, purchaseCost: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button disabled={!form.name.trim()} onClick={() => void submitForm()}>{form.id ? 'Save' : 'Create'}</Button>
          </div>
        </Modal>
      )}

      {/* detail with movement history (§16/§40) */}
      {detail && (
        <Modal title={`${detail.assetCode} — ${detail.name}`} onClose={() => setDetail(null)} wide>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm mb-4">
            <div><span className="text-gray-400 text-xs block">Status</span>{statusBadge(detail.status)}</div>
            <div><span className="text-gray-400 text-xs block">Category</span>{detail.category?.name ?? '—'}</div>
            <div><span className="text-gray-400 text-xs block">Location</span>{detail.location?.name ?? '—'}</div>
            <div><span className="text-gray-400 text-xs block">Custodian</span>{detail.custodian ?? '—'}</div>
            <div><span className="text-gray-400 text-xs block">Serial</span><span className="font-mono text-xs">{detail.serialNumber ?? '—'}</span></div>
            <div><span className="text-gray-400 text-xs block">Cost</span>{detail.purchaseCost ? Number(detail.purchaseCost).toLocaleString() : '—'}</div>
            <div><span className="text-gray-400 text-xs block">Brand / Model</span>{[detail.brand, detail.model].filter(Boolean).join(' / ') || '—'}</div>
            <div><span className="text-gray-400 text-xs block">Purchase date</span>{detail.purchaseDate ? detail.purchaseDate.slice(0, 10) : '—'}</div>
            <div><span className="text-gray-400 text-xs block">Acquired via</span>{detail.poItems.map((p) => p.purchaseOrder.poNumber).join(', ') || '—'}</div>
          </div>
          {detail.description && <p className="text-sm text-gray-600 mb-4">{detail.description}</p>}
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Movement history</h3>
          {detail.movements.length === 0 ? (
            <Empty label="No movements recorded" />
          ) : (
            <ul className="divide-y divide-gray-100 text-sm">
              {detail.movements.map((m) => (
                <li key={m.id} className="py-2 flex items-start justify-between gap-3">
                  <div>
                    <span className="font-medium text-gray-800">{m.type}</span>
                    <span className="text-gray-500">
                      {m.fromLocation?.name || m.toLocation?.name
                        ? ` — ${m.fromLocation?.name ?? '—'} → ${m.toLocation?.name ?? '—'}`
                        : ''}
                    </span>
                    {m.note && <div className="text-xs text-gray-400">{m.note}</div>}
                  </div>
                  <div className="text-right text-xs text-gray-400 shrink-0">
                    <div>{m.createdAt.slice(0, 10)}</div>
                    <div>{m.createdBy?.username}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}

      {/* transfer (§40) */}
      {transfer && (
        <Modal title={`Transfer — ${transfer.name}`} onClose={() => setTransfer(null)} error={error}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">New location</label>
              <Select value={transfer.toLocationId} onChange={(e) => setTransfer({ ...transfer, toLocationId: e.target.value })}>
                <option value="">— keep current —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Custodian</label>
              <Input value={transfer.custodian} onChange={(e) => setTransfer({ ...transfer, custodian: e.target.value })} placeholder="Person / department taking custody" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Note</label>
              <Input value={transfer.note} onChange={(e) => setTransfer({ ...transfer, note: e.target.value })} placeholder="Reason for the move" />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setTransfer(null)}>Cancel</Button>
            <Button onClick={() => void submitTransfer()}>Transfer</Button>
          </div>
        </Modal>
      )}

      {/* delete — §66: procurement-linked assets are refused by the API */}
      {toDelete && (
        <ConfirmDialog
          title={`Delete ${toDelete.assetCode}?`}
          description="Only unused assets can be deleted. Assets with procurement history must be set to DISPOSED instead (the delete API enforces this)."
          variant="danger"
          confirmLabel="Delete"
          onClose={() => setToDelete(null)}
          onConfirm={async () => {
            await api(`/assets/${toDelete.id}`, { method: 'DELETE' });
            setToDelete(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
