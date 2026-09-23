import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Card, Empty, PageHeader } from '../components/ui';

interface AuditRow {
  id: string;
  username?: string;
  action: string;
  module: string;
  recordId?: string;
  ipAddress?: string;
  severity: string;
  createdAt: string;
}

export default function AuditLogs() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const load = useCallback(() => {
    api<{ items: AuditRow[]; total: number }>(`/audit-logs?page=${page}&pageSize=${pageSize}`)
      .then((r) => {
        setRows(r.items);
        setTotal(r.total);
      })
      .catch(() => {});
  }, [page]);

  useEffect(load, [load]);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <PageHeader title="Audit Logs" subtitle={`Append-only activity trail · ${total} records`} />

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">User</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Module</th>
              <th className="px-4 py-3 font-medium">IP</th>
              <th className="px-4 py-3 font-medium">Severity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && <tr><td colSpan={6}><Empty /></td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="px-4 py-2.5">{r.username ?? '—'}</td>
                <td className="px-4 py-2.5 font-medium text-gray-800">{r.action}</td>
                <td className="px-4 py-2.5"><Badge>{r.module}</Badge></td>
                <td className="px-4 py-2.5 text-gray-500">{r.ipAddress ?? '—'}</td>
                <td className="px-4 py-2.5">
                  <Badge color={r.severity === 'CRITICAL' ? 'red' : r.severity === 'WARNING' ? 'yellow' : 'gray'}>
                    {r.severity}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
        <span>Page {page} / {pages}</span>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← Prev
          </button>
          <button className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
