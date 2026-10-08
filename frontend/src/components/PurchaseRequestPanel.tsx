import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Empty } from './ui';

// Purchase Request detail (procurement §5): required date, priority, budget
// code + line items with optional Account/Asset references. Mirrors
// MeetingRoomPanel — fetched per docType from /procurement/requests/:id.

interface PrItem {
  id: string;
  description: string;
  quantity: number;
  unit?: string | null;
  estimatedUnitPrice?: string | null;
  account?: { name: string; code?: string | null } | null;
  asset?: { assetCode: string; name: string } | null;
}

interface PrDetail {
  priority: string;
  requiredDate?: string | null;
  justification?: string | null;
  budgetCode?: string | null;
  items: PrItem[];
}

const fmtMoney = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function PurchaseRequestPanel({ requestId }: { requestId: string }) {
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ purchaseRequest: PrDetail | null }>(`/procurement/requests/${requestId}`)
      .then((r) => setPr(r.purchaseRequest))
      .catch((e) => setError(e.message));
  }, [requestId]);

  if (error) return null; // the page-level error area already reports read failures

  const items = pr?.items ?? [];
  const total = items.reduce((sum, it) => sum + (Number(it.estimatedUnitPrice) || 0) * (Number(it.quantity) || 0), 0);

  return (
    <Card className="p-5 mb-5">
      <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Purchase Request</h2>

      {!pr ? (
        <Empty label="Loading…" />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mb-4">
            <div>
              <div className="text-gray-400 text-xs uppercase">Priority</div>
              <div className="mt-1 font-medium">{pr.priority === 'URGENT' ? '🔴 Urgent' : 'Normal'}</div>
            </div>
            <div>
              <div className="text-gray-400 text-xs uppercase">Required date</div>
              <div className="mt-1 font-medium">{pr.requiredDate ? new Date(pr.requiredDate).toLocaleDateString() : '—'}</div>
            </div>
            <div>
              <div className="text-gray-400 text-xs uppercase">Budget code</div>
              <div className="mt-1 font-medium">{pr.budgetCode ?? '—'}</div>
            </div>
            <div>
              <div className="text-gray-400 text-xs uppercase">Estimated total</div>
              <div className="mt-1 font-medium">{items.length ? fmtMoney(total) : '—'}</div>
            </div>
          </div>

          {pr.justification && <p className="text-sm text-gray-700 whitespace-pre-wrap mb-4">{pr.justification}</p>}

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="py-2 font-medium">Item</th>
                <th className="py-2 font-medium text-right">Qty</th>
                <th className="py-2 font-medium text-right">Unit price</th>
                <th className="py-2 font-medium text-right">Amount</th>
                <th className="py-2 font-medium">Account</th>
                <th className="py-2 font-medium">Asset</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((it) => {
                const price = Number(it.estimatedUnitPrice) || 0;
                return (
                  <tr key={it.id}>
                    <td className="py-2">
                      {it.description}
                      {it.unit && <span className="text-gray-400"> · {it.unit}</span>}
                    </td>
                    <td className="py-2 text-right">{it.quantity}</td>
                    <td className="py-2 text-right">{it.estimatedUnitPrice != null ? fmtMoney(price) : '—'}</td>
                    <td className="py-2 text-right font-medium">{price ? fmtMoney(price * it.quantity) : '—'}</td>
                    <td className="py-2 text-gray-500">
                      {it.account ? (it.account.code ? `${it.account.code} — ${it.account.name}` : it.account.name) : '—'}
                    </td>
                    <td className="py-2 text-gray-500">{it.asset ? `${it.asset.assetCode} · ${it.asset.name}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
