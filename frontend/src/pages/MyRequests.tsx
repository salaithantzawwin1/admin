import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader, Select } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface RequestRow {
  id: string;
  docNumber: string;
  docType: string;
  title: string;
  status: string;
  currentLevel: number;
  totalLevels: number;
  createdAt: string;
  requester: { fullName: string };
  department?: { name: string } | null;
  _count?: { attachments: number };
}

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = {
  DRAFT: 'gray',
  PENDING_APPROVAL: 'yellow',
  APPROVED: 'green',
  REJECTED: 'red',
  CANCELLED: 'gray',
  COMPLETED: 'green',
  CLOSED: 'gray',
};

export default function MyRequests() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', description: '', docType: 'GENERIC_REQUEST' });
  const navigate = useNavigate();
  // in-app confirm dialog state (replaces window.confirm)
  const [confirming, setConfirming] = useState<{ kind: 'recall' | 'cancelApproved'; id: string } | null>(null);

  const load = useCallback(() => {
    api<{ items: RequestRow[] }>('/requests?scope=mine&pageSize=100')
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  // auto-refresh: status changes appear without manual reload
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const create = async () => {
    setError('');
    try {
      const created = await api<{ id: string }>('/requests', { method: 'POST', body: form });
      setShowForm(false);
      setForm({ title: '', description: '', docType: 'GENERIC_REQUEST' });
      navigate(`/requests/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const submit = async (id: string) => {
    setError('');
    try {
      await api(`/requests/${id}/submit`, { method: 'POST' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const cancel = async (id: string) => {
    setError('');
    try {
      await api(`/requests/${id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  /** Withdraw a request that is still waiting for approval. */
  const recall = async (id: string) => {
    setError('');
    try {
      await api(`/requests/${id}`, { method: 'DELETE' });
      setConfirming(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      throw e; // ConfirmDialog keeps itself open and shows the error inside
    }
  };

  /** Cancel an APPROVED request — Administration frees the room/vehicle/stock afterwards. */
  const cancelApproved = async (id: string) => {
    setError('');
    try {
      await api(`/requests/${id}/cancel-approved`, { method: 'POST' });
      setConfirming(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      throw e; // ConfirmDialog keeps itself open and shows the error inside
    }
  };

  return (
    <div>
      <PageHeader
        title="My Requests"
        subtitle="Requests you have created"
        actions={<Button onClick={() => setShowForm(!showForm)}>{showForm ? 'Close' : '+ New Request'}</Button>}
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {showForm && (
        <Card className="mb-5 p-5 space-y-3">
          <Input placeholder="Request title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <textarea
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={3}
            placeholder="Description / details"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          {/* CAR_REQUEST is created from the Car Requests page (needs car details) */}
          <Select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })}>
            <option value="GENERIC_REQUEST">General Request</option>
            <option value="MEETING_ROOM_REQUEST">Meeting Room Request</option>
            <option value="OFFICE_SUPPLY_REQUEST">Office Supply Request</option>
            <option value="TRAVEL_REQUEST">Travel Request</option>
            <option value="MAINTENANCE_REQUEST">Maintenance Request</option>
          </Select>
          <Button onClick={create} disabled={!form.title}>Create Draft</Button>
        </Card>
      )}

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Doc No.</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Level</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && <tr><td colSpan={7}><Empty /></td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">
                  <Link to={`/requests/${r.id}`} className="text-blue-600 hover:underline">{r.docNumber}</Link>
                </td>
                <td className="px-4 py-3">{r.title}</td>
                <td className="px-4 py-3 text-gray-500">{r.docType.replace(/_REQUEST|_/, ' ')}</td>
                <td className="px-4 py-3"><Badge color={STATUS_COLORS[r.status] ?? 'gray'}>{r.status}</Badge></td>
                <td className="px-4 py-3 text-gray-500">{r.totalLevels ? `${r.currentLevel}/${r.totalLevels}` : '—'}</td>
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(r.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right space-x-2">
                  {r.status === 'DRAFT' && (
                    <>
                      <Button variant="ghost" onClick={() => submit(r.id)}>Submit</Button>
                      <Button variant="danger" onClick={() => cancel(r.id)}>Delete</Button>
                    </>
                  )}
                  {(r.status === 'PENDING_APPROVAL' || r.status === 'SUBMITTED') && (
                    <Button variant="ghost" onClick={() => setConfirming({ kind: 'recall', id: r.id })}>↩ Recall</Button>
                  )}
                  {r.status === 'APPROVED' && (r.docType === 'CAR_REQUEST' || r.docType === 'MEETING_ROOM_REQUEST' || r.docType === 'OFFICE_SUPPLY_REQUEST') && (
                    <Button variant="ghost" onClick={() => setConfirming({ kind: 'cancelApproved', id: r.id })}>✕ Cancel</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {confirming?.kind === 'recall' && (
        <ConfirmDialog
          title="Recall this request?"
          description="It will be cancelled and removed from the approver inbox."
          confirmLabel="Recall"
          variant="danger"
          onConfirm={async () => { await recall(confirming.id); }}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming?.kind === 'cancelApproved' && (
        <ConfirmDialog
          title="Cancel this approved request?"
          description="Administration will be notified to release the room/vehicle/items."
          confirmLabel="Cancel request"
          variant="danger"
          onConfirm={async () => { await cancelApproved(confirming.id); }}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
