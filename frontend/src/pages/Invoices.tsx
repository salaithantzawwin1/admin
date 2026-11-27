import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Textarea } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
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
  /** list payload only: how many bill papers are attached */
  _count?: { attachments: number } | null;
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
  /** detail payload (v2 P1-1): money actually paid against this bill */
  payments?: PaymentRow[];
  /** detail payload (v2 P1-1): petty-cash expenses that settled it */
  pettyCashExpenses?: PettyCashExpenseRow[];
}

interface PaymentRow {
  id: string;
  paymentNumber: string;
  date: string;
  amount: string | number;
  method: string;
  reference?: string | null;
  note?: string | null;
  fundingSource?: string | null;
  payerName?: string | null;
  pettyCashTransactionId?: string | null;
  createdBy?: { fullName?: string | null; username?: string | null } | null;
}

interface PettyCashExpenseRow {
  id: string;
  code: string;
  date: string;
  amount: string | number;
  payee?: string | null;
  payment?: { paymentNumber: string } | null;
}

interface LinkableExpense {
  id: string;
  code: string;
  date: string;
  amount: string | number;
  payee?: string | null;
  description?: string | null;
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
  // full AP view (supplier visible, transitions available) — mirrors the
  // procurement.* gates; invoices.read alone gets the read-only, masked view
  const canSeeSupplier = hasPermission('procurement.read') || canManage;
  const canViewInvoices = canSeeSupplier || hasPermission('invoices.read');
  // a 403 on the list call means the server now enforces a revocation the
  // stored session has not caught up with yet (stale tab) — lock card, not an
  // empty "No invoices yet" table
  const [listDenied, setListDenied] = useState(false);
  const showInvoices = canViewInvoices && !listDenied;
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [detailTab, setDetailTab] = useState<'details' | 'attachments'>('details');
  const [attachmentCount, setAttachmentCount] = useState<number | null>(null);

  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: Invoice[]; total: number }>(`/invoices?page=${page}&pageSize=${PAGE_SIZE}`);
      setRows(r.items);
      setTotal(r.total);
      setListDenied(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setListDenied(true);
      else toast(e instanceof Error ? e.message : 'Could not load invoices', 'error');
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
      setDetailTab('details');
      setAttachmentCount(null);
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
        subtitle={
          canSeeSupplier
            ? 'Vendor bills with three-way matching (§23) — controls: GRN check, PO amount, duplicate bill'
            : 'Read-only AP view — supplier identity is hidden and approval/posting stays with Procurement'
        }
        actions={canManage ? <Button onClick={() => setCreateOpen(true)}>+ New invoice</Button> : undefined}
      />

      {/* procurement.read gate — mirrors the backend gates (see GET /invoices). */}
      {!showInvoices && (
        <Card className="mb-5 p-8 text-center">
          <div className="text-3xl mb-2">🔒</div>
          <p className="text-sm text-gray-700 font-medium">You do not have permission to view invoices.</p>
          <p className="text-xs text-gray-400 mt-1">"View invoices" requires the Procurement or Invoices (AP) permission, which was revoked from your role in the RBAC permission matrix.</p>
        </Card>
      )}

      {showInvoices && (
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
                {/* the vendor's own bill no is vendor identity: the API masks it and
                    the column is dropped entirely for the masked view (Payments
                    shows no bill-no column for the same reason) */}
                {canSeeSupplier && <th className="px-4 py-3 font-medium">Bill # (vendor)</th>}
                <th className="px-4 py-3 font-medium">Supplier</th>
                <th className="px-4 py-3 font-medium">PO</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Match</th>
                <th className="px-4 py-3 font-medium">Payment</th>
                <th className="px-4 py-3 font-medium text-center">Status</th>
                <th className="px-4 py-3 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => openDetail(inv)}>
                  <td className="px-4 py-3 font-medium whitespace-nowrap">
                    {inv.invoiceNumber}
                    {inv.status === 'POSTED' && (inv._count?.attachments ?? 0) === 0 && (
                      <span
                        title="POSTED bill has no attachment yet"
                        className="ml-2 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-medium text-amber-800"
                      >
                        📎 no bill
                      </span>
                    )}
                  </td>
                  {canSeeSupplier && <td className="px-4 py-3 text-gray-500">{inv.supplierInvoiceNumber}</td>}
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
                  <td className="px-4 py-3 text-center">
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
      )}

      {createOpen && (
        <NewInvoiceModal
          suppliers={suppliers}
          pos={pos}
          accounts={accounts}
          onClose={() => setCreateOpen(false)}
          onDone={load}
        />
      )}

      {detail && confirmDelete && (
        <ConfirmDialog
          title={`Delete ${detail.invoiceNumber}?`}
          description={`Removes the cancelled bill from ${detail.supplier.name} (${money(detail.total)}) and its lines. Payments and asset costs booked from it block the delete. This cannot be undone.`}
          confirmLabel="Delete invoice"
          variant="danger"
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await api(`/invoices/${detail.id}`, { method: 'DELETE' });
            toast(`Invoice ${detail.invoiceNumber} deleted`);
            setConfirmDelete(false);
            setDetail(null);
            load();
          }}
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
              {canSeeSupplier && <span className="text-sm text-gray-500">Bill #{detail.supplierInvoiceNumber}</span>}
              {detail.purchaseOrder && <span className="text-sm text-gray-500">PO: {detail.purchaseOrder.poNumber}</span>}
              {detail.goodsReceipt && <span className="text-sm text-gray-500">GRN: {detail.goodsReceipt.grnNumber}</span>}
              <span className="text-sm text-gray-500">Dated {fmtDate(detail.invoiceDate)}</span>
              {detail.dueDate && <span className="text-sm text-gray-500">Due {fmtDate(detail.dueDate)}</span>}
            </div>

            <div role="tablist" aria-label="Invoice detail" className="flex gap-1 border-b border-gray-200">
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'details'}
                className={`shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  detailTab === 'details'
                    ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                }`}
                onClick={() => setDetailTab('details')}
              >
                Details
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'attachments'}
                className={`shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  detailTab === 'attachments'
                    ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                }`}
                onClick={() => setDetailTab('attachments')}
              >
                Bill attachments
                {attachmentCount !== null && (
                  <span
                    title={attachmentCount === 0 ? 'No bill attached yet' : `${attachmentCount} file(s) attached`}
                    className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      attachmentCount === 0 ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {attachmentCount === 0 ? '0 · missing' : attachmentCount}
                  </span>
                )}
              </button>
            </div>

            <div className={detailTab === 'details' ? 'space-y-3' : 'hidden'}>
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

            <PaymentPanel
              invoice={detail}
              canManage={canManage}
              onChanged={async () => { setDetail(await api<Invoice>(`/invoices/${detail.id}`)); load(); }}
            />

            </div>

            <div className={detailTab === 'attachments' ? 'space-y-3' : 'hidden'}>
              <InvoiceAttachments
                invoiceId={detail.id}
                status={detail.status}
                canManage={canManage}
                onChanged={async () => {
                  setDetail(await api<Invoice>(`/invoices/${detail.id}`));
                }}
                onCount={setAttachmentCount}
              />
            </div>

            {canManage && detail.status === 'CANCELLED' && (
              <div className="flex gap-2 sticky bottom-0 -mx-5 px-5 py-3 bg-white border-t border-gray-100 rounded-b-xl">
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete invoice</Button>
                <span className="text-xs text-gray-400 self-center">A cancelled bill can be removed from the register</span>
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

// ---------------------------------------------------------------------------
// Bill papers: the vendor's bill photo/PDF and supporting documents, stored by
// the shared attachments module (type/size/magic-byte checked, 0600 on disk,
// served only through the guarded download route). POSTED invoices are frozen:
// the paper is part of the audit trail, so upload/remove disappear then.
// ---------------------------------------------------------------------------

interface InvoiceAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

function InvoiceAttachments({
  invoiceId, status, canManage, onChanged, onCount,
}: {
  invoiceId: string;
  status: string;
  canManage: boolean;
  onChanged: () => Promise<void>;
  onCount?: (count: number) => void;
}) {
  const [items, setItems] = useState<InvoiceAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toDelete, setToDelete] = useState<InvoiceAttachment | null>(null);
  const posted = status === 'POSTED';

  const refresh = useCallback(async () => {
    const rows = await api<InvoiceAttachment[]>(`/attachments/invoice/${invoiceId}`);
    setItems(rows);
    onCount?.(rows.length);
  }, [invoiceId, onCount]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refresh()
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load attachments'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refresh]);

  const upload = async (file: File) => {
    setError('');
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large (max 10 MB)');
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`/api/attachments/upload?invoiceId=${invoiceId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
        body,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
        throw new Error(typeof msg === 'string' ? msg : `Upload failed (${res.status})`);
      }
      toast('Attachment uploaded');
      await refresh();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload the file');
    } finally {
      setBusy(false);
    }
  };

  /** The download route needs the bearer token, so the file is fetched as a blob. */
  const download = async (a: InvoiceAttachment) => {
    setError('');
    try {
      const res = await fetch(`/api/attachments/${a.id}/download`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = a.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download the file');
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Bill attachments ({items.length})</div>
        {canManage && (
          <label className={`text-sm px-3 py-1.5 rounded-lg cursor-pointer border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
            {busy ? 'Uploading…' : '+ Attach photo / PDF'}
            <input
              type="file"
              className="hidden"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.currentTarget.value = '';
                if (f) void upload(f);
              }}
            />
          </label>
        )}
      </div>
      {posted && (
        <p className="text-xs text-gray-400 mb-2">This bill is POSTED — attached files are part of the audit trail and can no longer be removed. You can still attach supporting documents.</p>
      )}
      {error && <div className="text-sm text-red-600 bg-red-50 rounded px-3 py-2 mb-2">{error}</div>}
      {loading ? (
        <Empty label="Loading…" />
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-400 py-2">No bill attached yet — add the vendor's bill photo or PDF.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="text-gray-800 break-all">{a.filename}</span>
              <span className="text-xs text-gray-400">{a.size < 1024 ? '<1 KB' : `${(a.size / 1024).toFixed(0)} KB`} · {fmtDate(a.createdAt)}</span>
              <span className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={() => void download(a)}>Download</Button>
                {canManage && !posted && (
                  <Button variant="danger" onClick={() => setToDelete(a)}>Remove</Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {toDelete && (
        <ConfirmDialog
          title={`Remove ${toDelete.filename}?`}
          description="The file is deleted from the invoice and from storage. Attach it again if this was a mistake."
          confirmLabel="Remove file"
          variant="danger"
          onClose={() => setToDelete(null)}
          onConfirm={async () => {
            try {
              await api(`/attachments/${toDelete.id}`, { method: 'DELETE' });
              toast('Attachment removed');
              setToDelete(null);
              await refresh();
              await onChanged();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not remove the file');
              setToDelete(null);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Payment to supplier (v2 P1-1).
 *
 * Payment status is derived from the payment ledger, never typed — so this
 * panel only shows what the ledger says and offers the one action the office
 * actually needs: linking the petty-cash expense that already paid the shop.
 * A wrongly linked expense is corrected by deleting it on the Petty Cash
 * screen (audited), not by editing money here.
 */
const SOURCE_LABELS: Record<string, string> = {
  PETTY_CASH: 'Petty cash',
  COMPANY_CASH: 'Company cash',
  COMPANY_BANK: 'Company bank',
};

function PaymentPanel({
  invoice,
  canManage,
  onChanged,
}: {
  invoice: Invoice;
  canManage: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LinkableExpense[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // v2 P1-2 — company cash / bank payments recorded straight from the bill
  const canPay = hasPermission('payments.manage');
  const [recOpen, setRecOpen] = useState(false);
  const [recError, setRecError] = useState('');
  const [recBusy, setRecBusy] = useState(false);
  const [recDuplicate, setRecDuplicate] = useState<Record<string, unknown> | null>(null);
  const [rec, setRec] = useState({
    amount: '', date: '', method: 'BANK_TRANSFER', fundingSource: 'COMPANY_BANK',
    payerName: '', reference: '',
  });

  const paid = Number(invoice.paidAmount ?? 0);
  const total = Number(invoice.total ?? 0);
  const outstanding = total - paid;
  const payments = invoice.payments ?? [];
  const closed = invoice.status === 'CANCELLED' || invoice.status === 'REJECTED';
  // mirrors POST /petty-cash/:id/link-invoice (pettycash.manage or payments.manage):
  // the Finance user who owns the cash can link, without procurement.manage
  const canLink = (canManage || canPay || hasPermission('pettycash.manage')) && !closed && outstanding > 0.009;
  const canRecord = canPay && !closed && outstanding > 0.009;

  const openRecord = () => {
    setRec({
      amount: String(outstanding), date: new Date().toISOString().slice(0, 10),
      method: 'BANK_TRANSFER', fundingSource: 'COMPANY_BANK', payerName: '', reference: '',
    });
    setRecError('');
    setRecOpen(true);
  };

  const recordPayload = () => ({
    invoiceId: invoice.id,
    amount: Number(rec.amount),
    date: rec.date || undefined,
    method: rec.method,
    fundingSource: rec.fundingSource,
    payerName: rec.payerName || undefined,
    reference: rec.reference || undefined,
  });

  const record = async () => {
    setRecBusy(true);
    setRecError('');
    try {
      await api('/payments', { method: 'POST', body: recordPayload() });
      toast('Payment recorded');
      setRecOpen(false);
      await onChanged();
    } catch (e) {
      // BR-15 — the same payment twice is a question, not a refusal
      const code = e instanceof ApiError ? (e.details as { code?: string } | undefined)?.code : undefined;
      if (code === 'DUPLICATE_PAYMENT') {
        setRecDuplicate(recordPayload());
        return;
      }
      setRecError(e instanceof Error ? e.message : 'Could not record the payment');
    } finally {
      setRecBusy(false);
    }
  };

  const openLink = async () => {
    setOpen(true);
    setPicked('');
    setError('');
    setLoading(true);
    try {
      const r = await api<{ items: LinkableExpense[] }>(`/petty-cash/linkable/${invoice.id}`);
      setItems(r.items ?? []);
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : 'Could not load petty-cash expenses');
    } finally {
      setLoading(false);
    }
  };

  const pickedRow = items.find((i) => i.id === picked);
  const overBalance = Boolean(pickedRow) && Number(pickedRow?.amount ?? 0) > outstanding + 0.01;

  const link = async () => {
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ paymentNumber: string }>(`/petty-cash/${picked}/link-invoice`, {
        method: 'POST',
        body: { invoiceId: invoice.id },
      });
      toast(`Linked — payment ${r.paymentNumber} recorded against ${invoice.invoiceNumber}`);
      setOpen(false);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link the expense');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Payment to supplier</div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-500">Paid <span className="font-medium text-gray-900 tabular-nums">{money(paid)}</span></span>
          <span className="text-gray-500">Outstanding <span className={`font-medium tabular-nums ${outstanding > 0.009 ? 'text-orange-700' : 'text-green-700'}`}>{money(outstanding)}</span></span>
          {canRecord && <Button onClick={openRecord}>+ Record payment</Button>}
          {canLink && <Button variant="ghost" onClick={() => void openLink()}>Link petty-cash expense</Button>}
        </div>
      </div>

      {payments.length === 0 ? (
        <p className="text-sm text-gray-500">
          No payment recorded yet. If the shop was already paid from petty cash, link that expense; otherwise the bill stays{' '}
          <span className="font-medium">UNPAID</span>.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b">
              <th className="py-1 pr-2 font-medium">Payment</th>
              <th className="py-1 pr-2 font-medium">Date</th>
              <th className="py-1 pr-2 font-medium">Source</th>
              <th className="py-1 pr-2 font-medium">Method</th>
              <th className="py-1 pr-2 font-medium text-right">Amount</th>
              <th className="py-1 pr-2 font-medium">Note</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b last:border-0">
                <td className="py-1 pr-2 font-medium text-gray-900">{p.paymentNumber}</td>
                <td className="py-1 pr-2">{fmtDate(p.date)}</td>
                <td className="py-1 pr-2">
                  {p.fundingSource ? (SOURCE_LABELS[p.fundingSource] ?? p.fundingSource) : <span className="text-gray-400">—</span>}
                </td>
                <td className="py-1 pr-2">{p.method.replace(/_/g, ' ')}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{money(p.amount)}</td>
                <td className="py-1 pr-2 max-w-[240px] truncate" title={p.note ?? ''}>
                  {p.note ?? p.reference ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(invoice.pettyCashExpenses?.length ?? 0) > 0 && (
        <p className="text-xs text-gray-500">
          Linked petty-cash expenses:{' '}
          {invoice.pettyCashExpenses!.map((e) => `${e.code}${e.payment ? ` → ${e.payment.paymentNumber}` : ' (unlinked)'}`).join(', ')}
        </p>
      )}

      {open && (
        <Modal title={`Link a petty-cash expense to ${invoice.invoiceNumber}`} onClose={() => setOpen(false)} error={error}>
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Only expenses with no bill attached are listed. Linking records the payment and marks this bill paid; the
              expense itself is unchanged.
            </p>
            {loading ? (
              <Empty label="Loading…" />
            ) : items.length === 0 ? (
              <Empty label="No unlinked petty-cash expense for this supplier" />
            ) : (
              <div className="max-h-64 overflow-y-auto divide-y divide-gray-100 border border-gray-200 rounded-lg">
                {items.map((e) => {
                  const tooBig = Number(e.amount) > outstanding + 0.01;
                  return (
                    <label
                      key={e.id}
                      className={`flex items-start gap-2 p-2 text-sm ${tooBig ? 'opacity-60' : 'cursor-pointer hover:bg-gray-50'}`}
                    >
                      <input
                        type="radio"
                        name="linkable-expense"
                        className="mt-1"
                        disabled={tooBig}
                        checked={picked === e.id}
                        onChange={() => setPicked(e.id)}
                      />
                      <span className="flex-1">
                        <span className="font-medium text-gray-900">{e.code}</span>
                        <span className="text-gray-500"> · {fmtDate(e.date)} · {money(e.amount)} MMK</span>
                        <span className="block text-xs text-gray-500">
                          {e.payee ?? '—'}{e.description ? ` — ${e.description}` : ''}
                          {tooBig ? ' · more than the outstanding balance' : ''}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {overBalance && (
              <p className="text-xs text-red-600">
                The selected expense is larger than the outstanding balance (MMK {money(outstanding)}).
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!picked || busy || overBalance} onClick={() => void link()}>
              {busy ? 'Linking…' : 'Link and mark paid'}
            </Button>
          </div>
        </Modal>
      )}

      {/* v2 P1-2 — company cash / bank payment against this bill */}
      {recOpen && (
        <Modal title={`Record a payment against ${invoice.invoiceNumber}`} onClose={() => setRecOpen(false)} error={recError}>
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Outstanding: <span className="font-medium">{money(outstanding)} MMK</span>. Petty-cash money is not
              recorded here — link the expense that paid the shop instead.
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Amount (MMK) *</label>
              <Input
                type="number" min={0.01} step="0.01" value={rec.amount}
                onChange={(e) => setRec({ ...rec, amount: e.target.value })}
                error={Number(rec.amount) > outstanding ? `More than the balance due (${money(outstanding)} Ks) — the server rejects an over-payment.` : undefined}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Paid from *</label>
                <Select value={rec.fundingSource} onChange={(e) => setRec({ ...rec, fundingSource: e.target.value })}>
                  <option value="COMPANY_BANK">Company bank</option>
                  <option value="COMPANY_CASH">Company cash</option>
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Method *</label>
                <Select value={rec.method} onChange={(e) => setRec({ ...rec, method: e.target.value })}>
                  {['BANK_TRANSFER', 'CASH', 'CHEQUE', 'OTHER'].map((m) => (
                    <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
                <Input type="date" value={rec.date} onChange={(e) => setRec({ ...rec, date: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Paid by</label>
                <Input value={rec.payerName} onChange={(e) => setRec({ ...rec, payerName: e.target.value })} placeholder="Who handed the money over" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Reference</label>
              <Input value={rec.reference} onChange={(e) => setRec({ ...rec, reference: e.target.value })} placeholder="Transaction ref / cheque no." />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setRecOpen(false)}>Cancel</Button>
            <Button disabled={!rec.amount || Number(rec.amount) <= 0 || recBusy} onClick={() => void record()}>
              {recBusy ? 'Recording…' : 'Record payment'}
            </Button>
          </div>
        </Modal>
      )}

      {recDuplicate && (
        <ConfirmDialog
          title="Record this payment again?"
          description={`MMK ${money(Number(recDuplicate.amount))} on this date is already recorded for ${invoice.invoiceNumber}. Confirm only if this is a second, separate payment.`}
          confirmLabel="Yes, record a second payment"
          onClose={() => setRecDuplicate(null)}
          onConfirm={async () => {
            await api('/payments', { method: 'POST', body: { ...recDuplicate, confirmDuplicate: true } });
            toast('Second payment recorded');
            setRecDuplicate(null);
            setRecOpen(false);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}
