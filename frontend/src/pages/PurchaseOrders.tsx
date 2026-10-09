import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Textarea } from '../components/ui';
import { Modal } from '../components/Modal';
import { fmtDate } from '../util/yangonTime';
import { toast } from '../components/Toast';

// ---------------------------------------------------------------------------
// Purchase Orders + GRN receiving (Procurement design §15–20, phase P3).
// PO flow: create (DRAFT, from an APPROVED PR or ad-hoc) → approve → send to
// vendor → receive via GRN (partial deliveries OK) → fully received → close.
// GRN accepted consumable lines post stock IN into the inventory ledger.
// ---------------------------------------------------------------------------

interface PoItem {
  id: string;
  description: string;
  quantity: number;
  unit?: string | null;
  unitPrice: string;
  inventoryItemId?: string | null;
  inventoryItem?: { code: string; name: string; unit: string; balance: number } | null;
  grnItems?: { receivedQty: number; acceptedQty: number; rejectedQty: number }[];
}

interface PoDetail extends PoRow {
  createdById?: string;
  sentToVendorAt?: string | null;
  closedAt?: string | null;
  cancelledAt?: string | null;
  note?: string | null;
  grnRows?: {
    id: string;
    grnNumber: string;
    receivedAt: string;
    remarks?: string | null;
    items: { poItemId: string; receivedQty: number; acceptedQty: number; rejectedQty: number }[];
  }[];
}

interface PoRow {
  id: string;
  poNumber: string;
  status: string;
  orderDate: string;
  expectedDelivery?: string | null;
  supplier: { id: string; name: string };
  purchaseRequest?: { request: { id: string; docNumber: string; status: string } } | null;
  items: PoItem[];
}

interface Supplier {
  id: string;
  name: string;
}

interface InventoryItemOpt {
  id: string;
  code: string;
  name: string;
  unit: string;
  balance: number;
}

interface PrOption {
  id: string;
  docNumber: string;
  title?: string | null;
}

const PO_STATUS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'orange'> = {
  DRAFT: 'gray',
  APPROVED: 'blue',
  SENT_TO_VENDOR: 'yellow',
  PARTIALLY_RECEIVED: 'orange',
  FULLY_RECEIVED: 'green',
  CLOSED: 'gray',
  CANCELLED: 'red',
};

const money = (v: string | number) =>
  `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} Ks`;

interface LineDraft {
  inventoryItemId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
}

const emptyLine = (): LineDraft => ({ inventoryItemId: '', description: '', quantity: '1', unit: '', unitPrice: '' });

export default function PurchaseOrders() {
  const canManage = hasPermission('procurement.manage');
  const [pos, setPos] = useState<PoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItemOpt[]>([]);
  const [approvedPrs, setApprovedPrs] = useState<PrOption[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [prId, setPrId] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  const [detail, setDetail] = useState<PoDetail | null>(null);
  const [grnOpen, setGrnOpen] = useState(false);
  const [grnLines, setGrnLines] = useState<Record<string, { received: string; accepted: string; rejected: string; condition: string }>>({});
  const [grnRemarks, setGrnRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: PoRow[]; total: number }>(`/purchase-orders?page=${page}&pageSize=${PAGE_SIZE}`);
      setPos(r.items);
      setTotal(r.total);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load purchase orders', 'error');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!canManage) return;
    api<{ items: Supplier[] } | Supplier[]>('/suppliers?pageSize=200').then((r) => setSuppliers((r as { items?: Supplier[] }).items ?? (r as Supplier[]))).catch(() => undefined);
    api<{ items: InventoryItemOpt[] }>('/inventory/items?pageSize=500').then((r) => setInventoryItems(r.items ?? [])).catch(() => undefined);
    api<{ items: ({ id: string; docNumber: string; title?: string | null } | PrOption)[] }>('/procurement/requests?status=APPROVED&pageSize=50')
      .then((r) => setApprovedPrs((r as { items?: PrOption[] }).items ?? []))
      .catch(() => undefined);
  }, [canManage]);

  const openCreate = () => {
    setSupplierId('');
    setPrId('');
    setExpectedDelivery('');
    setNote('');
    setLines([emptyLine()]);
    setCreateOpen(true);
  };

  const pickItem = (idx: number, itemId: string) => {
    const item = inventoryItems.find((i) => i.id === itemId);
    setLines((ls) =>
      ls.map((l, i) =>
        i === idx
          ? {
              ...l,
              inventoryItemId: itemId,
              description: item ? `${item.name} (${item.code})` : l.description,
              unit: item?.unit ?? l.unit,
            }
          : l,
      ),
    );
  };

  const estimatedTotal = () =>
    lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);

  const createPo = async () => {
    if (!supplierId) { toast('Pick a supplier', 'error'); return; }
    const items = lines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        inventoryItemId: l.inventoryItemId || undefined,
        quantity: Number(l.quantity) || 0,
        unit: l.unit.trim() || undefined,
        unitPrice: Number(l.unitPrice) || 0,
      }));
    if (items.length === 0) { toast('At least one item is required', 'error'); return; }
    if (items.some((i) => !i.quantity || i.unitPrice < 0)) { toast('Check quantities and prices', 'error'); return; }
    setBusy(true);
    try {
      await api('/purchase-orders', {
        method: 'POST',
        body: {
          supplierId,
          purchaseRequestId: prId || undefined,
          expectedDelivery: expectedDelivery || undefined,
          note: note.trim() || undefined,
          items,
        },
      });
      toast('Purchase order created (DRAFT)');
      setCreateOpen(false);
      setPage(1);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the PO', 'error');
    } finally {
      setBusy(false);
    }
  };

  const transition = async (po: PoDetail | PoRow, action: 'approve' | 'send' | 'close' | 'cancel') => {
    setBusy(true);
    try {
      await api(`/purchase-orders/${po.id}/${action}`, { method: 'POST' });
      toast(`PO ${po.poNumber} ${action === 'send' ? 'sent to vendor' : action + 'd'}`);
      setDetail(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not ${action}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (po: PoRow) => {
    try {
      const r = await api<PoDetail>(`/purchase-orders/${po.id}`);
      setDetail(r);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the PO', 'error');
    }
  };

  const receivedFor = (it: PoItem) => (it.grnItems ?? []).reduce((s, g) => s + g.acceptedQty, 0);

  const grnDefaults = (d: PoDetail) => {
    const state: Record<string, { received: string; accepted: string; rejected: string; condition: string }> = {};
    for (const it of d.items) {
      const remaining = Math.max(0, it.quantity - receivedFor(it));
      state[it.id] = { received: String(remaining), accepted: String(remaining), rejected: '0', condition: '' };
    }
    return state;
  };

  const openGrn = () => {
    if (!detail) return;
    setGrnLines(grnDefaults(detail));
    setGrnRemarks('');
    setGrnOpen(true);
  };

  const openGrnFromRow = async (po: PoRow) => {
    try {
      const r = await api<PoDetail>(`/purchase-orders/${po.id}`);
      setDetail(r);
      setGrnLines(grnDefaults(r));
      setGrnRemarks('');
      setGrnOpen(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the PO', 'error');
    }
  };

  const submitGrn = async () => {
    if (!detail) return;
    const items = detail.items
      .map((it: PoItem) => ({
        poItemId: it.id,
        receivedQty: Number(grnLines[it.id]?.received ?? 0),
        acceptedQty: Number(grnLines[it.id]?.accepted ?? 0),
        rejectedQty: Number(grnLines[it.id]?.rejected ?? 0),
        condition: grnLines[it.id]?.condition.trim() || undefined,
      }))
      .filter((g) => g.receivedQty > 0 || g.acceptedQty > 0 || g.rejectedQty > 0);
    if (items.length === 0) { toast('Nothing received', 'error'); return; }
    for (const g of items) {
      if (g.acceptedQty + g.rejectedQty !== g.receivedQty) {
        toast('Accepted + rejected must equal received on every line', 'error');
        return;
      }
    }
    setBusy(true);
    try {
      const r = await api<{ poStatus: string; grnNumber: string }>(`/purchase-orders/${detail.id}/grn`, {
        method: 'POST',
        body: { remarks: grnRemarks.trim() || undefined, items },
      });
      toast(`GRN ${r.grnNumber} recorded — PO is now ${r.poStatus.replace(/_/g, ' ').toLowerCase()}`);
      setGrnOpen(false);
      setDetail(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record the GRN', 'error');
    } finally {
      setBusy(false);
    }
  };

  const nextQuality = (po: PoRow) => {
    const canReceive = canManage && ['SENT_TO_VENDOR', 'PARTIALLY_RECEIVED'].includes(po.status);
    if (canReceive) return '📥 Record GRN';
    if (po.status === 'SENT_TO_VENDOR' || po.status === 'PARTIALLY_RECEIVED') return 'Receive';
    return null;
  };

  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        subtitle="PO issuance and goods receiving (GRN) — approved purchase requests become orders"
        actions={canManage ? <Button onClick={openCreate}>+ New purchase order</Button> : undefined}
      />

      <Card>
        {loading ? (
          <Empty label="Loading…" />
        ) : pos.length === 0 ? (
          <Empty label="No purchase orders yet — create one from an approved PR" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-2 pr-2">PO</th>
                <th className="py-2 pr-2">Supplier</th>
                <th className="py-2 pr-2">From PR</th>
                <th className="py-2 pr-2">Lines</th>
                <th className="py-2 pr-2">Total</th>
                <th className="py-2 pr-2">Status</th>
                <th className="py-2 pr-2">Ordered</th>
                <th className="py-2 pr-2"></th>
              </tr>
            </thead>
            <tbody>
              {pos.map((po) => {
                const tot = po.items.reduce((s, i) => s + i.quantity * Number(i.unitPrice), 0);
                const quality = nextQuality(po);
                return (
                  <tr key={po.id} className="border-b last:border-0 hover:bg-gray-50 cursor-pointer" onClick={() => openDetail(po)}>
                    <td className="py-2 pr-2 font-medium">{po.poNumber}</td>
                    <td className="py-2 pr-2">{po.supplier.name}</td>
                    <td className="py-2 pr-2">{po.purchaseRequest ? po.purchaseRequest.request.docNumber : '—'}</td>
                    <td className="py-2 pr-2">{po.items.length}</td>
                    <td className="py-2 pr-2">{money(tot)}</td>
                    <td className="py-2 pr-2"><Badge color={PO_STATUS[po.status] ?? 'gray'}>{po.status.replace(/_/g, ' ')}</Badge></td>
                    <td className="py-2 pr-2">{fmtDate(po.orderDate)}</td>
                    <td className="py-2 pr-2 text-right" onClick={(e) => e.stopPropagation()}>
                      {quality && canManage && (
                        <Button variant="ghost" onClick={quality === '📥 Record GRN' ? () => openGrnFromRow(po) : undefined}>{quality}</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {total > PAGE_SIZE && (
          <div className="flex gap-2 justify-center mt-3">
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</Button>
            <span className="text-sm text-gray-500 self-center">Page {page} / {Math.ceil(total / PAGE_SIZE)}</span>
            <Button disabled={page * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Next ›</Button>
          </div>
        )}
      </Card>

      {/* ---------------- create PO ---------------- */}
      {createOpen && (
        <Modal onClose={() => setCreateOpen(false)} title="New purchase order" wide>
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-gray-600">Supplier *</span>
                <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">— pick a supplier —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">From approved PR (optional)</span>
                <Select value={prId} onChange={(e) => setPrId(e.target.value)}>
                  <option value="">— ad-hoc / direct purchase —</option>
                  {approvedPrs.map((p) => <option key={p.id} value={p.id}>{p.docNumber}{p.title ? ` — ${p.title}` : ''}</option>)}
                </Select>
              </label>
            </div>
            <label className="block text-sm">
              <span className="text-gray-600">Expected delivery</span>
              <Input type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} />
            </label>

            <div className="border rounded p-2 space-y-2">
              <div className="text-sm font-medium text-gray-600">Items — pick an inventory item only for stock (consumable) goods</div>
              {lines.map((l, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-end">
                  <label className="col-span-4 block text-sm">
                    <span className="text-gray-600">Inventory item (optional)</span>
                    <Select value={l.inventoryItemId} onChange={(e) => pickItem(idx, e.target.value)}>
                      <option value="">— asset / service (no stock) —</option>
                      {inventoryItems.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name} ({i.balance} {i.unit})</option>)}
                    </Select>
                  </label>
                  <label className="col-span-3 block text-sm">
                    <span className="text-gray-600">Description *</span>
                    <Input value={l.description} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, description: e.target.value } : x))} />
                  </label>
                  <label className="col-span-1 block text-sm">
                    <span className="text-gray-600">Qty *</span>
                    <Input type="number" min={1} value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, quantity: e.target.value } : x))} />
                  </label>
                  <label className="col-span-1 block text-sm">
                    <span className="text-gray-600">Unit</span>
                    <Input value={l.unit} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, unit: e.target.value } : x))} />
                  </label>
                  <label className="col-span-2 block text-sm">
                    <span className="text-gray-600">Unit price (Ks) *</span>
                    <Input type="number" min={0} value={l.unitPrice} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, unitPrice: e.target.value } : x))} />
                  </label>
                  <div className="col-span-1">
                    <Button variant="danger" onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))} disabled={lines.length <= 1}>✕</Button>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <Button variant="ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Add line</Button>
                <div className="text-sm text-gray-600">Estimated total: <b>{money(estimatedTotal())}</b></div>
              </div>
            </div>

            <label className="block text-sm">
              <span className="text-gray-600">Note</span>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button disabled={busy} onClick={createPo}>Create PO (DRAFT)</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---------------- PO detail + actions ---------------- */}
      {detail && !grnOpen && (
        <Modal onClose={() => setDetail(null)} title={`${detail.poNumber} — ${detail.supplier.name}`} wide>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={PO_STATUS[detail.status] ?? 'gray'}>{detail.status.replace(/_/g, ' ')}</Badge>
              {detail.purchaseRequest && (
                <span className="text-sm text-gray-500">PR: {detail.purchaseRequest.request.docNumber}</span>
              )}
              <span className="text-sm text-gray-500">Ordered {fmtDate(detail.orderDate)}</span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-1 pr-2">Item</th>
                  <th className="py-1 pr-2">Stock?</th>
                  <th className="py-1 pr-2 text-right">Ordered</th>
                  <th className="py-1 pr-2 text-right">Received</th>
                  <th className="py-1 pr-2 text-right">Unit price</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map((it) => {
                  const rec = receivedFor(it);
                  return (
                    <tr key={it.id} className="border-b last:border-0">
                      <td className="py-1 pr-2">{it.description}</td>
                      <td className="py-1 pr-2">{it.inventoryItem ? '📦 stock' : '—'}</td>
                      <td className="py-1 pr-2 text-right">{it.quantity}{it.unit ? ` ${it.unit}` : ''}</td>
                      <td className={`py-1 pr-2 text-right ${rec >= it.quantity ? 'text-green-600' : rec > 0 ? 'text-orange-600' : ''}`}>{rec}</td>
                      <td className="py-1 pr-2 text-right">{money(it.unitPrice)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {(detail.grnRows?.length ?? 0) > 0 && (
              <div className="text-sm text-gray-600 space-y-1">
                <div className="font-medium">Goods received notes</div>
                {detail.grnRows!.map((g) => (
                  <div key={g.id}>
                    • {g.grnNumber} — {fmtDate(g.receivedAt)} —{' '}
                    {g.items.reduce((s, i) => s + i.acceptedQty, 0)} accepted / {g.items.reduce((s, i) => s + i.rejectedQty, 0)} rejected
                  </div>
                ))}
              </div>
            )}

            {canManage && (
              <div className="flex flex-wrap gap-2 justify-end pt-2 border-t">
                {detail.status === 'DRAFT' && <Button disabled={busy} onClick={() => transition(detail, 'approve')}>Approve</Button>}
                {detail.status === 'APPROVED' && <Button disabled={busy} onClick={() => transition(detail, 'send')}>Send to vendor</Button>}
                {['SENT_TO_VENDOR', 'PARTIALLY_RECEIVED'].includes(detail.status) && <Button disabled={busy} onClick={openGrn}>📥 Record GRN</Button>}
                {detail.status === 'FULLY_RECEIVED' && <Button disabled={busy} onClick={() => transition(detail, 'close')}>Close PO</Button>}
                {['DRAFT', 'APPROVED', 'SENT_TO_VENDOR'].includes(detail.status) && (
                  <Button variant="danger" disabled={busy} onClick={() => transition(detail, 'cancel')}>Cancel PO</Button>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ---------------- GRN entry ---------------- */}
      {grnOpen && detail && (
        <Modal onClose={() => setGrnOpen(false)} title={`Record GRN — ${detail.poNumber}`}>
          <div className="space-y-3">
            <div className="text-sm text-gray-600">
              Accepted stock quantities post straight into the inventory ledger. 📦 lines are stock items; plain lines are assets/services (no stock).
            </div>
            {detail.items.map((it) => {
              const g = grnLines[it.id] ?? { received: '0', accepted: '0', rejected: '0', condition: '' };
              return (
                <div key={it.id} className="border rounded p-2">
                  <div className="flex justify-between text-sm mb-1">
                    <span>{it.description}</span>
                    <span className="text-gray-500">{receivedFor(it)}/{it.quantity} accepted so far</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <label className="text-sm">
                      <span className="text-gray-600">Received</span>
                      <Input type="number" min={0} value={g.received} onChange={(e) => setGrnLines((s) => ({ ...s, [it.id]: { ...g, received: e.target.value } }))} />
                    </label>
                    <label className="text-sm">
                      <span className="text-gray-600">Accepted</span>
                      <Input type="number" min={0} value={g.accepted} onChange={(e) => setGrnLines((s) => ({ ...s, [it.id]: { ...g, accepted: e.target.value } }))} />
                    </label>
                    <label className="text-sm">
                      <span className="text-gray-600">Rejected</span>
                      <Input type="number" min={0} value={g.rejected} onChange={(e) => setGrnLines((s) => ({ ...s, [it.id]: { ...g, rejected: e.target.value } }))} />
                    </label>
                    <label className="text-sm">
                      <span className="text-gray-600">Condition notes</span>
                      <Input value={g.condition} onChange={(e) => setGrnLines((s) => ({ ...s, [it.id]: { ...g, condition: e.target.value } }))} />
                    </label>
                  </div>
                </div>
              );
            })}
            <label className="block text-sm">
              <span className="text-gray-600">Remarks</span>
              <Textarea rows={2} value={grnRemarks} onChange={(e) => setGrnRemarks(e.target.value)} />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setGrnOpen(false)}>Cancel</Button>
              <Button disabled={busy} onClick={submitGrn}>Record GRN & post stock</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
