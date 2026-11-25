import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, NumberField, PageHeader, Select, Textarea } from '../components/ui';
import { Modal } from '../components/Modal';
import { BudgetBlockedModal, budgetBlockFrom, type BudgetBlock } from '../components/BudgetBlockedModal';
import { fmtDate } from '../util/yangonTime';
import { toast } from '../components/Toast';
import { pricingPending } from '../util/pricing';

// ---------------------------------------------------------------------------
// Procurement — Purchase Requests (Design §5–7, phase P1).
// A PR is a workflow document (PR-…) + line items. Account/Asset are NOT
// collected here: the employee only says what is needed, and the purchasing
// stage assigns the Account (design §17/§39 — PO lines carry it; invoices
// classify per line). Creation follows the standard request flow: create as
// DRAFT here, then POST /requests/:id/submit (same as car/meeting requests).
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
    purchaseType?: string;
    purchaseReason?: string | null;
    requiredDate?: string | null;
    budgetCode?: string | null;
    items: PrItem[];
  } | null;
}

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'orange' | 'teal'> = {
  DRAFT: 'gray',
  PENDING_APPROVAL: 'yellow',
  SUBMITTED: 'yellow',
  APPROVED: 'green',
  REJECTED: 'red',
  CANCELLED: 'gray',
  COMPLETED: 'teal',
  CLOSED: 'gray',
  ON_HOLD: 'orange',
  IN_PROGRESS: 'blue',
};

/** Line-item editor state — mirrors PurchaseRequestItem on the backend.
 *  Account/Asset live on the PO/invoice lines (§17/§39), not on the request. */
interface DraftItem {
  description: string;
  quantity: number;
  unit: string;
  estimatedUnitPrice: string;
  /** values we filled from the catalog — safe to replace when the item changes */
  autoPrice?: string;
  autoUnit?: string;
}

const emptyItem = (): DraftItem => ({ description: '', quantity: 1, unit: '', estimatedUnitPrice: '' });

const fmtMoney = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** A draft with a blank estimate sits in the pricing queue, not in approval. */
const awaitsPricing = (r: PrRow) => r.status === 'DRAFT' && pricingPending(r.purchaseRequest?.items);

interface CatalogItem {
  id: string;
  code: string;
  name: string;
  unit?: string | null;
  lastUnitPrice?: string | null;
}

export default function Procurement() {
  const [searchParams, setSearchParams] = useSearchParams();
  const canReadAll = hasPermission('procurement.read');
  const [rows, setRows] = useState<PrRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(searchParams.get('new') === '1');
  const [pricingFor, setPricingFor] = useState<PrRow | null>(null);
  const canManage = hasPermission('procurement.manage');

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: PrRow[] }>('/procurement/requests?pageSize=100')
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const closeForm = () => {
    setShowForm(false);
    if (searchParams.get('new')) setSearchParams({}, { replace: false });
    load();
  };

  const pricingQueue = canManage ? rows.filter(awaitsPricing) : [];

  return (
    <div>
      <PageHeader
        title="Procurement"
        subtitle="Purchase requests — approve first, buy later (Procurement Design §35)"
        actions={<Button onClick={() => setShowForm(true)}>+ New Purchase Request</Button>}
      />
      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {pricingQueue.length > 0 && (
        <Card className="mb-4">
          <div className="p-5">
            <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">
              Needs pricing ({pricingQueue.length})
            </h2>
            <p className="text-xs text-gray-500 mt-1 mb-3">
              The requester does not know the prices. Set the estimates and the request goes into approval with the right chain.
            </p>
            <ul className="divide-y divide-gray-100">
              {pricingQueue.map((r) => (
                <li key={r.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <Link to={`/requests/${r.id}`} className="text-blue-600 hover:underline font-medium">{r.docNumber}</Link>
                    <span className="text-gray-600"> — {r.title}</span>
                    <div className="text-xs text-gray-400">
                      {r.requester?.fullName ?? '—'} · {(r.purchaseRequest?.items ?? []).filter((i) => !(Number(i.estimatedUnitPrice) > 0)).length} line(s) without a price
                    </div>
                  </div>
                  <Button onClick={() => setPricingFor(r)}>Set prices</Button>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Doc No.</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Items</th>
              <th className="px-4 py-3 font-medium">Priority</th>
              <th className="px-4 py-3 font-medium text-center">Status</th>
              {canReadAll && <th className="px-4 py-3 font-medium">Requester</th>}
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={canReadAll ? 7 : 6}>
                  <Empty label={loading ? 'Loading…' : 'No purchase requests yet'} />
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
                    {r.purchaseRequest?.purchaseType && r.purchaseRequest.purchaseType !== 'NORMAL' && (
                      <div className="mt-1" title={r.purchaseRequest.purchaseReason ?? undefined}>
                        <Badge color={r.purchaseRequest.purchaseType === 'EMERGENCY' ? 'red' : 'orange'}>{r.purchaseRequest.purchaseType}</Badge>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge color={awaitsPricing(r) ? 'yellow' : STATUS_COLORS[r.status] ?? 'gray'}>
                      {awaitsPricing(r) ? 'Awaiting price' : r.status}
                    </Badge>
                    {canManage && awaitsPricing(r) && (
                      <button className="block mt-1 mx-auto text-xs text-blue-600 hover:underline" onClick={() => setPricingFor(r)}>
                        Set prices
                      </button>
                    )}
                    {canReadAll && r.status === 'APPROVED' && (
                      <Link
                        to={`/rfqs?new=1&pr=${r.id}`}
                        className="block mt-1 text-xs text-blue-600 hover:underline"
                        title="Ask vendors for quotations on this approved request (design §11)"
                      >
                        → Ask for RFQ
                      </Link>
                    )}
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
      {pricingFor && (
        <PricingModal
          row={pricingFor}
          onClose={() => setPricingFor(null)}
          onDone={() => { setPricingFor(null); load(); }}
        />
      )}
    </div>
  );
}

/** Procurement fills the estimates the requester could not know; the PR then enters approval. */
function PricingModal({ row, onClose, onDone }: { row: PrRow; onClose: () => void; onDone: () => void }) {
  const items = row.purchaseRequest?.items ?? [];
  const missing = items.filter((i) => !(Number(i.estimatedUnitPrice) > 0));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(missing.map((i) => [i.id, ''])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [budgetBlock, setBudgetBlock] = useState<BudgetBlock | null>(null);
  const allSet = missing.every((i) => Number(values[i.id]) > 0);
  const total = items.reduce(
    (sum, i) => sum + (Number(i.estimatedUnitPrice ?? values[i.id]) || 0) * i.quantity,
    0,
  );

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/procurement/requests/${row.id}/pricing`, {
        method: 'PATCH',
        body: { items: missing.map((i) => ({ itemId: i.id, estimatedUnitPrice: Number(values[i.id]) })) },
      });
      toast(`${row.docNumber} priced and sent for approval`);
      onDone();
    } catch (e) {
      const block = budgetBlockFrom(e);
      if (block) setBudgetBlock(block);
      else setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <>
      <Modal title={`Price ${row.docNumber}`} error={error} onClose={onClose} wide>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-gray-500">
            These estimates choose the approval chain. The requester sees them and is notified when it goes into approval.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-gray-200">
                <th className="py-2 font-medium">Item</th>
                <th className="py-2 font-medium text-right">Qty</th>
                <th className="py-2 font-medium text-right">Unit price (Ks)</th>
                <th className="py-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((i) => {
                const value = Number(i.estimatedUnitPrice ?? values[i.id]) || 0;
                return (
                  <tr key={i.id}>
                    <td className="py-2">{i.description}{i.unit ? <span className="text-gray-400"> ({i.unit})</span> : null}</td>
                    <td className="py-2 text-right">{i.quantity}</td>
                    <td className="py-2 text-right">
                      {Number(i.estimatedUnitPrice) > 0 ? (
                        <span className="text-gray-500">{fmtMoney(Number(i.estimatedUnitPrice))}</span>
                      ) : (
                        <Input
                          type="number"
                          min={0}
                          className="!w-32 text-right"
                          aria-label={`Estimated unit price for ${i.description}`}
                          value={values[i.id] ?? ''}
                          onChange={(e) => setValues((v) => ({ ...v, [i.id]: e.target.value }))}
                        />
                      )}
                    </td>
                    <td className="py-2 text-right font-medium">{fmtMoney(value * i.quantity)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="text-right text-sm">
            Estimated total: <b>{fmtMoney(total)} Ks</b>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button disabled={!allSet || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save prices & send for approval'}
            </Button>
          </div>
        </div>
      </Modal>
      {budgetBlock && <BudgetBlockedModal block={budgetBlock} onClose={() => setBudgetBlock(null)} />}
    </>
  );
}

function NewPurchaseRequestModal({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [priority, setPriority] = useState('NORMAL');
  const [purchaseType, setPurchaseType] = useState('NORMAL');
  const [purchaseReason, setPurchaseReason] = useState('');
  const [requiredDate, setRequiredDate] = useState('');
  const [budgetCode, setBudgetCode] = useState('');
  const [justification, setJustification] = useState('');
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  // "I don't know the prices" — Administration fills the estimates first
  const [askForPricing, setAskForPricing] = useState(false);
  // catalog rows carry the last paid price, so most lines need no typing
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  // optional OSR link — the purchase then shows up on that supply request
  const [sourceOsr, setSourceOsr] = useState('');
  const [osrOptions, setOsrOptions] = useState<{ id: string; docNumber: string; items: string }[]>([]);
  // §9 budget block — friendly explain modal instead of a raw 409 message
  const [budgetBlock, setBudgetBlock] = useState<BudgetBlock | null>(null);

  const setItem = (idx: number, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  // my approved supply requests still waiting for items — candidates for the link
  useEffect(() => {
    api<any[]>('/inventory/requests/mine')
      .then((rows) => setOsrOptions(
        (rows ?? [])
          .filter((r) => r.docType === 'OFFICE_SUPPLY_REQUEST' && r.status === 'APPROVED' && r.supplyRequest)
          .filter((r) => ['PENDING', 'PURCHASING', 'PARTIAL'].includes(r.supplyRequest.status))
          .filter((r) => (r.supplyRequest.purchaseRequests ?? []).length === 0)
          .map((r) => ({
            id: r.id,
            docNumber: r.docNumber,
            items: (r.supplyRequest.lines ?? []).map((l: any) => `${l.item?.name ?? ''} ×${l.quantity}`).join(', '),
          })),
      ))
      .catch(() => setOsrOptions([]));
  }, []);

  useEffect(() => {
    api<CatalogItem[]>('/inventory/items')
      .then((rows) => setCatalog(rows ?? []))
      .catch(() => setCatalog([]));
  }, []);

  /** Picking a catalog item fills its unit and last paid price (only blanks). */
  const fillFromCatalog = (idx: number, typed: string) => {
    const needle = typed.trim().toLowerCase();
    // duplicate names exist; a row with a last price is the useful one
    const matches = catalog.filter((c) => c.name.toLowerCase() === needle || c.code.toLowerCase() === needle);
    const match = matches.find((c) => c.lastUnitPrice != null) ?? matches[0];
    if (!match) return;
    setItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it;
      const nextPrice = match.lastUnitPrice != null ? String(Number(match.lastUnitPrice)) : '';
      const nextUnit = match.unit || '';
      // what the user typed is theirs; what we filled follows the chosen item
      const typedPrice = it.estimatedUnitPrice !== '' && it.estimatedUnitPrice !== it.autoPrice;
      const typedUnit = it.unit !== '' && it.unit !== it.autoUnit;
      return {
        ...it,
        unit: typedUnit ? it.unit : nextUnit,
        autoUnit: typedUnit ? it.autoUnit : nextUnit,
        estimatedUnitPrice: typedPrice ? it.estimatedUnitPrice : nextPrice,
        autoPrice: typedPrice ? it.autoPrice : nextPrice,
      };
    }));
  };

  const total = items.reduce((sum, it) => sum + (Number(it.estimatedUnitPrice) || 0) * (Number(it.quantity) || 0), 0);
  const reasonNeeded = purchaseType === 'EMERGENCY' || purchaseType === 'DIRECT';
  const missingPrice = pricingPending(items);
  const valid =
    items.length > 0 &&
    items.every((it) => it.description.trim() && Number(it.quantity) >= 1 && (askForPricing || Number(it.estimatedUnitPrice) > 0)) &&
    (!reasonNeeded || purchaseReason.trim());

  const submit = async (thenSubmitForApproval: boolean) => {
    setError('');
    setBusy(true);
    try {
      const created = await api<{ id: string; docNumber: string }>('/procurement/requests', {
        method: 'POST',
        body: {
          priority,
          purchaseType,
          purchaseReason: reasonNeeded ? purchaseReason.trim() : undefined,
          requiredDate: requiredDate || undefined,
          budgetCode: budgetCode.trim() || undefined,
          justification: justification.trim() || undefined,
          sourceSupplyRequestId: sourceOsr || undefined,
          askForPricing: askForPricing || undefined,
          items: items.map((it) => ({
            description: it.description.trim(),
            quantity: Number(it.quantity),
            unit: it.unit.trim() || undefined,
            estimatedUnitPrice: Number(it.estimatedUnitPrice) > 0 ? Number(it.estimatedUnitPrice) : undefined,
          })),
        },
      });
      if (!thenSubmitForApproval) {
        toast(`PR ${created.docNumber} saved as draft`);
      } else if (askForPricing && missingPrice) {
        await api(`/procurement/requests/${created.id}/request-pricing`, { method: 'POST' });
        toast(`PR ${created.docNumber} sent to Administration for pricing`);
      } else {
        await api(`/requests/${created.id}/submit`, { method: 'POST' });
        toast(`PR ${created.docNumber} submitted for approval`);
      }
      onClose();
    } catch (e) {
      const block = budgetBlockFrom(e);
      if (block) setBudgetBlock(block);
      else setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <>
    <Modal title="New purchase request" error={error} wide xl onClose={onClose}>
      <div className="space-y-4">
        {/* line items — bordered editor with desktop column headers; on small
            screens the grid stacks and placeholders label each field */}
        <div className="border border-gray-200 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Items</div>
            <span className="text-xs text-gray-400">{items.length} line{items.length === 1 ? '' : 's'}</span>
          </div>
          <div className="hidden md:grid grid-cols-12 gap-2 text-xs text-gray-500 px-1">
            <div className="col-span-5">Description</div>
            <div className="col-span-1">Qty</div>
            <div className="col-span-1">Unit</div>
            <div className="col-span-4">Unit price (Ks)</div>
            <div className="col-span-1 text-right" aria-hidden="true" />
          </div>
          {items.map((it, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-start">
              <div className="col-span-12 md:col-span-5">
                <Input
                  placeholder={`Item ${idx + 1} description *`}
                  list="pr-catalog-items"
                  title="Pick a catalog item to fill its unit and last paid price"
                  value={it.description}
                  onChange={(e) => {
                    setItem(idx, { description: e.target.value });
                    fillFromCatalog(idx, e.target.value);
                  }}
                />
              </div>
              <div className="col-span-4 md:col-span-1">
                <NumberField min={1} integer placeholder="Qty" title="Quantity" value={it.quantity} onChange={(quantity) => setItem(idx, { quantity })} />
              </div>
              <div className="col-span-4 md:col-span-1">
                <Input placeholder="Unit" value={it.unit} onChange={(e) => setItem(idx, { unit: e.target.value })} />
              </div>
              <div className="col-span-4 md:col-span-4">
                <Input
                  type="number"
                  min={0}
                  required={!askForPricing}
                  placeholder={askForPricing ? 'Price — Administration' : 'Unit price *'}
                  title={askForPricing
                    ? 'Optional here — Administration sets the estimate before approval'
                    : 'Estimated unit price in Kyat — required: the approval chain is chosen from the estimated total'}
                  value={it.estimatedUnitPrice}
                  onChange={(e) => setItem(idx, { estimatedUnitPrice: e.target.value })}
                />
              </div>
              <div className="col-span-12 md:col-span-1 flex justify-end">
                <Button variant="danger" title={`Remove item ${idx + 1}`} onClick={() => setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))}>
                  ×
                </Button>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" onClick={() => setItems((prev) => [...prev, emptyItem()])}>
              + Add item
            </Button>
            <div className="text-sm text-gray-600">
              Estimated total: <b>{fmtMoney(total)} Ks</b>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={askForPricing}
                onChange={(e) => setAskForPricing(e.target.checked)}
              />
              I don't know the prices — ask Administration to estimate
            </label>
            {askForPricing && missingPrice && <span className="text-xs text-gray-400">↳ prices filled by procurement before approval</span>}
          </div>
          {missingPrice && !askForPricing && (
            <div className="text-xs text-amber-700">
              Every line needs an estimated unit price — the approval chain is chosen from the estimated total.
              If you don't know it, tick “ask Administration to estimate”.
            </div>
          )}
          <div className="text-[11px] text-gray-400">
            Tip: pick an item from the catalog and its last paid price is filled in; edit it if the price changed.
          </div>
        </div>
        <datalist id="pr-catalog-items">
          {catalog.map((c) => (
            <option key={c.id} value={c.name}>{c.code}{c.lastUnitPrice != null ? ` · last ${fmtMoney(Number(c.lastUnitPrice))} Ks` : ''}</option>
          ))}
        </datalist>

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
            <label htmlFor="pr-type" className="text-xs text-gray-500 block mb-1">Purchase type (§36)</label>
            <Select id="pr-type" value={purchaseType} onChange={(e) => setPurchaseType(e.target.value)}>
              <option value="NORMAL">Normal</option>
              <option value="EMERGENCY">Emergency — reason required</option>
              <option value="DIRECT">Direct — reason required</option>
              <option value="PETTY_CASH">Petty cash</option>
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
          {reasonNeeded && (
            <div className="sm:col-span-2">
              <label htmlFor="pr-type-reason" className="text-xs text-gray-500 block mb-1">Reason for {purchaseType} purchase * (audited exception path)</label>
              <Textarea id="pr-type-reason" rows={2} placeholder="Why is the normal approval chain bypassed?" value={purchaseReason} onChange={(e) => setPurchaseReason(e.target.value)} />
            </div>
          )}
        </div>
        {osrOptions.length > 0 && (
          <div>
            <label htmlFor="pr-supply-request" className="text-xs text-gray-500 block mb-1">Buying for an office supply request (optional)</label>
            <Select id="pr-supply-request" value={sourceOsr} onChange={(e) => setSourceOsr(e.target.value)}>
              <option value="">— not linked —</option>
              {osrOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.docNumber} — {o.items}</option>
              ))}
            </Select>
            <div className="text-[11px] text-gray-400 mt-1">
              Links this PR to the supply request, so the OSR shows the PR → PO → GRN it was bought through.
            </div>
          </div>
        )}
        <div>
          <label htmlFor="pr-justification" className="text-xs text-gray-500 block mb-1">Purpose / justification (optional)</label>
          <Textarea id="pr-justification" rows={2} placeholder="Why is this purchase needed?" value={justification} onChange={(e) => setJustification(e.target.value)} />
        </div>
      </div>

      <div className="sticky bottom-0 -mx-5 px-5 py-3 mt-4 flex flex-wrap gap-2 justify-end bg-white border-t border-gray-100 rounded-b-xl">
        <Button disabled={!valid || busy} onClick={() => submit(true)}>
          {busy ? 'Submitting…' : askForPricing && missingPrice ? 'Send for pricing' : 'Submit for Approval'}
        </Button>
        <Button variant="ghost" disabled={!valid || busy} onClick={() => submit(false)}>
          Save as Draft
        </Button>
      </div>
    </Modal>
    {budgetBlock && <BudgetBlockedModal block={budgetBlock} onClose={() => setBudgetBlock(null)} />}
    </>
  );
}
