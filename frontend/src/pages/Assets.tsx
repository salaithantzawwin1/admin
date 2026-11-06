import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, hasPermission, getToken } from '../api';
import { PageHeader, Card, Button, Input, Select, Table, Empty, Badge } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AssetSetupTab } from '../components/AssetSetupTab';
import { categorySegment } from '../util/assetCode';

interface AssetRow {
  id: string;
  assetCode: string;
  name: string;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  custodian?: string | null;
  purchaseDate?: string | null;
  purchaseCost?: string | null;
  status: 'ACTIVE' | 'IN_STORAGE' | 'MAINTENANCE' | 'DISPOSED';
  description?: string | null;
  /** category-specific answers, keyed by the category's spec field keys */
  specs?: Record<string, string> | null;
  category?: { id: string; name: string; specFields?: SpecField[] | null } | null;
  location?: { id: string; name: string } | null;
  /** the asset's own picture — the backend never exposes the stored file name */
  photo?: { mimeType?: string | null; size?: number | null; updatedAt?: string | null } | null;
}

/**
 * The answers the given field list still asks for.
 *
 * A field removed in Asset Setup (or a select option that changed) must not ride
 * along as a stale value: the API rejects a select value it does not offer and
 * silently drops keys the category no longer defines, so the form starts from
 * what is actually answerable.
 */
export const pruneSpecs = (
  fields: SpecField[] | null | undefined,
  values: Record<string, string> | null | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of fields ?? []) {
    const v = values?.[f.key];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (f.type === 'select' && !(f.options ?? []).some((o) => o.toLowerCase() === v.trim().toLowerCase())) continue;
    out[f.key] = v;
  }
  return out;
};

/** A specification field a category asks for (a printer's Connection: USB /
 *  Network). Defined per category in the Asset Setup tab. */
interface SpecField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  options?: string[];
}

interface MovementRow {
  id: string;
  type: string;
  note?: string | null;
  createdAt: string;
  fromLocation?: { name: string } | null;
  toLocation?: { name: string } | null;
  createdBy?: { username: string } | null;
}

/** One row of the asset cost ledger (§14.5) — money spent on the asset AFTER
 *  it was bought: a service visit, a spare part, consumables. Decimal fields
 *  arrive as strings from the API. */
interface CostRow {
  id: string;
  date: string;
  kind: string;
  amount: string;
  quantity?: number | null;
  description?: string | null;
  /** MANUAL = typed here (deletable); INVOICE = came from a posted bill */
  sourceType: string;
  account?: { code?: string | null; name: string } | null;
  supplier?: { name: string } | null;
  createdBy?: { username: string } | null;
}

/** Total cost of ownership, computed by the backend from the asset + ledger. */
interface CostSummary {
  purchaseCost: number;
  recordedCost: number;
  totalCost: number;
  entries: number;
}

interface AssetDetail extends AssetRow {
  movements: MovementRow[];
  costs: CostRow[];
  costSummary: CostSummary;
  poItems: { purchaseOrder: { poNumber: string; supplier: { name: string } } }[];
  /** parts fitted INTO this asset (a cartridge in a printer) */
  installedParts: {
    id: string;
    installedAt: string;
    removedAt?: string | null;
    note?: string | null;
    component: { id: string; assetCode: string; name: string; status: string; purchaseCost?: string | null; category?: { name: string } | null };
  }[];
  /** where THIS asset is fitted (the cartridge's side of the link) */
  installedIn: {
    id: string;
    installedAt: string;
    removedAt?: string | null;
    parent: { id: string; assetCode: string; name: string; status: string };
  }[];
}

interface Category { id: string; name: string; specFields?: SpecField[] | null }
interface Location { id: string; name: string }
interface Custodian { id: string; name: string }

const STATUS_COLORS: Record<string, 'green' | 'gray' | 'yellow' | 'red' | 'blue'> = {
  ACTIVE: 'green', IN_STORAGE: 'gray', MAINTENANCE: 'yellow', DISPOSED: 'red',
  // set by "fit component": the part is physically inside a machine right now
  IN_USE: 'blue',
};

/** Printable asset sticker: the SVG QR encodes this asset's own page on the AMS origin. */
function QrLabel({ assetId, assetCode, name }: { assetId: string; assetCode: string; name: string }) {
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const token = localStorage.getItem('ams_token');
    setErr('');
    setSvg('');
    fetch(`/api/assets/${assetId}/qr.svg`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`QR request failed (${r.status})`))))
      .then(setSvg)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Failed'));
  }, [assetId]);
  if (err) return <div className="text-sm text-red-600">{err}</div>;
  if (!svg) return <Empty label="Preparing label…" />;
  return (
    <div>
      <div className="qr-print mx-auto w-72 bg-white border border-gray-200 rounded-xl p-4 text-center">
        <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="mt-2 font-mono text-sm font-semibold">{assetCode}</div>
        <div className="text-xs text-gray-600 truncate">{name}</div>
        <div className="text-[10px] text-gray-400 mt-1">AMS — scan to open this asset</div>
      </div>
      <div className="flex justify-center mt-3">
        <Button onClick={() => window.print()}>🖨 Print label</Button>
      </div>
      <p className="text-[11px] text-gray-400 mt-2 text-center">
        Scanning opens this asset for anyone already signed in — the label carries no token.
      </p>
    </div>
  );
}

/** Square icon action for the register table. The label stays in `title` and
 *  `aria-label`, so hovering and screen readers still name the action. */
function IconButton({ label, onClick, danger, children }: {
  label: string; onClick: () => void; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border bg-white transition-colors ${
        danger
          ? 'border-red-200 text-red-600 hover:bg-red-50'
          : 'border-gray-200 text-gray-600 hover:bg-gray-50 hover:text-gray-900'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

const IconEye = () => (<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>);
const IconTransfer = () => (<><path d="m16 3 4 4-4 4" /><path d="M20 7H4" /><path d="m8 21-4-4 4-4" /><path d="M4 17h16" /></>);
const IconEdit = () => (<><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></>);
const IconTrash = () => (<><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>);
const IconQr = () => (<>
  <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
  <rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h4v4h-4z" />
  <path d="M21 14h.01" /><path d="M14 21h.01" /><path d="M21 21h.01" />
</>);
const IconPhoto = () => (<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-4.5-4.5L9 18" /></>);

/**
 * The picture sits behind an authenticated route, so it is fetched as a blob
 * (a plain <img src> cannot send the bearer token) and the object URL is
 * revoked when the element goes away or the photo is replaced.
 */
function usePhotoBlob(assetId: string | undefined, version?: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let created: string | null = null;
    let cancelled = false;
    setUrl(null);
    if (assetId && version !== null) {
      void (async () => {
        try {
          const res = await fetch(`/api/assets/${assetId}/photo`, {
            headers: { Authorization: `Bearer ${getToken()}` },
          });
          if (!res.ok) return;
          created = URL.createObjectURL(await res.blob());
          if (!cancelled) setUrl(created);
        } catch {
          /* a missing preview never breaks the row or the dialog */
        }
      })();
    }
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [assetId, version]);
  return url;
}

/** Register-table thumbnail; clicking it opens the photo modal. */
function AssetThumb({ row, onOpen }: { row: AssetRow; onOpen: () => void }) {
  const url = usePhotoBlob(row.photo ? row.id : undefined, row.photo?.updatedAt ?? null);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={row.photo ? 'View photo' : 'No photo yet'}
      aria-label={row.photo ? `View ${row.assetCode} photo` : `${row.assetCode} has no photo`}
      className="h-10 w-12 rounded-md border border-gray-200 bg-gray-50 overflow-hidden flex items-center justify-center text-gray-300 hover:border-yellow-500 hover:text-gray-400"
    >
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <IconPhoto />}
    </button>
  );
}

/** Shared pagination bar: range, page numbers (with gaps) and prev/next. */
function Pager({ page, pageCount, total, from, to, onChange }: {
  page: number; pageCount: number; total: number; from: number; to: number;
  onChange: (p: number) => void;
}) {
  if (total === 0) return null;
  const shown = Array.from({ length: pageCount }, (_, i) => i).filter(
    (p) => pageCount <= 7 || p === 0 || p === pageCount - 1 || Math.abs(p - page) <= 1,
  );
  const btn = 'h-7 min-w-7 px-2 rounded-md border text-xs transition-colors';
  let previous = -1;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-3 text-xs text-gray-500">
      <span>Showing {from}–{to} of {total}</span>
      <div className="flex items-center gap-1">
        <button type="button" className={`${btn} border-gray-200 hover:bg-gray-50 disabled:opacity-40`}
          disabled={page === 0} onClick={() => onChange(page - 1)}>Prev</button>
        {shown.map((p) => {
          const gap = p - previous > 1;
          previous = p;
          return (
            <span key={p} className="flex items-center gap-1">
              {gap && <span className="px-1">…</span>}
              <button type="button" onClick={() => onChange(p)}
                aria-current={p === page ? 'page' : undefined}
                className={`${btn} ${p === page
                  ? 'border-yellow-600 bg-yellow-50 text-yellow-800 font-semibold'
                  : 'border-gray-200 hover:bg-gray-50'}`}>
                {p + 1}
              </button>
            </span>
          );
        })}
        <button type="button" className={`${btn} border-gray-200 hover:bg-gray-50 disabled:opacity-40`}
          disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)}>Next</button>
      </div>
    </div>
  );
}

/** Full-size view of one asset photo (the register thumbnail and the detail
 *  dialog's picture both open this). */
function PhotoModalBody({ assetId, version }: { assetId: string; version?: string | null }) {
  const url = usePhotoBlob(assetId, version);
  if (!url) return <Empty label="Loading photo…" />;
  return <img src={url} alt="Asset photo" className="mx-auto max-h-[70vh] w-auto rounded-lg border border-gray-200" />;
}

const REGISTER_PAGE_SIZE = 10;
const DETAIL_PAGE_SIZE = 5;

const emptyForm = {
  name: '', assetCode: '', categoryId: '', brand: '', model: '', serialNumber: '',
  custodian: '', locationId: '', purchaseDate: '', purchaseCost: '', description: '',
  status: 'ACTIVE', specs: {} as Record<string, string>,
};

export default function Assets() {
  const canManage = hasPermission('assets.manage');
  const [rows, setRows] = useState<AssetRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [custodians, setCustodians] = useState<Custodian[]>([]);
  // tabs (URL-driven, same pattern as Inventory / Meeting Rooms); the setup tab
  // is admin-only, so a stale ?tab=setup URL falls back to the register
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'setup' && canManage ? 'setup' : 'register';
  const setTab = (t: 'register' | 'setup') => setSearchParams(t === 'register' ? {} : { tab: t }, { replace: false });
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  // one value per specification field of the filtered category (sf_<key>=…)
  const [specFilters, setSpecFilters] = useState<Record<string, string>>({});
  const [locationId, setLocationId] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // modals
  const [form, setForm] = useState<(typeof emptyForm & { id?: string }) | null>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [transfer, setTransfer] = useState<{ id: string; name: string; toLocationId: string; custodian: string; note: string } | null>(null);
  const [toDelete, setToDelete] = useState<AssetRow | null>(null);
  // §14.5 cost ledger: add form + the row queued for removal
  const [costForm, setCostForm] = useState<{ kind: string; date: string; amount: string; description: string } | null>(null);
  const [costToDelete, setCostToDelete] = useState<CostRow | null>(null);
  // asset parts (a cartridge fitted into a printer) + the QR label dialog —
  // held as the asset it belongs to, so a row can print a label without the
  // detail panel being open
  const [qrAsset, setQrAsset] = useState<{ id: string; assetCode: string; name: string } | null>(null);
  const [installPick, setInstallPick] = useState('');
  // asset photo: an authenticated blob URL (a plain <img src> cannot send the JWT)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  // the register list is paged; the photo modal shows a picture full size
  const [page, setPage] = useState(0);
  const [photoModal, setPhotoModal] = useState<{ assetId: string; code: string; name: string; version?: string | null } | null>(null);
  // the detail dialog shows one section at a time, each with its own page
  const [detailTab, setDetailTab] = useState<'details' | 'components' | 'cost' | 'movement'>('details');
  const [partsPage, setPartsPage] = useState(0);
  const [costPage, setCostPage] = useState(0);
  const [movePage, setMovePage] = useState(0);

  /** Open one asset by id — shared by the list, the QR deep link and the part links. */
  const openAsset = async (id: string) => {
    setError(null);
    try {
      setDetail(await api<AssetDetail>(`/assets/${id}`));
      setDetailTab('details');
      setPartsPage(0);
      setCostPage(0);
      setMovePage(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open asset');
    }
  };

  // a new filter means a new result set — start again on page 1
  useEffect(() => { setPage(0); }, [q, categoryId, locationId, status]);

  // Fetch the photo as a blob so the request carries the bearer token; revoke
  // the URL when the dialog closes or the picture is replaced.
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setPhotoUrl(null);
    const assetId = detail?.id;
    const hasPhoto = !!detail?.photo;
    if (assetId && hasPhoto) {
      void (async () => {
        try {
          const res = await fetch(`/api/assets/${assetId}/photo`, {
            headers: { Authorization: `Bearer ${getToken()}` },
          });
          if (!res.ok) return;
          url = URL.createObjectURL(await res.blob());
          if (!cancelled) setPhotoUrl(url);
        } catch {
          /* a missing preview never blocks the dialog */
        }
      })();
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [detail?.id, detail?.photo?.updatedAt]);

  const uploadPhoto = async (file: File) => {
    if (!detail) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('Photo too large (max 5 MB)');
      return;
    }
    setError(null);
    setPhotoBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`/api/assets/${detail.id}/photo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
        body,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
        throw new Error(typeof msg === 'string' ? msg : `Upload failed (${res.status})`);
      }
      await openAsset(detail.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to upload the photo');
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    if (!detail) return;
    setError(null);
    setPhotoBusy(true);
    try {
      await api(`/assets/${detail.id}/photo`, { method: 'DELETE' });
      await openAsset(detail.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove the photo');
    } finally {
      setPhotoBusy(false);
    }
  };

  // deep link from the printed label: /asset-register?asset=AST-...
  useEffect(() => {
    const code = searchParams.get('asset');
    if (!code || detail) return;
    const row = rows.find((r) => r.assetCode === code);
    if (row) void openAsset(row.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const installPart = async () => {
    if (!detail || !installPick) return;
    setError(null);
    try {
      setDetail(await api<AssetDetail>(`/assets/${detail.id}/components`, {
        method: 'POST',
        body: { componentAssetId: installPick },
      }));
      setInstallPick('');
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fit the component');
    }
  };

  const removePart = async (linkId: string, retire: boolean) => {
    if (!detail) return;
    setError(null);
    try {
      setDetail(await api<AssetDetail>(
        `/assets/${detail.id}/components/${linkId}${retire ? '?retire=true' : ''}`,
        { method: 'DELETE' },
      ));
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove the component');
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (categoryId) params.set('categoryId', categoryId);
      if (locationId) params.set('locationId', locationId);
      if (status) params.set('status', status);
      for (const [key, value] of Object.entries(specFilters)) {
        if (value) params.set(`sf_${key}`, value);
      }
      const data = await api<AssetRow[]>(`/assets?${params.toString()}`);
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load assets');
    } finally {
      setLoading(false);
    }
  }, [q, categoryId, locationId, status, specFilters]);

  useEffect(() => { void load(); }, [load]);

  // pickers (once, and again after the Asset Setup tab edits them)
  const loadPickers = useCallback(async () => {
    try {
      const [cats, locs, custs] = await Promise.all([
        // /assets/categories carries each category's specification fields, so
        // the form can ask the right questions as soon as one is picked
        api<Category[]>('/assets/categories'),
        api<Location[]>('/procurement/asset-locations'),
        api<Custodian[]>('/assets/custodians'),
      ]);
      setCategories(cats);
      setLocations(locs);
      setCustodians(custs);
    } catch {
      // pickers degrade to empty — the form still works without them
    }
  }, []);

  useEffect(() => { void loadPickers(); }, [loadPickers]);

  const openDetail = async (id: string) => {
    try {
      setDetail(await api<AssetDetail>(`/assets/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load asset');
    }
  };

  const submitForm = async () => {
    if (!form) return;
    setError(null);
    // create: a blank field means "not set" (undefined → backend default).
    // edit:  a blank field means "clear it" (null) — mapping '' to undefined
    // made wiping a custodian/brand/category in the Edit dialog silently keep
    // the old value, because the service reads undefined as "leave unchanged".
    const blank = form.id ? null : undefined;
    const body: Record<string, unknown> = {
      name: form.name,
      assetCode: form.assetCode || undefined,
      categoryId: form.categoryId || blank,
      brand: form.brand || blank,
      model: form.model || blank,
      serialNumber: form.serialNumber || blank,
      custodian: form.custodian || blank,
      locationId: form.locationId || blank,
      purchaseDate: form.purchaseDate || blank,
      purchaseCost: form.purchaseCost === '' ? blank : Number(form.purchaseCost),
      description: form.description || blank,
      // specifications: send the filled ones; edit with none left clears them
      specs: (() => {
        const filled = Object.entries(form.specs ?? {}).filter(([, v]) => String(v ?? '').trim());
        return filled.length ? Object.fromEntries(filled) : blank;
      })(),
      // status is editable only on an existing row (create always starts ACTIVE)
      ...(form.id ? { status: form.status } : {}),
    };
    try {
      if (form.id) await api(`/assets/${form.id}`, { method: 'PATCH', body });
      else await api('/assets', { method: 'POST', body });
      setForm(null);
      await load();
    } catch (e) {
      // keep the dialog open and show WHY — a 409 (duplicate code) or 400 must
      // never look like a silent no-op save
      setError(e instanceof Error ? e.message : 'Failed to save asset');
    }
  };

  const submitTransfer = async () => {
    if (!transfer) return;
    setError(null);
    try {
      await api(`/assets/${transfer.id}/transfer`, {
        method: 'POST',
        body: {
          toLocationId: transfer.toLocationId || undefined,
          custodian: transfer.custodian || undefined,
          note: transfer.note || undefined,
        },
      });
      setTransfer(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transfer failed');
    }
  };

  /** §14.5 — record money spent on this asset (service / part / consumable). */
  const submitCost = async () => {
    if (!detail || !costForm) return;
    setError(null);
    try {
      await api(`/assets/${detail.id}/costs`, {
        method: 'POST',
        body: {
          kind: costForm.kind,
          amount: Number(costForm.amount),
          date: costForm.date || undefined,
          description: costForm.description.trim() || undefined,
        },
      });
      setCostForm(null);
      await openDetail(detail.id);
      await load();
    } catch (e) {
      // keep the dialog open and say why (the API rejects a 0 amount etc.)
      setError(e instanceof Error ? e.message : 'Failed to add the cost');
    }
  };

  const removeCostEntry = async (row: CostRow) => {
    if (!detail) return;
    try {
      await api(`/assets/${detail.id}/costs/${row.id}`, { method: 'DELETE' });
      setCostToDelete(null);
      await openDetail(detail.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove the cost');
    }
  };

  const downloadCsv = async () => {
    try {
      const res = await fetch('/api/assets/csv', { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `asset-register-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const statusBadge = (s: string) => <Badge color={STATUS_COLORS[s] ?? 'gray'}>{s}</Badge>;
  const totalCost = useMemo(
    () => rows.reduce((sum, r) => sum + (r.purchaseCost ? Number(r.purchaseCost) : 0), 0),
    [rows],
  );
  // client-side paging over the filtered list: the API returns the filtered
  // set in one go, so the QR deep link and the CSV export still see every row
  const pageCount = Math.max(1, Math.ceil(rows.length / REGISTER_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * REGISTER_PAGE_SIZE, safePage * REGISTER_PAGE_SIZE + REGISTER_PAGE_SIZE);
  // each detail section is paged on its own, so a long cost ledger never hides
  // the movement history
  const detailParts = detail?.installedParts ?? [];
  const partsPageCount = Math.max(1, Math.ceil(detailParts.length / DETAIL_PAGE_SIZE));
  const safePartsPage = Math.min(partsPage, partsPageCount - 1);
  const detailCosts = detail?.costs ?? [];
  const costPageCount = Math.max(1, Math.ceil(detailCosts.length / DETAIL_PAGE_SIZE));
  const safeCostPage = Math.min(costPage, costPageCount - 1);
  const detailMovements = detail?.movements ?? [];
  const movePageCount = Math.max(1, Math.ceil(detailMovements.length / DETAIL_PAGE_SIZE));
  const safeMovePage = Math.min(movePage, movePageCount - 1);
  const detailTabDefs: { key: 'details' | 'components' | 'cost' | 'movement'; label: string; count: number }[] = detail
    ? [
        { key: 'details', label: 'Details', count: 0 },
        { key: 'components', label: 'Installed components', count: detailParts.filter((p) => !p.removedAt).length },
        { key: 'cost', label: 'Cost & spending', count: detailCosts.length },
        { key: 'movement', label: 'Movement history', count: detailMovements.length },
      ]
    : [];
  const tabDefs: { key: 'register' | 'setup'; label: string }[] = canManage
    ? [{ key: 'register', label: 'Asset Register' }, { key: 'setup', label: 'Asset Setup (New)' }]
    : [{ key: 'register', label: 'Asset Register' }];
  // auto-code segment the backend derives from the chosen category
  // ("IT Equipment" → AST-ITE-…), mirrored here so the dialog can preview it
  const autoSeg = categorySegment(categories.find((c) => c.id === form?.categoryId)?.name);
  // fields the chosen category defines — the questions this asset must answer
  const formSpecFields: SpecField[] = categories.find((c) => c.id === form?.categoryId)?.specFields ?? [];
  // …and the ones the register shows as filterable columns for the chosen filter
  const registerSpecFields: SpecField[] = categories.find((c) => c.id === categoryId)?.specFields ?? [];
  const setSpec = (key: string, value: string) =>
    setForm((f) => (f ? { ...f, specs: { ...f.specs, [key]: value } } : f));

  return (
    <div>
      <PageHeader
        title="Asset Register"
        subtitle={`${rows.length} asset(s) · book value MMK ${totalCost.toLocaleString()}`}
        actions={
          tab === 'register' ? (
            <>
              <Button variant="ghost" onClick={() => void downloadCsv()}>⬇ CSV</Button>
              {canManage && <Button onClick={() => setForm({ ...emptyForm })}>+ New asset</Button>}
            </>
          ) : null
        }
      />

      {/* Tabs (URL-driven, same pattern as Inventory / Meeting Rooms) */}
      {/* flex-wrap: two tabs must not overflow a narrow viewport (they pushed
          the page into horizontal scroll below ~450px) */}
      <div className="flex flex-wrap gap-1 border-b border-gray-200 mb-4">
        {tabDefs.map((t) => (
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

      {/* ============ Tab: Asset Register (everyone) ============ */}
      {tab === 'register' && (
      <>

      {/* filters */}
      <Card className="p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Input placeholder="Search code / name / serial / custodian" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setSpecFilters({}); // the questions change with the category
            }}
          >
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="IN_STORAGE">IN STORAGE</option>
            <option value="MAINTENANCE">MAINTENANCE</option>
            <option value="DISPOSED">DISPOSED</option>
          </Select>
          {registerSpecFields.map((f) =>
            f.type === 'select' ? (
              <Select
                key={f.key}
                value={specFilters[f.key] ?? ''}
                aria-label={`Filter by ${f.label}`}
                onChange={(e) => setSpecFilters((s) => ({ ...s, [f.key]: e.target.value }))}
              >
                <option value="">All {f.label.toLowerCase()}</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            ) : (
              <Input
                key={f.key}
                value={specFilters[f.key] ?? ''}
                placeholder={`Filter by ${f.label.toLowerCase()}`}
                onChange={(e) => setSpecFilters((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            ),
          )}
        </div>
        {registerSpecFields.length > 0 && (
          <p className="mt-2 text-xs text-gray-400">
            Specifications come from Asset Setup → {categories.find((c) => c.id === categoryId)?.name}.
          </p>
        )}
      </Card>

      {error && !form && !detail && !transfer && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>
      )}

      <Table head={['PHOTO', 'CODE', 'NAME', 'CATEGORY', ...registerSpecFields.map((f) => f.label.toUpperCase()), 'SERIAL', 'CUSTODIAN', 'LOCATION', 'STATUS', 'COST (MMK)', 'ACTIONS']}>
        {loading ? (
          <tr><td colSpan={10 + registerSpecFields.length}><Empty label="Loading…" /></td></tr>
        ) : rows.length === 0 ? (
          <tr><td colSpan={10 + registerSpecFields.length}><Empty label="No assets match the filters" /></td></tr>
        ) : pageRows.map((a) => (
          <tr key={a.id} className="hover:bg-gray-50/60">
            <td className="px-4 py-2.5">
              <AssetThumb
                row={a}
                onOpen={() => setPhotoModal({ assetId: a.id, code: a.assetCode, name: a.name, version: a.photo?.updatedAt ?? null })}
              />
            </td>
            <td className="px-4 py-2.5 font-medium text-gray-900">{a.assetCode}</td>
            <td className="px-4 py-2.5">{a.name}</td>
            <td className="px-4 py-2.5">{a.category?.name ?? '—'}</td>
            {registerSpecFields.map((f) => (
              <td key={f.key} className="px-4 py-2.5 text-xs text-gray-600">
                {a.specs?.[f.key] || <span className="text-gray-300">—</span>}
              </td>
            ))}
            <td className="px-4 py-2.5 font-mono text-xs">{a.serialNumber ?? '—'}</td>
            <td className="px-4 py-2.5">{a.custodian ?? '—'}</td>
            <td className="px-4 py-2.5">{a.location?.name ?? '—'}</td>
            <td className="px-4 py-2.5 text-center">{statusBadge(a.status)}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{a.purchaseCost ? Number(a.purchaseCost).toLocaleString() : '—'}</td>
            <td className="px-4 py-2.5 text-center">
              <div className="flex flex-wrap justify-center gap-1">
                <IconButton label="View details" onClick={() => void openDetail(a.id)}><IconEye /></IconButton>
                <IconButton label="Print QR label" onClick={() => setQrAsset({ id: a.id, assetCode: a.assetCode, name: a.name })}>
                  <IconQr />
                </IconButton>
                {canManage && a.status !== 'DISPOSED' && (
                  <IconButton
                    label="Transfer to another location / custodian"
                    onClick={() => setTransfer({ id: a.id, name: a.name, toLocationId: a.location?.id ?? '', custodian: a.custodian ?? '', note: '' })}
                  ><IconTransfer /></IconButton>
                )}
                {canManage && a.status === 'DISPOSED' && (
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-gray-200 text-[10px] text-gray-300" title="A DISPOSED asset cannot be transferred">—</span>
                )}
                {canManage && (
                  <>
                    <IconButton label="Edit asset" onClick={() => setForm({
                      ...emptyForm, id: a.id, name: a.name, assetCode: a.assetCode,
                      categoryId: a.category?.id ?? '', brand: a.brand ?? '', model: a.model ?? '',
                      serialNumber: a.serialNumber ?? '', custodian: a.custodian ?? '',
                      locationId: a.location?.id ?? '', status: a.status,
                      purchaseDate: a.purchaseDate ? a.purchaseDate.slice(0, 10) : '',
                      purchaseCost: a.purchaseCost ?? '', description: a.description ?? '',
                      specs: pruneSpecs(a.category?.specFields, a.specs),
                    })}><IconEdit /></IconButton>
                    <IconButton label="Delete asset" danger onClick={() => setToDelete(a)}><IconTrash /></IconButton>
                  </>
                )}
              </div>
            </td>
          </tr>
        ))}
      </Table>
      <Pager
        page={safePage}
        pageCount={pageCount}
        total={rows.length}
        from={rows.length ? safePage * REGISTER_PAGE_SIZE + 1 : 0}
        to={Math.min(rows.length, (safePage + 1) * REGISTER_PAGE_SIZE)}
        onChange={setPage}
      />
      {rows.length > REGISTER_PAGE_SIZE && (
        <p className="text-[11px] text-gray-400 mt-1">
          {REGISTER_PAGE_SIZE} assets per page — CSV export and search always cover the whole filtered list.
        </p>
      )}

      </>
      )}

      {/* ============ Tab: Asset Setup (New) — CATEGORY / LOCATION / CUSTODIAN CRUD ============ */}
      {tab === 'setup' && canManage && (
        <AssetSetupTab onChanged={() => void loadPickers()} />
      )}

      {/* create / edit */}
      {form && (
        <Modal title={form.id ? 'Edit asset' : 'New asset'} onClose={() => setForm(null)} error={error} wide>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Name *</label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Dell OptiPlex 7090" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Asset code</label>
              <Input
                value={form.assetCode}
                onChange={(e) => setForm({ ...form, assetCode: e.target.value })}
                placeholder="Leave blank → auto from category"
                describe={form.assetCode
                  ? 'Custom code must be unique'
                  : `Auto code: ${autoSeg ? `AST-${autoSeg}-YYMM-0001` : 'AST-YYMM-0001'}`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
              <Select
                value={form.categoryId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  // carry over only the answers the newly picked category asks for
                  setForm({
                    ...form,
                    categoryId: nextId,
                    specs: pruneSpecs(categories.find((c) => c.id === nextId)?.specFields, form.specs),
                  });
                }}
              >
                <option value="">— none —</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Location</label>
              <Select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                <option value="">— none —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
            {/* Status only exists on an existing row (create always starts ACTIVE).
                Previously unreachable from the UI even though the API supports it —
                so the delete dialog's "set DISPOSED instead" advice had no way to be
                followed. Every change is recorded in the movement history. */}
            {form.id && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
                <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="IN_STORAGE">IN STORAGE</option>
                  <option value="MAINTENANCE">MAINTENANCE</option>
                  <option value="DISPOSED">DISPOSED</option>
                </Select>
                <p className="text-[11px] text-gray-400 mt-1">
                  Status changes are logged in the movement history. A DISPOSED asset cannot be transferred.
                </p>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Brand</label>
              <Input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Model</label>
              <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Serial number</label>
              <Input value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
            </div>
            {/* Category-specific questions (a printer's USB vs Network, a
                projector's connection…). Defined per category in Asset Setup,
                so the form only asks what this kind of asset actually has. */}
            {formSpecFields.length > 0 && (
              <div className="sm:col-span-2 rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                <p className="text-xs font-medium text-gray-500 mb-2">
                  Specifications — {categories.find((c) => c.id === form.categoryId)?.name}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {formSpecFields.map((f) => (
                    <div key={f.key}>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{f.label}</label>
                      {f.type === 'select' ? (
                        <Select value={form.specs[f.key] ?? ''} onChange={(e) => setSpec(f.key, e.target.value)}>
                          <option value="">— not set —</option>
                          {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                        </Select>
                      ) : (
                        <Input
                          type={f.type === 'number' ? 'number' : 'text'}
                          value={form.specs[f.key] ?? ''}
                          onChange={(e) => setSpec(f.key, e.target.value)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Custodian</label>
              <Select value={form.custodian} onChange={(e) => setForm({ ...form, custodian: e.target.value })}>
                <option value="">— none —</option>
                {/* a value that left the master list stays selectable, so saving
                    never silently rewrites the row it came from */}
                {form.custodian && !custodians.some((c) => c.name === form.custodian) && (
                  <option value={form.custodian}>{form.custodian}</option>
                )}
                {custodians.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </Select>
              <p className="text-[11px] text-gray-400 mt-1">Maintained in the Asset Setup (New) tab.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Purchase date</label>
              <Input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Purchase cost (MMK)</label>
              <Input type="number" min={0} value={form.purchaseCost} onChange={(e) => setForm({ ...form, purchaseCost: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button disabled={!form.name.trim()} onClick={() => void submitForm()}>{form.id ? 'Save' : 'Create'}</Button>
          </div>
        </Modal>
      )}

      {/* detail with movement history (§16/§40) */}
      {detail && (
        <Modal title={`${detail.assetCode} — ${detail.name}`} onClose={() => setDetail(null)} wide>
          {error && <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
          {/* Sections sit behind tabs at the very top, so the open one gets the
              whole dialog height instead of sharing it with three others. */}
          <div className="flex flex-wrap gap-1 border-b border-gray-200 mb-3">
            {detailTabDefs.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`px-3 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
                  detailTab === t.key
                    ? 'border-yellow-600 text-yellow-800 bg-yellow-50/60'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                }`}
                onClick={() => setDetailTab(t.key)}
              >
                {t.label}{t.key === 'details' ? '' : ` (${t.count})`}
              </button>
            ))}
          </div>
          <div className={detailTab === 'details' ? '' : 'hidden'}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <span className="text-xs text-gray-400">Scan the printed label to open this asset on a signed-in device</span>
            <Button variant="ghost" onClick={() => setQrAsset({ id: detail.id, assetCode: detail.assetCode, name: detail.name })}>
              🏷️ QR label
            </Button>
          </div>
          {/* Asset photo — one picture, replaceable. Stored privately and shown
              only through the token-guarded endpoint. */}
          <div className="mb-4 flex flex-wrap items-start gap-4">
            <div className="w-44 h-32 shrink-0 rounded-lg border border-gray-200 bg-gray-50 overflow-hidden flex items-center justify-center">
              {photoUrl ? (
                <button
                  type="button"
                  title="View photo"
                  aria-label={`View ${detail.assetCode} photo`}
                  className="w-full h-full"
                  onClick={() => setPhotoModal({ assetId: detail.id, code: detail.assetCode, name: detail.name, version: detail.photo?.updatedAt ?? null })}
                >
                  <img src={photoUrl} alt={`${detail.assetCode} photo`} className="w-full h-full object-cover" />
                </button>
              ) : (
                <span className="text-xs text-gray-400">No photo</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-gray-400 text-xs block mb-1">Photo · JPEG / PNG / WebP, max 5 MB</span>
              <span className="text-[11px] text-gray-400 block mb-2">Location data (EXIF/GPS) is removed on upload.</span>
              {detail.photo && (
                <span className="text-xs text-gray-500 block mb-2">
                  {detail.photo.size ? `${Math.round(detail.photo.size / 1024)} KB` : ''}
                  {detail.photo.updatedAt ? ` · updated ${detail.photo.updatedAt.slice(0, 10)}` : ''}
                </span>
              )}
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  <label
                    className={`inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium cursor-pointer ${
                      photoBusy ? 'bg-gray-200 text-gray-500' : 'bg-yellow-600 text-white hover:bg-yellow-700'
                    }`}
                  >
                    {photoBusy ? 'Uploading…' : detail.photo ? 'Replace photo' : 'Upload photo'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      disabled={photoBusy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.currentTarget.value = ''; // picking the same file again must still fire
                        if (file) void uploadPhoto(file);
                      }}
                    />
                  </label>
                  {detail.photo && (
                    <Button variant="ghost" onClick={() => void removePhoto()} disabled={photoBusy}>
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm mb-4">
            <div><span className="text-gray-400 text-xs block">Status</span>{statusBadge(detail.status)}</div>
            <div><span className="text-gray-400 text-xs block">Category</span>{detail.category?.name ?? '—'}</div>
            <div><span className="text-gray-400 text-xs block">Location</span>{detail.location?.name ?? '—'}</div>
            <div><span className="text-gray-400 text-xs block">Custodian</span>{detail.custodian ?? '—'}</div>
            <div><span className="text-gray-400 text-xs block">Serial</span><span className="font-mono text-xs">{detail.serialNumber ?? '—'}</span></div>
            <div><span className="text-gray-400 text-xs block">Cost</span>{detail.purchaseCost ? Number(detail.purchaseCost).toLocaleString() : '—'}</div>
            <div><span className="text-gray-400 text-xs block">Brand / Model</span>{[detail.brand, detail.model].filter(Boolean).join(' / ') || '—'}</div>
            <div><span className="text-gray-400 text-xs block">Purchase date</span>{detail.purchaseDate ? detail.purchaseDate.slice(0, 10) : '—'}</div>
            <div><span className="text-gray-400 text-xs block">Acquired via</span>{detail.poItems.map((p) => p.purchaseOrder.poNumber).join(', ') || '—'}</div>
          </div>
          {detail.category?.specFields?.length ? (
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Specifications</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                {detail.category.specFields.map((f) => (
                  <div key={f.key}>
                    <span className="text-gray-400 text-xs block">{f.label}</span>
                    {detail.specs?.[f.key] || <span className="text-gray-300">—</span>}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {detail.description && <p className="text-sm text-gray-600 mb-4">{detail.description}</p>}

          </div>

          {/* Parts fitted into this asset (a cartridge in a printer): the same link
              that puts the part's price on this asset's cost of ownership. */}
          <div className={`mb-4 ${detailTab === 'components' ? '' : 'hidden'}`}>
            {detail.installedIn.filter((l) => !l.removedAt).map((l) => (
              <div key={l.id} className="mb-2 text-sm">
                <span className="text-gray-400 text-xs block">Installed in</span>
                <button type="button" className="text-blue-600 hover:underline" onClick={() => void openAsset(l.parent.id)}>
                  🖨 {l.parent.assetCode} — {l.parent.name}
                </button>
              </div>
            ))}
            {detailParts.length === 0 ? (
              <Empty label="No components fitted" />
            ) : (
              <ul className="divide-y divide-gray-100 text-sm">
                {detailParts.slice(safePartsPage * DETAIL_PAGE_SIZE, (safePartsPage + 1) * DETAIL_PAGE_SIZE).map((p) => (
                  <li key={p.id} className="py-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="font-medium text-gray-800">{p.component.assetCode}</span>
                      <span className="text-gray-500"> — {p.component.name}</span>
                      <div className="text-xs text-gray-400">
                        {p.removedAt ? `removed ${p.removedAt.slice(0, 10)}` : `fitted ${p.installedAt.slice(0, 10)}`}
                        {p.component.purchaseCost
                          ? ` · ${Number(p.component.purchaseCost).toLocaleString()} MMK on this asset`
                          : ''}
                        {p.note ? ` · ${p.note}` : ''}
                      </div>
                    </div>
                    {canManage && !p.removedAt && (
                      <div className="flex gap-2 shrink-0">
                        <button type="button" className="text-xs text-gray-600 hover:underline" onClick={() => void removePart(p.id, false)}>
                          Remove
                        </button>
                        <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => void removePart(p.id, true)}>
                          Used up
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Pager
              page={safePartsPage}
              pageCount={partsPageCount}
              total={detailParts.length}
              from={detailParts.length ? safePartsPage * DETAIL_PAGE_SIZE + 1 : 0}
              to={Math.min(detailParts.length, (safePartsPage + 1) * DETAIL_PAGE_SIZE)}
              onChange={setPartsPage}
            />
            {canManage && (
              <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center mt-2">
                <Select value={installPick} onChange={(e) => setInstallPick(e.target.value)} className="!w-full sm:!w-72">
                  <option value="">— pick an asset to fit —</option>
                  {rows
                    .filter((r) => r.id !== detail.id && r.status !== 'DISPOSED')
                    .map((r) => (
                      <option key={r.id} value={r.id}>{r.assetCode} — {r.name}</option>
                    ))}
                </Select>
                <Button variant="ghost" disabled={!installPick} onClick={() => void installPart()}>
                  + Fit component
                </Button>
              </div>
            )}
            <p className="text-[11px] text-gray-400 mt-1">
              A part bought as its own asset (a toner cartridge) is fitted here: its price moves onto this asset's cost
              ledger and the part shows IN_USE. Parts that are never reused again are better kept as Inventory stock and
              issued to the asset.
            </p>
          </div>

          {/* §14.5 cost ledger — purchase price + everything spent since */}
          <div className={detailTab === 'cost' ? '' : 'hidden'}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="text-sm font-semibold text-gray-700">Cost &amp; spending</h3>
            {canManage && (
              <Button
                variant="ghost"
                onClick={() => setCostForm({
                  kind: 'SERVICE',
                  date: new Date().toISOString().slice(0, 10),
                  amount: '',
                  description: '',
                })}
              >
                + Add cost
              </Button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm mb-3">
            <div>
              <span className="text-gray-400 text-xs block">Purchase cost</span>
              <span className="tabular-nums">{detail.costSummary.purchaseCost.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-gray-400 text-xs block">Spent since ({detail.costSummary.entries})</span>
              <span className="tabular-nums">{detail.costSummary.recordedCost.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-gray-400 text-xs block">Total cost</span>
              <span className="font-semibold tabular-nums">{detail.costSummary.totalCost.toLocaleString()}</span>
            </div>
          </div>
          {detail.costs.length === 0 ? (
            <Empty label="No costs recorded yet" />
          ) : (
            <ul className="divide-y divide-gray-100 text-sm mb-4">
              {detailCosts.slice(safeCostPage * DETAIL_PAGE_SIZE, (safeCostPage + 1) * DETAIL_PAGE_SIZE).map((c) => (
                <li key={c.id} className="py-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-medium text-gray-800">{c.kind}</span>
                    <span className="text-gray-500"> — {c.description ?? '—'}</span>
                    {(c.supplier?.name || c.account?.name) && (
                      <div className="text-xs text-gray-400">
                        {[c.supplier?.name, c.account?.name].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-medium tabular-nums">{Number(c.amount).toLocaleString()}</div>
                    <div className="text-xs text-gray-400">
                      {c.date.slice(0, 10)}{c.sourceType === 'INVOICE' ? ' · invoice' : ''}
                    </div>
                    {canManage && c.sourceType === 'MANUAL' && (
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline mt-0.5"
                        onClick={() => setCostToDelete(c)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Pager
            page={safeCostPage}
            pageCount={costPageCount}
            total={detailCosts.length}
            from={detailCosts.length ? safeCostPage * DETAIL_PAGE_SIZE + 1 : 0}
            to={Math.min(detailCosts.length, (safeCostPage + 1) * DETAIL_PAGE_SIZE)}
            onChange={setCostPage}
          />
          </div>

          <div className={detailTab === 'movement' ? '' : 'hidden'}>
          {detailMovements.length === 0 ? (
            <Empty label="No movements recorded" />
          ) : (
            <ul className="divide-y divide-gray-100 text-sm">
              {detailMovements.slice(safeMovePage * DETAIL_PAGE_SIZE, (safeMovePage + 1) * DETAIL_PAGE_SIZE).map((m) => (
                <li key={m.id} className="py-2 flex items-start justify-between gap-3">
                  <div>
                    <span className="font-medium text-gray-800">{m.type}</span>
                    <span className="text-gray-500">
                      {m.fromLocation?.name || m.toLocation?.name
                        ? ` — ${m.fromLocation?.name ?? '—'} → ${m.toLocation?.name ?? '—'}`
                        : ''}
                    </span>
                    {m.note && <div className="text-xs text-gray-400">{m.note}</div>}
                  </div>
                  <div className="text-right text-xs text-gray-400 shrink-0">
                    <div>{m.createdAt.slice(0, 10)}</div>
                    <div>{m.createdBy?.username}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Pager
            page={safeMovePage}
            pageCount={movePageCount}
            total={detailMovements.length}
            from={detailMovements.length ? safeMovePage * DETAIL_PAGE_SIZE + 1 : 0}
            to={Math.min(detailMovements.length, (safeMovePage + 1) * DETAIL_PAGE_SIZE)}
            onChange={setMovePage}
          />
          </div>
        </Modal>
      )}

      {qrAsset && (
        <Modal title={`QR label — ${qrAsset.assetCode}`} onClose={() => setQrAsset(null)}>
          <QrLabel assetId={qrAsset.id} assetCode={qrAsset.assetCode} name={qrAsset.name} />
        </Modal>
      )}

      {/* full-size photo — opened from a register thumbnail or the detail picture */}
      {photoModal && (
        <Modal title={`${photoModal.code} — photo`} onClose={() => setPhotoModal(null)} wide>
          <p className="text-sm text-gray-600 mb-3">{photoModal.name}</p>
          <PhotoModalBody assetId={photoModal.assetId} version={photoModal.version} />
          <p className="text-[11px] text-gray-400 mt-3">
            Served through the signed-in photo route — the picture is never a public file.
          </p>
        </Modal>
      )}

      {/* §14.5 add a cost against the open asset */}
      {costForm && detail && (
        <Modal title={`Add cost — ${detail.assetCode}`} onClose={() => setCostForm(null)} error={error}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">What was it for?</label>
              <Select value={costForm.kind} onChange={(e) => setCostForm({ ...costForm, kind: e.target.value })}>
                <option value="SERVICE">SERVICE — service / maintenance visit</option>
                <option value="REPAIR">REPAIR — breakdown repair</option>
                <option value="PART">PART — spare part</option>
                <option value="CONSUMABLE">CONSUMABLE — toner, cartridge, filters…</option>
                <option value="PURCHASE">PURCHASE — accessories / other purchase</option>
                <option value="OTHER">OTHER</option>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
                <Input type="date" value={costForm.date} onChange={(e) => setCostForm({ ...costForm, date: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Amount (Ks)</label>
                <Input
                  type="number"
                  min={0}
                  value={costForm.amount}
                  onChange={(e) => setCostForm({ ...costForm, amount: e.target.value })}
                  placeholder="0"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Note</label>
              <Input
                value={costForm.description}
                onChange={(e) => setCostForm({ ...costForm, description: e.target.value })}
                placeholder="e.g. Gas refill + compressor cleaning"
              />
            </div>
            <p className="text-xs text-gray-400">
              Recorded against this asset only — the purchase price stays on the asset row, so the
              total never counts the same money twice.
            </p>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setCostForm(null)}>Cancel</Button>
            <Button disabled={!costForm.amount || Number(costForm.amount) <= 0} onClick={() => void submitCost()}>Save</Button>
          </div>
        </Modal>
      )}

      {/* transfer (§40) */}
      {transfer && (
        <Modal title={`Transfer — ${transfer.name}`} onClose={() => setTransfer(null)} error={error}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">New location</label>
              <Select value={transfer.toLocationId} onChange={(e) => setTransfer({ ...transfer, toLocationId: e.target.value })}>
                <option value="">— keep current —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Custodian</label>
              <Select value={transfer.custodian} onChange={(e) => setTransfer({ ...transfer, custodian: e.target.value })}>
                <option value="">— keep current —</option>
                {transfer.custodian && !custodians.some((c) => c.name === transfer.custodian) && (
                  <option value={transfer.custodian}>{transfer.custodian}</option>
                )}
                {custodians.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Note</label>
              <Input value={transfer.note} onChange={(e) => setTransfer({ ...transfer, note: e.target.value })} placeholder="Reason for the move" />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setTransfer(null)}>Cancel</Button>
            <Button onClick={() => void submitTransfer()}>Transfer</Button>
          </div>
        </Modal>
      )}

      {/* remove a hand-typed cost row (invoice rows are refused by the API) */}
      {costToDelete && (
        <ConfirmDialog
          title={`Remove this ${costToDelete.kind.toLowerCase()} cost?`}
          description={`${Number(costToDelete.amount).toLocaleString()} Ks on ${costToDelete.date.slice(0, 10)} will be removed from this asset's history.`}
          variant="danger"
          confirmLabel="Remove"
          onClose={() => setCostToDelete(null)}
          onConfirm={async () => { await removeCostEntry(costToDelete); }}
        />
      )}

      {/* delete — §66: procurement-linked assets are refused by the API */}
      {toDelete && (
        <ConfirmDialog
          title={`Delete ${toDelete.assetCode}?`}
          description="Only unused assets can be deleted. Assets with procurement history must be set to DISPOSED instead (the delete API enforces this)."
          variant="danger"
          confirmLabel="Delete"
          onClose={() => setToDelete(null)}
          onConfirm={async () => {
            await api(`/assets/${toDelete.id}`, { method: 'DELETE' });
            setToDelete(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
