import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, hasPermission, getToken } from '../api';
import { PageHeader, Card, Button, Input, Select, Table, Empty, Badge } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';

interface Txn {
  id: string;
  code: string;
  date: string;
  type: 'TOPUP' | 'EXPENSE';
  amount: string;
  payee?: string | null;
  description?: string | null;
  account?: { code?: string | null; name: string } | null;
  createdBy?: { username: string; fullName?: string } | null;
  /** v2 P1-1: the bill this entry settled, when it settled one */
  invoice?: { id: string; invoiceNumber: string } | null;
  payment?: { id: string; paymentNumber: string; invoiceId: string } | null;
}

interface Totals { topup: number; expense: number; balance: number }

interface Account { id: string; code?: string | null; name: string }

/** An open invoice an expense may settle (v2 §4.2 step 3 picker). */
interface BillOption {
  id: string;
  invoiceNumber: string;
  status: string;
  invoiceDate: string;
  total: number;
  paidAmount: number;
  /** total − paidAmount, computed server-side */
  balance: number;
  supplier: { id: string; name: string };
}

const emptyForm = { type: 'TOPUP', amount: '', date: '', payee: '', accountId: '', description: '', invoiceId: '' };

const money = (v: string | number) => Number(v ?? 0).toLocaleString();

export default function PettyCash() {
  const canManage = hasPermission('pettycash.manage');
  const canSeeBills = hasPermission('procurement.read') || hasPermission('procurement.manage');
  const [items, setItems] = useState<Txn[]>([]);
  const [totals, setTotals] = useState<Totals>({ topup: 0, expense: 0, balance: 0 });
  // unfiltered balance — "cash on hand" must not follow the list filters
  const [cashBalance, setCashBalance] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bills, setBills] = useState<BillOption[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<typeof emptyForm | null>(null);
  const [formError, setFormError] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [toDelete, setToDelete] = useState<Txn | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (type) params.set('type', type);
      const data = await api<{ items: Txn[]; totals: Totals }>(`/petty-cash?${params.toString()}`);
      setItems(data.items);
      setTotals(data.totals);
      // only an unfiltered read knows the whole float (mount, or filters cleared)
      if (!from && !to && !type) setCashBalance(data.totals.balance);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load petty cash');
    } finally {
      setLoading(false);
    }
  }, [from, to, type]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        setAccounts(await api<Account[]>('/procurement/accounts'));
      } catch {
        // account picker optional — the row still records without one
      }
    })();
  }, []);

  // v2 §4.2 step 3: the bills an expense can settle — open (not cancelled or
  // rejected) and still carrying a balance. Fetched server-side on EVERY open,
  // because a cached first page meant a bill entered later (or the 101st bill)
  // never appeared in the picker.
  const loadBills = useCallback(async () => {
    if (!canSeeBills) return;
    try {
      const r = await api<{ items: BillOption[] }>('/petty-cash/open-bills');
      setBills(r.items ?? []);
    } catch {
      setBills([]);
    }
  }, [canSeeBills]);

  const openForm = () => {
    setForm({ ...emptyForm });
    setFormError('');
    void loadBills();
  };

  // server already dropped closed and settled bills; only the order is ours
  const openBills = useMemo(
    () => [...bills].sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber)),
    [bills],
  );

  const pickedBill = form?.invoiceId ? openBills.find((b) => b.id === form.invoiceId) : undefined;
  const pickedBalance = pickedBill ? pickedBill.balance : 0;
  const overOutstanding = Boolean(pickedBill) && Number(form?.amount ?? 0) > pickedBalance;

  // keeps "cash on hand" honest after a write even while the list is filtered
  const refreshCash = useCallback(() => {
    api<{ totals: Totals }>('/petty-cash')
      .then((d) => setCashBalance(d.totals.balance))
      .catch(() => undefined);
  }, []);

  const submitForm = async () => {
    if (!form) return;
    setFormError('');
    setFormBusy(true);
    try {
      await api('/petty-cash', {
        method: 'POST',
        body: {
          type: form.type,
          amount: Number(form.amount),
          date: form.date || undefined,
          payee: form.payee || undefined,
          accountId: form.accountId || undefined,
          description: form.description || undefined,
          // only an expense may name a bill; the server refuses a linked top-up
          invoiceId: form.type === 'EXPENSE' && form.invoiceId ? form.invoiceId : undefined,
        },
      });
      toast(
        form.type === 'TOPUP'
          ? 'Petty cash top-up recorded'
          : form.invoiceId
            ? 'Expense recorded and the invoice marked paid'
            : 'Petty cash expense recorded',
      );
      setForm(null);
      await load();
      refreshCash();
    } catch (e) {
      // a rejected entry (bad date, unknown account, server rule) must be visible
      // in the form the user is still looking at
      setFormError(e instanceof Error ? e.message : 'Could not record the entry');
    } finally {
      setFormBusy(false);
    }
  };

  const downloadCsv = async () => {
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(`/api/petty-cash/csv?${params.toString()}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `petty-cash-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const amountColor = (t: string) => (t === 'TOPUP' ? 'text-green-700' : 'text-red-700');
  // the tiles read the filtered rows, so they are not the lifetime ledger totals
  const usingFilters = Boolean(from || to || type);

  return (
    <div>
      <PageHeader
        title="Petty Cash"
        subtitle="Append-only ledger — balance is always Σ top-ups − Σ expenses"
        actions={
          <>
            <Button variant="ghost" onClick={() => void downloadCsv()}>⬇ CSV</Button>
            {canManage && <Button onClick={openForm}>+ Record entry</Button>}
          </>
        }
      />

      {/* totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <Card className="p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Top-ups{usingFilters ? ' (in range)' : ''}</div>
          <div className="text-xl font-bold text-green-700 mt-1 tabular-nums">{totals.topup.toLocaleString()}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Expenses{usingFilters ? ' (in range)' : ''}</div>
          <div className="text-xl font-bold text-red-700 mt-1 tabular-nums">{totals.expense.toLocaleString()}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Balance{usingFilters ? ' (in range)' : ''}</div>
          <div className="text-xl font-bold text-gray-900 mt-1 tabular-nums">{totals.balance.toLocaleString()}</div>
          <p className="text-[11px] text-gray-400 mt-1 leading-tight">Advisory — top-ups are not always recorded</p>
        </Card>
      </div>

      {/* filters */}
      <Card className="p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All entries</option>
              <option value="TOPUP">Top-ups</option>
              <option value="EXPENSE">Expenses</option>
            </Select>
          </div>
        </div>
      </Card>

      {error && !form && !toDelete && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>
      )}

      <Table head={['CODE', 'DATE', 'TYPE', 'AMOUNT (MMK)', 'PAYEE', 'ACCOUNT', 'DESCRIPTION', 'RECORDED BY', 'ACTIONS']}>
        {loading ? (
          <tr><td colSpan={9}><Empty label="Loading…" /></td></tr>
        ) : items.length === 0 ? (
          <tr><td colSpan={9}><Empty label="No entries in this range" /></td></tr>
        ) : items.map((t) => (
          <tr key={t.id} className="hover:bg-gray-50/60">
            <td className="px-4 py-2.5 font-medium text-gray-900">{t.code}</td>
            <td className="px-4 py-2.5">{new Date(t.date).toISOString().slice(0, 10)}</td>
            <td className="px-4 py-2.5">
              <Badge color={t.type === 'TOPUP' ? 'green' : 'red'}>{t.type}</Badge>
            </td>
            <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${amountColor(t.type)}`}>
              {t.type === 'EXPENSE' ? '−' : '+'}{Number(t.amount).toLocaleString()}
            </td>
            <td className="px-4 py-2.5">
              {t.payee ?? '—'}
              {t.invoice && (
                <div className="text-xs text-gray-500 whitespace-nowrap" title={t.payment ? `paid as ${t.payment.paymentNumber}` : undefined}>
                  → {t.invoice.invoiceNumber}{t.payment ? ` · ${t.payment.paymentNumber}` : ''}
                </div>
              )}
            </td>
            <td className="px-4 py-2.5">{t.account ? `${t.account.code ?? ''} ${t.account.name}` : '—'}</td>
            <td className="px-4 py-2.5 max-w-[280px] truncate" title={t.description ?? ''}>{t.description ?? '—'}</td>
            <td className="px-4 py-2.5 text-gray-500">{t.createdBy?.fullName || t.createdBy?.username || '—'}</td>
            <td className="px-4 py-2.5 text-center">
              {canManage && (
                <Button variant="danger" onClick={() => setToDelete(t)}>Delete</Button>
              )}
            </td>
          </tr>
        ))}
      </Table>

      {/* record entry */}
      {form && (
        <Modal
          title="Record petty cash entry"
          onClose={() => { setForm(null); setFormError(''); }}
          error={formError}
        >
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Type *</label>
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, invoiceId: '' })}>
                <option value="TOPUP">TOPUP — cash received</option>
                <option value="EXPENSE">EXPENSE — cash paid out</option>
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Amount (MMK) *</label>
              <Input type="number" min={0.01} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="e.g. 50000" />
              {form.type === 'EXPENSE' && Number(form.amount) > cashBalance && (
                <p className="text-xs text-orange-600 mt-1">
                  More than the cash on hand (MMK {cashBalance.toLocaleString()}). The float figure is advisory — the entry saves anyway.
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </div>

            {form.type === 'EXPENSE' && canSeeBills && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Invoice paid (optional)</label>
                <Select
                  value={form.invoiceId}
                  onChange={(e) => {
                    const id = e.target.value;
                    const bill = openBills.find((b) => b.id === id);
                    setForm({ ...form, invoiceId: id, payee: bill ? bill.supplier.name : form.payee });
                  }}
                >
                  <option value="">— none (ordinary expense) —</option>
                  {openBills.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.invoiceNumber} · {b.supplier.name} · balance                       {money(b.balance)}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-gray-500 mt-1">
                  Linking records the payment to the supplier and marks the bill paid. Leave it empty when the cash was not for a bill.
                </p>
                {overOutstanding && (
                  <p className="text-xs text-red-600 mt-1">
                    More than the outstanding balance on {pickedBill?.invoiceNumber} (MMK {money(pickedBalance)}) — record a separate expense per instalment.
                  </p>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Payee</label>
              <Input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} placeholder={form.type === 'EXPENSE' ? 'Paid to' : 'Drawn from'} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Account</label>
              <Select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                <option value="">— none —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.code ?? ''} {a.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What the cash was for" />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => { setForm(null); setFormError(''); }}>Cancel</Button>
            <Button
              disabled={!form.amount || Number(form.amount) <= 0 || formBusy || overOutstanding}
              onClick={() => void submitForm()}
            >
              {formBusy ? 'Recording…' : 'Record'}
            </Button>
          </div>
        </Modal>
      )}

      {/* delete — audited correction flow with a required reason (D-9/BR-14) */}
      {toDelete && (
        <ConfirmDialog
          title={`Delete ${toDelete.code}?`}
          description={
            toDelete.payment
              ? `This expense paid ${toDelete.invoice?.invoiceNumber ?? 'an invoice'} (payment ${toDelete.payment.paymentNumber}). Deleting it also deletes that payment and puts the bill back to its previous payment status — both steps are audited. Amount: MMK ${Number(toDelete.amount).toLocaleString()}.`
              : `A monetary entry is never edited — delete (audited) and re-enter the corrected row. Amount: MMK ${Number(toDelete.amount).toLocaleString()} (${toDelete.type}).`
          }
          variant="danger"
          confirmLabel="Delete entry"
          withNote
          noteRequired
          notePlaceholder="Reason for deleting this entry (required — kept in the audit log)"
          onClose={() => setToDelete(null)}
          onConfirm={async (note) => {
            await api(`/petty-cash/${toDelete.id}`, { method: 'DELETE', body: { reason: note } });
            toast('Entry deleted');
            setToDelete(null);
            await load();
            refreshCash();
          }}
        />
      )}
    </div>
  );
}
