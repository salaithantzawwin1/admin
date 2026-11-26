import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Textarea } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BudgetBlockedModal, budgetBlockFrom, type BudgetBlock } from '../components/BudgetBlockedModal';
import { fmtDate } from '../util/yangonTime';
import { toast } from '../components/Toast';

// ---------------------------------------------------------------------------
// Purchase Orders + GRN receiving (Procurement design §15–20, phase P3).
// PO flow: create (DRAFT, from an APPROVED PR or ad-hoc) → approve → send to
// vendor → receive via GRN (partial deliveries OK) → fully received → close.
// GRN accepted consumable lines post stock IN into the inventory ledger.
// Every line charges an Account (design §17/§39): the purchasing stage is
// where classification happens — §9 budget check runs on PO create.
// ---------------------------------------------------------------------------

interface PoItem {
  id: string;
  description: string;
  quantity: number;
  unit?: string | null;
  unitPrice: string;
  inventoryItemId?: string | null;
  inventoryItem?: { code: string; name: string; unit: string; balance: number } | null;
  /** §39 — registered asset for non-stock lines (null until registered). */
  assetId?: string | null;
  asset?: { id: string; assetCode: string; name: string } | null;
  grnItems?: { receivedQty: number; acceptedQty: number; rejectedQty: number }[];
}

interface PoDetail extends PoRow {
  createdById?: string;
  sentToVendorAt?: string | null;
  closedAt?: string | null;
  cancelledAt?: string | null;
  note?: string | null;
  goodsReceipts?: {
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
  purchaseType?: string; // §W4 NORMAL/EMERGENCY/DIRECT/PETTY_CASH
  purchaseReason?: string | null;
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

interface PrLineDetail {
  id: string;
  description: string;
  quantity: number;
  unit?: string | null;
  estimatedUnitPrice?: string | null;
  accountId?: string | null;
}

interface PrDetail {
  docNumber: string;
  purchaseRequest?: { items: PrLineDetail[] } | null;
}

interface AccountOpt {
  id: string;
  code?: string | null;
  name: string;
}

/** The quotation behind a PR: its vendor becomes the default supplier, its lines the default prices. */
interface QuotedQuote {
  quoteNumber: string;
  supplier: { id: string; name: string };
  items: { description: string; quantity: number; unit?: string | null; unitPrice: number }[];
}

interface QuotedForPr {
  rfq: { docNumber: string } | null;
  quote: QuotedQuote | null;
}

/**
 * The price a PR line should start at: the vendor's quote when one covers the
 * line (same description, else the same position in an equal-length quote),
 * otherwise the estimate procurement set on the PR.
 */
function quotedUnitPrice(quote: QuotedQuote | null, line: PrLineDetail, index: number, lineCount: number) {
  const key = (s: string) => s.trim().toLowerCase();
  const match = quote?.items.find((q) => key(q.description) === key(line.description))
    ?? (quote && quote.items.length === lineCount ? quote.items[index] : undefined);
  return match && match.unitPrice > 0 ? match.unitPrice : null;
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

/** Human labels for the badges and the status filter (raw enums read badly). */
const PO_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  SENT_TO_VENDOR: 'Sent to vendor',
  PARTIALLY_RECEIVED: 'Partially received',
  FULLY_RECEIVED: 'Fully received',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};
const PO_STATUS_ORDER = ['DRAFT', 'APPROVED', 'SENT_TO_VENDOR', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED'];

/** Structured 409 payload when a PO costs more than the PR estimate allows. */
export interface EstimateOverrun {
  prNumber: string;
  estimate: number;
  total: number;
  percent: number;
  tolerancePercent: number;
}

function estimateOverrunFrom(e: unknown): EstimateOverrun | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.details as (Partial<EstimateOverrun> & { code?: string }) | undefined;
  if (d?.code !== 'ESTIMATE_EXCEEDED' || typeof d.estimate !== 'number' || typeof d.total !== 'number') return null;
  return {
    prNumber: d.prNumber ?? 'the linked PR',
    estimate: d.estimate,
    total: d.total,
    percent: d.percent ?? 0,
    tolerancePercent: d.tolerancePercent ?? 10,
  };
}

const money = (v: string | number) =>
  `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} Ks`;

const accepted = (it: PoItem) => (it.grnItems ?? []).reduce((s, g) => s + g.acceptedQty, 0);
const acceptedTotal = (items: PoItem[]) => items.reduce((s, i) => s + accepted(i), 0);
const orderedTotal = (items: PoItem[]) => items.reduce((s, i) => s + i.quantity, 0);
const poTotal = (items: PoItem[]) => items.reduce((s, i) => s + i.quantity * Number(i.unitPrice), 0);

interface LineDraft {
  /** Where this line's goods land on GRN: the store (stock) or the asset register. */
  track: 'STOCK' | 'ASSET';
  inventoryItemId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  accountId: string; // §17 — required: which account the line is charged to
}

const emptyLine = (): LineDraft => ({ track: 'ASSET', inventoryItemId: '', description: '', quantity: '1', unit: '', unitPrice: '', accountId: '' });

export default function PurchaseOrders() {
  const canManage = hasPermission('procurement.manage');
  const [pos, setPos] = useState<PoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  // approving a PO above the PR estimate asks once, then retries with the flag
  const [estimateWarn, setEstimateWarn] = useState<{ po: PoDetail | PoRow; info: EstimateOverrun } | null>(null);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItemOpt[]>([]);
  const [approvedPrs, setApprovedPrs] = useState<PrOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  // §9 budget block on PO create — same explain modal as the PR submit path
  const [budgetBlock, setBudgetBlock] = useState<BudgetBlock | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [prId, setPrId] = useState('');
  const [prBusy, setPrBusy] = useState(false);
  // the quotation behind the picked PR — shown, and changeable like everything else
  const [quoteSource, setQuoteSource] = useState<{
    rfq: string; quoteNumber: string; supplierId: string; supplierName: string;
  } | null>(null);
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [purchaseType, setPurchaseType] = useState('NORMAL');
  const [purchaseReason, setPurchaseReason] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  // create the missing inventory item right here, instead of leaving the line
  // unlinked (which quietly turns the receipt into a fixed asset)
  const canCreateItems = hasPermission('inventory.manage');
  const [newItemFor, setNewItemFor] = useState<number | null>(null);
  const [newItemDraft, setNewItemDraft] = useState({ name: '', unit: 'pcs', category: 'STATIONERY', minStock: '0' });
  const [newItemBusy, setNewItemBusy] = useState(false);
  const [newItemError, setNewItemError] = useState('');
  // "no inventory item = asset" is a real decision, so it is confirmed once
  const [confirmAssetLines, setConfirmAssetLines] = useState(false);

  const [detail, setDetail] = useState<PoDetail | null>(null);
  const [grnOpen, setGrnOpen] = useState(false);
  const [grnLines, setGrnLines] = useState<Record<string, { received: string; accepted: string; rejected: string; condition: string; registerAsset: boolean }>>({});
  const [grnRemarks, setGrnRemarks] = useState('');
  // received goods land in the asset register at this location
  const [grnLocationId, setGrnLocationId] = useState('');
  const [busy, setBusy] = useState(false);

  // §39 — register a fixed asset from a non-stock PO line
  const canRegisterAssets = hasPermission('assets.manage');
  const [regAsset, setRegAsset] = useState<{
    poItemId: string; description: string; name: string; categoryId: string;
    locationId: string; serialNumber: string; custodian: string;
  } | null>(null);
  const [assetCats, setAssetCats] = useState<{ id: string; name: string }[]>([]);
  const [assetLocs, setAssetLocs] = useState<{ id: string; name: string }[]>([]);

  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: PoRow[]; total: number }>(
        `/purchase-orders?page=${page}&pageSize=${PAGE_SIZE}${statusFilter ? `&status=${statusFilter}` : ''}`,
      );
      setPos(r.items);
      setTotal(r.total);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load purchase orders', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!canManage) return;
    api<{ items: Supplier[] } | Supplier[]>('/suppliers?pageSize=200').then((r) => setSuppliers((r as { items?: Supplier[] }).items ?? (r as Supplier[]))).catch(() => undefined);
    api<{ items: InventoryItemOpt[] } | InventoryItemOpt[]>('/inventory/items')
      .then((r) => setInventoryItems(Array.isArray(r) ? r : r.items ?? []))
      .catch(() => undefined);
    api<{ items: ({ id: string; docNumber: string; title?: string | null } | PrOption)[] }>('/procurement/requests?status=APPROVED&pageSize=50')
      .then((r) => setApprovedPrs((r as { items?: PrOption[] }).items ?? []))
      .catch(() => undefined);
    api<AccountOpt[]>('/procurement/accounts').then(setAccounts).catch(() => setAccounts([]));
  }, [canManage]);

  const openCreate = () => {
    setSupplierId('');
    setPrId('');
    setQuoteSource(null);
    setExpectedDelivery('');
    setPurchaseType('NORMAL');
    setPurchaseReason('');
    setNote('');
    setLines([emptyLine()]);
    setCreateOpen(true);
  };

  const loadInventoryItems = useCallback(async () => {
    const r = await api<{ items: InventoryItemOpt[] } | InventoryItemOpt[]>('/inventory/items');
    const list = Array.isArray(r) ? r : r.items ?? [];
    setInventoryItems(list);
    return list;
  }, []);

  const createInventoryItem = async (idx: number) => {
    const name = newItemDraft.name.trim();
    if (!name) return;
    setNewItemBusy(true);
    setNewItemError('');
    try {
      const created = await api<{ id: string; code: string }>('/inventory/items', {
        method: 'POST',
        body: {
          name,
          unit: newItemDraft.unit.trim() || 'pcs',
          category: newItemDraft.category,
          // opening stock stays 0 — the GRN posts the real quantity in
          balance: 0,
          minStock: Number(newItemDraft.minStock) || 0,
        },
      });
      const list = await loadInventoryItems();
      const item = list.find((i) => i.id === created.id);
      setLines((ls) => ls.map((l, i) => (i === idx
        ? {
            ...l,
            track: 'STOCK',
            inventoryItemId: created.id,
            description: item ? `${item.name} (${item.code})` : l.description,
            unit: item?.unit ?? l.unit,
          }
        : l)));
      setNewItemFor(null);
      setNewItemDraft({ name: '', unit: 'pcs', category: 'STATIONERY', minStock: '0' });
      toast(`${created.code} created — this line now posts to stock`);
    } catch (e) {
      setNewItemError(e instanceof Error ? e.message : 'Could not create the item');
    } finally {
      setNewItemBusy(false);
    }
  };

  const pickItem = (idx: number, itemId: string) => {
    const item = inventoryItems.find((i) => i.id === itemId);
    setLines((ls) =>
      ls.map((l, i) =>
        i === idx
          ? {
              ...l,
              track: itemId ? 'STOCK' : l.track,
              inventoryItemId: itemId,
              description: item ? `${item.name} (${item.code})` : l.description,
              unit: item?.unit ?? l.unit,
            }
          : l,
      ),
    );
  };

  /**
   * Picking an approved PR copies its lines — description, quantity, unit and the
   * agreed price — so the PO starts from what was approved and the price is
   * visible instead of being retyped. The vendor's quotation wins over the PR
   * estimate, because that is the price actually offered; the account stays open
   * because §17 classification and the §9 budget check happen on the PO.
   */
  const pickPr = async (id: string) => {
    setPrId(id);
    if (!id) return;
    setPrBusy(true);
    try {
      const [r, quoted] = await Promise.all([
        api<PrDetail>(`/procurement/requests/${id}`),
        api<QuotedForPr>(`/procurement/requests/${id}/quoted-suppliers`).catch(() => null),
      ]);
      const items = r.purchaseRequest?.items ?? [];
      if (items.length === 0) {
        toast(`${r.docNumber} has no lines to copy`, 'error');
        return;
      }
      const quote = quoted?.quote ?? null;
      let fromQuote = 0;
      const picked: LineDraft[] = items.map((it, idx) => {
        const quotedPrice = quotedUnitPrice(quote, it, idx, items.length);
        if (quotedPrice !== null) fromQuote += 1;
        const estimate = Number(it.estimatedUnitPrice);
        const price = quotedPrice ?? (estimate > 0 ? estimate : null);
        return {
          // a purchased item is a fixed asset until the buyer says otherwise; a
          // consumable line is flipped to 📦 Stock and pointed at a store item
          track: 'ASSET' as const,
          inventoryItemId: '',
          description: it.description,
          quantity: String(it.quantity),
          unit: it.unit ?? '',
          unitPrice: price === null ? '' : String(price),
          accountId: it.accountId ?? '',
        };
      });
      setLines(picked);
      // the vendor decision already taken on the RFQ (§14) follows the PR into
      // the PO: pre-fill the supplier too, keep it changeable
      if (quote && quoted?.rfq) {
        setSupplierId(quote.supplier.id);
        setQuoteSource({
          rfq: quoted.rfq.docNumber,
          quoteNumber: quote.quoteNumber,
          supplierId: quote.supplier.id,
          supplierName: quote.supplier.name,
        });
      } else {
        setQuoteSource(null);
      }
      const noPrice = picked.filter((l) => !l.unitPrice).length;
      toast(
        `${items.length} line${items.length === 1 ? '' : 's'} copied from ${r.docNumber}`
          + (fromQuote ? ` — ${fromQuote} priced from ${quote!.supplier.name}'s quote` : '')
          + (noPrice > 0 ? ` — ${noPrice} still need${noPrice === 1 ? 's' : ''} a price` : ''),
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the PR lines', 'error');
    } finally {
      setPrBusy(false);
    }
  };

  const estimatedTotal = () =>
    lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);

  /** Lines without an inventory item become assets — ask before doing that. */
  const createPo = () => {
    if (!supplierId) { toast('Pick a supplier', 'error'); return; }
    const assetLines = lines.filter((l) => l.description.trim() && !l.inventoryItemId);
    if (assetLines.length > 0 && !confirmAssetLines) {
      setConfirmAssetLines(true);
      return;
    }
    void submitPo();
  };

  const submitPo = async () => {
    const items = lines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        // ASSET lines deliberately carry no stock item — that is what makes the
        // GRN register them in the asset register instead of posting stock.
        inventoryItemId: l.track === 'STOCK' ? l.inventoryItemId || undefined : undefined,
        quantity: Number(l.quantity) || 0,
        unit: l.unit.trim() || undefined,
        unitPrice: Number(l.unitPrice) || 0,
        accountId: l.accountId,
      }));
    if (items.length === 0) { toast('At least one item is required', 'error'); return; }
    if (items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1)) { toast('Quantity must be a whole number (1 or more)', 'error'); return; }
    if (items.some((i) => i.unitPrice < 0)) { toast('Check the unit prices', 'error'); return; }
    if (items.some((i) => !i.accountId)) { toast('Pick an account for every line — it drives the budget check', 'error'); return; }
    if (lines.some((l) => l.description.trim() && l.track === 'STOCK' && !l.inventoryItemId)) {
      toast('Pick the stock item for every 📦 Stock line — or switch that line to 🏷 Asset', 'error');
      return;
    }
    const reasonNeeded = purchaseType === 'EMERGENCY' || purchaseType === 'DIRECT';
    if (reasonNeeded && !purchaseReason.trim()) { toast(`A reason is required for a ${purchaseType} purchase (§36)`, 'error'); return; }
    setBusy(true);
    try {
      await api('/purchase-orders', {
        method: 'POST',
        body: {
          supplierId,
          purchaseRequestId: prId || undefined,
          expectedDelivery: expectedDelivery || undefined,
          purchaseType,
          purchaseReason: reasonNeeded ? purchaseReason.trim() : undefined,
          note: note.trim() || undefined,
          items,
        },
      });
      toast('Purchase order created (DRAFT)');
      setCreateOpen(false);
      setPage(1);
      load();
    } catch (e) {
      const block = budgetBlockFrom(e);
      if (block) setBudgetBlock(block);
      else toast(e instanceof Error ? e.message : 'Could not create the PO', 'error');
    } finally {
      setBusy(false);
    }
  };

  const transition = async (
    po: PoDetail | PoRow,
    action: 'approve' | 'send' | 'close' | 'cancel',
    opts?: { confirmOverEstimate?: boolean },
  ) => {
    setBusy(true);
    try {
      await api(`/purchase-orders/${po.id}/${action}`, { method: 'POST', body: opts });
      toast(`PO ${po.poNumber} ${action === 'send' ? 'sent to vendor' : action + 'd'}`);
      setDetail(null);
      load();
    } catch (e) {
      const warn = estimateOverrunFrom(e);
      if (warn) {
        setEstimateWarn({ po, info: warn });
        return;
      }
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

  const ensureRegisterPickers = () => {
    if (assetCats.length === 0) {
      api<{ id: string; name: string }[]>('/procurement/asset-categories').then(setAssetCats).catch(() => undefined);
    }
    if (assetLocs.length === 0) {
      api<{ id: string; name: string }[]>('/procurement/asset-locations').then(setAssetLocs).catch(() => undefined);
    }
  };

  const openRegisterAsset = async (it: PoItem) => {
    setRegAsset({ poItemId: it.id, description: it.description, name: it.description, categoryId: '', locationId: '', serialNumber: '', custodian: '' });
    ensureRegisterPickers();
  };

  const submitRegisterAsset = async () => {
    if (!regAsset || !detail) return;
    setBusy(true);
    try {
      const a = await api<{ assetCode: string }>(`/assets/register-from-po/${regAsset.poItemId}`, {
        method: 'POST',
        body: {
          name: regAsset.name || regAsset.description,
          categoryId: regAsset.categoryId || undefined,
          locationId: regAsset.locationId || undefined,
          serialNumber: regAsset.serialNumber || undefined,
          custodian: regAsset.custodian || undefined,
        },
      });
      toast(`${a.assetCode} registered from ${detail.poNumber}`);
      setRegAsset(null);
      const refreshed = await api<PoDetail>(`/purchase-orders/${detail.id}`);
      setDetail(refreshed);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not register the asset', 'error');
    } finally {
      setBusy(false);
    }
  };

  const receivedFor = accepted;

  const grnDefaults = (d: PoDetail) => {
    const state: Record<string, { received: string; accepted: string; rejected: string; condition: string; registerAsset: boolean }> = {};
    for (const it of d.items) {
      const remaining = Math.max(0, it.quantity - receivedFor(it));
      // a non-stock line is a fixed asset by default; the receiver unticks a
      // service/installation line so no junk asset is created for it
      state[it.id] = { received: String(remaining), accepted: String(remaining), rejected: '0', condition: '', registerAsset: !it.inventoryItem };
    }
    return state;
  };

  const openGrn = () => {
    if (!detail) return;
    setGrnLines(grnDefaults(detail));
    setGrnRemarks('');
    setGrnLocationId('');
    ensureRegisterPickers();
    setGrnOpen(true);
  };

  const openGrnFromRow = async (po: PoRow) => {
    try {
      const r = await api<PoDetail>(`/purchase-orders/${po.id}`);
      setDetail(r);
      setGrnLines(grnDefaults(r));
      setGrnRemarks('');
      setGrnLocationId('');
      ensureRegisterPickers();
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
        registerAsset: grnLines[it.id]?.registerAsset ?? !it.inventoryItem,
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
      const r = await api<{ poStatus: string; grnNumber: string; assetsCreated?: { assetCode: string }[]; assetErrors?: string[] }>(`/purchase-orders/${detail.id}/grn`, {
        method: 'POST',
        body: { remarks: grnRemarks.trim() || undefined, locationId: grnLocationId || undefined, items },
      });
      toast(`GRN ${r.grnNumber} recorded — PO is now ${r.poStatus.replace(/_/g, ' ').toLowerCase()}`);
      if (r.assetsCreated?.length) {
        toast(`${r.assetsCreated.map((a) => a.assetCode).join(', ')} added to the asset register`);
      }
      if (r.assetErrors?.length) {
        toast(`Asset registration failed — register by hand: ${r.assetErrors.join('; ')}`, 'error');
      }
      setGrnOpen(false);
      setDetail(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record the GRN', 'error');
    } finally {
      setBusy(false);
    }
  };

  const canRecordGrn = (po: PoRow) =>
    canManage && ['SENT_TO_VENDOR', 'PARTIALLY_RECEIVED'].includes(po.status);

  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        subtitle="PO issuance and goods receiving (GRN) — approved purchase requests become orders"
        actions={canManage ? <Button onClick={openCreate}>+ New purchase order</Button> : undefined}
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
          <Select
            className="!w-48"
            aria-label="Filter purchase orders by status"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          >
            <option value="">All statuses</option>
            {PO_STATUS_ORDER.map((s) => <option key={s} value={s}>{PO_LABEL[s]}</option>)}
          </Select>
          <span className="text-xs text-gray-400 ml-auto">
            {total} order{total === 1 ? '' : 's'}
          </span>
        </div>
        {loading ? (
          <Empty label="Loading…" />
        ) : pos.length === 0 ? (
          <Empty label={statusFilter ? `No ${PO_LABEL[statusFilter].toLowerCase()} purchase orders` : 'No purchase orders yet — create one from an approved PR'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 font-medium">PO</th>
                  <th className="px-4 py-3 font-medium">Supplier</th>
                  <th className="px-4 py-3 font-medium">From PR</th>
                  <th className="hidden px-4 py-3 font-medium text-right xl:table-cell">Lines</th>
                  <th className="px-4 py-3 font-medium text-right">Total</th>
                  <th className="px-4 py-3 font-medium text-center">Status</th>
                  <th className="hidden px-4 py-3 font-medium lg:table-cell">Ordered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pos.map((po) => {
                  const tot = poTotal(po.items);
                  return (
                    <tr
                      key={po.id}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => openDetail(po)}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') openDetail(po); }}
                    >
                      <td className="px-4 py-3 font-medium whitespace-nowrap">{po.poNumber}</td>
                      <td className="px-4 py-3 min-w-[9rem]">{po.supplier.name}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-gray-600">{po.purchaseRequest?.request.docNumber ?? '—'}</td>
                      <td className="hidden px-4 py-3 text-right tabular-nums xl:table-cell">{po.items.length}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">{money(tot)}</td>
                      <td className="px-4 py-3 text-center whitespace-nowrap">
                        <Badge color={PO_STATUS[po.status] ?? 'gray'}>{PO_LABEL[po.status] ?? po.status}</Badge>
                        {po.purchaseType && po.purchaseType !== 'NORMAL' && (
                          <div className="mt-1" title={po.purchaseReason ?? undefined}>
                            <Badge color={po.purchaseType === 'EMERGENCY' ? 'red' : 'orange'}>{po.purchaseType}</Badge>
                          </div>
                        )}
                        {canRecordGrn(po) && (
                          <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" title="Record the goods received note for this PO" onClick={() => void openGrnFromRow(po)}>
                              📥 GRN
                            </Button>
                          </div>
                        )}
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap text-gray-600 lg:table-cell">{fmtDate(po.orderDate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE_SIZE && (
          <div className="flex gap-2 justify-center px-4 py-3 border-t border-gray-100">
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</Button>
            <span className="text-sm text-gray-500 self-center">Page {page} / {Math.ceil(total / PAGE_SIZE)}</span>
            <Button disabled={page * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Next ›</Button>
          </div>
        )}
      </Card>

      {/* ---------------- create PO ---------------- */}
      {createOpen && (
        <Modal onClose={() => setCreateOpen(false)} title="New purchase order" wide xl>
          <div className="space-y-4">
            <section className="rounded-xl border border-gray-200 p-3 space-y-3">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Order details</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label htmlFor="po-supplier" className="text-xs text-gray-500 block mb-1">Supplier *</label>
                  <Select id="po-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                    <option value="">— pick a supplier —</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                  {quoteSource && quoteSource.supplierId === supplierId && (
                    <div className="text-[11px] text-green-700 mt-1">
                      ★ {quoteSource.supplierName} quoted on {quoteSource.rfq} — change it if this order goes elsewhere.
                    </div>
                  )}
                </div>
                <div>
                  <label htmlFor="po-expected" className="text-xs text-gray-500 block mb-1">Expected delivery</label>
                  <Input id="po-expected" type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="po-pr" className="text-xs text-gray-500 block mb-1">From approved PR — copies its lines, quantities and prices</label>
                  <Select id="po-pr" value={prId} onChange={(e) => void pickPr(e.target.value)} disabled={prBusy}>
                    <option value="">— ad-hoc / direct purchase —</option>
                    {approvedPrs.map((p) => <option key={p.id} value={p.id}>{p.docNumber}{p.title ? ` — ${p.title}` : ''}</option>)}
                  </Select>
                  <p className="text-[11px] text-gray-400 mt-1">
                    {prBusy
                      ? 'Loading the PR and its quotations…'
                      : 'Quotations recorded on the RFQ raised for that PR supply the supplier and the unit prices.'}
                  </p>
                </div>
                <div>
                  <label htmlFor="po-type" className="text-xs text-gray-500 block mb-1">Purchase type (§36)</label>
                  <Select id="po-type" value={purchaseType} onChange={(e) => setPurchaseType(e.target.value)}>
                    <option value="NORMAL">Normal</option>
                    <option value="EMERGENCY">Emergency — reason required</option>
                    <option value="DIRECT">Direct — reason required</option>
                    <option value="PETTY_CASH">Petty cash</option>
                  </Select>
                </div>
              </div>
              {(purchaseType === 'EMERGENCY' || purchaseType === 'DIRECT') && (
                <div>
                  <label htmlFor="po-type-reason" className="text-xs text-gray-500 block mb-1">Reason for {purchaseType} purchase * (audited exception path)</label>
                  <Textarea id="po-type-reason" rows={2} placeholder="Why is the normal approval chain bypassed?" value={purchaseReason} onChange={(e) => setPurchaseReason(e.target.value)} />
                </div>
              )}
            </section>

            {/* line items — pick an inventory item only for stock (consumable) goods */}
            <section className="rounded-xl border border-gray-200">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-gray-100 bg-gray-50/60 rounded-t-xl">
                <div className="text-xs font-medium text-gray-600 uppercase tracking-wide">Items ({lines.length})</div>
                <span className="text-[11px] text-gray-500">📦 Stock posts to the store on GRN · 🏷️ Asset registers an AST record</span>
              </div>
              {quoteSource && (
                <div className="mx-3 mt-3 rounded-lg bg-green-50 border border-green-100 px-3 py-2 text-[11px] text-green-800">
                  Unit prices filled from {quoteSource.rfq} quote #{quoteSource.quoteNumber} ({quoteSource.supplierName}). Edit any line if this order differs.
                </div>
              )}
              <div className="p-3 space-y-2">
              {/* 13 tracks on md+: the 12 labelled columns plus the remove button */}
              <div className="hidden md:grid md:grid-cols-[repeat(13,minmax(0,1fr))] gap-2 text-xs text-gray-500 px-1">
                <div className="col-span-3">Receipt (Stock / Asset)</div>
                <div className="col-span-3">Description *</div>
                <div className="col-span-1">Qty *</div>
                <div className="col-span-1">Unit</div>
                <div className="col-span-2">Unit price (Ks) *</div>
                <div className="col-span-2">Account *</div>
              </div>
              {lines.map((l, idx) => (
                <div key={idx} className="grid grid-cols-12 md:grid-cols-[repeat(13,minmax(0,1fr))] gap-2 items-start">
                  <div className="col-span-12 md:col-span-3 space-y-1">
                    {/* One decision per line: the store (stock) or the asset register. */}
                    <div className="flex rounded-lg border border-gray-200 p-0.5 bg-gray-50" role="group" aria-label={`Receipt type for line ${idx + 1}`}>
                      <button
                        type="button"
                        aria-pressed={l.track === 'STOCK'}
                        onClick={() => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, track: 'STOCK' } : x)))}
                        className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${l.track === 'STOCK' ? 'bg-white shadow text-green-700' : 'text-gray-500 hover:text-gray-700'}`}
                        title="Consumables / bulk goods — the GRN posts them into the inventory ledger"
                      >
                        📦 Stock
                      </button>
                      <button
                        type="button"
                        aria-pressed={l.track === 'ASSET'}
                        onClick={() => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, track: 'ASSET', inventoryItemId: '' } : x)))}
                        className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${l.track === 'ASSET' ? 'bg-white shadow text-orange-700' : 'text-gray-500 hover:text-gray-700'}`}
                        title="Fixed asset — the GRN creates an asset record (AST-…) and posts no stock"
                      >
                        🏷️ Asset
                      </button>
                    </div>
                    {l.track === 'STOCK' ? (
                      <Select value={l.inventoryItemId} onChange={(e) => pickItem(idx, e.target.value)} aria-label={`Stock item for line ${idx + 1}`}>
                        <option value="">— pick a stock item * —</option>
                        {inventoryItems.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name} ({i.balance} {i.unit})</option>)}
                      </Select>
                    ) : (
                      <div className="text-[11px] text-orange-700 leading-tight">Registered on GRN as an AST-… asset.</div>
                    )}
                  </div>
                  <div className="col-span-6 md:col-span-3">
                    <Input placeholder={`Line ${idx + 1} description *`} value={l.description} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, description: e.target.value } : x))} />
                  </div>
                  <div className="col-span-3 md:col-span-1">
                    <Input type="number" min={1} placeholder="Qty" title="Quantity" value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, quantity: e.target.value } : x))} />
                  </div>
                  <div className="col-span-3 md:col-span-1">
                    <Input placeholder="Unit" value={l.unit} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, unit: e.target.value } : x))} />
                  </div>
                  <div className="col-span-6 md:col-span-2">
                    <Input type="number" min={0} placeholder="Unit price (Ks)" title="Unit price in Kyat" value={l.unitPrice} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, unitPrice: e.target.value } : x))} />
                  </div>
                  <div className="col-span-9 md:col-span-2">
                    <Select value={l.accountId} onChange={(e) => setLines((ls) => ls.map((x, i) => i === idx ? { ...x, accountId: e.target.value } : x))} aria-label={`Account for line ${idx + 1}`}>
                      <option value="">Account… *</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code ? `${a.code} — ` : ''}
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="col-span-3 md:col-span-1 flex justify-end">
                    <Button variant="danger" title={`Remove line ${idx + 1}`} onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))} disabled={lines.length <= 1}>✕</Button>
                  </div>
                  {l.track === 'STOCK' && !l.inventoryItemId && (
                    <div className="col-span-12 -mt-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-gray-500">No stock item yet — pick one above, or create it here.</span>
                        {canCreateItems && (
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setNewItemFor(newItemFor === idx ? null : idx);
                              setNewItemError('');
                            }}
                          >
                            ＋ New inventory item
                          </Button>
                        )}
                      </div>
                      {newItemFor === idx && (
                        <div className="mt-2 border border-gray-200 rounded-lg p-2 bg-gray-50 space-y-2">
                          {newItemError && <div className="text-xs text-red-600">{newItemError}</div>}
                          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                            <Input
                              className="sm:col-span-2"
                              placeholder={`Item name * (e.g. ${l.description || 'Wireless Mouse'})`}
                              value={newItemDraft.name}
                              onChange={(e) => setNewItemDraft({ ...newItemDraft, name: e.target.value })}
                            />
                            <Input placeholder="Unit" value={newItemDraft.unit} onChange={(e) => setNewItemDraft({ ...newItemDraft, unit: e.target.value })} />
                            <Select value={newItemDraft.category} onChange={(e) => setNewItemDraft({ ...newItemDraft, category: e.target.value })} aria-label="Item category">
                              {['STATIONERY', 'BOOKS', 'PAPER', 'ELECTRONICS', 'CLEANING', 'KITCHEN', 'FURNITURE', 'IT_SUPPLIES', 'OTHER'].map((c) => (
                                <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
                              ))}
                            </Select>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              className="!w-28"
                              type="number"
                              min={0}
                              placeholder="Min stock"
                              value={newItemDraft.minStock}
                              onChange={(e) => setNewItemDraft({ ...newItemDraft, minStock: e.target.value })}
                            />
                            <Button disabled={newItemBusy || !newItemDraft.name.trim()} onClick={() => void createInventoryItem(idx)}>
                              {newItemBusy ? 'Creating…' : 'Create & use on this line'}
                            </Button>
                            <span className="text-xs text-gray-400">Opening stock stays 0 — the GRN posts the real quantity.</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-gray-100 bg-gray-50/60 rounded-b-xl">
                <Button variant="ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Add line</Button>
                <div className="text-sm text-gray-600">
                  <span className="text-xs text-gray-400 mr-2">quantity × unit price</span>
                  Total <b className="tabular-nums">{money(estimatedTotal())}</b>
                </div>
              </div>
            </section>

            <div>
              <label htmlFor="po-note" className="text-xs text-gray-500 block mb-1">Note</label>
              <Textarea id="po-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 sticky bottom-0 -mx-5 px-5 py-3 bg-white border-t border-gray-100 rounded-b-xl">
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
              <Badge color={PO_STATUS[detail.status] ?? 'gray'}>{PO_LABEL[detail.status] ?? detail.status}</Badge>
              {detail.purchaseType && detail.purchaseType !== 'NORMAL' && (
                <Badge color={detail.purchaseType === 'EMERGENCY' ? 'red' : 'orange'}>{detail.purchaseType}</Badge>
              )}
              {detail.purchaseReason && (
                <span className="text-sm text-gray-500" title="Reason for the exception path (§36)">Reason: {detail.purchaseReason}</span>
              )}
              {detail.purchaseRequest && (
                <span className="text-sm text-gray-500">PR: {detail.purchaseRequest.request.docNumber}</span>
              )}
              <span className="text-sm text-gray-500">Ordered {fmtDate(detail.orderDate)}</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-gray-50 rounded-lg px-3 py-2 text-sm">
              <div>
                <div className="text-xs text-gray-400">Order total</div>
                <div className="font-semibold tabular-nums">{money(poTotal(detail.items))}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400">Received</div>
                <div className="tabular-nums">
                  {acceptedTotal(detail.items)} of {orderedTotal(detail.items)} accepted
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-400">Expected delivery</div>
                <div>{detail.expectedDelivery ? fmtDate(detail.expectedDelivery) : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400">Sent to vendor</div>
                <div>{detail.sentToVendorAt ? fmtDate(detail.sentToVendorAt) : '—'}</div>
              </div>
            </div>

            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-1 pr-2">Item</th>
                  <th className="py-1 pr-2">Stock?</th>
                  <th className="py-1 pr-2 text-right">Ordered</th>
                  <th className="py-1 pr-2 text-right">Received</th>
                  <th className="py-1 pr-2 text-right">Unit price</th>
                  <th className="py-1 pr-2 text-right">Amount</th>
                  <th className="py-1 pr-2">Asset</th>
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
                      <td className="py-1 pr-2 text-right whitespace-nowrap">{money(it.unitPrice)}</td>
                      <td className="py-1 pr-2 text-right whitespace-nowrap tabular-nums">{money(it.quantity * Number(it.unitPrice))}</td>
                      <td className="py-1 pr-2">
                        {it.asset ? (
                          <span className="text-green-700 font-medium" title={it.asset.name}>🏷 {it.asset.assetCode}</span>
                        ) : !it.inventoryItem && canRegisterAssets && rec > 0 ? (
                          <Button variant="ghost" onClick={() => void openRegisterAsset(it)}>🏷 Register asset</Button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>

            {detail.note && <div className="text-sm text-gray-600">Note: {detail.note}</div>}

            {(detail.goodsReceipts?.length ?? 0) > 0 && (
              <div className="text-sm text-gray-600 space-y-1">
                <div className="font-medium">Goods received notes</div>
                {detail.goodsReceipts!.map((g) => (
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
        <Modal onClose={() => setGrnOpen(false)} title={`Record GRN — ${detail.poNumber}`} wide xl>
          <div className="space-y-3">
            <div className="text-sm text-gray-600">
              Accepted stock quantities post straight into the inventory ledger. 📦 lines are stock items; plain lines are assets/services (no stock).
              Accepted units of a plain line are registered as assets automatically — untick a line that is a service, not a thing.
            </div>
            <div className="max-w-sm">
              <label htmlFor="grn-location" className="text-xs text-gray-500 block mb-1">Delivered to (asset location)</label>
              <Select id="grn-location" value={grnLocationId} onChange={(e) => setGrnLocationId(e.target.value)}>
                <option value="">— none —</option>
                {assetLocs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
            <div className="hidden md:grid grid-cols-4 gap-2 text-xs text-gray-500 px-3">
              <div>Received *</div>
              <div>Accepted *</div>
              <div>Rejected *</div>
              <div>Condition notes</div>
            </div>
            {detail.items.map((it) => {
              const g = grnLines[it.id] ?? { received: '0', accepted: '0', rejected: '0', condition: '', registerAsset: !it.inventoryItem };
              return (
                <div key={it.id} className="border border-gray-200 rounded-lg p-2">
                  <div className="flex justify-between text-sm mb-2">
                    <span className="font-medium">{it.description}</span>
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
                  {it.inventoryItem ? (
                    <div className="mt-2 text-xs text-green-700">
                      📦 Stock line ({it.inventoryItem.code}) — accepted units post into the inventory ledger.
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                      <Select
                        className="!w-60"
                        aria-label={`Receipt handling for ${it.description}`}
                        value={g.registerAsset ? 'ASSET' : 'SERVICE'}
                        onChange={(e) => setGrnLines((s) => ({ ...s, [it.id]: { ...g, registerAsset: e.target.value === 'ASSET' } }))}
                      >
                        <option value="ASSET">🏷️ Fixed asset — register</option>
                        <option value="SERVICE">🛠 Service — no asset</option>
                      </Select>
                      <span className="text-gray-400">
                        {g.registerAsset
                          ? 'Accepted units become asset records (no stock).'
                          : 'Accepted units are received but register nothing.'}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
            <div>
              <label htmlFor="grn-remarks" className="text-xs text-gray-500 block mb-1">Remarks (optional)</label>
              <Textarea id="grn-remarks" rows={2} value={grnRemarks} onChange={(e) => setGrnRemarks(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 sticky bottom-0 -mx-5 px-5 py-3 bg-white border-t border-gray-100 rounded-b-xl">
              <Button variant="ghost" onClick={() => setGrnOpen(false)}>Cancel</Button>
              <Button disabled={busy} onClick={submitGrn}>Record GRN & post stock</Button>
            </div>
          </div>
        </Modal>
      )}

      {budgetBlock && <BudgetBlockedModal block={budgetBlock} onClose={() => setBudgetBlock(null)} />}

      {estimateWarn && (
        <ConfirmDialog
          title="PO is above the approved PR estimate"
          description={<>
            <p>
              <b>{estimateWarn.info.prNumber}</b> was approved for <b>{money(estimateWarn.info.estimate)}</b>.
              This PO totals <b>{money(estimateWarn.info.total)}</b> — <b>{estimateWarn.info.percent}% higher</b>{' '}
              (tolerance {estimateWarn.info.tolerancePercent}%).
            </p>
            <p className="mt-2 text-xs text-gray-500">
              Approving again confirms the overrun; it is written to the audit log.
            </p>
          </>}
          confirmLabel="Approve with overrun"
          onClose={() => setEstimateWarn(null)}
          onConfirm={async () => {
            const po = estimateWarn.po;
            setEstimateWarn(null);
            await transition(po, 'approve', { confirmOverEstimate: true });
          }}
        />
      )}

      {confirmAssetLines && (
        <ConfirmDialog
          title="These lines will be assets, not stock"
          description={lines.filter((l) => l.description.trim() && !l.inventoryItemId).map((l) => `• ${l.description}`).join('\n') + '\n\nNo inventory item is linked, so the GRN registers them in the asset register and nothing enters the store. Create/link an inventory item instead if the store should issue them.'}
          confirmLabel="Continue as asset"
          onClose={() => setConfirmAssetLines(false)}
          onConfirm={async () => { setConfirmAssetLines(false); await submitPo(); }}
        />
      )}

      {/* ---------------- register asset from a PO line (§39) ---------------- */}
      {regAsset && (
        <Modal onClose={() => setRegAsset(null)} title={`Register asset — ${regAsset.description}`} wide>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Asset name *</label>
              <Input value={regAsset.name} onChange={(e) => setRegAsset({ ...regAsset, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Serial number</label>
              <Input value={regAsset.serialNumber} onChange={(e) => setRegAsset({ ...regAsset, serialNumber: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Category</label>
              <Select value={regAsset.categoryId} onChange={(e) => setRegAsset({ ...regAsset, categoryId: e.target.value })}>
                <option value="">— none —</option>
                {assetCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Location</label>
              <Select value={regAsset.locationId} onChange={(e) => setRegAsset({ ...regAsset, locationId: e.target.value })}>
                <option value="">— none —</option>
                {assetLocs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-gray-500 mb-1">Custodian</label>
              <Input value={regAsset.custodian} onChange={(e) => setRegAsset({ ...regAsset, custodian: e.target.value })} placeholder="Person / department" />
            </div>
            <div className="sm:col-span-2 text-xs text-gray-400">
              Cost and purchase date are taken from this PO line (accepted quantity × unit price, first GRN date).
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setRegAsset(null)}>Cancel</Button>
            <Button disabled={busy || !regAsset.name.trim()} onClick={() => void submitRegisterAsset()}>Register asset</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
