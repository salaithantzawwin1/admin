import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Card, Empty, Input, PageHeader, Select } from '../components/ui';

// ---------------------------------------------------------------------------
// Procurement reports (R7, design §9/§33–34) — everything below is aggregated
// from real transaction rows on the backend (invoices APPROVED/POSTED, PO and
// PR statuses, monthly budgets). No denormalized totals (spec §23).
// ---------------------------------------------------------------------------

interface TileData {
  purchaseRequests: Record<string, number>;
  purchaseOrders: Record<string, number>;
  invoices: Record<string, number>;
  invoiceMatches: Record<string, number>;
}

interface VendorRow {
  supplierId: string;
  supplier: string;
  invoiceCount: number;
  subtotal: number;
}

interface AccountRow {
  accountId: string;
  accountCode: string | null;
  account: string;
  lineCount: number;
  total: number;
}

interface BudgetRow {
  accountId: string;
  account: string;
  accountCode?: string | null;
  amount: number;
  spent: number;
  remaining: number;
  usedPercent: number;
}

const fmtMoney = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'orange'> = {
  DRAFT: 'gray',
  SUBMITTED: 'yellow',
  PENDING_APPROVAL: 'yellow',
  APPROVED: 'green',
  REJECTED: 'red',
  ON_HOLD: 'orange',
  IN_PROGRESS: 'blue',
  SENT_TO_VENDOR: 'yellow',
  PARTIALLY_RECEIVED: 'orange',
  FULLY_RECEIVED: 'green',
  CLOSED: 'gray',
  CANCELLED: 'gray',
  POSTED: 'green',
  COMPLETED: 'green',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function Tile({ label, value, tone = 'gray' }: { label: string; value: number | string | undefined; tone?: 'gray' | 'green' | 'red' | 'yellow' | 'blue' | 'orange' }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200/80 shadow-card px-4 py-3">
      <div className="text-xs text-gray-400 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold ${tone === 'green' ? 'text-green-700' : tone === 'red' ? 'text-red-700' : tone === 'yellow' ? 'text-yellow-700' : tone === 'orange' ? 'text-orange-700' : tone === 'blue' ? 'text-blue-700' : 'text-gray-800'}`}>
        {value ?? '—'}
      </div>
    </div>
  );
}

export default function Reports() {
  const now = useMemo(() => new Date(), []);
  const [tiles, setTiles] = useState<TileData | null>(null);
  const [error, setError] = useState('');

  // date range for the transaction-based reports (empty = all time)
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);

  // budget month
  const [budgetYear, setBudgetYear] = useState(String(now.getUTCFullYear()));
  const [budgetMonth, setBudgetMonth] = useState(String(now.getUTCMonth() + 1));
  const [budget, setBudget] = useState<BudgetRow[]>([]);

  const rangeQs = useCallback(
    (f: string, t: string) => `?${[f && `from=${f}`, t && `to=${t}`].filter(Boolean).join('&')}`,
    [],
  );

  const load = useCallback(() => {
    api<TileData>('/reports/procurement/dashboard').then(setTiles).catch((e) => setError(e.message));
    api<VendorRow[]>(`/reports/procurement/vendors${rangeQs(from, to)}`).then(setVendors).catch(() => setVendors([]));
    api<AccountRow[]>(`/reports/procurement/accounts${rangeQs(from, to)}`).then(setAccounts).catch(() => setAccounts([]));
    api<BudgetRow[]>(`/reports/procurement/budget?year=${budgetYear}&month=${budgetMonth}`).then(setBudget).catch(() => setBudget([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeQs, from, to, budgetYear, budgetMonth]);

  useEffect(load, [load]);

  const years = Array.from({ length: 5 }, (_, i) => String(now.getUTCFullYear() - 2 + i));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Procurement Reports"
        subtitle="Real transaction data — PR/PO/invoice flow, vendor purchases, spend by account, budget vs actual (§9/§33–34)"
        actions={
          <div className="flex items-end gap-2">
            <div>
              <label htmlFor="rep-from" className="text-xs text-gray-500 block mb-1">From</label>
              <Input id="rep-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label htmlFor="rep-to" className="text-xs text-gray-500 block mb-1">To</label>
              <Input id="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        }
      />
      {error && <div className="mb-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {/* ---------- dashboard tiles (§33/§44) ---------- */}
      <section>
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Document flow — all time</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          <Tile label="PR Pending" value={tiles?.purchaseRequests.PENDING_APPROVAL ?? 0} tone="yellow" />
          <Tile label="PR Approved" value={tiles?.purchaseRequests.APPROVED ?? 0} tone="green" />
          <Tile label="PO Open" value={(tiles?.purchaseOrders.DRAFT ?? 0) + (tiles?.purchaseOrders.APPROVED ?? 0) + (tiles?.purchaseOrders.SENT_TO_VENDOR ?? 0)} tone="blue" />
          <Tile label="PO Received" value={(tiles?.purchaseOrders.PARTIALLY_RECEIVED ?? 0) + (tiles?.purchaseOrders.FULLY_RECEIVED ?? 0)} tone="green" />
          <Tile label="Invoices Awaiting" value={(tiles?.invoices.DRAFT ?? 0) + (tiles?.invoices.SUBMITTED ?? 0)} tone="yellow" />
          <Tile label="Invoices Posted" value={tiles?.invoices.POSTED ?? 0} tone="green" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-gray-500 uppercase tracking-wide">3-way match:</span>
          <Badge color="green">MATCHED {tiles?.invoiceMatches.MATCHED ?? 0}</Badge>
          <Badge color="orange">PARTIAL {tiles?.invoiceMatches.PARTIAL_MATCH ?? 0}</Badge>
          <Badge color="red">MISMATCH {tiles?.invoiceMatches.MISMATCH ?? 0}</Badge>
          <Badge color="gray">NO_MATCH {tiles?.invoiceMatches.NO_MATCH ?? 0}</Badge>
        </div>
      </section>

      {/* ---------- vendor purchase report (§34) ---------- */}
      <section>
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Vendor purchase report — invoice counts are real bills; totals include tax (APPROVED+POSTED)</div>
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wider bg-gray-50/70">
                <th className="px-4 py-3 font-semibold first:pl-5">#</th>
                <th className="px-4 py-3 font-semibold">Vendor</th>
                <th className="px-4 py-3 font-semibold">Invoices</th>
                <th className="px-4 py-3 font-semibold">Spend (Ks)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {vendors.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <Empty label={from || to ? 'No approved/posted invoices in this period' : 'No approved/posted invoices yet'} />
                  </td>
                </tr>
              )}
              {vendors.map((r, i) => (
                <tr key={r.supplierId} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 first:pl-5 text-gray-500">{i + 1}</td>
                  <td className="px-4 py-2.5 font-medium text-gray-800">{r.supplier}</td>
                  <td className="px-4 py-2.5 text-gray-500">{r.invoiceCount}</td>
                  <td className="px-4 py-2.5 font-medium">{fmtMoney(r.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      {/* ---------- purchase by account (§33/§34) ---------- */}
      <section>
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Purchase by account (same period as vendors — what the money was spent on)</div>
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wider bg-gray-50/70">
                <th className="px-4 py-3 font-semibold first:pl-5">Account</th>
                <th className="px-4 py-3 font-semibold">Code</th>
                <th className="px-4 py-3 font-semibold">Lines</th>
                <th className="px-4 py-3 font-semibold">Spend (Ks)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <Empty label="No account-attributed invoice lines in this period" />
                  </td>
                </tr>
              )}
              {accounts.map((r) => (
                <tr key={r.accountId} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 first:pl-5 font-medium text-gray-800">{r.account}</td>
                  <td className="px-4 py-2.5 text-gray-500">{r.accountCode ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500">{r.lineCount}</td>
                  <td className="px-4 py-2.5 font-medium">{fmtMoney(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      {/* ---------- budget vs actual (§9) ---------- */}
      <section>
        <div className="flex flex-wrap items-end justify-between gap-2 mb-2">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Budget vs actual (§9 — remaining is budget minus real invoice spend)</div>
          <div className="flex items-end gap-2">
            <div>
              <label htmlFor="rep-by" className="text-xs text-gray-500 block mb-1">Year</label>
              <Select id="rep-by" value={budgetYear} onChange={(e) => setBudgetYear(e.target.value)} className="!w-24">
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="rep-bm" className="text-xs text-gray-500 block mb-1">Month</label>
              <Select id="rep-bm" value={budgetMonth} onChange={(e) => setBudgetMonth(e.target.value)} className="!w-28">
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </Select>
            </div>
          </div>
        </div>
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wider bg-gray-50/70">
                <th className="px-4 py-3 font-semibold first:pl-5">Account</th>
                <th className="px-4 py-3 font-semibold">Budget</th>
                <th className="px-4 py-3 font-semibold">Spent</th>
                <th className="px-4 py-3 font-semibold">Remaining</th>
                <th className="px-4 py-3 font-semibold">Used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {budget.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <Empty label={`No budgets set for ${MONTHS[Number(budgetMonth) - 1]} ${budgetYear} — set one under /budgets (API)`} />
                  </td>
                </tr>
              )}
              {budget.map((r) => (
                <tr key={r.accountId} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 first:pl-5 font-medium text-gray-800">
                    {r.account}
                    {r.accountCode && <span className="text-xs text-gray-400 ml-2">{r.accountCode}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-gray-600">{r.amount > 0 ? fmtMoney(r.amount) : <Badge color="gray">0</Badge>}</td>
                  <td className="px-4 py-2.5">{fmtMoney(r.spent)}</td>
                  <td className={`px-4 py-2.5 font-medium ${r.remaining < 0 ? 'text-red-700' : 'text-gray-800'}`}>{fmtMoney(r.remaining)}</td>
                  <td className="px-4 py-2.5">
                    <Badge color={r.usedPercent >= 100 ? 'red' : r.usedPercent >= 80 ? 'orange' : r.usedPercent >= 50 ? 'yellow' : 'green'}>
                      {r.usedPercent}%
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  );
}
