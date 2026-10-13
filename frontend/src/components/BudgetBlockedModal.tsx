import { ApiError } from '../api';
import { Modal } from './Modal';
import { Button } from './ui';

// ---------------------------------------------------------------------------
// R7 §9 — structured payload the backend returns (HTTP 409, code
// BUDGET_EXCEEDED) when a PURCHASE_REQUEST submit would exceed a per-account
// monthly budget. This modal explains the block in plain language: which
// account, estimated vs remaining, and how to resolve it.
// ---------------------------------------------------------------------------

export interface BudgetBlockedLine {
  account: string;
  estimated: number;
  budget: number;
  alreadySpent: number;
  remaining: number;
}

export interface BudgetBlock {
  year: number;
  month: number;
  blocked: BudgetBlockedLine[];
}

/** Extract the §9 budget-block payload from an API error (null when other error). */
export function budgetBlockFrom(e: unknown): BudgetBlock | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.details as { code?: string; blocked?: BudgetBlockedLine[]; year?: number; month?: number } | undefined;
  if (!d || d.code !== 'BUDGET_EXCEEDED' || !Array.isArray(d.blocked) || d.blocked.length === 0) return null;
  if (typeof d.year !== 'number' || typeof d.month !== 'number') return null;
  return { year: d.year, month: d.month, blocked: d.blocked };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const fmt = (n: number) => n.toLocaleString();

export function BudgetBlockedModal({ block, onClose }: { block: BudgetBlock; onClose: () => void }) {
  return (
    <Modal title="Budget limit reached" wide onClose={onClose}>
      <div className="space-y-4 text-sm text-gray-700">
        <p>
          This purchase request can’t be submitted for approval yet — the estimated total for
          the account(s) below exceeds the remaining budget for{' '}
          <b>{MONTHS[block.month - 1] ?? block.month} {block.year}</b>.
        </p>

        <div className="border border-gray-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-2 font-semibold">Account</th>
                <th className="px-3 py-2 font-semibold text-right">Estimated</th>
                <th className="px-3 py-2 font-semibold text-right">Budget</th>
                <th className="px-3 py-2 font-semibold text-right">Already spent</th>
                <th className="px-3 py-2 font-semibold text-right">Remaining</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {block.blocked.map((b) => (
                <tr key={b.account}>
                  <td className="px-3 py-2 font-medium text-gray-800">{b.account}</td>
                  <td className="px-3 py-2 text-right">{fmt(b.estimated)}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{fmt(b.budget)}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{fmt(b.alreadySpent)}</td>
                  <td className="px-3 py-2 text-right font-semibold text-red-700">{fmt(b.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 text-xs leading-relaxed">
          <b>How to resolve:</b> ask Finance to raise this account’s budget
          (Settings → Budgets), lower the estimated prices on the request lines,
          or resubmit once next month’s budget is available. Only accounts with a
          budget set are blocked — unbudgeted accounts pass through.
        </div>

        <div className="flex justify-end">
          <Button onClick={onClose}>Got it</Button>
        </div>
      </div>
    </Modal>
  );
}
