import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Textarea } from '../components/ui';
import { Modal } from '../components/Modal';
import { fmtDate } from '../util/yangonTime';
import { toast } from '../components/Toast';

// ---------------------------------------------------------------------------
// Procurement — Purchase Requests (Design §5–7, phase P1).
// A PR is a workflow document (PR-…) + line items with optional Account/Asset
// references. Creation follows the standard request flow: create as DRAFT here,
// then POST /requests/:id/submit (same as car and meeting-room requests).
// ---------------------------------------------------------------------------

interface PrItem {
  id: string;
  description: string;
  quantity: number;
  unit?: string | null;
  estimatedUnitPrice?: string | null;
  account?: { id: string; name: string; code?: string | null } | null;
  asset?: { id: string; assetCode: string; name: string } | null;
}

interface PrRow {
  id: string;
  docNumber: string;
  title: string;
  status: string;
  currentLevel: number;
  totalLevels: number;
  createdAt: string;
  requester?: { fullName: string } | null;
  department?: { name: string } | null;
  purchaseRequest?: {
    priority: string;
    requiredDate?: string | null;
    budgetCode?: string | null;
    items: PrItem[];
  } | null;
}

interface Account {
  id: string;
  code?: string | null;
  name: string;
  category?: { name: string } | null;
}

interface Asset {
  id: string;
  assetCode: string;
  name: string;
}

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'orange'> = {
  DRAFT: 'gray',
  PENDING_APPROVAL: 'yellow',
  SUBMITTED: 'yellow',
  APPROVED: 'green',
  REJECTED: 'red',
  CANCELLED: 'gray',
  COMPLETED: 'green',
  CLOSED: 'gray',
  ON_HOLD: 'orange',
  IN_PROGRESS: 'blue',
};

/** Line-item editor state — mirrors PurchaseRequestItem on the backend. */
interface DraftItem {
  description: string;
  quantity: number;
  unit: string;
  estimatedUnitPrice: string;
  accountId: string;
  assetId: string;
}

const emptyItem = (): DraftItem => ({ description: '', quantity: 1, unit: '', estimatedUnitPrice: '', accountId: '', assetId: '' });

const fmtMoney = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function Procurement() {
  const [searchParams, setSearchParams] = useSearchParams();
  const canReadAll = hasPermission('procurement.read');
  const [rows, setRows] = useState<PrRow[]>([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(searchParams.get('new') === '1');

  const load = useCallback(() => {
    api<{ items: PrRow[] }>('/procurement/requests?pageSize=100')
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const closeForm = () => {
    setShowForm(false);
    if (searchParams.get('new')) setSearchParams({}, { replace: false });
    load();
  };

  return (
    <div>
      <PageHeader
        title="Procurement"
        subtitle="Purchase requests — approve first, buy later (Procurement Design §35)"
        actions={<Button onClick={() => setShowForm(true)}>+ New Purchase Request</Button>}
      />
      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Doc No.</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Items</th>
              <th className="px-4 py-3 font-medium">Priority</th>
              <th className="px-4 py-3 font-medium">Status</th>
              {canReadAll && <th className="px-4 py-3 font-medium">Requester</th>}
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={canReadAll ? 7 : 6}>
                  <Empty label="No purchase requests yet" />
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const items = r.purchaseRequest?.items ?? [];
              return (
                <tr key={r.id} className="hover:bg-gray-50 align-top">
                  <td className="px-4 py-3 font-medium whitespace-nowrap">
                    <Link to={`/requests/${r.id}`} className="text-blue-600 hover:underline">
                      {r.docNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{r.title}</td>
                  <td className="px-4 py-3 text-gray-500">{items.length}</td>
                  <td className="px-4 py-3">
                    {r.purchaseRequest?.priority === 'URGENT' ? <Badge color="red">URGENT</Badge> : <span className="text-gray-400">Normal</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={STATUS_COLORS[r.status] ?? 'gray'}>{r.status}</Badge>
                  </td>
                  {canReadAll && (
                    <td className="px-4 py-3">
                      {r.requester?.fullName ?? '—'}
                      <div className="text-xs text-gray-400">{r.department?.name ?? '—'}</div>
                    </td>
                  )}
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {showForm && <NewPurchaseRequestModal onClose={closeForm} />}
    </div>
  );
}

function NewPurchaseRequestModal({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [priority, setPriority] = useState('NORMAL');
  const [requiredDate, setRequiredDate] = useState('');
  const [budgetCode, setBudgetCode] = useState('');
  const [justification, setJustification] = useState('');
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);

  useEffect(() => {
    api<Account[]>('/procurement/accounts').then(setAccounts).catch(() => setAccounts([]));
    api<Asset[]>('/procurement/assets').then(setAssets).catch(() => setAssets([]));
  }, []);

  const setItem = (idx: number, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const total = items.reduce((sum, it) => sum + (Number(it.estimatedUnitPrice) || 0) * (Number(it.quantity) || 0), 0);
  const valid = items.length > 0 && items.every((it) => it.description.trim() && Number(it.quantity) >= 1);

  const submit = async (thenSubmitForApproval: boolean) => {
    setError('');
    setBusy(true);
    try {
      const created = await api<{ id: string; docNumber: string }>('/procurement/requests', {
        method: 'POST',
        body: {
          priority,
          requiredDate: requiredDate || undefined,
          budgetCode: budgetCode.trim() || undefined,
          justification: justification.trim() || undefined,
          items: items.map((it) => ({
            description: it.description.trim(),
            quantity: Number(it.quantity),
            unit: it.unit.trim() || undefined,
            estimatedUnitPrice: it.estimatedUnitPrice === '' ? undefined : Number(it.estimatedUnitPrice),
            accountId: it.accountId || undefined,
            assetId: it.assetId || undefined,
          })),
        },
      });
      if (thenSubmitForApproval) {
        await api(`/requests/${created.id}/submit`, { method: 'POST' });
        toast(`PR ${created.docNumber} submitted for approval`);
      } else {
        toast(`PR ${created.docNumber} saved as draft`);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <Modal title="New purchase request" error={error} wide onClose={onClose}>
      <div className="space-y-4">
        {/* line items */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Items</div>
          {items.map((it, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-start">
              <div className="col-span-12 sm:col-span-5">
                <Input placeholder={`Item ${idx + 1} description *`} value={it.description} onChange={(e) => setItem(idx, { description: e.target.value })} />
              </div>
              <div className="col-span-3 sm:col-span-1">
                <Input type="number" min={1} placeholder="Qty" value={it.quantity} onChange={(e) => setItem(idx, { quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
              </div>
              <div className="col-span-3 sm:col-span-1">
                <Input placeholder="Unit" value={it.unit} onChange={(e) => setItem(idx, { unit: e.target.value })} />
              </div>
              <div className="col-span-6 sm:col-span-2">
                <Input type="number" min={0} placeholder="Unit price" value={it.estimatedUnitPrice} onChange={(e) => setItem(idx, { estimatedUnitPrice: e.target.value })} />
              </div>
              <div className="col-span-6 sm:col-span-2">
                <Select value={it.accountId} onChange={(e) => setItem(idx, { accountId: e.target.value })}>
                  <option value="">Account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code ? `${a.code} — ` : ''}
                      {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="col-span-10 sm:col-span-1">
                <Select value={it.assetId} onChange={(e) => setItem(idx, { assetId: e.target.value })}>
                  <option value="">Asset…</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.assetCode}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="col-span-2 sm:col-span-1 flex justify-end">
                <Button variant="danger" onClick={() => setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))}>
                  ×
                </Button>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setItems((prev) => [...prev, emptyItem()])}>
              + Add item
            </Button>
            <div className="text-sm text-gray-600">
              Estimated total: <b>{fmtMoney(total)}</b>
            </div>
          </div>
        </div>

        {/* PR fields */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="pr-priority" className="text-xs text-gray-500 block mb-1">Priority</label>
            <Select id="pr-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="NORMAL">Normal</option>
              <option value="URGENT">Urgent</option>
            </Select>
          </div>
          <div>
            <label htmlFor="pr-required-date" className="text-xs text-gray-500 block mb-1">Required date (optional)</label>
            <Input id="pr-required-date" type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="pr-budget-code" className="text-xs text-gray-500 block mb-1">Budget code (optional)</label>
            <Input id="pr-budget-code" placeholder="Budget code" value={budgetCode} onChange={(e) => setBudgetCode(e.target.value)} />
          </div>
        </div>
        <div>
          <label htmlFor="pr-justification" className="text-xs text-gray-500 block mb-1">Purpose / justification (optional)</label>
          <Textarea id="pr-justification" rows={2} placeholder="Why is this purchase needed?" value={justification} onChange={(e) => setJustification(e.target.value)} />
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <Button disabled={!valid || busy} onClick={() => submit(true)}>
          {busy ? 'Submitting…' : 'Submit for Approval'}
        </Button>
        <Button variant="ghost" disabled={!valid || busy} onClick={() => submit(false)}>
          Save as Draft
        </Button>
      </div>
    </Modal>
  );
}
