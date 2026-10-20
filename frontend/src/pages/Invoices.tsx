import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Textarea } from '../components/ui';
import { Modal } from '../components/Modal';
import { fmtDate } from '../util/yangonTime';
import { toast } from '../components/Toast';

// ---------------------------------------------------------------------------
// Invoices (Procurement design §22–25, phase P7 / roadmap R6).
// Vendor bills carry PO + optional GRN refs; submitting runs the §23 three-way
// match (persisted on the invoice) and Controls 3/4 guard the transition;
// Control 5 blocks duplicate vendor bill numbers at the backend.
// Lifecycle: DRAFT → SUBMITTED → APPROVED → POSTED (REJECTED can redraft).
// ---------------------------------------------------------------------------

interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unit?: string | null;
  unitPrice: string;
  accountId?: string | null;
  assetId?: string | null;
}

interface MatchLine {
  description: string;
  invoiceQty: number;
  invoiceUnitPrice: number;
  orderedQty: number;
  grnAcceptedQty: number;
  poUnitPrice: number;
  priceOk: boolean;
  invoiceTooHigh: boolean;
  billedBeyondReceived: boolean;
  status: 'MATCHED' | 'PARTIAL_MATCH' | 'MISMATCH';
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  supplierInvoiceNumber: string;
  status: string;
  invoiceDate: string;
  dueDate?: string | null;
  subtotal: string | number;
  tax: string | number;
  total: string | number;
  paidAmount: string | number; // W1 rollup — Σ payments (maintained with every payment write)
  paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  matchStatus?: string | null;
  matchDetail?: { lines?: MatchLine[] } | null;
  note?: string | null;
  supplier: { id: string; name: string };
  purchaseOrder?: { id: string; poNumber: string; status: string } | null;
  goodsReceipt?: { id: string; grnNumber: string; receivedAt: string } | null;
  createdBy?: { fullName?: string | null } | null;
  createdAt: string;
  items: InvoiceItem[];
}

interface Supplier {
  id: string;
  name: string;
}

interface PoOption {
  id: string;
  poNumber: string;
  items: { description: string; quantity: number; unit?: string | null; unitPrice: string }[];
}

interface AccountOpt {
  id: string;
  name: string;
  code?: string | null;
}

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'orange'> = {
  DRAFT: 'gray',
  SUBMITTED: 'yellow',
  APPROVED: 'blue',
  POSTED: 'green',
  REJECTED: 'red',
  CANCELLED: 'gray',
};

const MATCH_COLORS: Record<string, 'gray' | 'green' | 'red' | 'orange'> = {
  MATCHED: 'green',
  PARTIAL_MATCH: 'orange',
  MISMATCH: 'red',
  NO_MATCH: 'gray',
};

const PAY_COLORS: Record<string, 'gray' | 'yellow' | 'green'> = {
  UNPAID: 'gray',
  PARTIALLY_PAID: 'yellow',
  PAID: 'green',
};

const money = (v: string | number) =>
  `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} Ks`;

interface LineDraft {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  accountId: string;
}

const emptyLine = (): LineDraft => ({ description: '', quantity: '1', unit: '', unitPrice: '', accountId: '' });

export default function Invoices() {
  const canManage = hasPermission('procurement.manage');
  const [rows, setRows] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [pos, setPos] = useState<PoOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState(false);

  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: Invoice[]; total: number }>(`/invoices?page=${page}&pageSize=${PAGE_SIZE}`);
      setRows(r.items);
      setTotal(r.total);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load invoices', 'error');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!canManage) return;
    api<{ items: Supplier[] } | Supplier[]>('/suppliers?pageSize=200')
      .then((r) => setSuppliers((r as { items?: Supplier[] }).items ?? (r as Supplier[])))
      .catch(() => undefined);
    api<{ items: PoOption[] }>('/purchase-orders?pageSize=100').then((r) => setPos(r.items ?? [])).catch(() => undefined);
    api<AccountOpt[]>('/procurement/accounts').then(setAccounts).catch(() => undefined);
  }, [canManage]);

  const openDetail = async (inv: Invoice) => {
    try {
      const r = await api<Invoice>(`/invoices/${inv.id}`);
      setDetail(r);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the invoice', 'error');
    }
  };

  const transition = async (inv: Invoice, action: string, done?: () => void) => {
    setBusy(true);
    try {
      const r = await api<{ matchStatus?: string | null }>(`/invoices/${inv.id}/${action}`, { method: 'POST' });
      toast(`Invoice ${inv.invoiceNumber} ${action}${r.matchStatus ? ` — match: ${r.matchStatus}` : ''}`);
      setDetail(null);
      done?.();
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not ${action}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const ACTIONS_PER_STATUS: Record<string, string[]> = {
    DRAFT: ['submit', 'cancel'],
    SUBMITTED: ['approve', 'reject'],
    REJECTED: ['redraft'],
    APPROVED: ['post', 'cancel'],
  };

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle="Vendor bills with three-way matching (§23) — controls: GRN check, PO amount, duplicate bill"
        actions={canManage ? <Button onClick={() => setCreateOpen(true)}>+ New invoice</Button> : undefined}
      />

      <Card>
        {loading ? (
          <Empty label="Loading…" />
        ) : rows.length === 0 ? (
          <Empty label="No invoices yet — record a vendor bill against a PO" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3 font-medium">Invoice</th>
                <th className="px-4 py-3 font-medium">Bill # (vendor)</th>
                <th className="px-4 py-3 font-medium">Supplier</th>
                <th className="px-4 py-3 font-medium">PO</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Match</th>
                <th className="px-4 py-3 font-medium">Payment</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => openDetail(inv)}>
                  <td className="px-4 py-3 font-medium">{inv.invoiceNumber}</td>
                  <td className="px-4 py-3 text-gray-500">{inv.supplierInvoiceNumber}</td>
                  <td className="px-4 py-3">{inv.supplier.name}</td>
                  <td className="px-4 py-3 text-gray-500">{inv.purchaseOrder?.poNumber ?? '—'}</td>
                  <td className="px-4 py-3">{money(inv.total)}</td>
                  <td className="px-4 py-3">
                    {inv.matchStatus ? (
                      <Badge color={MATCH_COLORS[inv.matchStatus] ?? 'gray'}>{inv.matchStatus.replace(/_/g, ' ')}</Badge>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={PAY_COLORS[inv.paymentStatus] ?? 'gray'}>{(inv.paymentStatus ?? 'UNPAID').replace(/_/g, ' ')}</Badge>
                    {Number(inv.paidAmount ?? 0) > 0 && inv.paymentStatus !== 'PAID' && (
                      <div className="text-xs text-gray-400 mt-0.5 tabular-nums">bal {money(Number(inv.total) - Number(inv.paidAmount))}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={STATUS_COLORS[inv.status] ?? 'gray'}>{inv.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(inv.invoiceDate)}</td>
                </tr>
              ))}
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

      {createOpen && (
        <NewInvoiceModal
          suppliers={suppliers}
          pos={pos}
          accounts={accounts}
          onClose={() => setCreateOpen(false)}
          onDone={load}
        />
      )}

      {detail && (
        <Modal onClose={() => setDetail(null)} title={`${detail.invoiceNumber} — ${detail.supplier.name}`} wide xl>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={STATUS_COLORS[detail.status] ?? 'gray'}>{detail.status}</Badge>
              <Badge color={PAY_COLORS[detail.paymentStatus] ?? 'gray'}>
                Payment: {(detail.paymentStatus ?? 'UNPAID').replace(/_/g, ' ')}{Number(detail.paidAmount ?? 0) > 0 ? ` — ${money(detail.paidAmount)} paid` : ''}
              </Badge>
              {detail.matchStatus && (
                <Badge color={MATCH_COLORS[detail.matchStatus] ?? 'gray'}>Match: {detail.matchStatus.replace(/_/g, ' ')}</Badge>
              )}
              <span className="text-sm text-gray-500">Bill #{detail.supplierInvoiceNumber}</span>
              {detail.purchaseOrder && <span className="text-sm text-gray-500">PO: {detail.purchaseOrder.poNumber}</span>}
              {detail.goodsReceipt && <span className="text-sm text-gray-500">GRN: {detail.goodsReceipt.grnNumber}</span>}
              <span className="text-sm text-gray-500">{fmtDate(detail.invoiceDate)}</span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-2 py-2 font-medium">Description</th>
                  <th className="px-2 py-2 font-medium text-right">Qty</th>
                  <th className="px-2 py-2 font-medium text-right">Unit price</th>
                  <th className="px-2 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {detail.items.map((it) => (
                  <tr key={it.id}>
                    <td className="px-2 py-2">{it.description}</td>
                    <td className="px-2 py-2 text-right">{it.quantity}{it.unit ? ` ${it.unit}` : ''}</td>
                    <td className="px-2 py-2 text-right">{money(it.unitPrice)}</td>
                    <td className="px-2 py-2 text-right">{money(Number(it.quantity) * Number(it.unitPrice))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t">
                  <td colSpan={3} className="px-2 py-1 text-right text-gray-500">Subtotal</td>
                  <td className="px-2 py-1 text-right">{money(detail.subtotal)}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="px-2 py-1 text-right text-gray-500">Tax</td>
                  <td className="px-2 py-1 text-right">{money(detail.tax)}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="px-2 py-1 text-right font-medium">Total</td>
                  <td className="px-2 py-1 text-right font-medium">{money(detail.total)}</td>
                </tr>
              </tfoot>
            </table>

            {detail.matchDetail?.lines && detail.matchDetail.lines.length > 0 && (
              <div className="border border-gray-200 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Three-way match (§23)</div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="py-1 pr-2">Line</th>
                      <th className="py-1 pr-2 text-right">Billed</th>
                      <th className="py-1 pr-2 text-right">GRN ok'd</th>
                      <th className="py-1 pr-2 text-right">Ordered</th>
                      <th className="py-1 pr-2 text-right">PO price</th>
                      <th className="py-1 pr-2">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.matchDetail.lines.map((l, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-1 pr-2">{l.description}</td>
                        <td className="py-1 pr-2 text-right">{l.invoiceQty}</td>
                        <td className="py-1 pr-2 text-right">{l.grnAcceptedQty}</td>
                        <td className="py-1 pr-2 text-right">{l.orderedQty}</td>
                        <td className="py-1 pr-2 text-right">{money(l.poUnitPrice)}</td>
                        <td className="py-1 pr-2">
                          <Badge color={l.status === 'MATCHED' ? 'green' : l.status === 'MISMATCH' ? 'red' : 'orange'}>{l.status.replace(/_/g, ' ')}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {canManage && ACTIONS_PER_STATUS[detail.status] && (
              <div className={`flex gap-2 sticky bottom-0 -mx-5 px-5 py-3 bg-white border-t border-gray-100 rounded-b-xl`}>
                {ACTIONS_PER_STATUS[detail.status].map((a) => (
                  <Button
                    key={a}
                    disabled={busy}
                    variant={a === 'reject' || a === 'cancel' ? 'danger' : 'primary'}
                    onClick={() => transition(detail, a)}
                  >
                    {a.charAt(0).toUpperCase() + a.slice(1)}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function NewInvoiceModal({
  suppliers,
  pos,
  accounts,
  onClose,
  onDone,
}: {
  suppliers: Supplier[];
  pos: PoOption[];
  accounts: AccountOpt[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [supplierId, setSupplierId] = useState('');
  const [billNo, setBillNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [poId, setPoId] = useState('');
  const [tax, setTax] = useState('0');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (andSubmit: boolean) => {
    setError('');
    if (!supplierId) { setError('Pick a supplier'); return; }
    if (!billNo.trim()) { setError("The vendor's bill number is required (duplicate check control)"); return; }
    const items = lines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity) || 0,
        unit: l.unit.trim() || undefined,
        unitPrice: Number(l.unitPrice) || 0,
        accountId: l.accountId || undefined,
      }));
    if (items.length === 0) { setError('At least one line is required'); return; }
    if (items.some((i) => i.quantity < 1)) { setError('Check line quantities'); return; }
    setBusy(true);
    try {
      const r = await api<{ invoiceNumber: string; matchStatus?: string | null }>(andSubmit ? '/invoices/create-and-submit' : '/invoices', {
        method: 'POST',
        body: {
          supplierId,
          supplierInvoiceNumber: billNo.trim(),
          invoiceDate,
          dueDate: dueDate || undefined,
          purchaseOrderId: poId || undefined,
          tax: Number(tax) || 0,
          note: note.trim() || undefined,
          items,
        },
      });
      toast(`Invoice ${r.invoiceNumber}${andSubmit ? ` submitted — match: ${r.matchStatus ?? '—'}` : ' saved as draft'}`);
      onClose();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  };

  const setLine = (idx: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  // picking a PO pre-fills the first line from the PO data (helpful default,
  // vendor bills mirror the PO lines in this organisation's process)
  const onPoPick = (id: string) => {
    setPoId(id);
    if (!id) return;
    const po = pos.find((p) => p.id === id);
    if (!po || po.items.length === 0) return;
    setLines(
      po.items.map((it) => ({
        description: it.description,
        quantity: String(it.quantity),
        unit: it.unit ?? '',
        unitPrice: String(Number(it.unitPrice)),
        accountId: '',
      })),
    );
  };

  const subtotal = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);

  return (
    <Modal title="New invoice" error={error} wide xl onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="inv-supplier" className="text-xs text-gray-500 block mb-1">Supplier *</label>
            <Select id="inv-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— pick a supplier —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="inv-billno" className="text-xs text-gray-500 block mb-1">Vendor's bill number * (duplicate check)</label>
            <Input id="inv-billno" value={billNo} onChange={(e) => setBillNo(e.target.value)} placeholder="e.g. V-BILL-2026-100" />
          </div>
          <div>
            <label htmlFor="inv-date" className="text-xs text-gray-500 block mb-1">Invoice date</label>
            <Input id="inv-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="inv-due" className="text-xs text-gray-500 block mb-1">Due date (optional)</label>
            <Input id="inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="inv-po" className="text-xs text-gray-500 block mb-1">Related PO (optional — starts the 3-way match)</label>
            <Select id="inv-po" value={poId} onChange={(e) => onPoPick(e.target.value)}>
              <option value="">— none (service / direct bill) —</option>
              {pos.map((p) => <option key={p.id} value={p.id}>{p.poNumber}</option>)}
            </Select>
          </div>
        </div>

        <div className="border border-gray-200 rounded-lg p-3 space-y-2">
          <div className="hidden md:grid grid-cols-12 gap-2 text-xs text-gray-500 px-1">
            <div className="col-span-4">Description *</div>
            <div className="col-span-2">Qty *</div>
            <div className="col-span-1">Unit</div>
            <div className="col-span-2">Unit price (Ks) *</div>
            <div className="col-span-2">Account</div>
            <div className="col-span-1 text-right" aria-hidden="true" />
          </div>
          {lines.map((l, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-start">
              <div className="col-span-12 md:col-span-4">
                <Input placeholder={`Line ${idx + 1} description *`} value={l.description} onChange={(e) => setLine(idx, { description: e.target.value })} />
              </div>
              <div className="col-span-3 md:col-span-2">
                <Input type="number" min={1} placeholder="Qty" title="Quantity" value={l.quantity} onChange={(e) => setLine(idx, { quantity: e.target.value })} />
              </div>
              <div className="col-span-3 md:col-span-1">
                <Input placeholder="Unit" value={l.unit} onChange={(e) => setLine(idx, { unit: e.target.value })} />
              </div>
              <div className="col-span-6 md:col-span-2">
                <Input type="number" min={0} placeholder="Unit price (Ks)" title="Unit price in Kyat" value={l.unitPrice} onChange={(e) => setLine(idx, { unitPrice: e.target.value })} />
              </div>
              <div className="col-span-6 md:col-span-2">
                <Select value={l.accountId} onChange={(e) => setLine(idx, { accountId: e.target.value })}>
                  <option value="">Account…</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} — ` : ''}{a.name}</option>)}
                </Select>
              </div>
              <div className="col-span-12 md:col-span-1 flex justify-end">
                <Button variant="danger" title={`Remove line ${idx + 1}`} onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, i) => i !== idx) : ls))}>✕</Button>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Add line</Button>
            <div className="text-sm text-gray-600">Subtotal: <b>{money(subtotal)}</b></div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="inv-tax" className="text-xs text-gray-500 block mb-1">Tax (Ks)</label>
            <Input id="inv-tax" type="number" min={0} value={tax} onChange={(e) => setTax(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="inv-note" className="text-xs text-gray-500 block mb-1">Note</label>
            <Input id="inv-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        <div className="sticky bottom-0 -mx-5 px-5 py-3 flex flex-wrap gap-2 justify-end bg-white border-t border-gray-100 rounded-b-xl">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => submit(false)}>{busy ? 'Saving…' : 'Save as Draft'}</Button>
          <Button disabled={busy} onClick={() => submit(true)}>{busy ? 'Submitting…' : 'Create & Submit (runs 3-way match)'}</Button>
        </div>
      </div>
    </Modal>
  );
}
