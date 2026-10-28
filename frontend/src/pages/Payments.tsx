import { useCallback, useEffect, useState } from 'react';
import { api, getToken, hasPermission } from '../api';
import { PageHeader, Card, Button, Input, Select, Table, Empty, Badge } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface PaymentRow {
  id: string;
  paymentNumber: string;
  date: string;
  amount: string;
  method: string;
  reference?: string | null;
  note?: string | null;
  invoice: {
    id: string;
    invoiceNumber: string;
    total: string;
    paidAmount: string;
    paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
    dueDate?: string | null;
    supplier: { id: string; name: string };
    purchaseOrder?: { poNumber: string } | null;
  };
  createdBy?: { username: string; fullName?: string } | null;
}

interface Payable {
  id: string;
  invoiceNumber: string;
  supplierInvoiceNumber: string;
  supplier: { id: string; name: string };
  purchaseOrder?: { poNumber: string } | null;
  invoiceDate: string;
  dueDate?: string | null;
  total: number;
  paid: number;
  balance: number;
  paymentStatus: string;
  daysOverdue: number;
}

const METHODS = ['BANK_TRANSFER', 'CASH', 'CHEQUE', 'OTHER'];
const PAY_STATUS_COLOR: Record<string, 'gray' | 'yellow' | 'green'> = {
  UNPAID: 'gray',
  PARTIALLY_PAID: 'yellow',
  PAID: 'green',
};

const emptyForm = { invoiceId: '', amount: '', date: '', method: 'BANK_TRANSFER', reference: '', note: '' };

export default function Payments() {
  const canManage = hasPermission('payments.manage');
  const [items, setItems] = useState<PaymentRow[]>([]);
  const [payables, setPayables] = useState<Payable[]>([]);
  const [payableTotals, setPayableTotals] = useState({ total: 0, paid: 0, balance: 0 });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<typeof emptyForm | null>(null);
  const [toDelete, setToDelete] = useState<PaymentRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const [reg, out] = await Promise.all([
        api<{ items: PaymentRow[] }>(`/payments?${params.toString()}`),
        api<{ items: Payable[]; totals: { total: number; paid: number; balance: number } }>(`/payments/payables?${params.toString()}`),
      ]);
      setItems(reg.items);
      setPayables(out.items);
      setPayableTotals(out.totals);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  const submitForm = async () => {
    if (!form) return;
    await api('/payments', {
      method: 'POST',
      body: {
        invoiceId: form.invoiceId,
        amount: Number(form.amount),
        date: form.date || undefined,
        method: form.method,
        reference: form.reference || undefined,
        note: form.note || undefined,
      },
    });
    setForm(null);
    await load();
  };

  const overdueCount = payables.filter((p) => p.daysOverdue > 0).length;

  const downloadCsv = async () => {
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(`/api/payments/csv?${params.toString()}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payments-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  };

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle="Finance records money against APPROVED/POSTED invoices — an invoice flips UNPAID → PARTIALLY_PAID → PAID as its balance is settled (§26)"
        actions={
          <>
            <Button variant="ghost" onClick={() => void downloadCsv()}>⬇ CSV</Button>
            {canManage && (
              <Button onClick={() => setForm({ ...emptyForm })} disabled={payables.length === 0}>
                + Record payment
              </Button>
            )}
          </>
        }
      />

      {/* totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <Card className="p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Paid in range</div>
          <div className="text-xl font-bold text-green-700 mt-1 tabular-nums">
            {items.reduce((s, p) => s + Number(p.amount), 0).toLocaleString()}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Outstanding balance</div>
          <div className="text-xl font-bold text-gray-900 mt-1 tabular-nums">{payableTotals.balance.toLocaleString()}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Overdue invoices</div>
          <div className={`text-xl font-bold mt-1 tabular-nums ${overdueCount > 0 ? 'text-red-600' : 'text-gray-900'}`}>
            {overdueCount}
          </div>
        </Card>
      </div>

      {/* filters */}
      <Card className="p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </Card>

      {error && !form && !toDelete && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>
      )}

      {/* ---------- payment register ---------- */}
      <h2 className="text-sm font-semibold text-gray-700 mb-2">Payment register</h2>
      <Table head={['CODE', 'DATE', 'INVOICE', 'SUPPLIER', 'AMOUNT (MMK)', 'METHOD', 'REFERENCE', 'RECORDED BY', 'ACTIONS']}>
        {loading ? (
          <tr><td colSpan={9}><Empty label="Loading…" /></td></tr>
        ) : items.length === 0 ? (
          <tr><td colSpan={9}><Empty label="No payments in this range" /></td></tr>
        ) : items.map((p) => (
          <tr key={p.id} className="hover:bg-gray-50/60">
            <td className="px-4 py-2.5 font-medium text-gray-900">{p.paymentNumber}</td>
            <td className="px-4 py-2.5">{new Date(p.date).toISOString().slice(0, 10)}</td>
            <td className="px-4 py-2.5 font-medium text-gray-900">{p.invoice.invoiceNumber}</td>
            <td className="px-4 py-2.5">{p.invoice.supplier.name}</td>
            <td className="px-4 py-2.5 text-right tabular-nums font-medium text-green-700">
              {Number(p.amount).toLocaleString()}
            </td>
            <td className="px-4 py-2.5">{p.method.replace('_', ' ')}</td>
            <td className="px-4 py-2.5 text-gray-500">{p.reference ?? '—'}</td>
            <td className="px-4 py-2.5 text-gray-500">{p.createdBy?.fullName || p.createdBy?.username || '—'}</td>
            <td className="px-4 py-2.5 text-center">
              {canManage && <Button variant="danger" onClick={() => setToDelete(p)}>Delete</Button>}
            </td>
          </tr>
        ))}
      </Table>

      {/* ---------- outstanding payables ---------- */}
      <h2 className="text-sm font-semibold text-gray-700 mt-6 mb-2">
        Outstanding invoices (balance &gt; 0 — overdue first)
      </h2>
      <Table head={['INVOICE', 'SUPPLIER', 'PO', 'TOTAL', 'PAID', 'BALANCE', 'DUE DATE', 'STATUS']}>
        {loading ? (
          <tr><td colSpan={8}><Empty label="Loading…" /></td></tr>
        ) : payables.length === 0 ? (
          <tr><td colSpan={8}><Empty label="Nothing outstanding — every approved invoice is settled" /></td></tr>
        ) : payables.map((p) => (
          <tr key={p.id} className="hover:bg-gray-50/60">
            <td className="px-4 py-2.5 font-medium text-gray-900">{p.invoiceNumber}</td>
            <td className="px-4 py-2.5">{p.supplier.name}</td>
            <td className="px-4 py-2.5 text-gray-500">{p.purchaseOrder?.poNumber ?? '—'}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{p.total.toLocaleString()}</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-green-700">{p.paid.toLocaleString()}</td>
            <td className="px-4 py-2.5 text-right tabular-nums font-medium">{p.balance.toLocaleString()}</td>
            <td className="px-4 py-2.5">
              {p.dueDate ? new Date(p.dueDate).toISOString().slice(0, 10) : '—'}
              {p.daysOverdue > 0 && (
                <span className="ml-2 text-xs font-semibold text-red-600">{p.daysOverdue}d overdue</span>
              )}
            </td>
            <td className="px-4 py-2.5 text-center">
              <Badge color={PAY_STATUS_COLOR[p.paymentStatus] ?? 'gray'}>{p.paymentStatus.replace('_', ' ')}</Badge>
            </td>
          </tr>
        ))}
      </Table>

      {/* record payment */}
      {form && (
        <Modal title="Record payment" onClose={() => setForm(null)} error={error}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Invoice *</label>
              <Select
                value={form.invoiceId}
                onChange={(e) => {
                  const p = payables.find((x) => x.id === e.target.value);
                  // prefill the amount with the outstanding balance (the common case)
                  setForm({ ...form, invoiceId: e.target.value, amount: p ? String(p.balance) : form.amount });
                }}
              >
                <option value="">— select a payable invoice —</option>
                {payables.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.invoiceNumber} — {p.supplier.name} — balance {p.balance.toLocaleString()}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Amount (MMK) *</label>
              <Input
                type="number" min={0.01} step="0.01" value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="Outstanding balance of the selected invoice"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
                <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Method *</label>
                <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                  {METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
                </Select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Reference</label>
              <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="Transaction ref / cheque no." />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Note</label>
              <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional remark" />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button
              disabled={!form.invoiceId || !form.amount || Number(form.amount) <= 0}
              onClick={() => void submitForm()}
            >
              Record payment
            </Button>
          </div>
        </Modal>
      )}

      {/* delete — audited correction flow (no edit of money rows) */}
      {toDelete && (
        <ConfirmDialog
          title={`Delete ${toDelete.paymentNumber}?`}
          description={`A payment is never edited — delete (audited) and re-enter the corrected row. Amount: MMK ${Number(toDelete.amount).toLocaleString()} against ${toDelete.invoice.invoiceNumber}.`}
          variant="danger"
          confirmLabel="Delete payment"
          onClose={() => setToDelete(null)}
          onConfirm={async () => {
            await api(`/payments/${toDelete.id}`, { method: 'DELETE' });
            setToDelete(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
