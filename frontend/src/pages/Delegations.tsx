import { useCallback, useEffect, useState } from 'react';
import { api, getUser } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader } from '../components/ui';

interface Delegation {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  reason?: string;
  toUser?: { username: string; fullName: string };
  fromUser?: { username: string; fullName: string };
}

interface UserRow {
  id: string;
  username: string;
  fullName: string;
}

export default function Delegations() {
  const [given, setGiven] = useState<Delegation[]>([]);
  const [received, setReceived] = useState<Delegation[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState({ toUserId: '', startAt: '', endAt: '', reason: '' });
  const [error, setError] = useState('');
  const me = getUser();

  const load = useCallback(() => {
    api<{ given: Delegation[]; received: Delegation[] }>('/delegations')
      .then((r) => {
        setGiven(r.given);
        setReceived(r.received);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    api<{ items: UserRow[] }>('/users?pageSize=100')
      .then((r) => setUsers(r.items))
      .catch(() => {});
  }, [load]);

  const create = async () => {
    setError('');
    try {
      await api('/delegations', { method: 'POST', body: form });
      setForm({ toUserId: '', startAt: '', endAt: '', reason: '' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const end = async (id: string) => {
    try {
      await api(`/delegations/${id}/end`, { method: 'PATCH' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const fmt = (s: string) => new Date(s).toLocaleString();
  const activeBadge = (d: Delegation) => {
    const now = new Date();
    const isActive = d.status === 'ACTIVE' && new Date(d.startAt) <= now && new Date(d.endAt) >= now;
    const isFuture = d.status === 'ACTIVE' && new Date(d.startAt) > now;
    return <Badge color={isActive ? 'green' : isFuture ? 'blue' : 'gray'}>{isActive ? 'ACTIVE NOW' : isFuture ? 'SCHEDULED' : d.status}</Badge>;
  };

  return (
    <div className="max-w-4xl">
      <PageHeader title="Approval Delegations" subtitle="Delegate your approvals when on leave" />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <Card className="p-5 mb-5 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Delegate to</label>
            <select
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
              value={form.toUserId}
              onChange={(e) => setForm({ ...form, toUserId: e.target.value })}
            >
              <option value="">— Select user —</option>
              {users.filter((u) => u.username !== me?.username).map((u) => (
                <option key={u.id} value={u.id}>{u.fullName} ({u.username})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Reason</label>
            <Input placeholder="e.g. Annual leave" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">From</label>
            <Input type="datetime-local" value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>
            <Input type="datetime-local" value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })} />
          </div>
        </div>
        <Button onClick={create} disabled={!form.toUserId || !form.startAt || !form.endAt}>Create Delegation</Button>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Card className="p-5">
          <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase">Given by me</h2>
          {given.length === 0 && <Empty label="None" />}
          <ul className="space-y-3">
            {given.map((d) => (
              <li key={d.id} className="text-sm border-b border-gray-100 pb-3 last:border-0">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-medium">→ {d.toUser?.fullName}</div>
                    <div className="text-xs text-gray-500">{fmt(d.startAt)} → {fmt(d.endAt)}</div>
                    {d.reason && <div className="text-xs text-gray-400 mt-0.5">{d.reason}</div>}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {activeBadge(d)}
                    {d.status === 'ACTIVE' && (
                      <button className="text-xs text-red-600 hover:underline" onClick={() => end(d.id)}>End</button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase">Received by me</h2>
          {received.length === 0 && <Empty label="None" />}
          <ul className="space-y-3">
            {received.map((d) => (
              <li key={d.id} className="text-sm border-b border-gray-100 pb-3 last:border-0">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-medium">← {d.fromUser?.fullName}</div>
                    <div className="text-xs text-gray-500">{fmt(d.startAt)} → {fmt(d.endAt)}</div>
                    {d.reason && <div className="text-xs text-gray-400 mt-0.5">{d.reason}</div>}
                  </div>
                  {activeBadge(d)}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
