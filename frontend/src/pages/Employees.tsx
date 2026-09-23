import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Button, Empty, Input, PageHeader, Table, statusColor } from '../components/ui';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';

interface DepartmentLite {
  id: string;
  name: string;
  isActive: boolean;
}

interface EmployeeRow {
  id: string;
  employeeNo: string;
  fullName: string;
  email?: string;
  phone?: string;
  position?: string;
  status: string;
  hiredAt?: string;
  department?: DepartmentLite | null;
  branch?: { id: string; name: string } | null;
  user?: { username: string; roles?: string[] } | null;
  roles?: string[];
}

interface BranchLite {
  id: string;
  name: string;
  isActive: boolean;
}

const ROLES = ['SYSTEM_ADMIN', 'ADMINISTRATION', 'DEPARTMENT_HEAD', 'PURCHASING', 'FINANCE', 'MANAGEMENT', 'MAINTENANCE_COORDINATOR', 'EMPLOYEE'];

const EMPTY: {
  employeeNo: string; fullName: string; position: string; phone: string;
  email: string; hiredAt: string; departmentId: string; branchId: string;
  createLogin: boolean; username: string; password: string; roles: string[]; authSource: 'LOCAL' | 'AD';
} = {
  employeeNo: '', fullName: '', position: '', phone: '', email: '', hiredAt: '', departmentId: '', branchId: '',
  createLogin: false, username: '', password: '', roles: ['EMPLOYEE'], authSource: 'LOCAL',
};

export default function Employees() {
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [depts, setDepts] = useState<DepartmentLite[]>([]);
  const [branches, setBranches] = useState<BranchLite[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [edit, setEdit] = useState<EmployeeRow | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [newLogin, setNewLogin] = useState({ username: '', password: '', roles: ['EMPLOYEE'] as string[], authSource: 'LOCAL' as 'LOCAL' | 'AD' });
  const [confirmDelete, setConfirmDelete] = useState<EmployeeRow | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState('');
  const [modalError, setModalError] = useState(''); // submit errors show inside the dialog, not on the page

  const load = useCallback(() => {
    api<{ items: EmployeeRow[] }>('/org/employees?pageSize=100')
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message));
    api<DepartmentLite[]>('/org/departments')
      .then((r) => setDepts(r.filter((d) => d.isActive)))
      .catch(() => undefined);
    api<BranchLite[]>('/org/branches')
      .then((r) => setBranches(r.filter((b) => b.isActive)))
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  const create = async () => {
    setModalError('');
    try {
      await api('/org/employees', {
        method: 'POST',
        body: {
          employeeNo: form.employeeNo,
          fullName: form.fullName,
          position: form.position || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          departmentId: form.departmentId || undefined,
          branchId: form.branchId || undefined,
          ...(form.createLogin ? { username: form.username, password: form.password || undefined, roles: form.roles, authSource: form.authSource } : {}),
        },
      });
      setShowForm(false);
      setForm({ ...EMPTY });
      toast('Employee created');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    setModalError('');
    try {
      await api(`/org/employees/${edit.id}`, {
        method: 'PATCH',
        body: {
          fullName: edit.fullName,
          position: edit.position || undefined,
          phone: edit.phone || undefined,
          email: edit.email || undefined,
          departmentId: edit.department?.id,
        },
      });
      if (edit.user) {
        await api(`/org/employees/${edit.id}/roles`, { method: 'PATCH', body: { roles: editRoles } });
      } else if (newLogin.username && (newLogin.password || newLogin.authSource === 'AD')) {
        await api(`/org/employees/${edit.id}/login`, {
          method: 'POST',
          body: { username: newLogin.username, password: newLogin.password || undefined, roles: newLogin.roles, authSource: newLogin.authSource },
        });
      }
      setEdit(null);
      setNewLogin({ username: '', password: '', roles: ['EMPLOYEE'], authSource: 'LOCAL' });
      toast('Employee updated');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const toggle = async (e0: EmployeeRow) => {
    const next = e0.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    setError('');
    try {
      await api(`/org/employees/${e0.id}`, { method: 'PATCH', body: { status: next } });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setModalError('');
    try {
      await api(`/org/employees/${confirmDelete.id}`, { method: 'DELETE' });
      setConfirmDelete(null);
      setConfirmText('');
      toast('Employee deleted');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Delete failed — the employee likely has history in the system.');
    }
  };

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle="Employee master data — departments route requests to the right approvers"
        actions={<Button onClick={() => setShowForm(!showForm)}>{showForm ? 'Close' : '+ New Employee'}</Button>}
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {showForm && (
        <div className="mb-5 bg-white border border-gray-200 rounded-xl p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Input placeholder="Employee No (e.g. EMP-001)" value={form.employeeNo} onChange={(e) => setForm({ ...form, employeeNo: e.target.value })} />
            <Input placeholder="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            <Input placeholder="Position" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
            <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <select
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.departmentId}
              onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
            >
              <option value="">— Department —</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
              value={form.branchId}
              onChange={(e) => setForm({ ...form, branchId: e.target.value })}
            >
              <option value="">— Branch —</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          {/* Login account (optional, same step) */}
          <div className="border-t border-gray-100 pt-3">
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-2">
              <input
                type="checkbox"
                checked={form.createLogin}
                onChange={(e) => setForm({ ...form, createLogin: e.target.checked })}
                className="w-4 h-4 accent-yellow-600"
              />
              Create login account (username + password + role)
            </label>
            {form.createLogin && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input type="radio" checked={form.authSource === 'LOCAL'} onChange={() => setForm({ ...form, authSource: 'LOCAL' })} className="accent-yellow-600" />
                    Local account (password stored here)
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input type="radio" checked={form.authSource === 'AD'} onChange={() => setForm({ ...form, authSource: 'AD' })} className="accent-yellow-600" />
                    Windows AD account (password checked by the directory)
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Input placeholder="Username (AD: same as Windows)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                  {form.authSource === 'LOCAL' ? (
                    <Input placeholder="Password (min 8)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                  ) : (
                    <div className="text-xs text-gray-500 self-center">No password here — the user signs in with their Windows password; AD verifies it.</div>
                  )}
                  <select
                    multiple
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white h-24 focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
                    value={form.roles}
                    onChange={(e) => setForm({ ...form, roles: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                {form.authSource === 'AD' && (
                  <div className="text-xs text-gray-500">Department, branch, position and name above are stored now — the account works as soon as the person signs in with their Windows credentials.</div>
                )}
              </div>
            )}
          </div>

          <Button
            onClick={create}
            disabled={
              form.employeeNo.length < 4 || form.fullName.length < 2 ||
              (form.createLogin && (form.username.length < 3 || (form.authSource === 'LOCAL' && form.password.length < 8) || form.roles.length === 0))
            }
          >
            Create Employee
          </Button>
        </div>
      )}

      <Table head={['No', 'Name', 'Department', 'Position', 'Linked User', 'Roles', 'Status', 'Actions']}>
        {rows.length === 0 && <tr><td colSpan={8}><Empty /></td></tr>}
        {rows.map((e0) => (
          <tr key={e0.id} className={`hover:bg-gray-50 ${e0.status !== 'ACTIVE' ? 'opacity-60' : ''}`}>
            <td className="px-4 py-3 font-mono text-xs text-gray-600">{e0.employeeNo}</td>
            <td className="px-4 py-3 font-medium text-gray-800">{e0.fullName}</td>
            <td className="px-4 py-3">{e0.department?.name ?? '—'}</td>
            <td className="px-4 py-3">{e0.position || '—'}</td>
            <td className="px-4 py-3 text-gray-500">{e0.user?.username ?? '—'}</td>
            <td className="px-4 py-3">
              {e0.roles && e0.roles.length > 0
                ? <div className="flex flex-wrap gap-1">{e0.roles.map((r) => <Badge key={r} color="blue">{r}</Badge>)}</div>
                : <span className="text-gray-400">—</span>}
            </td>
            <td className="px-4 py-3"><Badge color={statusColor(e0.status)}>{e0.status}</Badge></td>
            <td className="px-4 py-3">
              <div className="flex flex-wrap justify-end gap-1.5">
                <button
                  className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
                  onClick={() => {
                    setEdit({ ...e0 });
                    setEditRoles(e0.roles ?? []);
                    if (e0.user) {
                      api<{ roles: string[] }>(`/org/employees/${e0.id}/roles`)
                        .then((r) => setEditRoles(r.roles))
                        .catch(() => undefined);
                    }
                  }}
                >
                  Edit
                </button>
                <button
                  className={`text-xs px-2 py-1 rounded border ${e0.status === 'ACTIVE' ? 'border-yellow-300 text-yellow-700 hover:bg-yellow-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}
                  onClick={() => toggle(e0)}
                >
                  {e0.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                </button>
                <button className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50" onClick={() => { setConfirmDelete(e0); setConfirmText(''); }}>Delete</button>
              </div>
            </td>
          </tr>
        ))}
      </Table>

      {/* Edit modal */}
      {edit && (
        <Modal title={`Edit employee — ${edit.employeeNo}`} error={modalError} onClose={() => { setEdit(null); setModalError(''); }}>
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Employee No (immutable)</label>
                <Input value={edit.employeeNo} disabled />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Full name</label>
                <Input value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Position</label>
                <Input value={edit.position ?? ''} onChange={(e) => setEdit({ ...edit, position: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Phone</label>
                <Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Email</label>
                <Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Department</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={edit.department?.id ?? ''}
                onChange={(e) => setEdit({ ...edit, department: depts.find((d) => d.id === e.target.value) ?? null })}
              >
                <option value="">— None —</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            {edit.user ? (
              <div>
                <label className="block text-xs text-gray-500 mb-1">Linked user — {edit.user.username} · roles (Ctrl+click for multiple)</label>
                <select
                  multiple
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white h-28 focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
                  value={editRoles}
                  onChange={(e) => setEditRoles(Array.from(e.target.selectedOptions).map((o) => o.value))}
                >
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            ) : (
              <div className="border border-dashed border-gray-300 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-2">This employee has no login account — create one (optional)</div>
                <div className="flex flex-wrap items-center gap-4 mb-2">
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input type="radio" checked={newLogin.authSource === 'LOCAL'} onChange={() => setNewLogin({ ...newLogin, authSource: 'LOCAL' })} className="accent-yellow-600" />
                    Local account
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input type="radio" checked={newLogin.authSource === 'AD'} onChange={() => setNewLogin({ ...newLogin, authSource: 'AD' })} className="accent-yellow-600" />
                    Windows AD account
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input placeholder="Username (AD: same as Windows)" value={newLogin.username} onChange={(e) => setNewLogin({ ...newLogin, username: e.target.value })} />
                  {newLogin.authSource === 'LOCAL' ? (
                    <Input placeholder="Password (min 8)" type="password" value={newLogin.password} onChange={(e) => setNewLogin({ ...newLogin, password: e.target.value })} />
                  ) : (
                    <div className="text-xs text-gray-500 self-center">No password here — AD verifies the Windows password at sign-in.</div>
                  )}
                </div>
                <select
                  multiple
                  className="w-full mt-3 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white h-24 focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
                  value={newLogin.roles}
                  onChange={(e) => setNewLogin({ ...newLogin, roles: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                >
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
              <Button
                onClick={saveEdit}
                disabled={
                  edit.fullName.length < 2 ||
                  (!edit.user && newLogin.username !== '' && (newLogin.username.length < 3 || (newLogin.authSource === 'LOCAL' && newLogin.password.length < 8) || newLogin.roles.length === 0))
                }
              >
                Save Changes
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirm modal */}
      {confirmDelete && (
        <Modal title={`Delete employee — ${confirmDelete.fullName}`} error={modalError} onClose={() => { setConfirmDelete(null); setModalError(''); }}>
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">
              Deleting removes the employee master record. If the employee heads a department or has linked
              request history, deletion will fail (409 Conflict) — deactivate instead to keep the audit trail.
            </p>
            <Input placeholder={`Type "${confirmDelete.fullName}" to confirm`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="danger" disabled={confirmText !== confirmDelete.fullName} onClick={doDelete}>Delete Permanently</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
