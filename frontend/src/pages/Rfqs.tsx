import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Textarea } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { fmtDate } from '../util/yangonTime';
import { toast } from '../components/Toast';

// ---------------------------------------------------------------------------
// RFQ / Quotation / Comparison (Procurement Design §11–14, phase P3/P4).
// A quotation request (RFQ-…) records that vendors were asked. It is not a
// workflow document: no approval step (the record opens on creation) and no
// entry in Approvals or My Requests. It carries the vendors asked (§11), their
// quotations (§12) and the recorded comparison decision (§13–14).
// ---------------------------------------------------------------------------

interface SupplierRef {
  id: string;
  name: string;
  isActive?: boolean;
}

interface RfqVendor {
  id: string;
  supplier: SupplierRef;
  priority: number;
  contactedAt: string;
  contactReason?: string | null;
}

interface QuotationItem {
  id?: string;
  description: string;
  quantity: number;
  unit?: string | null;
  unitPrice: string; // Decimal arrives as string over the wire
  taxPercent?: string | null;
  discountPercent?: string | null;
  deliveryDays?: number | null;
  warrantyMonths?: number | null;
}

interface Quotation {
  id: string;
  quoteNumber: string;
  supplier: SupplierRef;
  quoteDate: string;
  validUntil?: string | null;
  paymentTerms?: string | null;
  taxIncluded: boolean;
  items: QuotationItem[];
}

interface ComparisonRow {
  quotationId: string;
  quoteNumber: string;
  supplierId: string;
  supplier: string;
  subtotal: number;
  paymentTerms?: string | null;
  validUntil?: string | null;
  lines: { description: string; quantity: number; unitPrice: number; lineTotal: number; deliveryDays?: number | null; warrantyMonths?: number | null }[];
}

interface RfqDecision {
  id: string;
  selectionReason: string;
  supportingDocument?: string | null;
  recommendedSupplier: SupplierRef;
  recommendedQuote: Quotation;
  createdBy?: { fullName: string } | null;
}

interface RfqRow {
  id: string; // quotation_requests id (children keep this same rfqId)
  docNumber: string;
  title: string;
  status: string;
  createdAt: string;
  requester?: { fullName: string } | null;
  department?: { name: string } | null;
  rfq?: {
    dueDate?: string | null;
    specification?: string | null;
    notes?: string | null;
    /** the approved PR this RFQ asks vendors about (drives the PO defaults) */
    purchaseRequest?: { requestId: string; request: { docNumber: string } } | null;
    rfqVendors?: RfqVendor[];
    quotations?: Quotation[];
    comparison?: RfqDecision | null;
  } | null;
}

/** An RFQ raised before the quotation_requests table existed: it is still a
 *  workflow document row, archived out of the active lists. Read-only here. */
interface ArchivedRfqRow {
  id: string;
  docNumber: string;
  title: string;
  status: string;
  createdAt: string;
  archivedAt?: string | null;
  requester?: { fullName: string } | null;
  department?: { name: string } | null;
}

type RfqFilter = 'all' | 'open' | 'closed' | 'archived';

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'orange'> = {
  OPEN: 'green',
  CLOSED: 'gray',
  CANCELLED: 'gray',
};

const statusLabel = (s: string) =>
  s === 'OPEN' ? 'Open' : s === 'CLOSED' ? 'Closed' : s === 'CANCELLED' ? 'Cancelled' : s;

const fmtMoney = (n: number) => (n === undefined || n === null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const num = (v: string | number | null | undefined, fallback = 0) => (v === null || v === undefined || v === '' ? fallback : Number(v));

export default function Rfqs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const canManage = hasPermission('procurement.manage');
  const [rows, setRows] = useState<RfqRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(searchParams.get('new') === '1');
  const [detail, setDetail] = useState<string | null>(null); // rfqId
  const [filter, setFilter] = useState<RfqFilter>('all');
  const [archived, setArchived] = useState<ArchivedRfqRow[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: RfqRow[] }>('/procurement/rfqs?pageSize=100')
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  // Old RFQs (pre quotation_requests) live on as archived workflow documents;
  // the archive view reads them from the documents API so their history stays
  // reachable instead of only through a hand-made link.
  useEffect(() => {
    if (filter !== 'archived') return;
    setArchivedLoading(true);
    api<{ items: ArchivedRfqRow[] }>('/requests?docType=RFQ&archived=only&pageSize=100')
      .then((r) => setArchived(r.items))
      .catch((e) => setError(e.message))
      .finally(() => setArchivedLoading(false));
  }, [filter]);

  const closeForm = () => {
    setShowForm(false);
    if (searchParams.get('new')) setSearchParams({}, { replace: false });
    load();
  };

  const visible = rows.filter((r) =>
    filter === 'all' ? true : filter === 'open' ? r.status === 'OPEN' : filter === 'closed' ? r.status === 'CLOSED' : false,
  );

  const filters: { key: RfqFilter; label: string }[] = [
    { key: 'all', label: `All (${rows.length})` },
    { key: 'open', label: `Open (${rows.filter((r) => r.status === 'OPEN').length})` },
    { key: 'closed', label: `Closed (${rows.filter((r) => r.status === 'CLOSED').length})` },
    { key: 'archived', label: 'Archived' },
  ];

  return (
    <div>
      <PageHeader
        title="RFQ — Request for Quotation"
        subtitle="Ask vendors, compare their quotations, record the decision (design §11–14)"
        actions={
          canManage && (
            <Button onClick={() => setShowForm(true)}>+ New RFQ</Button>
          )
        }
      />
      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <div className="flex flex-wrap gap-2 mb-3">
        {filters.map((f) => (
          <Button key={f.key} variant={filter === f.key ? 'primary' : 'ghost'} onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      <Card>
        {filter === 'archived' ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3 font-medium">Doc No.</th>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Requester</th>
                <th className="px-4 py-3 font-medium">Department</th>
                <th className="px-4 py-3 font-medium text-center">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {archived.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <Empty label={archivedLoading ? 'Loading…' : 'No archived RFQs'} />
                  </td>
                </tr>
              )}
              {archived.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50 align-top">
                  <td className="px-4 py-3 font-medium whitespace-nowrap">
                    <Link className="text-blue-600 hover:underline" to={`/requests/${a.id}`}>
                      {a.docNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{a.title}</td>
                  <td className="px-4 py-3 text-gray-500">{a.requester?.fullName ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{a.department?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-center">
                    <Badge color="gray">Archived</Badge>
                    <div className="text-xs text-gray-400 mt-1">{statusLabel(a.status)}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Doc No.</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Vendors</th>
              <th className="px-4 py-3 font-medium">Quotation</th>
              <th className="px-4 py-3 font-medium">Decision</th>
              <th className="px-4 py-3 font-medium text-center">Status</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <Empty
                    label={
                      loading
                        ? 'Loading…'
                        : filter === 'open'
                          ? 'No open RFQs'
                          : filter === 'closed'
                            ? 'No closed RFQs'
                            : 'No RFQs yet — create one from an approved request'
                    }
                  />
                </td>
              </tr>
            )}
            {visible.map((r) => {
              const vendors = r.rfq?.rfqVendors ?? [];
              const quotes = r.rfq?.quotations ?? [];
              return (
                <tr key={r.id} className="hover:bg-gray-50 align-top">
                  <td className="px-4 py-3 font-medium whitespace-nowrap">
                    <button className="text-blue-600 hover:underline" onClick={() => setDetail(r.id)}>
                      {r.docNumber}
                    </button>
                  </td>
                  <td className="px-4 py-3">{r.title}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {vendors.length === 0 ? '—' : vendors.map((v) => v.supplier.name).join(', ')}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{quotes.length === 0 ? '—' : quotes.map((q) => `${q.supplier.name} (${q.quoteNumber})`).join(', ')}</td>
                  <td className="px-4 py-3">
                    {r.rfq?.comparison ? (
                      <Badge color="green">★ {r.rfq.comparison.recommendedSupplier.name}</Badge>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge color={STATUS_COLORS[r.status] ?? 'gray'}>{statusLabel(r.status)}</Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </Card>

      {showForm && <NewRfqModal onClose={closeForm} prefillRequestId={searchParams.get('pr') ?? undefined} />}
      {detail && <RfqDetailModal rfqId={detail} canManage={canManage} onClose={() => { setDetail(null); load(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function NewRfqModal({ onClose, prefillRequestId }: { onClose: () => void; prefillRequestId?: string }) {
  const [suppliers, setSuppliers] = useState<SupplierRef[]>([]);
  const [prs, setPrs] = useState<{ id: string; docNumber: string; title: string; purchaseRequest?: { items: { description: string; quantity: number }[] } | null }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sourcePr, setSourcePr] = useState(prefillRequestId ?? '');
  const [title, setTitle] = useState('');
  const [specification, setSpecification] = useState('');
  const [notes, setNotes] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [vendorIds, setVendorIds] = useState<string[]>([]);

  useEffect(() => {
    api<SupplierRef[]>('/suppliers?all=1').then((s) => setSuppliers(s.filter((x) => x.isActive))).catch(() => setSuppliers([]));
    // approved PRs are RFQ candidates (design: approve first, then ask vendors)
    api<{ items: { id: string; docNumber: string; title: string; purchaseRequest?: { items: { description: string; quantity: number }[] } | null }[] }>(
      '/procurement/requests?status=APPROVED&pageSize=100',
    )
      .then((r) => setPrs(r.items))
      .catch(() => setPrs([]));
  }, []);

  const pickPr = (requestId: string) => {
    setSourcePr(requestId);
    const pr = prs.find((p) => p.id === requestId);
    if (pr && !title.trim()) setTitle(`${pr.title.replace(/^Purchase:\s*/, '')} — RFQ`);
    if (pr && !specification.trim()) {
      const lines = (pr.purchaseRequest?.items ?? []).map((it) => `• ${it.description} ×${it.quantity}`);
      setSpecification(lines.join('\n'));
    }
  };

  const toggleVendor = (id: string) =>
    setVendorIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));

  const valid = title.trim().length > 0;

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const created = await api<{ id: string; docNumber: string }>('/procurement/rfqs', {
        method: 'POST',
        body: {
          title: title.trim(),
          purchaseRequestId: sourcePr || undefined,
          specification: specification.trim() || undefined,
          notes: notes.trim() || undefined,
          dueDate: dueDate || undefined,
          vendors: vendorIds.map((supplierId) => ({ supplierId })),
        },
      });
      toast(`RFQ ${created.docNumber} created${vendorIds.length ? ` — ${vendorIds.length} vendor(s) invited` : ''}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <Modal title="New RFQ" error={error} wide onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label htmlFor="rfq-src-pr" className="text-xs text-gray-500 block mb-1">
            Source PR (optional — pre-fills the requirement and lets the PO default to a vendor that quoted)
          </label>
          <Select id="rfq-src-pr" value={sourcePr} onChange={(e) => pickPr(e.target.value)}>
            <option value="">Manual RFQ (no source PR)</option>
            {prs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.docNumber} — {p.title}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="rfq-title" className="text-xs text-gray-500 block mb-1">
            Title *
          </label>
          <Input id="rfq-title" placeholder="What are you buying?" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label htmlFor="rfq-spec" className="text-xs text-gray-500 block mb-1">
            Specification / requirement list
          </label>
          <Textarea id="rfq-spec" rows={4} placeholder={'• Item ×qty\n• Item ×qty'} value={specification} onChange={(e) => setSpecification(e.target.value)} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="rfq-due" className="text-xs text-gray-500 block mb-1">
              Quotation due date (§11)
            </label>
            <Input id="rfq-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="rfq-notes" className="text-xs text-gray-500 block mb-1">
              Extra instructions to vendors
            </label>
            <Input id="rfq-notes" placeholder="Delivery location, packaging, …" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
            Vendors to invite (§11) — {vendorIds.length} selected
          </div>
          {suppliers.length === 0 ? (
            <Empty label="No active suppliers — register vendors first" />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-2">
              {suppliers.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm text-gray-700 hover:bg-gray-50 rounded px-2 py-1 cursor-pointer">
                  <input type="checkbox" checked={vendorIds.includes(s.id)} onChange={() => toggleVendor(s.id)} />
                  {s.name}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="sticky bottom-0 -mx-5 px-5 py-3 mt-4 flex justify-end bg-white border-t border-gray-100 rounded-b-xl">
        <Button disabled={!valid || busy} onClick={submit}>
          {busy ? 'Creating…' : 'Create RFQ'}
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

interface DraftQuoteItem {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxPercent: string;
  discountPercent: string;
  deliveryDays: string;
  warrantyMonths: string;
}

const emptyQuoteItem = (): DraftQuoteItem => ({
  description: '', quantity: '', unit: '', unitPrice: '', taxPercent: '', discountPercent: '', deliveryDays: '', warrantyMonths: '',
});

function RfqDetailModal({ rfqId, canManage, onClose }: { rfqId: string; canManage: boolean; onClose: () => void }) {
  const [doc, setDoc] = useState<RfqRow | null>(null);
  const [comparison, setComparison] = useState<ComparisonRow[]>([]);
  const [decision, setDecision] = useState<RfqDecision | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showQuoteForm, setShowQuoteForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingQuote, setEditingQuote] = useState<Quotation | null>(null);
  const [deletingQuote, setDeletingQuote] = useState<Quotation | null>(null);

  const load = useCallback(() => {
    api<RfqRow & { rfq?: { comparison?: RfqDecision | null } }>(`/procurement/rfqs/${rfqId}`).then((d) => {
      setDoc(d);
      setDecision(d.rfq?.comparison ?? null);
    }).catch((e) => setError(e.message));
    api<ComparisonRow[]>(`/procurement/rfqs/${rfqId}/comparison`).then(setComparison).catch(() => setComparison([]));
  }, [rfqId]);

  useEffect(load, [load]);

  const rfq = doc?.rfq;
  const vendors = rfq?.rfqVendors ?? [];
  const quotes = rfq?.quotations ?? [];

  const act = async (fn: () => Promise<unknown>, okMessage: string) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      toast(okMessage);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  if (!doc) return <Modal title="RFQ" onClose={onClose} error={error} xl>{<Empty label="Loading…" />}</Modal>;

  const status = doc.status;

  return (
    <Modal title={`${doc.docNumber} — RFQ`} onClose={onClose} error={error} xl>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={STATUS_COLORS[status] ?? 'gray'}>{statusLabel(status)}</Badge>
          <span className="text-sm text-gray-600">{doc.title}</span>
          {(rfq?.dueDate) && <span className="text-xs text-gray-400">Quotation due: {fmtDate(rfq.dueDate)}</span>}
        </div>
        <SourcePrEditor
          rfqId={doc.id}
          current={rfq?.purchaseRequest ?? null}
          canEdit={canManage && !['CLOSED', 'CANCELLED', 'REJECTED'].includes(status)}
          onDone={load}
        />
        {rfq?.specification && (
          <div className="text-sm whitespace-pre-wrap bg-gray-50 border border-gray-100 rounded-lg p-3">{rfq.specification}</div>
        )}

        {/* no approval step — the RFQ is recorded on creation; close it when the round ends */}
        <div className="flex flex-wrap gap-2">
          {canManage && status === 'OPEN' && (
            <Button variant="ghost" disabled={busy} onClick={() => act(() => api(`/procurement/rfqs/${doc.id}/close`, { method: 'PATCH' }), 'RFQ closed')}>
              Close RFQ
            </Button>
          )}
          {canManage && quotes.length === 0 && status === 'OPEN' && (
            <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete RFQ
            </Button>
          )}
        </div>

        {confirmDelete && (
          <ConfirmDialog
            title={`Delete ${doc.docNumber}?`}
            description={`Removes the RFQ with its ${vendors.length} invited vendor(s). Only an RFQ with no quotations recorded can be deleted — once a vendor has quoted, close it instead. This cannot be undone.`}
            confirmLabel="Delete RFQ"
            variant="danger"
            onClose={() => setConfirmDelete(false)}
            onConfirm={async () => {
              await api(`/procurement/rfqs/${doc.id}`, { method: 'DELETE' });
              toast('RFQ deleted');
              setConfirmDelete(false);
              onClose();
            }}
          />
        )}

        {deletingQuote && (
          <ConfirmDialog
            title={`Delete quotation #${deletingQuote.quoteNumber}?`}
            description={`Removes ${deletingQuote.supplier.name}'s quotation with its ${deletingQuote.items.length} line(s). Record it again if this was not a mistake. Only possible while the RFQ is open and no vendor decision has been recorded.`}
            confirmLabel="Delete quotation"
            variant="danger"
            onClose={() => setDeletingQuote(null)}
            onConfirm={async () => {
              try {
                await api(`/procurement/rfqs/${doc.id}/quotations/${deletingQuote.id}`, { method: 'DELETE' });
                toast('Quotation deleted');
                setDeletingQuote(null);
                load();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not delete the quotation');
                setDeletingQuote(null);
              }
            }}
          />
        )}

        {/* vendors §11 */}
        <section>
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Vendors ({vendors.length})</div>
          {vendors.length === 0 ? <Empty label="No vendors invited yet" /> : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
              {vendors.map((v) => (
                <li key={v.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div>
                    <span className="font-medium text-gray-800">{v.supplier.name}</span>
                    <span className="text-xs text-gray-400 ml-2">{v.contactReason}</span>
                  </div>
                  <span className="text-xs text-gray-400">asked {fmtDate(v.contactedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          {canManage && <VendorPicker rfqId={doc.id} existing={vendors.map((v) => v.supplier.id)} onDone={load} />}
        </section>

        {/* quotations §12 */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Quotations ({quotes.length})</div>
            {canManage && vendors.length > 0 && !editingQuote && (
              <Button variant="ghost" onClick={() => setShowQuoteForm(!showQuoteForm)}>
                {showQuoteForm ? 'Cancel' : '+ Record quotation'}
              </Button>
            )}
          </div>
          {(showQuoteForm || editingQuote) && (
            <NewQuotationForm
              rfqId={doc.id}
              vendors={vendors}
              initial={editingQuote ?? undefined}
              onDone={() => { setShowQuoteForm(false); setEditingQuote(null); load(); }}
              onCancel={() => { setShowQuoteForm(false); setEditingQuote(null); }}
            />
          )}
          {quotes.length === 0 ? <Empty label="No quotations yet" /> : (
            <div className="space-y-3">
              {quotes.map((q) => (
                <div key={q.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm mb-2">
                    <span className="font-medium text-gray-800">{q.supplier.name}</span>
                    <Badge color="blue">#{q.quoteNumber}</Badge>
                    <span className="text-xs text-gray-400">
                      {q.paymentTerms ? `${q.paymentTerms} · ` : ''}quoted {fmtDate(q.quoteDate)}
                    </span>
                    {canManage && status === 'OPEN' && !decision && (
                      <span className="ml-auto flex gap-2">
                        <Button variant="ghost" onClick={() => { setEditingQuote(q); setShowQuoteForm(false); }}>Edit</Button>
                        <Button variant="danger" onClick={() => setDeletingQuote(q)}>Delete</Button>
                      </span>
                    )}
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-400 text-left">
                        <th className="py-1">Item</th>
                        <th className="py-1">Qty</th>
                        <th className="py-1">Unit price</th>
                        <th className="py-1">Disc%</th>
                        <th className="py-1">Tax%</th>
                        <th className="py-1">Delivery</th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.items.map((it, i) => (
                        <tr key={it.id ?? i} className="border-t border-gray-50">
                          <td className="py-1">{it.description}</td>
                          <td className="py-1">{it.quantity}{it.unit ? ` ${it.unit}` : ''}</td>
                          <td className="py-1">{num(it.unitPrice).toLocaleString()}</td>
                          <td className="py-1">{num(it.discountPercent, 0)}</td>
                          <td className="py-1">{num(it.taxPercent, 0)}</td>
                          <td className="py-1">{it.deliveryDays ? `${it.deliveryDays} d` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* comparison §13 */}
        {comparison.length > 0 && (
          <section>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Comparison (net totals, low → high)</div>
            <div className="border border-gray-200 rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs text-gray-500 bg-gray-50/70">
                    <th className="px-3 py-2 font-medium">Rank</th>
                    <th className="px-3 py-2 font-medium">Vendor</th>
                    <th className="px-3 py-2 font-medium">Quote</th>
                    <th className="px-3 py-2 font-medium">Lines</th>
                    <th className="px-3 py-2 font-medium">Net total (Ks)</th>
                    <th className="px-3 py-2 font-medium">Terms</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {comparison.map((row, i) => (
                    <tr key={row.quotationId} className={i === 0 ? 'bg-green-50/60' : ''}>
                      <td className="px-3 py-2">{i === 0 ? '🥇 1' : i + 1}</td>
                      <td className="px-3 py-2 font-medium">{row.supplier}</td>
                      <td className="px-3 py-2 text-gray-500">#{row.quoteNumber}</td>
                      <td className="px-3 py-2 text-gray-500">{row.lines.length}</td>
                      <td className="px-3 py-2 font-medium">{fmtMoney(row.subtotal)}</td>
                      <td className="px-3 py-2 text-gray-500">{row.paymentTerms ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* decision §14 */}
        <section>
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Vendor decision (§14)</div>
          {decision ? (
            <div className="border border-green-200 bg-green-50/60 rounded-lg p-3 text-sm">
              <div className="font-medium text-green-800 mb-1">★ {decision.recommendedSupplier.name} (#{decision.recommendedQuote.quoteNumber})</div>
              <div className="text-gray-700 whitespace-pre-wrap">{decision.selectionReason}</div>
              {decision.supportingDocument && <div className="text-xs text-gray-500 mt-1">Document: {decision.supportingDocument}</div>}
            </div>
          ) : canManage && quotes.length > 0 ? (
            <DecisionForm rfqId={doc.id} quotes={quotes} busy={busy} setBusy={setBusy} onDone={load} />
          ) : (
            <Empty label="Record quotations first, then select a vendor" />
          )}
        </section>
      </div>
    </Modal>
  );
}

/**
 * The approved PR an RFQ was raised for. Editable while the RFQ is still open —
 * RFQs created before the link existed can be pointed at their PR here, and the
 * PO form then defaults to a vendor that quoted instead of asking again.
 */
function SourcePrEditor({
  rfqId, current, canEdit, onDone,
}: {
  rfqId: string;
  current: { requestId: string; request: { docNumber: string } } | null;
  canEdit: boolean;
  onDone: () => void;
}) {
  const [prs, setPrs] = useState<{ id: string; docNumber: string; title: string }[]>([]);
  const [picked, setPicked] = useState(current?.requestId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: { id: string; docNumber: string; title: string }[] }>('/procurement/requests?status=APPROVED&pageSize=100')
      .then((r) => setPrs(r.items))
      .catch(() => setPrs([]));
  }, []);

  useEffect(() => { setPicked(current?.requestId ?? ''); }, [current?.requestId]);

  if (!canEdit) {
    if (!current) return null;
    return (
      <div className="text-sm text-gray-600">
        Source PR: <span className="font-medium">{current.request.docNumber}</span>
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/procurement/rfqs/${rfqId}/source-pr`, {
        method: 'PATCH',
        body: { purchaseRequestId: picked },
      });
      toast(picked ? 'RFQ linked to its source PR' : 'Source PR link cleared');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg px-3 py-2">
      <div className="flex flex-col sm:flex-row sm:items-end gap-2">
        <div className="flex-1 min-w-0">
          <label htmlFor="rfq-source-pr" className="text-xs text-gray-500 block mb-1">
            Source PR — the approved request this RFQ asks vendors about
          </label>
          <Select id="rfq-source-pr" value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Not linked</option>
            {prs.map((p) => (
              <option key={p.id} value={p.id}>{p.docNumber} — {p.title}</option>
            ))}
          </Select>
        </div>
        <Button disabled={busy || picked === (current?.requestId ?? '')} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save link'}
        </Button>
      </div>
      <p className={`text-xs mt-1 ${current || picked ? 'text-gray-400' : 'text-orange-700'}`}>
        {picked !== (current?.requestId ?? '')
          ? 'Save to change the linked PR.'
          : current
            ? `Linked to ${current.request.docNumber} — the PO for it defaults to a vendor that quoted here.`
            : 'Not linked: the PO for this request cannot default its supplier or prices from a quotation.'}
      </p>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}

function VendorPicker({ rfqId, existing, onDone }: { rfqId: string; existing: string[]; onDone: () => void }) {
  const [suppliers, setSuppliers] = useState<SupplierRef[]>([]);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<SupplierRef[]>('/suppliers?all=1').then((s) => setSuppliers(s.filter((x) => x.isActive && !existing.includes(x.id)))).catch(() => setSuppliers([]));
  }, [existing.join(',')]);

  return (
    <div className="mt-2">
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Select value={picked} onChange={(e) => { setPicked(e.target.value); setError(''); }}>
            <option value="">Invite a vendor…</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </div>
        <Button
          disabled={!picked || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api(`/procurement/rfqs/${rfqId}/vendors`, { method: 'POST', body: { supplierId: picked } });
              toast('Vendor invited');
              setPicked('');
              onDone();
            } catch (e) {
              // already-invited / closed-RFQ refusals were silently swallowed
              setError(e instanceof Error ? e.message : 'Could not invite the vendor');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}

function NewQuotationForm({
  rfqId, vendors, initial, onDone, onCancel,
}: {
  rfqId: string;
  vendors: RfqVendor[];
  /** existing quotation → the same form edits it (PATCH) instead of recording a new one */
  initial?: Quotation;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [supplierId, setSupplierId] = useState(initial?.supplier.id ?? vendors[0]?.supplier.id ?? '');
  const [quoteNumber, setQuoteNumber] = useState(initial?.quoteNumber ?? '');
  const [paymentTerms, setPaymentTerms] = useState(initial?.paymentTerms ?? '');
  const [validUntil, setValidUntil] = useState(initial?.validUntil?.slice(0, 10) ?? '');
  const [quoteDate, setQuoteDate] = useState(initial?.quoteDate?.slice(0, 10) ?? '');
  const [items, setItems] = useState<DraftQuoteItem[]>(
    initial?.items.length
      ? initial.items.map((it) => ({
          description: it.description,
          quantity: String(it.quantity),
          unit: it.unit ?? '',
          unitPrice: String(it.unitPrice),
          taxPercent: it.taxPercent == null ? '' : String(Number(it.taxPercent)),
          discountPercent: it.discountPercent == null ? '' : String(Number(it.discountPercent)),
          deliveryDays: it.deliveryDays == null ? '' : String(it.deliveryDays),
          warrantyMonths: it.warrantyMonths == null ? '' : String(it.warrantyMonths),
        }))
      : [emptyQuoteItem()],
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setItem = (idx: number, patch: Partial<DraftQuoteItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const valid = supplierId && quoteNumber.trim() && items.every((it) => it.description.trim() && Number(it.quantity) >= 1 && num(it.unitPrice) > 0);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await api(initial ? `/procurement/rfqs/${rfqId}/quotations/${initial.id}` : `/procurement/rfqs/${rfqId}/quotations`, {
        method: initial ? 'PATCH' : 'POST',
        body: {
          supplierId,
          quoteNumber: quoteNumber.trim(),
          quoteDate: quoteDate || undefined,
          paymentTerms: paymentTerms.trim() || undefined,
          validUntil: validUntil || undefined,
          items: items.map((it) => ({
            description: it.description.trim(),
            quantity: Math.floor(Number(it.quantity)),
            unit: it.unit.trim() || undefined,
            unitPrice: num(it.unitPrice),
            taxPercent: it.taxPercent === '' ? undefined : num(it.taxPercent),
            discountPercent: it.discountPercent === '' ? undefined : num(it.discountPercent),
            deliveryDays: it.deliveryDays === '' ? undefined : Math.floor(num(it.deliveryDays)),
            warrantyMonths: it.warrantyMonths === '' ? undefined : Math.floor(num(it.warrantyMonths)),
          })),
        },
      });
      toast(initial ? 'Quotation updated' : 'Quotation recorded');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-2 mb-3">
      {error && <div className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label className="text-xs text-gray-500 block mb-1">Vendor (invited) *</label>
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {vendors.map((v) => (
              <option key={v.id} value={v.supplier.id}>{v.supplier.name}</option>
            ))}
          </Select>
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Vendor's quote number *</label>
          <Input placeholder="e.g. Q-2026-014" value={quoteNumber} onChange={(e) => setQuoteNumber(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Quote date</label>
          <Input type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Valid until</label>
          <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </div>
        <div className="sm:col-span-2 lg:col-span-4">
          <label className="text-xs text-gray-500 block mb-1">Payment terms</label>
          <Input placeholder="e.g. 30 Days / COD" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
        </div>
      </div>
      {items.map((it, idx) => (
        <div key={idx} className="grid grid-cols-12 gap-2 items-start">
          <div className="col-span-12 md:col-span-4">
            <Input placeholder={`Item ${idx + 1} description *`} value={it.description} onChange={(e) => setItem(idx, { description: e.target.value })} />
          </div>
          <div className="col-span-3 md:col-span-1">
            <Input type="number" min={1} placeholder="Qty" value={it.quantity} onChange={(e) => setItem(idx, { quantity: e.target.value })} />
          </div>
          <div className="col-span-3 md:col-span-2">
            <Input type="number" min={0} placeholder="Price" title="Quoted unit price" value={it.unitPrice} onChange={(e) => setItem(idx, { unitPrice: e.target.value })} />
          </div>
          <div className="col-span-3 md:col-span-1">
            <Input type="number" min={0} max={100} placeholder="Disc%" value={it.discountPercent} onChange={(e) => setItem(idx, { discountPercent: e.target.value })} />
          </div>
          <div className="col-span-3 md:col-span-1">
            <Input type="number" min={0} max={100} placeholder="Tax%" value={it.taxPercent} onChange={(e) => setItem(idx, { taxPercent: e.target.value })} />
          </div>
          <div className="col-span-3 md:col-span-1">
            <Input type="number" min={0} placeholder="Days" title="Quoted delivery days" value={it.deliveryDays} onChange={(e) => setItem(idx, { deliveryDays: e.target.value })} />
          </div>
          <div className="col-span-9 md:col-span-1">
            <Input type="number" min={0} placeholder="W(M)" title="Warranty (months)" value={it.warrantyMonths} onChange={(e) => setItem(idx, { warrantyMonths: e.target.value })} />
          </div>
          <div className="col-span-3 md:col-span-1 flex justify-end">
            <Button variant="danger" onClick={() => setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))} title={`Remove line ${idx + 1}`}>
              ×
            </Button>
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setItems((prev) => [...prev, emptyQuoteItem()])}>+ Add line</Button>
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
        <Button disabled={!valid || busy} onClick={submit}>
          {busy ? 'Saving…' : initial ? 'Save changes' : 'Save quotation'}
        </Button>
      </div>
    </div>
  );
}

function DecisionForm({
  rfqId, quotes, busy, setBusy, onDone,
}: {
  rfqId: string;
  quotes: Quotation[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: () => void;
}) {
  const [quoteId, setQuoteId] = useState(quotes[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [supportingDoc, setSupportingDoc] = useState('');
  const [error, setError] = useState('');
  const quote = quotes.find((q) => q.id === quoteId);

  const submit = async () => {
    if (!quote) return;
    setError('');
    setBusy(true);
    try {
      await api(`/procurement/rfqs/${rfqId}/decision`, {
        method: 'POST',
        body: {
          recommendedSupplierId: quote.supplier.id,
          recommendedQuoteId: quote.id,
          selectionReason: reason.trim(),
          supportingDocument: supportingDoc.trim() || undefined,
        },
      });
      toast('Vendor selected');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-2">
      {error && <div className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-500 block mb-1">Recommended quotation *</label>
          <Select value={quoteId} onChange={(e) => setQuoteId(e.target.value)}>
            {quotes.map((q) => (
              <option key={q.id} value={q.id}>{q.supplier.name} — #{q.quoteNumber}</option>
            ))}
          </Select>
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Supporting document (optional)</label>
          <Input
            placeholder="file / brief reference"
            value={supportingDoc}
            onChange={(e) => setSupportingDoc(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-gray-500 block mb-1">Selection reason (justification, §14) *</label>
        <Textarea rows={2} placeholder="Why this vendor — price, delivery, warranty, payment terms…" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="flex justify-end">
        <Button disabled={!quote || !reason.trim() || busy} onClick={submit}>
          {busy ? 'Recording…' : 'Record decision'}
        </Button>
      </div>
    </div>
  );
}
