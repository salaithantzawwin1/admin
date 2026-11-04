import { useCallback, useEffect, useState } from 'react';
import { api, getToken } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select } from '../components/ui';
import { fmtDateTime } from '../util/yangonTime';

interface AuditRow {
  id: string;
  username?: string | null;
  action: string;
  module: string;
  recordId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  severity: string;
  platform: string;
  createdAt: string;
}

interface AuditDetail extends AuditRow {
  oldValue?: unknown;
  newValue?: unknown;
}

interface FilterOptions {
  users: string[];
  actions: string[];
  modules: string[];
  severities: string[];
}

interface Filters {
  from: string;
  to: string;
  user: string;
  action: string;
  severity: string;
  ip: string;
  q: string;
}

const EMPTY: Filters = { from: '', to: '', user: '', action: '', severity: '', ip: '', q: '' };
const PAGE_SIZES = [25, 50, 100];

const platformColor = (p: string): 'blue' | 'green' | 'teal' | 'gray' =>
  p === 'Desktop' ? 'blue' : p === 'Mobile' ? 'green' : p === 'Tablet' ? 'teal' : 'gray';

const severityColor = (s: string): 'red' | 'yellow' | 'gray' =>
  s === 'CRITICAL' ? 'red' : s === 'WARNING' ? 'yellow' : 'gray';

function queryString(f: Filters, page: number, pageSize: number) {
  const p = new URLSearchParams();
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.user) p.set('username', f.user);
  if (f.action) p.set('action', f.action);
  if (f.severity) p.set('severity', f.severity);
  if (f.ip.trim()) p.set('ip', f.ip.trim());
  if (f.q.trim()) p.set('q', f.q.trim());
  p.set('page', String(page));
  p.set('pageSize', String(pageSize));
  return p.toString();
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return <span className="text-xs text-gray-400">{label}: —</span>;
  return (
    <div>
      <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</div>
      <pre className="max-h-48 overflow-auto rounded-md bg-gray-50 border border-gray-200 p-2 text-[11px] leading-relaxed text-gray-700">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function AuditLogs() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [options, setOptions] = useState<FilterOptions>({ users: [], actions: [], modules: [], severities: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api<{ items: AuditRow[]; total: number }>(`/audit-logs?${queryString(applied, page, pageSize)}`)
      .then((r) => {
        setRows(r.items);
        setTotal(r.total);
        setError('');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load audit logs'))
      .finally(() => setLoading(false));
  }, [applied, page, pageSize]);

  useEffect(load, [load]);

  useEffect(() => {
    api<FilterOptions>('/audit-logs/filters').then(setOptions).catch(() => {});
  }, []);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  // a filter change can shorten the result set under the current page
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);

  const apply = (next: Filters) => {
    setDraft(next);
    setApplied(next);
    setPage(1);
    setExpanded(null);
    setDetail(null);
  };

  const applySelect = (patch: Partial<Filters>) => apply({ ...applied, ...patch });

  const toggleDetail = async (row: AuditRow) => {
    if (expanded === row.id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(row.id);
    setDetail(null);
    setDetailError('');
    try {
      setDetail(await api<AuditDetail>(`/audit-logs/${row.id}`));
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : 'Failed to load the entry');
    }
  };

  const exportCsv = async () => {
    try {
      const res = await fetch(`/api/audit-logs/export.csv?${queryString(applied, 1, pageSize)}`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const activeFilters = Object.values(applied).filter(Boolean).length;
  const colCount = 8;

  return (
    <div>
      <PageHeader
        title="Audit Logs"
        subtitle={`Append-only activity trail · ${total.toLocaleString()} record${total === 1 ? '' : 's'}${activeFilters ? ' matching the filters' : ''}`}
        actions={<Button variant="ghost" onClick={() => void exportCsv()}>⬇ Export CSV</Button>}
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {/* ---------- filters ---------- */}
      <Card className="sticky top-[57px] z-20 mb-4 p-4 bg-white/95 backdrop-blur-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label htmlFor="audit-from" className="block text-xs text-gray-500 mb-1">From date</label>
            <Input id="audit-from" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </div>
          <div>
            <label htmlFor="audit-to" className="block text-xs text-gray-500 mb-1">To date</label>
            <Input id="audit-to" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </div>
          <div>
            <label htmlFor="audit-user" className="block text-xs text-gray-500 mb-1">User</label>
            <Select id="audit-user" value={draft.user} onChange={(e) => applySelect({ user: e.target.value })}>
              <option value="">All users</option>
              {options.users.map((u) => <option key={u} value={u}>{u}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="audit-action" className="block text-xs text-gray-500 mb-1">Action</label>
            <Select id="audit-action" value={draft.action} onChange={(e) => applySelect({ action: e.target.value })}>
              <option value="">All actions</option>
              {options.actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="audit-ip" className="block text-xs text-gray-500 mb-1">IP address</label>
            <Input
              id="audit-ip"
              placeholder="e.g. 192.168.100.50"
              value={draft.ip}
              onChange={(e) => setDraft({ ...draft, ip: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') apply(draft); }}
            />
          </div>
          <div>
            <label htmlFor="audit-severity" className="block text-xs text-gray-500 mb-1">Severity</label>
            <Select id="audit-severity" value={draft.severity} onChange={(e) => applySelect({ severity: e.target.value })}>
              <option value="">All severities</option>
              {options.severities.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="audit-q" className="block text-xs text-gray-500 mb-1">Search (action, user, module, record, IP, device)</label>
            <Input
              id="audit-q"
              placeholder="Type and press Enter"
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') apply(draft); }}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-gray-500">
            Dates are read as Yangon days. {activeFilters > 0 && <span className="text-yellow-800">{activeFilters} filter(s) active</span>}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => apply(EMPTY)} disabled={activeFilters === 0 && !draft.q && !draft.ip && !draft.from && !draft.to}>
              Reset
            </Button>
            <Button onClick={() => apply(draft)} disabled={loading}>{loading ? 'Searching…' : 'Search'}</Button>
          </div>
        </div>
      </Card>

      <Card>
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">User</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Module</th>
              <th className="px-4 py-3 font-medium">IP</th>
              <th className="px-4 py-3 font-medium">Platform</th>
              <th className="px-4 py-3 font-medium">Severity</th>
              <th className="px-4 py-3 font-medium text-center">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && !loading && (
              <tr><td colSpan={colCount}><Empty label={activeFilters ? 'No audit entries match these filters' : 'No activity recorded yet'} /></td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={`hover:bg-gray-50 ${expanded === r.id ? 'bg-yellow-50/40' : ''}`}>
                <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                <td className="px-4 py-2.5">{r.username ?? '—'}</td>
                <td className="px-4 py-2.5 font-medium text-gray-800">
                  {r.action}
                  {r.recordId && <div className="text-[10px] font-normal font-mono text-gray-400 truncate max-w-[180px]">{r.recordId}</div>}
                </td>
                <td className="px-4 py-2.5"><Badge>{r.module}</Badge></td>
                <td className="px-4 py-2.5 text-gray-500 font-mono text-xs">{r.ipAddress ?? '—'}</td>
                <td className="px-4 py-2.5"><Badge color={platformColor(r.platform)} title={r.userAgent ?? ''}>{r.platform}</Badge></td>
                <td className="px-4 py-2.5"><Badge color={severityColor(r.severity)}>{r.severity}</Badge></td>
                <td className="px-4 py-2.5 text-center">
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:underline"
                    aria-expanded={expanded === r.id}
                    onClick={() => void toggleDetail(r)}
                  >
                    {expanded === r.id ? 'Hide' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
            {expanded && (
              <tr className="bg-gray-50/70">
                <td colSpan={colCount} className="px-4 py-3">
                  {detailError && <div className="text-sm text-red-600">{detailError}</div>}
                  {!detail && !detailError && <div className="text-xs text-gray-400">Loading entry…</div>}
                  {detail && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-gray-600">
                        <div><span className="text-gray-400">Record:</span> <span className="font-mono">{detail.recordId ?? '—'}</span></div>
                        <div><span className="text-gray-400">IP:</span> <span className="font-mono">{detail.ipAddress ?? '—'}</span></div>
                        <div><span className="text-gray-400">Platform:</span> {detail.platform}</div>
                        <div className="sm:col-span-3 truncate"><span className="text-gray-400">User agent:</span> {detail.userAgent ?? '—'}</div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <JsonBlock label="Before" value={detail.oldValue} />
                        <JsonBlock label="After" value={detail.newValue} />
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 mt-4 text-sm text-gray-500">
        <div className="flex items-center gap-2">
          <span>Page {page} / {pages} · {total.toLocaleString()} record{total === 1 ? '' : 's'}</span>
          <Select
            aria-label="Rows per page"
            className="!w-auto"
            value={String(pageSize)}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
          </Select>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(1)}>
            ⇤ First
          </button>
          <button className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← Prev
          </button>
          <button className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next →
          </button>
          <button className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(pages)}>
            Last ⇥
          </button>
        </div>
      </div>
    </div>
  );
}
