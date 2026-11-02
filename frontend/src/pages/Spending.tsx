/**
 * Administration Spend — one entry for money that leaves the office.
 *
 * The office used to type the same kyat in three places (petty cash, the asset's
 * history, the service log) and the third one was usually forgotten. This form
 * writes all of it in one submission, and refuses the combinations that would
 * count the same money twice.
 */
import { useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { PageHeader, Card, Button, Input, Select, Empty } from '../components/ui';

interface AssetOption { id: string; assetCode: string; name: string }
interface ItemOption { id: string; code: string; name: string; unit: string; balance: number }

interface SpendResult {
  pettyCash: { id: string; code: string; amount: string } | null;
  assetCost: { id: string; kind: string; amount: string } | null;
  maintenance: { id: string; code: string } | null;
  stock: { itemCode: string; quantity: number; balanceAfter: number }[];
  total: number;
}

const COST_KINDS = ['SERVICE', 'REPAIR', 'PART', 'CONSUMABLE', 'PURCHASE', 'OTHER'];
const SERVICE_TYPES = ['CORRECTIVE', 'PREVENTIVE', 'INSPECTION', 'WARRANTY_SERVICE', 'EMERGENCY'];

const today = () => new Date().toISOString().slice(0, 10);
const emptyForm = () => ({
  date: today(),
  description: '',
  amount: '',
  payee: '',
  paidFrom: 'PETTY_CASH',
  assetId: '',
  costKind: 'SERVICE',
  logService: false,
  serviceType: 'CORRECTIVE',
  problem: '',
  workDone: '',
  nextDueDate: '',
});

export default function Spending() {
  const canSpend = hasPermission('pettycash.manage');
  const canAssets = hasPermission('assets.manage');
  const canStock = hasPermission('inventory.manage');

  const [form, setForm] = useState(emptyForm());
  const [stockLines, setStockLines] = useState<{ itemId: string; quantity: number }[]>([]);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [items, setItems] = useState<ItemOption[]>([]);
  const [pick, setPick] = useState({ itemId: '', quantity: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SpendResult | null>(null);

  useEffect(() => {
    void (async () => {
      if (canAssets) {
        try { setAssets(await api<AssetOption[]>('/assets')); } catch { /* no assets.read → free-text stays out */ }
      }
      if (canStock) {
        try { setItems(await api<ItemOption[]>('/inventory/items')); } catch { /* same */ }
      }
    })();
  }, [canAssets, canStock]);

  const usingStock = stockLines.length > 0;
  const amount = Number(form.amount || 0);

  const addLine = () => {
    if (!pick.itemId || pick.quantity <= 0) return;
    setStockLines((prev) => {
      const found = prev.find((l) => l.itemId === pick.itemId);
      return found
        ? prev.map((l) => (l.itemId === pick.itemId ? { ...l, quantity: l.quantity + pick.quantity } : l))
        : [...prev, { itemId: pick.itemId, quantity: pick.quantity }];
    });
    setPick({ itemId: '', quantity: 1 });
  };

  const submit = async () => {
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        date: form.date,
        description: form.description.trim() || undefined,
        payee: form.payee.trim() || undefined,
        paidFrom: form.paidFrom,
        assetId: form.assetId || undefined,
      };
      if (!usingStock) {
        body.amount = amount;
        body.costKind = form.costKind;
      } else {
        body.stockLines = stockLines;
      }
      if (form.logService && form.assetId) {
        body.maintenance = {
          type: form.serviceType,
          problem: form.problem.trim() || undefined,
          workDone: form.workDone.trim() || undefined,
          nextDueDate: form.nextDueDate || undefined,
        };
      }
      const res = await api<SpendResult>('/spending/entries', { method: 'POST', body });
      setResult(res);
      setForm(emptyForm());
      setStockLines([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const ready = form.assetId
    ? usingStock || amount > 0
    : usingStock ? false : amount > 0;

  if (!canSpend && !canAssets) {
    return (
      <>
        <PageHeader title="Administration Spend" subtitle="Record what the office paid for" />
        <Card><Empty label="You need petty cash or asset rights to record spending." /></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Administration Spend"
        subtitle="One entry: the money, the machine it was for, the service it paid for and any stock it used"
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {result && (
        <Card className="mb-4">
          <h3 className="font-semibold text-gray-800 mb-2">Recorded</h3>
          <ul className="text-sm text-gray-700 space-y-1">
            {result.pettyCash && <li>Petty cash EXPENSE <span className="font-mono">{result.pettyCash.code}</span> — {Number(result.pettyCash.amount).toLocaleString()} Ks</li>}
            {result.assetCost && <li>Asset cost row — {result.assetCost.kind}, {Number(result.assetCost.amount).toLocaleString()} Ks</li>}
            {result.maintenance && <li>Service log <span className="font-mono">{result.maintenance.code}</span></li>}
            {result.stock.map((s) => (
              <li key={s.itemCode}>{s.itemCode} — {s.quantity} issued, {s.balanceAfter} left in the store</li>
            ))}
            {!result.pettyCash && !result.assetCost && !result.maintenance && result.stock.length === 0 && (
              <li className="text-gray-500">Nothing was written — check the entry.</li>
            )}
          </ul>
        </Card>
      )}

      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
            <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-gray-500 mb-1">What was it for?</label>
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="e.g. Toner drum replacement, 2nd floor printer"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Paid to</label>
            <Input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} placeholder="Supplier / person" />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Money came from</label>
            <Select value={form.paidFrom} onChange={(e) => setForm({ ...form, paidFrom: e.target.value })} disabled={usingStock}>
              <option value="PETTY_CASH">Petty cash</option>
              <option value="OTHER">Already paid (just record it)</option>
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Amount (Ks)</label>
            <Input
              type="number"
              min={0}
              value={form.amount}
              disabled={usingStock}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder={usingStock ? 'stock, not money' : '0'}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Asset (optional)</label>
            <Select value={form.assetId} onChange={(e) => setForm({ ...form, assetId: e.target.value })}>
              <option value="">— none —</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.assetCode} · {a.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Kind of spend</label>
            <Select
              value={form.costKind}
              disabled={usingStock || !form.assetId}
              onChange={(e) => setForm({ ...form, costKind: e.target.value })}
            >
              {COST_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
          </div>
        </div>

        {!form.assetId && amount > 0 && (
          <p className="text-xs text-gray-500 mt-2">
            No asset chosen — the money goes to petty cash only. Pick a machine to put it on its cost history.
          </p>
        )}

        {/* service log */}
        <div className="mt-4 border-t pt-3">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.logService}
              disabled={!form.assetId || usingStock}
              onChange={(e) => setForm({ ...form, logService: e.target.checked })}
            />
            Also log this as a service on that asset
            {!form.assetId && <span className="text-xs text-gray-400">(pick an asset first)</span>}
          </label>
          {form.logService && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Service type</label>
                <Select value={form.serviceType} onChange={(e) => setForm({ ...form, serviceType: e.target.value })}>
                  {SERVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Problem</label>
                <Input value={form.problem} onChange={(e) => setForm({ ...form, problem: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Work done</label>
                <Input value={form.workDone} onChange={(e) => setForm({ ...form, workDone: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Next service due</label>
                <Input type="date" value={form.nextDueDate} onChange={(e) => setForm({ ...form, nextDueDate: e.target.value })} />
              </div>
            </div>
          )}
          {form.logService && (
            <p className="text-xs text-gray-400 mt-2">
              The service record carries no cost of its own — the money above is the cost, so it is counted once.
            </p>
          )}
        </div>

        {/* stock taken from the store */}
        {canStock && (
          <div className="mt-4 border-t pt-3">
            <p className="text-sm text-gray-700 mb-2">
              Stock taken from the store <span className="text-xs text-gray-400">(already paid for when it was bought — do not enter an amount)</span>
            </p>
            {usingStock ? (
              <ul className="text-sm text-gray-700 space-y-1 mb-2">
                {stockLines.map((l) => {
                  const item = items.find((i) => i.id === l.itemId);
                  return (
                    <li key={l.itemId} className="flex items-center gap-3">
                      <span className="font-mono text-xs">{item?.code}</span>
                      <span>{item?.name}</span>
                      <span className="text-gray-500">{l.quantity} {item?.unit} (stock {item?.balance})</span>
                      <button
                        className="text-red-600 hover:underline text-xs"
                        onClick={() => setStockLines(stockLines.filter((x) => x.itemId !== l.itemId))}
                      >
                        remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="md:col-span-2">
                  <Select value={pick.itemId} onChange={(e) => setPick({ ...pick, itemId: e.target.value })}>
                    <option value="">— choose an item —</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id} disabled={i.balance <= 0}>
                        {i.code} · {i.name} ({i.balance} {i.unit})
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Input
                    type="number"
                    min={1}
                    value={pick.quantity}
                    onChange={(e) => setPick({ ...pick, quantity: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <Button variant="ghost" disabled={!pick.itemId || !form.assetId} onClick={addLine}>Add usage</Button>
                </div>
              </div>
            )}
            {!form.assetId && (
              <p className="text-xs text-gray-400 mt-1">Stock can only be issued to a named asset.</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => { setForm(emptyForm()); setStockLines([]); setError(''); }}>Clear</Button>
          <Button disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Record spend'}
          </Button>
        </div>
      </Card>
    </>
  );
}
