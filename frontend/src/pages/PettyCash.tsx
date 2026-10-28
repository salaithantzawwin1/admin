import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission, getToken } from '../api';
import { PageHeader, Card, Button, Input, Select, Table, Empty, Badge } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';

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
}

interface Totals { topup: number; expense: number; balance: number }

interface Account { id: string; code?: string | null; name: string }

const emptyForm = { type: 'TOPUP', amount: '', date: '', payee: '', accountId: '', description: '' };

export default function PettyCash() {
  const canManage = hasPermission('pettycash.manage');
  const [items, setItems] = useState<Txn[]>([]);
  const [totals, setTotals] = useState<Totals>({ topup: 0, expense: 0, balance: 0 });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<typeof emptyForm | null>(null);
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

  const submitForm = async () => {
    if (!form) return;
    await api('/petty-cash', {
      method: 'POST',
      body: {
        type: form.type,
        amount: Number(form.amount),
        date: form.date || undefined,
        payee: form.payee || undefined,
        accountId: form.accountId || undefined,
        description: form.description || undefined,
      },
    });
    setForm(null);
    await load();
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

  return (
    <div>
      <PageHeader
        title="Petty Cash"
        subtitle="Append-only ledger — balance is always Σ top-ups − Σ expenses"
        actions={
          <>
            <Button variant="ghost" onClick={() => void downloadCsv()}>⬇ CSV</Button>
            {canManage && <Button onClick={() => setForm({ ...emptyForm })}>+ Record entry</Button>}
          </>
        }
      />

      {/* totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <Card className="p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Top-ups</div>
          <div className="text-xl font-bold text-green-700 mt-1 tabular-nums">{totals.topup.toLocaleString()}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Expenses</div>
          <div className="text-xl font-bold text-red-700 mt-1 tabular-nums">{totals.expense.toLocaleString()}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Balance</div>
          <div className="text-xl font-bold text-gray-900 mt-1 tabular-nums">{totals.balance.toLocaleString()}</div>
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
            <td className="px-4 py-2.5">{t.payee ?? '—'}</td>
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
        <Modal title="Record petty cash entry" onClose={() => setForm(null)} error={error}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Type *</label>
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="TOPUP">TOPUP — cash received</option>
                <option value="EXPENSE">EXPENSE — cash paid out</option>
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Amount (MMK) *</label>
              <Input type="number" min={0.01} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="e.g. 50000" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </div>
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
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button disabled={!form.amount || Number(form.amount) <= 0} onClick={() => void submitForm()}>Record</Button>
          </div>
        </Modal>
      )}

      {/* delete — audited correction flow (no edit) */}
      {toDelete && (
        <ConfirmDialog
          title={`Delete ${toDelete.code}?`}
          description={`A monetary entry is never edited — delete (audited) and re-enter the corrected row. Amount: MMK ${Number(toDelete.amount).toLocaleString()} (${toDelete.type}).`}
          variant="danger"
          confirmLabel="Delete entry"
          onClose={() => setToDelete(null)}
          onConfirm={async () => {
            await api(`/petty-cash/${toDelete.id}`, { method: 'DELETE' });
            setToDelete(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
