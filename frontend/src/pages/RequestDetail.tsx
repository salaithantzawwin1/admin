import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { Badge, Button, Card, Empty, PageHeader } from '../components/ui';
import { CarPanel } from '../components/CarPanel';
import { MeetingRoomPanel } from '../components/MeetingRoomPanel';

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = {
  DRAFT: 'gray',
  SUBMITTED: 'yellow',
  PENDING_APPROVAL: 'yellow',
  APPROVED: 'green',
  REJECTED: 'red',
  CANCELLED: 'gray',
  ON_HOLD: 'yellow',
  IN_PROGRESS: 'blue',
  COMPLETED: 'green',
  CLOSED: 'gray',
};

interface Detail {
  id: string;
  docNumber: string;
  docType: string;
  title: string;
  description?: string;
  status: string;
  currentLevel: number;
  totalLevels: number;
  escalated: boolean;
  createdAt: string;
  requester: { username: string; fullName: string };
  department?: { name: string } | null;
  isOwner: boolean;
  canViewCar?: boolean;
  currentStep?: { roleName: string } | null;
  actions: {
    id: string; level: number; action: string; comment?: string;
    previousStatus: string; newStatus: string; createdAt: string;
    approver: { username: string; fullName: string };
  }[];
  attachments: { id: string; filename: string; size: number; createdAt: string }[];
}

export default function RequestDetail() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api<Detail>(`/requests/${id}`)
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  // auto-refresh: status/assignment changes appear without manual reload
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (action: 'submit' | 'approve' | 'reject' | 'return') => {
    setError('');
    // a comment is mandatory when rejecting — surface it without a server round-trip
    if (action === 'reject' && !comment.trim()) {
      setError('A comment is required to reject — please type a comment first.');
      return;
    }
    try {
      await api(`/requests/${id}/${action}`, { method: 'POST', body: { comment: comment || undefined } });
      setComment('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const cancel = async () => {
    setError('');
    try {
      await api(`/requests/${id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const upload = async () => {
    if (!file) return;
    setError('');
    const fd = new FormData();
    fd.append('file', file);
    const token = localStorage.getItem('ams_token');
    try {
      const res = await fetch(`/api/attachments/upload?requestId=${id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) throw new Error('Upload failed');
      setFile(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    }
  };

  if (error && !detail) return <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>;
  if (!detail) return <Empty label="Loading…" />;

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={detail.docNumber}
        subtitle={detail.title}
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      <Card className="p-5 mb-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-gray-400 text-xs uppercase">Status</div>
            <div className="mt-1"><Badge color={STATUS_COLORS[detail.status] ?? 'gray'}>{detail.status}</Badge></div>
          </div>
          <div>
            <div className="text-gray-400 text-xs uppercase">Level</div>
            <div className="mt-1 font-medium">{detail.totalLevels ? `${detail.currentLevel}/${detail.totalLevels}` : '—'}</div>
          </div>
          <div>
            <div className="text-gray-400 text-xs uppercase">Requester</div>
            <div className="mt-1 font-medium">{detail.requester?.fullName ?? '—'}</div>
          </div>
          <div>
            <div className="text-gray-400 text-xs uppercase">Department</div>
            <div className="mt-1 font-medium">{detail.department?.name ?? '—'}</div>
          </div>
        </div>
        {detail.description && <p className="mt-4 text-sm text-gray-700 whitespace-pre-wrap border-t border-gray-100 pt-4">{detail.description}</p>}
        {detail.escalated && <div className="mt-3 text-xs text-orange-600">⚠ This request has been escalated.</div>}
      </Card>

      {detail.docType === 'CAR_REQUEST' && (
        <CarPanel requestId={detail.id} status={detail.status} isOwner={detail.isOwner} canView={detail.canViewCar} />
      )}

      {detail.docType === 'MEETING_ROOM_REQUEST' && (
        <MeetingRoomPanel requestId={detail.id} status={detail.status} />
      )}

      <Card className="p-5 mb-5">
        <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Actions</h2>
        <div className="flex flex-wrap gap-2 items-center">
          {detail.isOwner && detail.status === 'DRAFT' && (
            <>
              <Button onClick={() => act('submit')}>Submit for Approval</Button>
              <Button variant="danger" onClick={cancel}>Delete Draft</Button>
            </>
          )}
          {detail.status === 'PENDING_APPROVAL' && hasPermission('approvals.act') && (
            <>
              <Button onClick={() => act('approve')}>Approve</Button>
              <Button variant="ghost" onClick={() => act('return')}>Return</Button>
              <Button variant="danger" onClick={() => act('reject')}>Reject</Button>
            </>
          )}
          {detail.isOwner && detail.status === 'PENDING_APPROVAL' && (
            <Button variant="danger" onClick={cancel}>Cancel Request</Button>
          )}
        </div>
        <input
          className="mt-3 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          placeholder="Comment (optional for approve/return, required for reject)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </Card>

      <Card className="p-5 mb-5">
        <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Approval History</h2>
        {detail.actions.length === 0 ? (
          <Empty label="No actions yet" />
        ) : (
          <ol className="space-y-3">
            {detail.actions.map((a) => (
              <li key={a.id} className="flex gap-3 text-sm">
                <span className="w-10 text-gray-400">L{a.level}</span>
                <span className="font-medium w-28">{a.action}</span>
                <span className="text-gray-600 flex-1">
                  {a.approver?.fullName ?? '—'}
                  {a.comment && <span className="text-gray-400"> — “{a.comment}”</span>}
                </span>
                <span className="text-gray-400 whitespace-nowrap">{new Date(a.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Attachments</h2>
        {detail.attachments.length === 0 && <Empty label="No attachments" />}
        <ul className="space-y-2 mb-4">
          {detail.attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between text-sm">
              <a href={`/api/attachments/${a.id}/download`} className="text-blue-600 hover:underline">{a.filename}</a>
              <span className="text-gray-400">{(a.size / 1024).toFixed(1)} KB</span>
            </li>
          ))}
        </ul>
        {detail.isOwner && (
          <div className="flex gap-2 items-center">
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            <Button variant="ghost" onClick={upload} disabled={!file}>Upload</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
