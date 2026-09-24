import { useCallback, useEffect, useState } from 'react';
import { api, getUser } from '../api';
import { Badge, Button, Empty, Input, PageHeader, Table, statusColor } from '../components/ui';
import { Modal } from '../components/Modal';
import { PasswordStrength } from '../components/PasswordStrength';
import { toast } from '../components/Toast';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface UserRow {
  id: string;
  username: string;
  fullName: string;
  email?: string;
  status: string;
  lastLoginAt?: string;
  roles: string[];
  telegram?: { linked: boolean; username: string | null };
}

const ALL_ROLES = [
  'SYSTEM_ADMIN', 'ADMINISTRATION', 'DEPARTMENT_HEAD', 'PURCHASING',
  'FINANCE', 'MANAGEMENT', 'MAINTENANCE_COORDINATOR', 'EMPLOYEE',
];

export default function Users() {
  const me = getUser();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [modalError, setModalError] = useState(''); // submit errors show inside the dialog, not on the page
  const [form, setForm] = useState({ username: '', fullName: '', password: '', roles: ['EMPLOYEE'] as string[] });
  const [unbindFor, setUnbindFor] = useState<UserRow | null>(null); // in-app confirm (replaces window.confirm)

  // edit state
  const [edit, setEdit] = useState<UserRow | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const load = useCallback(() => {
    api<{ items: UserRow[] }>('/users?pageSize=100')
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const createUser = async () => {
    setError('');
    try {
      await api('/users', { method: 'POST', body: form });
      setShowForm(false);
      setForm({ username: '', fullName: '', password: '', roles: ['EMPLOYEE'] });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const openEdit = (u: UserRow) => {
    setEdit(u);
    setEditRoles(u.roles);
    setError('');
  };

  const saveEdit = async () => {
    if (!edit) return;
    setModalError('');
    try {
      await api(`/users/${edit.id}`, {
        method: 'PATCH',
        body: { fullName: edit.fullName, email: edit.email || undefined, roles: editRoles },
      });
      setEdit(null);
      toast('User updated');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const toggleStatus = async (u: UserRow) => {
    const status = u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    setError('');
    try {
      await api(`/users/${u.id}/status`, { method: 'PATCH', body: { status } });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doReset = async () => {
    if (!resetFor) return;
    setModalError('');
    try {
      await api(`/users/${resetFor.id}/password`, { method: 'PATCH', body: { newPassword } });
      setResetFor(null);
      setNewPassword('');
      toast('Password reset');
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setModalError('');
    try {
      await api(`/users/${confirmDelete.id}`, { method: 'DELETE' });
      setConfirmDelete(null);
      setConfirmText('');
      toast('User deleted');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed to delete — the account likely has history; use Disable instead.');
    }
  };

  const roleToggled = (r: string) =>
    setEditRoles((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="User accounts and role assignment"
        actions={<Button onClick={() => setShowForm(!showForm)}>{showForm ? 'Close' : '+ New User'}</Button>}
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {showForm && (
        <div className="mb-5 bg-white border border-gray-200 rounded-xl p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            <Input placeholder="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            <Input placeholder="Password (min 8)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_ROLES.map((r) => (
              <label key={r} className="inline-flex items-center gap-1.5 text-xs border rounded-full px-3 py-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.roles.includes(r)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      roles: e.target.checked ? [...form.roles, r] : form.roles.filter((x) => x !== r),
                    })
                  }
                />
                {r}
              </label>
            ))}
          </div>
          <Button onClick={createUser} disabled={!form.username || !form.fullName || form.password.length < 8}>
            Create User
          </Button>
        </div>
      )}

      <Table head={['Username', 'Full Name', 'Roles', 'Status', 'Telegram', 'Last Login', 'Actions']}>
        {rows.length === 0 && (
          <tr><td colSpan={7}><Empty /></td></tr>
        )}
        {rows.map((u) => (
          <tr key={u.id} className="hover:bg-gray-50">
            <td className="px-4 py-3 font-medium text-gray-800">
              {u.username}
              {u.username === me?.username && <span className="ml-1 text-xs text-gray-400">(you)</span>}
            </td>
            <td className="px-4 py-3">{u.fullName}</td>
            <td className="px-4 py-3">
              <div className="flex flex-wrap gap-1">
                {u.roles.map((r) => (
                  <Badge key={r} color="blue">{r}</Badge>
                ))}
              </div>
            </td>
            <td className="px-4 py-3"><Badge color={statusColor(u.status)}>{u.status}</Badge></td>
            <td className="px-4 py-3 whitespace-nowrap">
              {u.telegram?.linked ? (
                <span className="text-green-700" title="User receives AMS notifications in Telegram">✓ {u.telegram.username ? `@${u.telegram.username}` : 'Linked'}</span>
              ) : (
                <span className="text-gray-400">—</span>
              )}
            </td>
            <td className="px-4 py-3 text-gray-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
            <td className="px-4 py-3">
              <div className="flex flex-wrap justify-end gap-1.5">
                <button className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50" onClick={() => openEdit(u)}>Edit</button>
                <button className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50" onClick={() => { setResetFor(u); setNewPassword(''); }}>Password</button>
                <button
                  className={`text-xs px-2 py-1 rounded border ${u.status === 'ACTIVE' ? 'border-yellow-300 text-yellow-700 hover:bg-yellow-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}
                  disabled={u.username === me?.username}
                  onClick={() => toggleStatus(u)}
                >
                  {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                </button>
                {u.telegram?.linked && (
                  <button
                    className="text-xs px-2 py-1 rounded border border-orange-300 text-orange-700 hover:bg-orange-50"
                    title="Remove the user's Telegram link — they stop receiving notifications in Telegram"
                    onClick={() => setUnbindFor(u)}
                  >
                    Unbind TG
                  </button>
                )}
                <button
                  className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40"
                  disabled={u.username === me?.username}
                  onClick={() => { setConfirmDelete(u); setConfirmText(''); }}
                >
                  Delete
                </button>
              </div>
            </td>
          </tr>
        ))}
      </Table>

      {/* Edit modal */}
      {edit && (
        <Modal title={`Edit user — ${edit.username}`} error={modalError} onClose={() => { setEdit(null); setModalError(''); }}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Username <span className="text-gray-400">(login ID — cannot be changed)</span>
              </label>
              <Input value={edit.username} disabled title="Username is the login identity (links AD/LDAP, audit trail and sessions) — it cannot be renamed" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Full name</label>
              <Input value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Email</label>
              <Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Roles</label>
              <div className="flex flex-wrap gap-2">
                {ALL_ROLES.map((r) => (
                  <label key={r} className="inline-flex items-center gap-1.5 text-xs border rounded-full px-3 py-1.5 cursor-pointer">
                    <input type="checkbox" checked={editRoles.includes(r)} onChange={() => roleToggled(r)} />
                    {r}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
              <Button onClick={saveEdit} disabled={!edit.fullName}>Save Changes</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Reset password modal */}
      {resetFor && (
        <Modal title={`Reset password — ${resetFor.username}`} error={modalError} onClose={() => { setResetFor(null); setModalError(''); }}>
          <div className="space-y-3">
            <div>
              <Input type="password" placeholder="New password (min 8)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              <PasswordStrength value={newPassword} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setResetFor(null)}>Cancel</Button>
              <Button onClick={doReset} disabled={newPassword.length < 8}>Reset Password</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirm modal */}
      {confirmDelete && (
        <Modal title={`Delete user — ${confirmDelete.username}`} error={modalError} onClose={() => { setConfirmDelete(null); setModalError(''); }}>
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">
              This permanently removes the account. Users with request/approval history cannot be deleted —
              use <strong>Disable</strong> instead to preserve the audit trail.
            </p>
            <Input placeholder={`Type username "${confirmDelete.username}" to confirm`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="danger" disabled={confirmText !== confirmDelete.username} onClick={doDelete}>
                Delete Permanently
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {unbindFor && (
        <ConfirmDialog
          title={`Unbind Telegram for ${unbindFor.username}?`}
          description="They will stop receiving notifications in Telegram (in-app notifications continue). They can re-link later from Profile."
          confirmLabel="Unbind"
          variant="danger"
          onConfirm={async () => {
            await api(`/users/${unbindFor.id}/telegram`, { method: 'DELETE' });
            setUnbindFor(null);
            toast('Telegram unlinked');
            load();
          }}
          onClose={() => setUnbindFor(null)}
        />
      )}
    </div>
  );
}
