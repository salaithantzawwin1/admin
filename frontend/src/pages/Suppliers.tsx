import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';
import { Badge, Button, Card, Empty, Input, PageHeader, Textarea } from '../components/ui';

interface Supplier {
  id: string;
  name: string;
  phone?: string | null;
  address?: string | null;
  note?: string | null;
  isActive: boolean;
  createdAt: string;
}

interface HistoryData {
  supplier: { id: string; name: string };
  totalCost: number;
  items: { name: string; unit: string; qty: number; cost: number }[];
  recent: { id: string; quantity: number; unitPrice?: string | null; reference?: string | null; createdAt: string; item: { name: string } }[];
}

const fmtMoney = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState<Partial<Supplier> | null>(null);
  const [deleting, setDeleting] = useState<Supplier | null>(null);
  const [historyFor, setHistoryFor] = useState<Supplier | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [modalError, setModalError] = useState('');
  const [error, setError] = useState('');
  const canManage = hasPermission('inventory.manage') || hasPermission('suppliers.manage');

  const load = useCallback(() => {
    api<Supplier[]>(`/suppliers${showInactive ? '?all=1' : ''}`).then(setSuppliers).catch(() => setSuppliers([]));
  }, [showInactive]);
  useEffect(load, [load]);

  const save = async () => {
    if (!form?.name?.trim()) return;
    setModalError('');
    try {
      const body = { name: form.name, phone: form.phone || undefined, address: form.address || undefined, note: form.note || undefined };
      if (form.id) {
        await api(`/suppliers/${form.id}`, { method: 'PATCH', body: { ...body, isActive: form.isActive } });
        toast('Supplier updated');
      } else {
        await api('/suppliers', { method: 'POST', body });
        toast('Supplier created');
      }
      setForm(null);
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doDelete = async (s: Supplier) => {
    setError('');
    try {
      await api(`/suppliers/${s.id}`, { method: 'DELETE' });
      toast('Supplier deleted');
      setDeleting(null);
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Delete failed');
      setDeleting(null);
    }
  };

  const openHistory = async (s: Supplier) => {
    setHistoryFor(s);
    setHistory(null);
    try {
      setHistory(await api<HistoryData>(`/suppliers/${s.id}/history`));
    } catch {
      setHistoryFor(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Suppliers"
        subtitle="Vendor master data — shared by Inventory purchases today and by future Purchasing / Fleet maintenance modules"
        actions={
          canManage ? (
            <Button onClick={() => { setForm({ name: '', phone: '', address: '', note: '', isActive: true }); setModalError(''); }}>+ Supplier</Button>
          ) : undefined
        }
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <Card className="mb-5 p-5">
        <div className="flex items-center justify-between mb-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show deactivated
          </label>
          <span className="text-xs text-gray-400">{suppliers?.filter((s) => s.isActive).length ?? 0} active supplier(s)</span>
        </div>

        {suppliers === null ? (
          <div className="text-sm text-gray-400 py-4">Loading…</div>
        ) : suppliers.length === 0 ? (
          <Empty label="No suppliers yet — add one to attach purchases to a source" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Address</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {suppliers.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{s.name}{!s.isActive && ' (inactive)'}</td>
                  <td className="px-4 py-3 text-gray-500">{s.phone || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 truncate max-w-xs">{s.address || '—'}</td>
                  <td className="px-4 py-3">
                    <Badge color={s.isActive ? 'green' : 'gray'}>{s.isActive ? 'ACTIVE' : 'INACTIVE'}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button className="text-blue-600 hover:underline mr-3" onClick={() => openHistory(s)}>History</button>
                    {canManage && (
                      <>
                        <button className="text-blue-600 hover:underline mr-3" onClick={() => { setForm({ ...s }); setModalError(''); }}>Edit</button>
                        <button className="text-red-600 hover:underline" onClick={() => setDeleting(s)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {form && (
        <Modal title={form.id ? `Edit supplier — ${form.name}` : 'New supplier'} error={modalError} onClose={() => { setForm(null); setModalError(''); }}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Supplier name *</label>
              <Input placeholder="e.g. Shwe Yangon Trading" value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Phone</label>
              <Input placeholder="09-xxx" value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Address</label>
              <Input placeholder="Address" value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Note</label>
              <Textarea rows={2} placeholder="Note (optional)" value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            {form.id && (
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={form.isActive ?? true} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                Active (shows in the restock dropdown)
              </label>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
              <Button onClick={save} disabled={!form.name?.trim()}>{form.id ? 'Save' : 'Create'}</Button>
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete supplier ${deleting.name}?`}
          description="Suppliers with purchase history cannot be deleted (deactivate instead). This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => { await doDelete(deleting); }}
          onClose={() => { setDeleting(null); setModalError(''); }}
        />
      )}

      {historyFor && (
        <Modal title={`Purchase history — ${historyFor.name}`} onClose={() => setHistoryFor(null)}>
          {!history ? (
            <div className="text-sm text-gray-400 py-4">Loading…</div>
          ) : (
            <div className="space-y-4">
              <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 text-sm">
                Lifetime purchases: <span className="font-semibold">{fmtMoney(history.totalCost)}</span> across {history.items.length} item(s)
              </div>
              {history.items.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                      <th className="px-2 py-2 font-medium">Item</th>
                      <th className="px-2 py-2 font-medium">Qty</th>
                      <th className="px-2 py-2 font-medium text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {history.items.map((i) => (
                      <tr key={i.name}>
                        <td className="px-2 py-2 font-medium">{i.name}</td>
                        <td className="px-2 py-2 text-gray-500">{i.qty} {i.unit}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(i.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {history.recent.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Recent purchases</h3>
                  <div className="space-y-1 max-h-48 overflow-auto">
                    {history.recent.map((t) => (
                      <div key={t.id} className="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1.5 flex justify-between">
                        <span>{t.item.name} · {t.quantity}{t.unitPrice ? ` @ ${fmtMoney(Number(t.unitPrice))}` : ''}</span>
                        <span className="text-gray-400">{new Date(t.createdAt).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
