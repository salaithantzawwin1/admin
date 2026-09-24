import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, getToken, hasPermission } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Textarea } from '../components/ui';

interface Item {
  id: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  balance: number;
  minStock: number;
  reorderLevel?: number | null;
  description?: string;
  isActive: boolean;
  imageStoredName?: string | null;
  lastUnitPrice?: number | string | null;
  updatedAt?: string;
  low?: boolean;
  out?: boolean;
}

interface SpendingEntry { quantity: number; unitPrice: number | null; reference: string | null; supplier?: string | null; createdAt: string }
interface ReorderRow {
  itemId: string; code: string; name: string; unit: string;
  balance: number; threshold: number; reorderLevel: number | null;
  suggestedQty: number; lastUnitPrice: number | null; estimatedCost: number | null;
}
interface Supplier { id: string; name: string; phone?: string | null; address?: string | null; note?: string | null; isActive: boolean }
interface Spending {
  monthStart: string;
  monthEnd: string;
  total: number;
  suppliers: { supplier: string; qty: number; cost: number; avgUnitPrice: number | null; noPrice: boolean }[];
  items: { itemId: string; code: string; name: string; unit: string; qty: number; cost: number; avgUnitPrice: number | null; noPrice: boolean; estimated?: boolean; entries: SpendingEntry[] }[];
}

interface SupplyLine {
  id: string;
  itemId: string;
  quantity: number;
  status: string;
  fulfilledQty: number;
  item?: { code: string; name: string; unit: string };
}

interface MyRequest {
  id: string;
  docNumber: string;
  status: string;
  createdAt: string;
  supplyRequest?: { status: string; note?: string; lines: SupplyLine[] } | null;
}

interface PendingRequest {
  id: string;
  docNumber: string;
  createdAt: string;
  status?: string;
  requester?: { fullName: string } | null;
  department?: { name: string } | null;
  supplyRequest?: { status: string; note?: string; lines: (SupplyLine & { item: { code: string; name: string; unit: string; balance: number } })[] } | null;
}

interface Txn {
  id: string;
  type: string;
  quantity: number;
  balanceAfter: number;
  reference?: string;
  unitPrice?: number | string | null;
  createdAt: string;
  createdBy?: { fullName: string } | null;
  // Who/What enrichment (ISSUE rows): who received the stock + linked request title
  issuedTo?: string | null;
  requestTitle?: string | null;
}

const ITEM_CATEGORIES = ['STATIONERY', 'BOOKS', 'PAPER', 'ELECTRONICS', 'CLEANING', 'KITCHEN', 'FURNITURE', 'IT_SUPPLIES', 'OTHER'];

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = {
  PENDING: 'yellow',
  APPROVED: 'green',
  REJECTED: 'red',
  FULFILLED: 'green',
  PARTIAL: 'blue',
  COMPLETED: 'green',
  CANCELLED: 'gray',
};

type Tab = 'catalog' | 'management' | 'purchases';
type MgmtTab = 'queue' | 'restock' | 'alerts' | 'reorder' | 'items';

const ITEMS_PER_PAGE = 10;

/** Shrink + convert any picked image to a small square-ish JPEG before upload (5 MB → ~50 KB). */
async function resizeToJpeg(file: File, maxDim = 512, quality = 0.82): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported in this browser');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Resize failed'))), 'image/jpeg', quality);
  });
}

// item images are JWT-protected now — <img> tags pass the token via query param
const itemImageUrl = (i: Item) =>
  `/api/inventory/items/${i.id}/image?v=${encodeURIComponent(i.updatedAt ?? '')}&token=${encodeURIComponent(getToken() ?? '')}`;

/** Stock health: 100% ≈ 3× the alert threshold (or full when no threshold set). */
const stockPct = (i: Item) => {
  if (i.out) return 0;
  const target = i.minStock > 0 ? i.minStock * 3 : Math.max(i.balance, 1);
  return Math.min(100, Math.round((i.balance / target) * 100));
};

const spendWindow = (d: Date) => ({
  start: new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString(),
  end: new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString(),
  label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
});

const fmtMoney = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function Inventory() {
  const canManage = hasPermission('inventory.manage');
  // active tab lives in the URL (?tab=purchases) so refresh / back / shared links keep it
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as Tab | null;
  const tab: Tab = tabParam === 'management' || tabParam === 'purchases' ? tabParam : 'catalog';
  const setTab = (t: Tab) => setSearchParams(t === 'catalog' ? {} : { tab: t }, { replace: false });
  // Management sub-tab also lives in the URL (?tab=management&sub=restock)
  // so refresh / back / shared links land on the exact working view
  const mgmtParam = searchParams.get('sub') as MgmtTab | null;
  const mgmtTab: MgmtTab =
    mgmtParam === 'queue' || mgmtParam === 'restock' || mgmtParam === 'alerts' || mgmtParam === 'reorder' || mgmtParam === 'items'
      ? mgmtParam
      : 'queue';
  const setMgmtTab = (m: MgmtTab) => setSearchParams({ tab: 'management', ...(m === 'queue' ? {} : { sub: m }) }, { replace: false });
  const [view, setView] = useState<'table' | 'grid'>(() =>
    localStorage.getItem('ams.inventoryView') === 'table' ? 'table' : 'grid',
  );
  const setViewPersist = (v: 'table' | 'grid') => {
    setView(v);
    try { localStorage.setItem('ams.inventoryView', v); } catch { /* private mode */ }
  };
  const [items, setItems] = useState<Item[]>([]);
  const [mine, setMine] = useState<MyRequest[]>([]);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // request modal state
  const [requestFor, setRequestFor] = useState<Item | null>(null);
  const [requestQty, setRequestQty] = useState(1);
  const [requestNote, setRequestNote] = useState('');

  // multi-item cart for the "new request" flow
  const [cart, setCart] = useState<Record<string, number>>({});
  const [cartNote, setCartNote] = useState('');
  const [showCart, setShowCart] = useState(false);

  // restock form
  const [restock, setRestock] = useState({ itemId: '', quantity: 1, reference: '', unitPrice: '', supplierId: '' });

  // spending report + low-stock alert (management)
  const [spending, setSpending] = useState<Spending | null>(null);
  const [spendMonth, setSpendMonth] = useState(() => new Date());
  const [alertMsg, setAlertMsg] = useState('');
  const [alertBusy, setAlertBusy] = useState(false);
  const [reorder, setReorder] = useState<ReorderRow[]>([]);
  // items-master pagination
  const [itemPage, setItemPage] = useState(1);
  const [itemQuery, setItemQuery] = useState('');

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  // item create/edit
  const [itemForm, setItemForm] = useState<Partial<Item> & { balance?: number } | null>(null);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [deletingItem, setDeletingItem] = useState<Item | null>(null);
  // reason-prompt dialogs (in-app, replaces window.prompt)
  const [cancelFor, setCancelFor] = useState<PendingRequest | null>(null);
  const [rejectFor, setRejectFor] = useState<PendingRequest | null>(null);

  // history viewer
  const [historyFor, setHistoryFor] = useState<Item | null>(null);
  // Ledger modal filters — movement type + date window
  const [ledgerFilter, setLedgerFilter] = useState<'ALL' | 'IN' | 'OUT'>('ALL');
  const [ledgerFrom, setLedgerFrom] = useState('');
  const [ledgerTo, setLedgerTo] = useState('');
  const [history, setHistory] = useState<Txn[]>([]);
  const [lifetime, setLifetime] = useState<{ qty: number; cost: number; unit: string } | null>(null);

  // item photo preview (lightbox) + upload
  const [previewFor, setPreviewFor] = useState<Item | null>(null);
  const [imageFor, setImageFor] = useState<Item | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  const [imageRemove, setImageRemove] = useState(false);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState('');

  const load = useCallback(() => {
    api<Item[]>('/inventory/items').then(setItems).catch((e) => setError(e.message));
    api<MyRequest[]>('/inventory/requests/mine').then(setMine).catch(() => setMine([]));
    if (hasPermission('inventory.manage')) {
      api<PendingRequest[]>('/inventory/requests/pending').then(setPending).catch(() => setPending([]));
    }
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!canManage) return;
    const w = spendWindow(spendMonth);
    api<Spending>(`/inventory/spending?start=${w.start}&end=${w.end}`).then(setSpending).catch(() => setSpending(null));
    api<ReorderRow[]>('/inventory/reorder-suggestions').then(setReorder).catch(() => setReorder([]));
  }, [spendMonth, canManage]);

  const loadSuppliers = useCallback(() => {
    if (!canManage) return;
    api<Supplier[]>('/inventory/suppliers').then(setSuppliers).catch(() => setSuppliers([]));
  }, [canManage]);
  useEffect(loadSuppliers, [loadSuppliers]);

  const openImageModal = (i: Item) => {
    setImageFor(i);
    setImageFile(null);
    setImageRemove(false);
    setImagePreview(i.imageStoredName ? itemImageUrl(i) : '');
    setImgError('');
  };

  const pickImage = (f: File | null) => {
    if (imagePreview.startsWith('blob:')) URL.revokeObjectURL(imagePreview);
    setImageRemove(false);
    setImageFile(f);
    setImagePreview(f ? URL.createObjectURL(f) : '');
  };

  const removePickedImage = () => {
    if (imagePreview.startsWith('blob:')) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImageRemove(true);
    setImagePreview('');
  };

  const closeImageModal = () => {
    if (imagePreview.startsWith('blob:')) URL.revokeObjectURL(imagePreview);
    setImageFor(null);
    setImageFile(null);
    setImagePreview('');
  };

  const saveImage = async () => {
    if (!imageFor) return;
    setImgBusy(true);
    setImgError('');
    try {
      if (imageFile) {
        const blob = await resizeToJpeg(imageFile);
        const fd = new FormData();
        fd.append('file', blob, 'item.jpg');
        const res = await fetch(`/api/inventory/items/${imageFor.id}/image`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd,
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Upload failed');
      } else if (imageRemove) {
        await api(`/inventory/items/${imageFor.id}/image`, { method: 'DELETE' });
      } else {
        setImgBusy(false);
        return;
      }
      if (imagePreview.startsWith('blob:')) URL.revokeObjectURL(imagePreview);
      setImageFor(null);
      setImageFile(null);
      setImagePreview('');
      load();
    } catch (e) {
      setImgError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setImgBusy(false);
    }
  };

  const openHistory = async (item: Item) => {
    setHistoryFor(item);
    setLifetime(null);
    setLedgerFilter('ALL');
    setLedgerFrom('');
    setLedgerTo('');
    try {
      setHistory(await api<Txn[]>(`/inventory/items/${item.id}/history`));
    } catch {
      setHistory([]);
    }
    try {
      const totals = await api<{ itemId: string; qty: number; cost: number }[]>('/inventory/purchase-totals');
      const t = totals.find((x) => x.itemId === item.id);
      if (t) setLifetime({ qty: t.qty, cost: t.cost, unit: item.unit });
    } catch { /* totals are supplementary */ }
  };

  /** Full movement ledger CSV — Received/Issued with Who/When/What for the window. */
  const downloadLedgerCsv = async () => {
    setBusy(true);
    setError('');
    try {
      const w = spendWindow(spendMonth);
      const res = await fetch(`/api/inventory/ledger.csv?start=${w.start}&end=${w.end}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `stock-ledger-${spendMonth.getFullYear()}-${String(spendMonth.getMonth() + 1).padStart(2, '0')}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = async () => {
    setBusy(true);
    setError('');
    try {
      const w = spendWindow(spendMonth);
      const res = await fetch(`/api/inventory/spending.csv?start=${w.start}&end=${w.end}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `purchases-${spendMonth.getFullYear()}-${String(spendMonth.getMonth() + 1).padStart(2, '0')}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const submitCart = async () => {
    const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([itemId, quantity]) => ({ itemId, quantity }));
    if (lines.length === 0) return;
    setBusy(true);
    setError('');
    try {
      await api('/inventory/requests', { method: 'POST', body: { items: lines, note: cartNote.trim() || undefined } });
      setCart({});
      setCartNote('');
      setShowCart(false);
      toast('Supply request submitted — Administration will review it.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const submitSingle = async () => {
    if (!requestFor) return;
    setBusy(true);
    setError('');
    try {
      await api('/inventory/requests', {
        method: 'POST',
        body: { items: [{ itemId: requestFor.id, quantity: requestQty }], note: requestNote.trim() || undefined },
      });
      setRequestFor(null);
      setRequestQty(1);
      setRequestNote('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const doFulfill = async (requestId: string) => {
    setError('');
    try {
      await api(`/inventory/requests/${requestId}/fulfill`, { method: 'POST' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doAdminCancel = async (requestId: string, reason?: string) => {
    setError('');
    try {
      await api(`/inventory/requests/${requestId}/admin-cancel`, { method: 'POST', body: { reason } });
      setCancelFor(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      throw e; // ConfirmDialog keeps itself open and shows the error inside
    }
  };

  const doRejectFulfill = async (requestId: string, reason?: string) => {
    setError('');
    try {
      await api(`/inventory/requests/${requestId}/reject`, { method: 'POST', body: { reason } });
      setRejectFor(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      throw e; // ConfirmDialog keeps itself open and shows the error inside
    }
  };

  const doRestock = async () => {
    if (!restock.itemId || restock.quantity <= 0) return;
    setBusy(true);
    setError('');
    try {
      await api('/inventory/restock', {
        method: 'POST',
        body: {
          itemId: restock.itemId,
          quantity: Number(restock.quantity),
          reference: restock.reference.trim() || undefined,
          unitPrice: restock.unitPrice !== '' ? Number(restock.unitPrice) : undefined,
          supplierId: restock.supplierId || undefined,
        },
      });
      setRestock({ itemId: '', quantity: 1, reference: '', unitPrice: '', supplierId: '' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  /** Pre-fill the restock form from a low-stock suggestion (jumps to the Restock sub-tab). */
  const suggestRestock = (i: Item) => {
    setRestock({ itemId: i.id, quantity: Math.max(i.minStock * 3 - i.balance, i.minStock), reference: `Restock suggestion — ${i.code}`, unitPrice: i.lastUnitPrice != null ? String(i.lastUnitPrice) : '', supplierId: '' });
    setMgmtTab('restock');
  };

  const alertNow = async () => {
    setAlertBusy(true);
    try {
      const sent = await api<number>('/inventory/low-stock/alert', { method: 'POST' });
      setAlertMsg(sent > 0 ? `${sent} low-stock alert(s) sent to Administration.` : 'No items below threshold right now.');
    } catch (e) {
      setAlertMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setAlertBusy(false);
    }
  };

  const saveItem = async () => {
    if (!itemForm?.name?.trim()) return;
    setBusy(true);
    setError('');
    try {
      if (editingItem) {
        await api(`/inventory/items/${editingItem.id}`, {
          method: 'PATCH',
          body: {
            name: itemForm.name, category: itemForm.category, unit: itemForm.unit,
            minStock: Number(itemForm.minStock) || 0,
            ...(itemForm.reorderLevel != null ? { reorderLevel: Number(itemForm.reorderLevel) } : { reorderLevel: null }),
            description: itemForm.description || undefined,
          },
        });
      } else {
        await api('/inventory/items', {
          method: 'POST',
          body: {
            name: itemForm.name, category: itemForm.category, unit: itemForm.unit,
            balance: Number(itemForm.balance) || 0, minStock: Number(itemForm.minStock) || 0,
            ...(itemForm.reorderLevel != null ? { reorderLevel: Number(itemForm.reorderLevel) } : {}),
            description: itemForm.description || undefined,
          },
        });
      }
      setItemForm(null);
      setEditingItem(null);
      toast(editingItem ? 'Item updated' : 'Item created');
      load();
    } catch (e) {
      // rethrow — ConfirmDialog keeps the dialog open and shows this inside
      throw new Error(e instanceof Error ? e.message : 'Failed to save item');
    } finally {
      setBusy(false);
    }
  };

  const cartLines = Object.entries(cart).filter(([, q]) => q > 0);
  const lowCount = items.filter((i) => i.low).length;

  // items-master search + pagination (Management → Items)
  const filteredItems = items.filter((i) => {
    const q = itemQuery.trim().toLowerCase();
    if (!q) return true;
    return i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q);
  });
  const itemPageCount = Math.max(1, Math.ceil(filteredItems.length / ITEMS_PER_PAGE));
  const itemPageSafe = Math.min(itemPage, itemPageCount);
  const pagedItems = filteredItems.slice((itemPageSafe - 1) * ITEMS_PER_PAGE, itemPageSafe * ITEMS_PER_PAGE);

  /** Ledger rows after the modal's type + date filters. */
  const filteredHistory = history.filter((t) => {
    if (ledgerFilter === 'IN' && t.quantity < 0) return false;
    if (ledgerFilter === 'OUT' && t.quantity >= 0) return false;
    if (ledgerFrom && new Date(t.createdAt) < new Date(`${ledgerFrom}T00:00:00`)) return false;
    if (ledgerTo && new Date(t.createdAt) > new Date(`${ledgerTo}T23:59:59.999`)) return false;
    return true;
  });
  const filterActive = ledgerFilter !== 'ALL' || ledgerFrom !== '' || ledgerTo !== '';

  const TABS: { key: Tab; label: string }[] = [
    { key: 'catalog', label: 'Item Catalog' },
    ...(canManage ? [{ key: 'management' as Tab, label: `Management${lowCount > 0 ? ` (${lowCount} low)` : ''}` }] : []),
    ...(canManage ? [{ key: 'purchases' as Tab, label: 'Purchases' }] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Inventory / Store"
        subtitle="Office supplies catalog — request items, Administration fulfills from stock (Plan §12)"
        actions={
          <div className="flex gap-2">
            {cartLines.length > 0 && (
              <Button variant="ghost" onClick={() => setShowCart(!showCart)}>
                🛒 Cart ({cartLines.length}) — Review
              </Button>
            )}
            {canManage && (
              <Button
                onClick={() => {
                  setEditingItem(null);
                  setItemForm({ name: '', category: 'STATIONERY', unit: 'pcs', balance: 0, minStock: 0, description: '' });
                }}
              >
                + New Item
              </Button>
            )}
          </div>
        }
      />

      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
              tab === t.key
                ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {/* ============ Tab: Catalog (everyone) ============ */}
      {tab === 'catalog' && (
        <>

          <div className="flex justify-end mb-3">
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              <button
                className={`px-3 py-1.5 ${view === 'table' ? 'bg-yellow-50 text-yellow-800 font-medium' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                onClick={() => setViewPersist('table')}
              >
                ☰ Table
              </button>
              <button
                className={`px-3 py-1.5 border-l border-gray-200 ${view === 'grid' ? 'bg-yellow-50 text-yellow-800 font-medium' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                onClick={() => setViewPersist('grid')}
              >
                ▦ Grid
              </button>
            </div>
          </div>

          {view === 'table' && (
          <Card className="mb-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 font-medium">Code</th>
                  <th className="px-4 py-3 font-medium">Item</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">In stock</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.length === 0 && <tr><td colSpan={5}><Empty label="No inventory items yet" /></td></tr>}
                {items.map((i) => (
                  <tr key={i.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{i.code}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {i.imageStoredName ? (
                          <img
                            src={itemImageUrl(i)}
                            alt={i.name}
                            title="Click to preview"
                            className="w-9 h-9 rounded object-cover flex-shrink-0 cursor-zoom-in hover:ring-2 hover:ring-yellow-400"
                            onClick={() => setPreviewFor(i)}
                          />
                        ) : (
                          <div className="w-9 h-9 rounded bg-gray-100 flex items-center justify-center text-gray-300 flex-shrink-0">📦</div>
                        )}
                        <div>
                          {i.name}
                          {i.description && <div className="text-xs text-gray-400">{i.description}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{i.category}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden flex-shrink-0"
                          title={`${i.balance} ${i.unit} / min ${i.minStock} — 100% ≈ 3× threshold`}
                        >
                          <div
                            className={`h-full ${i.out ? 'bg-red-500' : i.low ? 'bg-yellow-500' : 'bg-green-500'}`}
                            style={{ width: `${stockPct(i)}%` }}
                          />
                        </div>
                        {i.out ? (
                          <Badge color="red">OUT</Badge>
                        ) : i.low ? (
                          <Badge color="yellow">LOW · {i.balance} {i.unit}</Badge>
                        ) : (
                          <span className="font-medium text-sm">{i.balance} <span className="text-gray-400 text-xs">{i.unit}</span></span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        className="text-blue-600 hover:underline mr-3 disabled:text-gray-300 disabled:no-underline"
                        disabled={i.out}
                        onClick={() => {
                          if (cart[i.id]) {
                            setCart({ ...cart, [i.id]: cart[i.id] + 1 });
                          } else {
                            setCart({ ...cart, [i.id]: 1 });
                            setShowCart(true);
                          }
                        }}
                      >
                        {cart[i.id] ? `In cart (${cart[i.id]}) +` : '+ Request'}
                      </button>
                      {canManage && (
                        <button className="text-gray-500 hover:underline" title="Stock ledger — who issued/received, when, what" onClick={() => openHistory(i)}>Ledger</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          )}

          {view === 'grid' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 mb-5">
              {items.length === 0 && <div className="col-span-full"><Empty label="No inventory items yet" /></div>}
              {items.map((i) => (
                <Card key={i.id} className={`p-3 flex flex-col ${i.isActive ? '' : 'opacity-50'}`}>
                  <div className="relative mb-2">
                    {i.imageStoredName ? (
                      <img
                        src={itemImageUrl(i)}
                        alt={i.name}
                        title="Click to preview"
                        className="w-full h-36 object-cover rounded-lg cursor-zoom-in hover:ring-2 hover:ring-yellow-400"
                        onClick={() => setPreviewFor(i)}
                      />
                    ) : (
                      <div className="w-full h-36 rounded-lg bg-gray-100 flex items-center justify-center text-4xl text-gray-300">📦</div>
                    )}
                    {i.out ? (
                      <span className="absolute top-2 right-2"><Badge color="red">OUT</Badge></span>
                    ) : i.low ? (
                      <span className="absolute top-2 right-2"><Badge color="yellow">LOW</Badge></span>
                    ) : null}
                  </div>
                  <div className="text-xs font-mono text-gray-400">{i.code} · {i.category}</div>
                  <div className="font-medium leading-snug">{i.name}</div>
                  {i.description && <div className="text-xs text-gray-400 mb-2">{i.description}</div>}
                  <div className="mt-auto pt-2">
                    <div className="flex items-center gap-2 mb-2">
                      <div
                        className="w-full h-2 bg-gray-200 rounded-full overflow-hidden"
                        title={`${i.balance} ${i.unit} / min ${i.minStock} — 100% ≈ 3× threshold`}
                      >
                        <div
                          className={`h-full ${i.out ? 'bg-red-500' : i.low ? 'bg-yellow-500' : 'bg-green-500'}`}
                          style={{ width: `${stockPct(i)}%` }}
                        />
                      </div>
                      <span className="text-xs whitespace-nowrap">{i.balance} {i.unit}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <button
                        className={`inline-flex items-center gap-1 text-sm font-medium rounded-lg px-2 py-1 -ml-2 transition-colors ${i.out ? 'text-gray-300 cursor-not-allowed' : cart[i.id] ? 'text-blue-700 bg-blue-50' : 'text-blue-600 hover:bg-blue-50'}`}
                        disabled={i.out}
                        title={i.out ? 'Out of stock' : cart[i.id] ? `In cart (${cart[i.id]}) — open the cart to submit` : 'Request this item'}
                        onClick={() => {
                          if (cart[i.id]) {
                            setCart({ ...cart, [i.id]: cart[i.id] + 1 });
                          } else {
                            setCart({ ...cart, [i.id]: 1 });
                            setShowCart(true);
                          }
                        }}
                      >
                        {cart[i.id] ? <span aria-hidden>🛒</span> : <span aria-hidden>✋</span>}
                        {cart[i.id] ? `In cart (${cart[i.id]})` : 'Request'}
                      </button>
                      {canManage && (
                        <button
                          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-lg px-2 py-1 transition-colors"
                          title="Stock ledger — who issued/received, when, what"
                          onClick={() => openHistory(i)}
                        >
                          <span aria-hidden>📜</span> Ledger
                        </button>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          <Card>
            <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide px-5 pt-5">My supply requests</h2>
            {mine.length === 0 ? (
              <Empty label="No supply requests yet" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-3 font-medium">Doc No.</th>
                    <th className="px-4 py-3 font-medium">Items</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {mine.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">
                        <Link to={`/requests/${r.id}`} className="text-blue-600 hover:underline">{r.docNumber}</Link>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {r.supplyRequest?.lines.map((l) => `${l.item?.name ?? '?'} ×${l.quantity}`).join(', ')}
                      </td>
                      <td className="px-4 py-3">
                        <Badge color={STATUS_COLORS[r.supplyRequest?.status ?? r.status] ?? 'gray'}>
                          {r.supplyRequest?.status === 'PENDING' ? `PENDING (${r.status === 'PENDING_APPROVAL' ? 'awaiting approval' : 'approved — fulfilling'})` : r.supplyRequest?.status ?? r.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{new Date(r.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      {/* ============ Tab: Management (sub-tabs) ============ */}
      {tab === 'management' && canManage && (
        <>
          {/* management sub-tab bar — one concern per tab (screenshot request) */}
          <div className="flex flex-wrap gap-1.5 mb-4">
            {([
              ['queue', `📋 To issue (${pending.length})`],
              ['restock', '📥 Restock (stock IN)'],
              ['alerts', `🔔 Low stock${lowCount > 0 ? ` (${lowCount})` : ''}`],
              ['reorder', `♻️ Reorder${reorder.length > 0 ? ` (${reorder.length})` : ''}`],
              ['items', '🗂 Items'],
            ] as [MgmtTab, string][]).map(([k, label]) => (
              <button
                key={k}
                className={`px-3.5 py-1.5 text-sm rounded-full border transition-colors ${
                  mgmtTab === k
                    ? 'bg-yellow-600 border-yellow-600 text-white shadow-sm'
                    : 'bg-white border-gray-200 text-gray-600 hover:border-yellow-400 hover:text-yellow-800'
                }`}
                onClick={() => setMgmtTab(k)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* ---- sub-tab: fulfillment queue ---- */}
          {mgmtTab === 'queue' && (
          <Card className="mb-5 p-5">
            <h2 className="font-semibold text-gray-800 mb-1 text-sm uppercase tracking-wide">
              Approved — waiting for issue from store ({pending.length})
            </h2>
            <p className="text-xs text-gray-400 mb-3">
              Approving ( Fulfill ) deducts stock immediately. Items short of stock are marked OUT-OF-STOCK and can be fulfilled after restock.
            </p>
            {pending.length === 0 ? (
              <Empty label="No requests waiting — all caught up 🎉" />
            ) : (
              <div className="space-y-3">
                {pending.map((r) => (
                  <div key={r.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <Link to={`/requests/${r.id}`} className="font-medium text-blue-600 hover:underline">{r.docNumber}</Link>
                      <span className="text-sm">{r.requester?.fullName}</span>
                      <span className="text-xs text-gray-400">{r.department?.name}</span>
                      <span className="text-xs text-gray-400">{new Date(r.createdAt).toLocaleString()}</span>
                    </div>
                    <table className="w-full text-sm mb-2">
                      <tbody className="divide-y divide-gray-100">
                        {r.supplyRequest?.lines.map((l) => (
                          <tr key={l.id}>
                            <td className="py-1">{l.item.code} — {l.item.name}</td>
                            <td className="py-1 text-right">×{l.quantity} {l.item.unit}</td>
                            <td className={`py-1 text-right ${l.quantity > l.item.balance ? 'text-red-600' : 'text-green-700'}`}>
                              {l.quantity > l.item.balance ? `only ${l.item.balance} in stock` : `${l.item.balance} in stock`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {r.supplyRequest?.note && <div className="text-xs text-gray-500 mb-2">Note: {r.supplyRequest.note}</div>}
                    <div className="flex gap-2">
                      <Button onClick={() => doFulfill(r.id)}>✓ Fulfill (issue stock)</Button>
                      <Button variant="danger" onClick={() => setRejectFor(r)}>Cannot fulfill</Button>
                      {r.status === 'APPROVED' && (
                        <Button variant="ghost" onClick={() => setCancelFor(r)}>✕ Cancel request</Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          )}

          {/* ---- sub-tab: restock form ---- */}
          {mgmtTab === 'restock' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <Card className="p-5">
              <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Restock (stock IN)</h2>
              <div className="space-y-3">
                <Select value={restock.itemId} onChange={(e) => setRestock({ ...restock, itemId: e.target.value })}>
                  <option value="">— Item —</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.code} — {i.name} (now {i.balance} {i.unit}{i.lastUnitPrice != null ? ` · last @${fmtMoney(Number(i.lastUnitPrice))}` : ''})
                    </option>
                  ))}
                </Select>
                <div className="flex gap-3">
                  <Input type="number" min={1} placeholder="Quantity" value={restock.quantity} onChange={(e) => setRestock({ ...restock, quantity: Number(e.target.value) })} />
                  <Input type="number" min={0} step="0.01" placeholder="Unit price (optional)" value={restock.unitPrice} onChange={(e) => setRestock({ ...restock, unitPrice: e.target.value })} />
                </div>
                <div className="flex gap-3">
                  <Select value={restock.supplierId} onChange={(e) => setRestock({ ...restock, supplierId: e.target.value })}>
                    <option value="">— Supplier (optional) —</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.phone ? ` · ${s.phone}` : ''}</option>)}
                  </Select>
                  <Input placeholder="Reference (PO / invoice / donor)" value={restock.reference} onChange={(e) => setRestock({ ...restock, reference: e.target.value })} />
                </div>
                <p className="text-xs text-gray-400">Unit price + supplier are recorded on each PURCHASE entry — used by the Purchases report. Manage suppliers in the Purchases tab.</p>
                <Button onClick={doRestock} disabled={!restock.itemId || restock.quantity <= 0 || busy}>+ Add stock</Button>
              </div>
            </Card>

            <Card className="p-5">
              <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Quick tips</h2>
              <ul className="text-sm text-gray-500 space-y-2 list-disc pl-4">
                <li>Pick an item — the dropdown shows current balance and last paid price.</li>
                <li>Unit price + supplier feed the <b>Purchases</b> report and reorder cost estimates.</li>
                <li>Low-stock and reorder rows elsewhere have a <b>Fill restock</b> link that pre-fills this form.</li>
                <li>Every restock lands in the item's <b>Ledger</b> with who/when/what.</li>
              </ul>
            </Card>
          </div>
          )}

          {/* ---- sub-tab: low stock alerts ---- */}
          {mgmtTab === 'alerts' && (
          <Card className="p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">Low stock alerts</h2>
                <button className="text-xs text-blue-600 hover:underline" disabled={alertBusy} onClick={alertNow}>
                  {alertBusy ? 'Checking…' : '🔔 Check now'}
                </button>
              </div>
              {alertMsg && <div className="text-xs text-green-700 mb-2">{alertMsg}</div>}
              {lowCount === 0 ? (
                <div className="text-sm text-green-700">All items above threshold ✅</div>
              ) : (
                <ul className="space-y-2">
                  {items.filter((i) => i.low).map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate">{i.code} — {i.name}</span>
                      <span className="flex items-center gap-2 flex-shrink-0">
                        <Badge color={i.out ? 'red' : 'yellow'}>{i.balance} / min {i.minStock} {i.unit}</Badge>
                        <button
                          className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                          title="Pre-fill the restock form with a suggested quantity (≈ 3× threshold minus current balance)"
                          onClick={() => suggestRestock(i)}
                        >
                          Restock ×{Math.max(i.minStock * 3 - i.balance, i.minStock)}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-gray-400 mt-3">Administration is notified automatically (LOW_STOCK) once a day at 08:00 — “Check now” runs the pass immediately.</p>
          </Card>
          )}

          {/* ---- sub-tab: auto-reorder suggestions ---- */}
          {mgmtTab === 'reorder' && (
          <Card className="p-5">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">Auto-reorder suggestions</h2>
                <span className="text-xs text-gray-400">balance ≤ reorder level (≈3× threshold when unset) · Purchasing is notified daily at 08:00</span>
              </div>
              {reorder.length === 0 ? (
                <p className="text-sm text-gray-400">Nothing to reorder — every item is above its reorder level. ✓</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {reorder.map((r) => (
                    <li key={r.itemId} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="truncate">
                        <span className="font-medium text-gray-700">{r.code} — {r.name}</span>
                        <span className="text-xs text-gray-400 ml-2">
                          at {r.balance} {r.unit} · target {r.reorderLevel ?? `≈${r.threshold * 3}`} {r.unit}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 flex-shrink-0">
                        {r.estimatedCost !== null && <span className="text-xs text-gray-500">≈ {fmtMoney(r.estimatedCost)}</span>}
                        <Badge color="yellow">order {r.suggestedQty} {r.unit}</Badge>
                        <button
                          className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                          title="Pre-fill the restock form with the suggested quantity"
                          onClick={() => {
                            setRestock({ itemId: r.itemId, quantity: r.suggestedQty, reference: `Reorder suggestion — ${r.code}`, unitPrice: r.lastUnitPrice != null ? String(r.lastUnitPrice) : '', supplierId: '' });
                            setMgmtTab('restock');
                          }}
                        >
                          Fill restock
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
          )}

          {/* ---- sub-tab: items master (search + pagination) ---- */}
          {mgmtTab === 'items' && (
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <input
                className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-64 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
                placeholder="🔍 Search code, name, category…"
                value={itemQuery}
                onChange={(e) => { setItemQuery(e.target.value); setItemPage(1); }}
              />
              <span className="text-xs text-gray-400 ml-auto">{filteredItems.length} item{filteredItems.length === 1 ? '' : 's'}</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 font-medium">Code</th>
                  <th className="px-4 py-3 font-medium">Item</th>
                  <th className="px-4 py-3 font-medium">Unit</th>
                  <th className="px-4 py-3 font-medium">Balance</th>
                  <th className="px-4 py-3 font-medium">Min</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pagedItems.map((i) => (
                  <tr key={i.id} className={`hover:bg-gray-50 ${i.isActive ? '' : 'opacity-50'}`}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{i.code}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {i.imageStoredName ? (
                          <img
                            src={itemImageUrl(i)}
                            alt={i.name}
                            title="Click to preview"
                            className="w-9 h-9 rounded object-cover flex-shrink-0 cursor-zoom-in hover:ring-2 hover:ring-yellow-400"
                            onClick={() => setPreviewFor(i)}
                          />
                        ) : (
                          <div className="w-9 h-9 rounded bg-gray-100 flex items-center justify-center text-gray-300 flex-shrink-0">📦</div>
                        )}
                        <span>{i.name}{!i.isActive && ' (inactive)'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{i.unit}</td>
                    <td className="px-4 py-3">{i.balance}</td>
                    <td className="px-4 py-3 text-gray-500">{i.minStock}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button className="text-blue-600 hover:underline mr-3" onClick={() => openImageModal(i)}>Photo</button>
                      <button className="text-blue-600 hover:underline mr-3" onClick={() => { setEditingItem(i); setItemForm({ ...i }); }}>Edit</button>
                      <button className="text-gray-500 hover:underline mr-3" onClick={() => openHistory(i)}>Ledger</button>
                      <button className="text-red-600 hover:underline" onClick={() => setDeletingItem(i)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredItems.length === 0 && <p className="text-sm text-gray-400 p-4">No items match “{itemQuery}”.</p>}
            {/* pagination */}
            {itemPageCount > 1 && (
              <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
                <span className="text-xs text-gray-400">
                  Page {itemPageSafe} of {itemPageCount} — showing {pagedItems.length} of {filteredItems.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    className="px-2 py-1 rounded border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={itemPageSafe <= 1}
                    onClick={() => setItemPage(itemPageSafe - 1)}
                  >
                    ← Prev
                  </button>
                  {Array.from({ length: itemPageCount }, (_, n) => n + 1)
                    .filter((n) => n === 1 || n === itemPageCount || Math.abs(n - itemPageSafe) <= 1)
                    .map((n, idx, arr) => (
                      <span key={n} className="flex items-center">
                        {idx > 0 && arr[idx - 1] !== n - 1 && <span className="px-1 text-gray-300">…</span>}
                        <button
                          className={`w-8 h-8 rounded text-sm ${n === itemPageSafe ? 'bg-yellow-600 text-white font-medium' : 'text-gray-600 hover:bg-gray-50'}`}
                          onClick={() => setItemPage(n)}
                        >
                          {n}
                        </button>
                      </span>
                    ))}
                  <button
                    className="px-2 py-1 rounded border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={itemPageSafe >= itemPageCount}
                    onClick={() => setItemPage(itemPageSafe + 1)}
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}
          </Card>
          )}

          {/* monthly spending lives in its own Purchases tab now */}
        </>
      )}

      {/* ============ Tab: Purchases (Administration) ============ */}
      {tab === 'purchases' && canManage && (
        <>
          <div className="mb-4 text-sm text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
            Supplier master data has moved to its own page — <a href="/suppliers" className="text-blue-700 underline font-medium">🚛 Suppliers</a> (create/edit/deactivate + purchase history per supplier).
          </div>

          <Card className="mb-5 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">Purchases — {spendWindow(spendMonth).label}</h2>
              <div className="flex items-center gap-2 text-sm">
                <span title="Monthly purchase spend by item & supplier">
                  <Button variant="ghost" onClick={downloadCsv} disabled={busy}>⬇ Purchases CSV</Button>
                </span>
                <span title="Every stock movement — Received/Issued with Who, When, What">
                  <Button variant="ghost" onClick={downloadLedgerCsv} disabled={busy}>⬇ Ledger CSV</Button>
                </span>
                <button className="px-2 py-1 rounded hover:bg-gray-100" onClick={() => setSpendMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}>←</button>
                <button className="px-2 py-1 rounded hover:bg-gray-100 text-xs" onClick={() => setSpendMonth(new Date())}>This month</button>
                <button className="px-2 py-1 rounded hover:bg-gray-100" onClick={() => setSpendMonth((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}>→</button>
              </div>
            </div>
            {!spending ? (
              <Empty label="Loading spending…" />
            ) : (
              <>
                <div className="text-sm mb-3">
                  Total spent: <span className="font-semibold text-gray-800">{fmtMoney(spending.total)}</span>
                  <span className="text-gray-400 text-xs ml-2">per unit prices recorded at restock</span>
                </div>

                {/* by supplier */}
                {spending.suppliers.length > 0 && (
                  <div className="mb-5">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">By supplier</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {spending.suppliers.map((s) => (
                        <div key={s.supplier} className="border border-gray-200 rounded-lg p-3">
                          <div className="font-medium text-sm truncate">{s.supplier}</div>
                          <div className="text-xs text-gray-400">{s.qty} units in</div>
                          <div className="mt-1 flex items-baseline justify-between">
                            <span className="font-semibold text-gray-800">{fmtMoney(s.cost)}</span>
                            <span className="text-xs text-gray-400">avg {s.avgUnitPrice != null ? fmtMoney(s.avgUnitPrice) : '—'}</span>
                          </div>
                          {s.noPrice && <div className="text-xs text-gray-400 mt-1">⚠ includes entries without price</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {spending.items.length === 0 ? (
                  <Empty label="No purchases recorded in this month" />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                        <th className="px-2 py-2 font-medium">Item</th>
                        <th className="px-2 py-2 font-medium">Qty in</th>
                        <th className="px-2 py-2 font-medium">Avg unit</th>
                        <th className="px-2 py-2 font-medium text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {spending.items.map((s) => (
                        <tr key={s.itemId}>
                          <td className="px-2 py-2">
                            <div className="font-medium">{s.code} — {s.name}</div>
                            <div className="text-xs text-gray-400">
                              {s.entries.map((e) => `${e.quantity} ${s.unit}${e.unitPrice != null ? ` @${fmtMoney(e.unitPrice)}` : ''}${e.reference ? ` (${e.reference})` : ''}${e.supplier ? ` — ${e.supplier}` : ''}`).join(' · ')}
                            </div>
                          </td>
                          <td className="px-2 py-2">{s.qty} {s.unit}</td>
                          <td className="px-2 py-2 text-gray-500">{s.avgUnitPrice != null ? fmtMoney(s.avgUnitPrice) : '—'}</td>
                          <td className="px-2 py-2 text-right font-medium">
                            {fmtMoney(s.cost)}
                            {s.noPrice && <span className="text-xs text-gray-400 ml-1" title="No unit price recorded on these entries — set the price next time">(no price)</span>}
                            {!s.noPrice && s.estimated && <span className="text-xs text-gray-400 ml-1" title="Some entries had no price and were valued at the item's latest known price">(est.)</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </Card>
        </>
      )}

      {/* ============ Tab: Management (stock master) ============ */}
      {tab === 'management' && canManage && (
        <>
          {/* stock master table */}
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 font-medium">Code</th>
                  <th className="px-4 py-3 font-medium">Item</th>
                  <th className="px-4 py-3 font-medium">Unit</th>
                  <th className="px-4 py-3 font-medium">Balance</th>
                  <th className="px-4 py-3 font-medium">Min</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((i) => (
                  <tr key={i.id} className={`hover:bg-gray-50 ${i.isActive ? '' : 'opacity-50'}`}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{i.code}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {i.imageStoredName ? (
                          <img
                            src={itemImageUrl(i)}
                            alt={i.name}
                            title="Click to preview"
                            className="w-9 h-9 rounded object-cover flex-shrink-0 cursor-zoom-in hover:ring-2 hover:ring-yellow-400"
                            onClick={() => setPreviewFor(i)}
                          />
                        ) : (
                          <div className="w-9 h-9 rounded bg-gray-100 flex items-center justify-center text-gray-300 flex-shrink-0">📦</div>
                        )}
                        <span>{i.name}{!i.isActive && ' (inactive)'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{i.unit}</td>
                    <td className="px-4 py-3">{i.balance}</td>
                    <td className="px-4 py-3 text-gray-500">{i.minStock}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button className="text-blue-600 hover:underline mr-3" onClick={() => openImageModal(i)}>Photo</button>
                      <button className="text-blue-600 hover:underline mr-3" onClick={() => { setEditingItem(i); setItemForm({ ...i }); }}>Edit</button>
                      <button className="text-gray-500 hover:underline mr-3" onClick={() => openHistory(i)}>Ledger</button>
                      <button className="text-red-600 hover:underline" onClick={() => setDeletingItem(i)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {/* ============ modals ============ */}
      {/* admin-cancel with reason (replaces window.prompt) */}
      {cancelFor && (
        <ConfirmDialog
          title={`Cancel ${cancelFor.docNumber}?`}
          description="The request is withdrawn and the requester is notified with your reason."
          confirmLabel="Cancel request"
          variant="danger"
          withNote
          notePlaceholder="Cancellation reason (notifies the requester)"
          onClose={() => setCancelFor(null)}
          onConfirm={async (note) => { await doAdminCancel(cancelFor.id, note || undefined); }}
        />
      )}

      {/* cannot-fulfill with reason (replaces window.prompt) */}
      {rejectFor && (
        <ConfirmDialog
          title={`Cannot fulfill ${rejectFor.docNumber}?`}
          description="The request is rejected and the requester is notified with your reason."
          confirmLabel="Reject request"
          variant="danger"
          withNote
          notePlaceholder="Reason (notifies the requester)"
          onClose={() => setRejectFor(null)}
          onConfirm={async (note) => { await doRejectFulfill(rejectFor.id, note || undefined); }}
        />
      )}
      {/* single-item quick request */}
      {requestFor && (
        <ConfirmDialog
          title={`Request ${requestFor.name}?`}
          description={<>Request <b>{requestQty} {requestFor.unit}</b> of {requestFor.code} — {requestFor.name}. In stock: {requestFor.balance}. The Administration Department approves and issues the items.</>}
          confirmLabel="Submit request"
          onClose={() => setRequestFor(null)}
          onConfirm={async () => { await submitSingle(); }}
        >
          <div className="mt-3">
            <label className="block text-xs text-gray-500 mb-1">Quantity ({requestFor.unit})</label>
            <Input type="number" min={1} value={requestQty} onChange={(e) => setRequestQty(Math.max(1, Number(e.target.value)))} />
            <label className="block text-xs text-gray-500 mb-1 mt-2">Note (optional)</label>
            <Input value={requestNote} onChange={(e) => setRequestNote(e.target.value)} />
          </div>
        </ConfirmDialog>
      )}

      {/* item create/edit */}
      {itemForm && (
        <ConfirmDialog
          title={editingItem ? `Edit ${editingItem.code}` : 'New inventory item'}
          description={editingItem ? 'Balance changes only through restock / issue transactions.' : 'Opening balance is recorded as a PURCHASE transaction in the ledger.'}
          confirmLabel={editingItem ? 'Save' : 'Create item'}
          onClose={() => { setItemForm(null); setEditingItem(null); }}
          onConfirm={async () => { await saveItem(); }}
        >
          <div className="mt-3 space-y-3">
            <Input placeholder="Item name *" value={itemForm.name ?? ''} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
            <div className="grid grid-cols-2 gap-3">
              <Select value={itemForm.category ?? 'STATIONERY'} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })}>
                {ITEM_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
              <Input placeholder="Unit (pcs, box, ream…)" value={itemForm.unit ?? ''} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })} />
              {!editingItem && (
                <Input type="number" min={0} placeholder="Opening balance" value={itemForm.balance ?? 0} onChange={(e) => setItemForm({ ...itemForm, balance: Number(e.target.value) })} />
              )}
              <Input type="number" min={0} placeholder="Min stock (alert threshold)" value={itemForm.minStock ?? 0} onChange={(e) => setItemForm({ ...itemForm, minStock: Number(e.target.value) })} />
              <Input
                type="number"
                min={0}
                placeholder="Reorder level (auto top-up target)"
                title="When balance drops to/below this, a reorder suggestion is raised. Empty = ≈3× the alert threshold."
                value={itemForm.reorderLevel ?? ''}
                onChange={(e) => setItemForm({ ...itemForm, reorderLevel: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </div>
            <Textarea rows={2} placeholder="Description (optional)" value={itemForm.description ?? ''} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} />
          </div>
        </ConfirmDialog>
      )}

      {/* cart review — proper modal (screenshot request) */}
      {showCart && cartLines.length > 0 && (
        <Modal
          title={`Your supply request — ${cartLines.length} item${cartLines.length === 1 ? '' : 's'}`}
          error={error}
          onClose={() => setShowCart(false)}
        >
          <table className="w-full text-sm mb-3">
            <tbody className="divide-y divide-gray-100">
              {cartLines.map(([id, q]) => {
                const item = items.find((i) => i.id === id);
                return (
                  <tr key={id}>
                    <td className="py-2">
                      <div className="font-medium text-gray-700">{item?.name}</div>
                      <div className="text-[11px] text-gray-400">{item?.code} · balance {item?.balance} {item?.unit}</div>
                    </td>
                    <td className="py-2 text-right">
                      <Input type="number" min={1} className="!w-24" value={q}
                        onChange={(e) => setCart({ ...cart, [id]: Math.max(1, Number(e.target.value)) })} />
                    </td>
                    <td className="py-2 text-right text-gray-400">{item?.unit}</td>
                    <td className="py-2 text-right">
                      <button className="text-red-600 hover:underline" onClick={() => setCart(({ [id]: _, ...rest }) => rest)}>Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Textarea rows={2} placeholder="Note (optional)" value={cartNote} onChange={(e) => setCartNote(e.target.value)} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowCart(false)}>Keep browsing</Button>
            <Button onClick={submitCart} disabled={busy}>{busy ? 'Submitting…' : 'Submit Request'}</Button>
          </div>
        </Modal>
      )}

      {/* item photo preview (lightbox) */}
      {previewFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPreviewFor(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-semibold text-gray-800">{previewFor.name}</h3>
                <p className="text-xs text-gray-400">{previewFor.code} · {previewFor.balance} {previewFor.unit} in stock</p>
              </div>
              <button className="text-gray-400 hover:text-gray-600 text-2xl leading-none" onClick={() => setPreviewFor(null)}>×</button>
            </div>
            <img src={itemImageUrl(previewFor)} alt={previewFor.name} className="w-full max-h-[60vh] object-contain rounded-lg bg-gray-50" />
            {canManage && (
              <div className="mt-3 flex justify-end">
                <Button
                  onClick={() => {
                    const it = previewFor;
                    setPreviewFor(null);
                    openImageModal(it);
                  }}
                >
                  Change photo
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* item photo upload */}
      {imageFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setImageFor(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 mb-1">Item photo — {imageFor.code}</h3>
            <p className="text-xs text-gray-500 mb-3">{imageFor.name} · shown to everyone in the catalog (auto-resized to 512 px)</p>
            <div className="mb-3 flex items-center justify-center h-40 rounded-lg border border-dashed border-gray-300 bg-gray-50 overflow-hidden">
              {imagePreview ? (
                <img src={imagePreview} alt="" className="h-full object-contain" />
              ) : (
                <span className="text-xs text-gray-400">No image selected</span>
              )}
            </div>
            <input type="file" accept="image/*" className="text-sm mb-3" onChange={(e) => pickImage(e.target.files?.[0] ?? null)} />
            {imgError && <div className="text-sm text-red-600 mb-2">{imgError}</div>}
            <div className="flex gap-2 justify-end">
              {imageFor.imageStoredName && !imageRemove && !imageFile && (
                <Button variant="ghost" onClick={removePickedImage}>Remove photo</Button>
              )}
              <Button variant="ghost" onClick={closeImageModal}>Cancel</Button>
              <Button
                onClick={saveImage}
                disabled={imgBusy || (!imageFile && !imageRemove)}
              >
                {imgBusy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* item delete confirm */}
      {deletingItem && (
        <ConfirmDialog
          title={`Delete ${deletingItem.code} — ${deletingItem.name}?`}
          description="Items with transaction history cannot be deleted (deactivate instead). This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => {
            setError('');
            try {
              await api(`/inventory/items/${deletingItem.id}`, { method: 'DELETE' });
              setDeletingItem(null);
              load();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed');
              setDeletingItem(null);
            }
          }}
          onClose={() => setDeletingItem(null)}
        />
      )}

      {/* ledger drawer — Who / When / What for every stock movement */}
      {historyFor && (
        <Modal title={`Ledger — ${historyFor.code} ${historyFor.name}`} onClose={() => setHistoryFor(null)}>
          <div className="text-sm text-gray-600 mb-3">
            Balance now: <b>{historyFor.balance} {historyFor.unit}</b> · alert threshold {historyFor.minStock}
            {lifetime ? ` · Lifetime purchased: ${lifetime.qty} ${lifetime.unit} (${fmtMoney(lifetime.cost)})` : ''}
          </div>
          {/* filters — type + date window */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
              {([['ALL', 'All'], ['IN', 'Received'], ['OUT', 'Issued']] as const).map(([k, label]) => (
                <button
                  key={k}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${ledgerFilter === k ? 'bg-yellow-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  onClick={() => setLedgerFilter(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="text-gray-300">|</span>
            <label className="text-xs text-gray-500">From</label>
            <input
              type="date"
              className="text-xs border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
              value={ledgerFrom}
              onChange={(e) => setLedgerFrom(e.target.value)}
            />
            <label className="text-xs text-gray-500">To</label>
            <input
              type="date"
              className="text-xs border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
              value={ledgerTo}
              onChange={(e) => setLedgerTo(e.target.value)}
            />
            {filterActive && (
              <button
                className="text-xs text-gray-400 hover:text-gray-600 underline"
                onClick={() => { setLedgerFilter('ALL'); setLedgerFrom(''); setLedgerTo(''); }}
              >
                Clear
              </button>
            )}
            <span className="ml-auto text-xs text-gray-400">{filteredHistory.length} of {history.length} entries</span>
          </div>
          <div className="max-h-96 overflow-y-auto border border-gray-100 rounded-lg">
            {history.length === 0 ? (
              <div className="text-sm text-gray-400 p-4">No transactions yet.</div>
            ) : filteredHistory.length === 0 ? (
              <div className="text-sm text-gray-400 p-4">No entries match the current filter.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-400 uppercase bg-gray-50 sticky top-0">
                    <th className="py-2 px-2 font-medium">When</th>
                    <th className="py-2 px-2 font-medium">Type</th>
                    <th className="py-2 px-2 font-medium">Who</th>
                    <th className="py-2 px-2 font-medium">What</th>
                    <th className="py-2 px-2 text-right font-medium">Qty</th>
                    <th className="py-2 px-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredHistory.map((t) => (
                    <tr key={t.id}>
                      <td className="py-2 px-2 whitespace-nowrap text-gray-500" title={new Date(t.createdAt).toLocaleString()}>
                        {new Date(t.createdAt).toLocaleDateString()}<br />
                        <span className="text-[10px] text-gray-400">{new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </td>
                      <td className="py-2 px-2">
                        <Badge color={t.quantity >= 0 ? 'green' : 'blue'}>{t.type}</Badge>
                      </td>
                      <td className="py-2 px-2">
                        {t.type === 'ISSUE' ? (
                          <>
                            <div className="font-medium text-gray-700" title="Received the items">👤 {t.issuedTo ?? '—'}</div>
                            <div className="text-[10px] text-gray-400" title="Recorded by">by {t.createdBy?.fullName ?? '—'}</div>
                          </>
                        ) : (
                          <div className="text-gray-500">{t.createdBy?.fullName ?? '—'}</div>
                        )}
                      </td>
                      <td className="py-2 px-2 text-gray-500 max-w-[220px]">
                        {t.reference && <div className="font-mono text-[11px] text-gray-600">{t.reference}</div>}
                        {t.requestTitle && <div className="truncate" title={t.requestTitle}>{t.requestTitle}</div>}
                        {t.unitPrice != null && <div className="text-[10px] text-gray-400">@ {fmtMoney(Number(t.unitPrice))}</div>}
                        {!t.reference && !t.requestTitle && t.unitPrice == null && '—'}
                      </td>
                      <td className={`py-2 px-2 text-right font-medium whitespace-nowrap ${t.quantity >= 0 ? 'text-green-700' : 'text-blue-700'}`}>
                        {t.quantity > 0 ? '+' : ''}{t.quantity}
                      </td>
                      <td className="py-2 px-2 text-right text-gray-500 whitespace-nowrap">{t.balanceAfter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
