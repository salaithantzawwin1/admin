import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Textarea } from '../components/ui';

interface Supplier {
  id: string;
  name: string;
  phone?: string | null;
  address?: string | null;
  note?: string | null;
  isActive: boolean;
  createdAt: string;
}

interface HistoryData {
  supplier: { id: string; name: string };
  totalCost: number;
  items: { name: string; unit: string; qty: number; cost: number }[];
  recent: { id: string; quantity: number; unitPrice?: string | null; reference?: string | null; createdAt: string; item: { name: string }; recordedBy?: string }[];
}

interface ContactLog {
  id: string;
  contactedAt: string;
  person: string | null;
  channel: string;
  summary: string;
  followUpAt: string | null;
  createdBy: { fullName: string };
}

interface PoDraftLine { id?: string; itemId: string; quantity: number; unitPrice?: number | null; item?: { code: string; name: string; unit: string } }
interface PoDraft {
  id: string;
  status: string;
  note: string | null;
  createdAt: string;
  createdBy: { fullName: string };
  request?: { id: string; docNumber: string; status: string } | null;
  lines: PoDraftLine[];
}

const CHANNELS = ['CALL', 'EMAIL', 'VISIT', 'TELEGRAM', 'OTHER'] as const;

const fmtMoney = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState<Partial<Supplier> | null>(null);
  const [deleting, setDeleting] = useState<Supplier | null>(null);
  const [historyFor, setHistoryFor] = useState<Supplier | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [modalError, setModalError] = useState('');
  const [error, setError] = useState('');
  // history date range filter
  const [histFrom, setHistFrom] = useState('');
  const [histTo, setHistTo] = useState('');
  // vendor management — per-supplier detail modal with tabs
  const [vendorFor, setVendorFor] = useState<Supplier | null>(null);
  const [vendorTab, setVendorTab] = useState<'contacts' | 'pos'>('contacts');
  const [contacts, setContacts] = useState<ContactLog[] | null>(null);
  const [contactForm, setContactForm] = useState({ person: '', channel: 'CALL', summary: '', followUpAt: '' });
  const [drafts, setDrafts] = useState<PoDraft[] | null>(null);
  const [draftForm, setDraftForm] = useState<{ note: string; lines: { itemId: string; quantity: number; unitPrice: string }[] } | null>(null);
  // item picker for PO draft lines (catalog read is allowed for suppliers viewers)
  const [itemsCache, setItemsCache] = useState<{ id: string; code: string; name: string }[] | null>(null);
  const canManage = hasPermission('inventory.manage') || hasPermission('suppliers.manage');

  const load = useCallback(() => {
    api<Supplier[]>(`/suppliers${showInactive ? '?all=1' : ''}`).then(setSuppliers).catch(() => setSuppliers([]));
  }, [showInactive]);
  useEffect(load, [load]);

  const save = async () => {
    if (!form?.name?.trim()) return;
    setModalError('');
    try {
      const body = { name: form.name, phone: form.phone || undefined, address: form.address || undefined, note: form.note || undefined };
      if (form.id) {
        await api(`/suppliers/${form.id}`, { method: 'PATCH', body: { ...body, isActive: form.isActive } });
        toast('Supplier updated');
      } else {
        await api('/suppliers', { method: 'POST', body });
        toast('Supplier created');
      }
      setForm(null);
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doDelete = async (s: Supplier) => {
    setError('');
    try {
      await api(`/suppliers/${s.id}`, { method: 'DELETE' });
      toast('Supplier deleted');
      setDeleting(null);
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Delete failed');
      setDeleting(null);
    }
  };

  const openHistory = async (s: Supplier, from = histFrom, to = histTo) => {
    setHistoryFor(s);
    setHistory(null);
    try {
      const qs = from || to ? `?${from ? `start=${from}T00:00:00.000Z&` : ''}${to ? `end=${to}T23:59:59.999Z` : ''}` : '';
      setHistory(await api<HistoryData>(`/suppliers/${s.id}/history${qs}`));
    } catch {
      setHistoryFor(null);
    }
  };

  /** Open the vendor-management modal (contacts + PO drafts). */
  const openVendor = (s: Supplier) => {
    setVendorFor(s);
    setVendorTab('contacts');
    setContacts(null);
    setDrafts(null);
    setContactForm({ person: '', channel: 'CALL', summary: '', followUpAt: '' });
    setDraftForm(null);
    api<ContactLog[]>(`/suppliers/${s.id}/contact-logs`).then(setContacts).catch(() => setContacts([]));
    api<PoDraft[]>(`/suppliers/${s.id}/po-drafts`).then(setDrafts).catch(() => setDrafts([]));
    if (itemsCache === null) {
      api<{ id: string; code: string; name: string }[]>('/inventory/items').then(setItemsCache).catch(() => setItemsCache([]));
    }
  };

  const addContact = async () => {
    if (!vendorFor || !contactForm.summary.trim()) return;
    setModalError('');
    try {
      await api(`/suppliers/${vendorFor.id}/contact-logs`, {
        method: 'POST',
        body: {
          person: contactForm.person.trim() || undefined,
          channel: contactForm.channel,
          summary: contactForm.summary.trim(),
          followUpAt: contactForm.followUpAt || undefined,
        },
      });
      setContactForm({ person: '', channel: 'CALL', summary: '', followUpAt: '' });
      setContacts(await api<ContactLog[]>(`/suppliers/${vendorFor.id}/contact-logs`));
      toast('Contact logged');
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const removeContact = async (logId: string) => {
    if (!vendorFor) return;
    try {
      await api(`/suppliers/${vendorFor.id}/contact-logs/${logId}`, { method: 'DELETE' });
      setContacts(await api<ContactLog[]>(`/suppliers/${vendorFor.id}/contact-logs`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const saveDraft = async () => {
    if (!vendorFor || !draftForm) return;
    setModalError('');
    try {
      await api(`/suppliers/${vendorFor.id}/po-drafts`, {
        method: 'POST',
        body: {
          note: draftForm.note.trim() || undefined,
          lines: draftForm.lines.map((l) => ({
            itemId: l.itemId,
            quantity: Number(l.quantity),
            unitPrice: l.unitPrice !== '' ? Number(l.unitPrice) : undefined,
          })),
        },
      });
      setDraftForm(null);
      setDrafts(await api<PoDraft[]>(`/suppliers/${vendorFor.id}/po-drafts`));
      toast('PO draft saved');
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const submitDraft = async (d: PoDraft) => {
    if (!vendorFor) return;
    setError('');
    try {
      const r = await api<{ docNumber: string }>(`/suppliers/${vendorFor.id}/po-drafts/${d.id}/submit`, { method: 'POST' });
      setDrafts(await api<PoDraft[]>(`/suppliers/${vendorFor.id}/po-drafts`));
      toast(`Submitted as ${r.docNumber} — pending approval`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const deleteDraft = async (d: PoDraft) => {
    if (!vendorFor) return;
    try {
      await api(`/suppliers/${vendorFor.id}/po-drafts/${d.id}`, { method: 'DELETE' });
      setDrafts(await api<PoDraft[]>(`/suppliers/${vendorFor.id}/po-drafts`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div>
      <PageHeader
        title="Suppliers"
        subtitle="Vendor master data — shared by Inventory purchases today and by future Purchasing / Fleet maintenance modules"
        actions={
          canManage ? (
            <Button onClick={() => { setForm({ name: '', phone: '', address: '', note: '', isActive: true }); setModalError(''); }}>+ Supplier</Button>
          ) : undefined
        }
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <Card className="mb-5 p-5">
        <div className="flex items-center justify-between mb-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show deactivated
          </label>
          <span className="text-xs text-gray-400">{suppliers?.filter((s) => s.isActive).length ?? 0} active supplier(s)</span>
        </div>

        {suppliers === null ? (
          <div className="text-sm text-gray-400 py-4">Loading…</div>
        ) : suppliers.length === 0 ? (
          <Empty label="No suppliers yet — add one to attach purchases to a source" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Address</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {suppliers.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{s.name}{!s.isActive && ' (inactive)'}</td>
                  <td className="px-4 py-3 text-gray-500">{s.phone || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 truncate max-w-xs">{s.address || '—'}</td>
                  <td className="px-4 py-3">
                    <Badge color={s.isActive ? 'green' : 'gray'}>{s.isActive ? 'ACTIVE' : 'INACTIVE'}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button className="text-blue-600 hover:underline mr-3" onClick={() => openHistory(s)}>History</button>
                    {canManage && (
                      <>
                        <button className="text-blue-600 hover:underline mr-3" title="Contacts + PO drafts" onClick={() => openVendor(s)}>Manage</button>
                        <button className="text-blue-600 hover:underline mr-3" onClick={() => { setForm({ ...s }); setModalError(''); }}>Edit</button>
                        <button className="text-red-600 hover:underline" onClick={() => setDeleting(s)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {form && (
        <Modal title={form.id ? `Edit supplier — ${form.name}` : 'New supplier'} error={modalError} onClose={() => { setForm(null); setModalError(''); }}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Supplier name *</label>
              <Input placeholder="e.g. Shwe Yangon Trading" value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Phone</label>
              <Input placeholder="09-xxx" value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Address</label>
              <Input placeholder="Address" value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Note</label>
              <Textarea rows={2} placeholder="Note (optional)" value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            {form.id && (
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={form.isActive ?? true} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                Active (shows in the restock dropdown)
              </label>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
              <Button onClick={save} disabled={!form.name?.trim()}>{form.id ? 'Save' : 'Create'}</Button>
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete supplier ${deleting.name}?`}
          description="Suppliers with purchase history cannot be deleted (deactivate instead). This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => { await doDelete(deleting); }}
          onClose={() => { setDeleting(null); setModalError(''); }}
        />
      )}

      {historyFor && (
        <Modal title={`Purchase history — ${historyFor.name}`} onClose={() => setHistoryFor(null)}>
          {!history ? (
            <div className="text-sm text-gray-400 py-4">Loading…</div>
          ) : (
            <div className="space-y-4">
              {/* date range filter */}
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-gray-500">From</label>
                <input
                  type="date"
                  className="text-xs border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
                  value={histFrom}
                  onChange={(e) => { setHistFrom(e.target.value); openHistory(historyFor, e.target.value, histTo); }}
                />
                <label className="text-xs text-gray-500">To</label>
                <input
                  type="date"
                  className="text-xs border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
                  value={histTo}
                  onChange={(e) => { setHistTo(e.target.value); openHistory(historyFor, histFrom, e.target.value); }}
                />
                {(histFrom || histTo) && (
                  <button className="text-xs text-gray-400 hover:text-gray-600 underline" onClick={() => { setHistFrom(''); setHistTo(''); openHistory(historyFor, '', ''); }}>
                    Clear
                  </button>
                )}
              </div>
              <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 text-sm">
                {histFrom || histTo ? 'Purchases in range' : 'Lifetime purchases'}: <span className="font-semibold">{fmtMoney(history.totalCost)}</span> across {history.items.length} item(s)
              </div>
              {history.items.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                      <th className="px-2 py-2 font-medium">Item</th>
                      <th className="px-2 py-2 font-medium">Qty</th>
                      <th className="px-2 py-2 font-medium text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {history.items.map((i) => (
                      <tr key={i.name}>
                        <td className="px-2 py-2 font-medium">{i.name}</td>
                        <td className="px-2 py-2 text-gray-500">{i.qty} {i.unit}</td>
                        <td className="px-2 py-2 text-right">{fmtMoney(i.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {history.recent.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Purchases (newest first)</h3>
                  <div className="space-y-1 max-h-64 overflow-auto">
                    {history.recent.map((t) => (
                      <div key={t.id} className="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1.5 flex justify-between gap-2">
                        <span>
                          {t.item.name} · {t.quantity}{t.unitPrice ? ` @ ${fmtMoney(Number(t.unitPrice))}` : ''}
                          {t.reference ? ` · ${t.reference}` : ''}
                          {t.recordedBy && <span className="text-gray-400"> — recorded by {t.recordedBy}</span>}
                        </span>
                        <span className="text-gray-400 whitespace-nowrap">{new Date(t.createdAt).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {/* vendor management — contacts + PO drafts */}
      {vendorFor && (
        <Modal
          title={`Manage vendor — ${vendorFor.name}`}
          error={modalError}
          onClose={() => { setVendorFor(null); setModalError(''); }}
        >
          <div className="flex gap-1.5 mb-4">
            {([
              ['contacts', `📞 Contacts${contacts ? ` (${contacts.length})` : ''}`],
              ['pos', `📄 PO drafts${drafts ? ` (${drafts.filter((d) => d.status === 'DRAFT').length})` : ''}`],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${vendorTab === k ? 'bg-yellow-600 border-yellow-600 text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-yellow-400'}`}
                onClick={() => setVendorTab(k)}
              >
                {label}
              </button>
            ))}
          </div>

          {vendorTab === 'contacts' && (
            <div className="space-y-3">
              {contacts === null ? (
                <p className="text-sm text-gray-400">Loading…</p>
              ) : contacts.length === 0 ? (
                <p className="text-sm text-gray-400">No contact history yet — log the first call/visit below.</p>
              ) : (
                <ul className="space-y-2 max-h-64 overflow-auto">
                  {contacts.map((c) => (
                    <li key={c.id} className="border border-gray-100 rounded-lg px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <Badge color="blue">{c.channel}</Badge>
                          {c.person && <span className="font-medium text-gray-700">{c.person}</span>}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-gray-400 whitespace-nowrap">
                          {new Date(c.contactedAt).toLocaleDateString()} · {c.createdBy.fullName}
                          {canManage && (
                            <button className="text-red-500 hover:underline" title="Delete entry" onClick={() => removeContact(c.id)}>✕</button>
                          )}
                        </span>
                      </div>
                      <p className="text-gray-600 mt-1">{c.summary}</p>
                      {c.followUpAt && <p className="text-xs text-orange-600 mt-1">↻ Follow up: {new Date(c.followUpAt).toLocaleDateString()}</p>}
                    </li>
                  ))}
                </ul>
              )}
              {/* log new contact */}
              <div className="border-t border-gray-100 pt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Input placeholder="Person (who you spoke to)" value={contactForm.person} onChange={(e) => setContactForm({ ...contactForm, person: e.target.value })} />
                  <Select value={contactForm.channel} onChange={(e) => setContactForm({ ...contactForm, channel: e.target.value })}>
                    {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </div>
                <Input placeholder="Summary — what was discussed *" value={contactForm.summary} onChange={(e) => setContactForm({ ...contactForm, summary: e.target.value })} />
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500">Follow up</label>
                  <input
                    type="date"
                    className="text-xs border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-yellow-500/40"
                    value={contactForm.followUpAt}
                    onChange={(e) => setContactForm({ ...contactForm, followUpAt: e.target.value })}
                  />
                  <span className="ml-auto"><Button onClick={addContact} disabled={!contactForm.summary.trim()}>+ Log contact</Button></span>
                </div>
              </div>
            </div>
          )}

          {vendorTab === 'pos' && (
            <div className="space-y-3">
              {drafts === null ? (
                <p className="text-sm text-gray-400">Loading…</p>
              ) : drafts.length === 0 && !draftForm ? (
                <p className="text-sm text-gray-400">No PO drafts yet — create one (or fill from an Inventory reorder suggestion).</p>
              ) : (
                <ul className="space-y-2 max-h-64 overflow-auto">
                  {drafts.map((d) => (
                    <li key={d.id} className="border border-gray-100 rounded-lg px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <Badge color={d.status === 'DRAFT' ? 'yellow' : 'green'}>{d.status}</Badge>
                          {d.request && <span className="font-mono text-xs text-gray-500">{d.request.docNumber}</span>}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-gray-400">
                          {new Date(d.createdAt).toLocaleDateString()} · {d.createdBy.fullName}
                          {d.status === 'DRAFT' && canManage && (
                            <>
                              <button className="text-blue-600 hover:underline" onClick={() => submitDraft(d)}>Submit → approval</button>
                              <button className="text-red-500 hover:underline" onClick={() => deleteDraft(d)}>✕</button>
                            </>
                          )}
                        </span>
                      </div>
                      <ul className="text-xs text-gray-600 mt-1 space-y-0.5">
                        {d.lines.map((l) => (
                          <li key={l.id ?? `${l.itemId}-${l.quantity}`}>
                            {l.item?.code} {l.item?.name} ×{l.quantity} {l.item?.unit}{l.unitPrice != null ? ` @ ${fmtMoney(Number(l.unitPrice))}` : ''}
                          </li>
                        ))}
                      </ul>
                      {d.note && <p className="text-xs text-gray-400 mt-1">{d.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
              {!draftForm ? (
                <Button variant="ghost" onClick={() => setDraftForm({ note: '', lines: [{ itemId: '', quantity: 1, unitPrice: '' }] })}>+ New PO draft</Button>
              ) : (
                <div className="border-t border-gray-100 pt-3 space-y-2">
                  {draftForm.lines.map((l, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_80px_100px_32px] gap-2 items-center">
                      <Select
                        value={l.itemId}
                        onChange={(e) => setDraftForm({ ...draftForm, lines: draftForm.lines.map((x, i) => (i === idx ? { ...x, itemId: e.target.value } : x)) })}
                      >
                        <option value="">— Item —</option>
                        {(itemsCache ?? []).map((it) => <option key={it.id} value={it.id}>{it.code} — {it.name}</option>)}
                      </Select>
                      <Input
                        type="number" min={1} placeholder="Qty" value={l.quantity}
                        onChange={(e) => setDraftForm({ ...draftForm, lines: draftForm.lines.map((x, i) => (i === idx ? { ...x, quantity: Number(e.target.value) } : x)) })}
                      />
                      <Input
                        type="number" min={0} step="0.01" placeholder="Price" value={l.unitPrice}
                        onChange={(e) => setDraftForm({ ...draftForm, lines: draftForm.lines.map((x, i) => (i === idx ? { ...x, unitPrice: e.target.value } : x)) })}
                      />
                      <button
                        className="text-gray-300 hover:text-red-500"
                        title="Remove line"
                        onClick={() => setDraftForm({ ...draftForm, lines: draftForm.lines.filter((_, i) => i !== idx) })}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    className="text-xs text-blue-600 hover:underline"
                    onClick={() => setDraftForm({ ...draftForm, lines: [...draftForm.lines, { itemId: '', quantity: 1, unitPrice: '' }] })}
                  >
                    + another line
                  </button>
                  <Input placeholder="Note (optional)" value={draftForm.note} onChange={(e) => setDraftForm({ ...draftForm, note: e.target.value })} />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setDraftForm(null)}>Cancel</Button>
                    <Button onClick={saveDraft} disabled={draftForm.lines.some((l) => !l.itemId || l.quantity <= 0)}>Save draft</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
