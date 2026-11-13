import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, hasPermission } from '../api';
import { Badge, Button, Card, Empty, Input, PageHeader } from '../components/ui';
import { CarPanel } from '../components/CarPanel';
import { MeetingRoomPanel } from '../components/MeetingRoomPanel';
import { PurchaseRequestPanel } from '../components/PurchaseRequestPanel';
import { BudgetBlockedModal, budgetBlockFrom, type BudgetBlock } from '../components/BudgetBlockedModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { fmtDateTime } from '../util/yangonTime';
import { useLiveReload } from '../hooks/useLiveReload';

const STATUS_COLORS: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'teal'> = {
  DRAFT: 'gray',
  SUBMITTED: 'yellow',
  PENDING_APPROVAL: 'yellow',
  APPROVED: 'green',
  REJECTED: 'red',
  CANCELLED: 'gray',
  ON_HOLD: 'yellow',
  IN_PROGRESS: 'blue',
  COMPLETED: 'teal', // distinct from APPROVED green
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
  // §9 budget block — friendly explain modal instead of a raw 409 message
  const [budgetBlock, setBudgetBlock] = useState<BudgetBlock | null>(null);
  // ⌛ past-window guard: approving a car request whose trip window already ended
  // gets an explicit warning first (allowed, but must be deliberate)
  const [confirmPastApprove, setConfirmPastApprove] = useState<{ start: string; end: string } | null>(null);

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

  // live push: an approve / reject / return / shift done in ANOTHER tab repaints
  // this header now instead of waiting for the next poll (poll stays as fallback)
  useLiveReload(['request.updated'], (e) => {
    if (!e.requestId || e.requestId === id) load();
  });

  const act = async (action: 'submit' | 'approve' | 'reject' | 'return', force = false) => {
    setError('');
    // a comment is mandatory when rejecting — surface it without a server round-trip
    if (action === 'reject' && !comment.trim()) {
      setError('A comment is required to reject — please type a comment first.');
      return;
    }
    // ⌛ car requests: warn before approving a window that already ended (warn, not block)
    if (action === 'approve' && !force && detail?.docType === 'CAR_REQUEST') {
      try {
        const car = await api<{ startDate?: string; endDate?: string } | null>(`/cars/requests/${id}`);
        if (car?.endDate && new Date(car.endDate).getTime() < Date.now()) {
          setConfirmPastApprove({ start: car.startDate ?? car.endDate, end: car.endDate });
          return;
        }
      } catch {
        // no car row / no access — fall through and approve exactly as before
      }
    }
    try {
      await api(`/requests/${id}/${action}`, { method: 'POST', body: { comment: comment || undefined } });
      setComment('');
      load();
    } catch (e) {
      const block = budgetBlockFrom(e);
      if (block) setBudgetBlock(block);
      else setError(e instanceof Error ? e.message : 'Failed');
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

  // Only a document that is actually waiting on someone gets the Actions card —
  // an approved/in-progress request used to show an empty card and a comment box
  // nobody could submit.
  const canApprove = detail.status === 'PENDING_APPROVAL' && hasPermission('approvals.act');
  const canActOnDraft = detail.isOwner && detail.status === 'DRAFT';
  // Withdrawing is ownership, not approval: an owner who also holds approvals.act
  // still needs Cancel Request beside the approve buttons (the server refuses to
  // let anyone approve their own request, so that neighbour is the only way out).
  const canWithdraw = detail.isOwner && detail.status === 'PENDING_APPROVAL';
  const hasActions = canApprove || canActOnDraft || canWithdraw;

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={detail.docNumber}
        subtitle={detail.title}
      />
      {budgetBlock && <BudgetBlockedModal block={budgetBlock} onClose={() => setBudgetBlock(null)} />}
      {confirmPastApprove && (
        <ConfirmDialog
          title="Trip window already ended"
          description={
            <>
              The trip window <b>{fmtDateTime(new Date(confirmPastApprove.start))} → {fmtDateTime(new Date(confirmPastApprove.end))}</b>{' '}
              has already passed. Approve anyway only if the ride really happened — otherwise reject it; stale
              requests are auto-expired 2 hours after the window ends anyway.
            </>
          }
          confirmLabel="Approve anyway"
          onConfirm={async () => {
            setConfirmPastApprove(null);
            await act('approve', true);
          }}
          onClose={() => setConfirmPastApprove(null)}
        />
      )}

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {/* Two columns once there is room: what you DO with this request (its car,
          its trip, its history) on the left, the facts and the buttons that move
          it on a sticky rail. Stacked, the summary and an often-empty Actions card
          pushed the actual assignment a full screen down. On phones the rail comes
          first so the status and the approval buttons stay above the fold. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6 lg:items-start">
        <aside className="order-1 lg:order-2 lg:sticky lg:top-6 space-y-5 mb-5">
          {hasActions && (
            <Card className="p-4">
              <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Actions</h2>
              <div className="flex flex-wrap gap-2 items-center">
                {canActOnDraft && (
                  <>
                    <Button onClick={() => act('submit')}>Submit for Approval</Button>
                    <Button variant="danger" onClick={cancel}>Delete Draft</Button>
                  </>
                )}
                {canApprove && (
                  <>
                    <Button onClick={() => act('approve')}>Approve</Button>
                    <Button variant="ghost" onClick={() => act('return')}>Return</Button>
                    <Button variant="danger" onClick={() => act('reject')}>Reject</Button>
                  </>
                )}
                {canWithdraw && <Button variant="danger" onClick={cancel}>Cancel Request</Button>}
              </div>
              {canApprove && (
                <Input
                  className="mt-3"
                  placeholder="Comment (optional for approve/return, required for reject)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              )}
            </Card>
          )}

          <Card className="p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">Summary</h2>
              <Badge color={STATUS_COLORS[detail.status] ?? 'gray'}>{detail.status}</Badge>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
              <div>
                <dt className="text-gray-400 text-xs uppercase">Requester</dt>
                <dd className="mt-0.5 font-medium break-words">{detail.requester?.fullName ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs uppercase">Department</dt>
                <dd className="mt-0.5 font-medium break-words">{detail.department?.name ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs uppercase">Level</dt>
                <dd className="mt-0.5 font-medium">{detail.totalLevels ? `${detail.currentLevel}/${detail.totalLevels}` : '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs uppercase">Raised</dt>
                <dd className="mt-0.5 font-medium">{fmtDateTime(detail.createdAt)}</dd>
              </div>
            </dl>
            {detail.escalated && <div className="mt-3 text-xs text-orange-600">⚠ This request has been escalated.</div>}
            {detail.description && (
              <p className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-700 whitespace-pre-wrap break-words">
                {detail.description}
              </p>
            )}
          </Card>
        </aside>

        <div className="order-2 lg:order-1 min-w-0">
          {detail.docType === 'CAR_REQUEST' && (
            <CarPanel requestId={detail.id} status={detail.status} isOwner={detail.isOwner} canView={detail.canViewCar} />
          )}

          {detail.docType === 'MEETING_ROOM_REQUEST' && (
            <MeetingRoomPanel requestId={detail.id} status={detail.status} />
          )}

          {detail.docType === 'PURCHASE_REQUEST' && <PurchaseRequestPanel requestId={detail.id} />}

      <Card className="p-5 mb-5">
        <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Approval History</h2>
        {detail.actions.length === 0 ? (
          <p className="text-sm text-gray-400">No actions yet.</p>
        ) : (
          <ol className="space-y-3">
            {/* phones: level + action share a line, the comment and date go
                underneath — three fixed columns squeezed a comment to 3 words */}
            {detail.actions.map((a) => (
              <li key={a.id} className="flex flex-col sm:flex-row gap-1 sm:gap-3 text-sm">
                <div className="flex items-center gap-2 sm:contents">
                  <span className="sm:w-10 text-gray-400">L{a.level}</span>
                  <span className="font-medium sm:w-28">{a.action}</span>
                </div>
                <span className="text-gray-600 flex-1 min-w-0 break-words">
                  {a.approver?.fullName ?? '—'}
                  {a.comment && <span className="text-gray-400"> — “{a.comment}”</span>}
                </span>
                <span className="text-gray-400 whitespace-nowrap">{fmtDateTime(a.createdAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">Attachments</h2>
        {detail.attachments.length === 0 && <p className="text-sm text-gray-400 mb-3">No attachments yet.</p>}
        <ul className="space-y-2 mb-4">
          {detail.attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between text-sm">
              <a href={`/api/attachments/${a.id}/download`} className="text-blue-600 hover:underline truncate min-w-0 mr-2">{a.filename}</a>
              <span className="text-gray-400 shrink-0 whitespace-nowrap">{(a.size / 1024).toFixed(1)} KB</span>
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
      </div>
    </div>
  );
}
