import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Badge, Button, Card, Empty, PageHeader } from '../components/ui';

interface RequestRow {
  id: string;
  docNumber: string;
  docType?: string;
  title: string;
  status: string;
  currentLevel: number;
  submittedAt?: string;
  requester: { fullName: string };
  department?: { name: string } | null;
}

export default function Approvals() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [error, setError] = useState('');
  const [comment, setComment] = useState<{ id: string; value: string }>({ id: '', value: '' });
  const navigate = useNavigate();

  const load = useCallback(() => {
    api<{ items: RequestRow[] }>('/requests/inbox?pageSize=100')
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  // auto-refresh: new submissions appear without manual reload
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (id: string, action: 'approve' | 'reject' | 'return') => {
    setError('');
    // a comment is mandatory when rejecting — reveal the field instead of a server 400
    if (action === 'reject' && (comment.id !== id || !comment.value.trim())) {
      setComment({ id, value: comment.id === id ? comment.value : '' });
      setError('A comment is required to reject — please type a comment first.');
      return;
    }
    try {
      await api(`/requests/${id}/${action}`, { method: 'POST', body: { comment: comment.id === id ? comment.value : undefined } });
      setComment({ id: '', value: '' });
      // car + meeting-room requests go straight to the detail page so the approver
      // lands on the assign panel (vehicle/driver or room) without searching again
      if (action === 'approve') {
        const row = rows.find((r) => r.id === id);
        if (row?.docType === 'CAR_REQUEST' || row?.docType === 'MEETING_ROOM_REQUEST') {
          navigate(`/requests/${id}`);
          return;
        }
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div>
      <PageHeader title="Pending Approvals" subtitle="Requests waiting for your action" />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <div className="space-y-3">
        {rows.length === 0 && <Empty label="No pending approvals 🎉" />}
        {rows.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2">
                  <Link to={`/requests/${r.id}`} className="font-semibold text-blue-600 hover:underline">{r.docNumber}</Link>
                  <Badge color="yellow">L{r.currentLevel}</Badge>
                </div>
                <div className="text-sm text-gray-800 mt-1">{r.title}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {r.requester?.fullName ?? '—'} · {r.department?.name ?? '—'} · submitted {r.submittedAt ? new Date(r.submittedAt).toLocaleString() : '—'}
                </div>
              </div>
              <div className="flex gap-2 items-start">
                <Button onClick={() => act(r.id, 'approve')}>Approve</Button>
                <Button variant="ghost" onClick={() => act(r.id, 'return')}>Return</Button>
                <Button variant="danger" onClick={() => act(r.id, 'reject')}>Reject</Button>
              </div>
            </div>
            {comment.id === r.id ? (
              <input
                className="mt-3 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                placeholder="Comment (required for reject)"
                value={comment.value}
                onChange={(e) => setComment({ id: r.id, value: e.target.value })}
              />
            ) : (
              <button className="mt-3 text-xs text-gray-400 hover:text-gray-600" onClick={() => setComment({ id: r.id, value: '' })}>
                + add comment
              </button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
