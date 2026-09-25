import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { Badge, Button, Empty, Input, PageHeader, Table } from '../components/ui';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';

interface Branch {
  id: string;
  code: string;
  name: string;
  address?: string;
  phone?: string;
  isActive: boolean;
}

interface DepartmentRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  branch: Branch | null;
  headEmployee?: { id: string; fullName: string } | null;
  _count?: { employees: number };
}

type Mode =
  | { kind: 'editBranch'; row: Branch }
  | { kind: 'delBranch'; row: Branch; reason: string }
  | { kind: 'delDept'; row: DepartmentRow; reason: string };

export default function Departments() {
  const [branches, setBranches] = useState<Branch[]>([]);
  // departments.manage (or org.manage) gates the CRUD actions — read-only users see lists only
  const canManage = hasPermission('departments.manage') || hasPermission('org.manage');
  const [depts, setDepts] = useState<DepartmentRow[]>([]);
  const [showBranchForm, setShowBranchForm] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [error, setError] = useState('');
  const [modalError, setModalError] = useState(''); // submit errors show inside the dialog, not on the page
  const [bForm, setBForm] = useState({ code: '', name: '', address: '', phone: '' });
  const [showDeptForm, setShowDeptForm] = useState(false);
  const [dForm, setDForm] = useState({ code: '', name: '', branchId: '' });

  const load = useCallback(() => {
    api<Branch[]>('/org/branches')
      .then(setBranches)
      .catch((e) => setError(e.message));
    api<DepartmentRow[]>('/org/departments')
      .then(setDepts)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const createBranch = async () => {
    setModalError('');
    try {
      await api('/org/branches', { method: 'POST', body: bForm });
      setShowBranchForm(false);
      setBForm({ code: '', name: '', address: '', phone: '' });
      toast('Branch created');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const createDept = async () => {
    setModalError('');
    try {
      await api('/org/departments', { method: 'POST', body: dForm });
      setShowDeptForm(false);
      setDForm({ code: '', name: '', branchId: '' });
      toast('Department created');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const saveBranch = async () => {
    if (mode?.kind !== 'editBranch') return;
    setModalError('');
    try {
      await api(`/org/branches/${mode.row.id}`, {
        method: 'PATCH',
        body: { name: mode.row.name, address: mode.row.address || undefined, phone: mode.row.phone || undefined },
      });
      setMode(null);
      toast('Branch updated');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const toggleBranch = async (b: Branch) => {
    setError('');
    try {
      await api(`/org/branches/${b.id}`, { method: 'PATCH', body: { isActive: !b.isActive } });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const toggleDept = async (d: DepartmentRow) => {
    setError('');
    try {
      await api(`/org/departments/${d.id}`, { method: 'PATCH', body: { isActive: !d.isActive } });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doDelete = async () => {
    if (mode?.kind !== 'delBranch' && mode?.kind !== 'delDept') return;
    setModalError('');
    const { kind, row } = mode;
    try {
      await api(`/org/${kind === 'delBranch' ? 'branches' : 'departments'}/${row.id}`, { method: 'DELETE' });
      setMode(null);
      toast(kind === 'delBranch' ? 'Branch deleted' : 'Department deleted');
      load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Delete failed — it likely has linked departments or employees.');
    }
  };

  const delName = mode && (mode.kind === 'delBranch' || mode.kind === 'delDept') ? mode.row.name : '';
  const delConfirm = mode && (mode.kind === 'delBranch' || mode.kind === 'delDept') ? mode.reason : '';

  return (
    <div>
      <PageHeader
        title="Branches & Departments"
        subtitle="Branches group departments — departments group employees and route requests"
        actions={
          canManage ? (
            <>
              <Button onClick={() => { setDForm({ code: '', name: '', branchId: '' }); setModalError(''); setShowDeptForm(true); }}>+ Department</Button>
              <Button onClick={() => { setBForm({ code: '', name: '', address: '', phone: '' }); setModalError(''); setShowBranchForm(true); }}>+ Branch</Button>
            </>
          ) : undefined
        }
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

      {/* New branch — dialog (errors show inside) */}
      {showBranchForm && (
        <Modal title="New branch" error={modalError} onClose={() => { setShowBranchForm(false); setModalError(''); }}>
          <div className="space-y-3">
            <div className="text-xs text-gray-500">Branches group departments — e.g. head office vs. branches.</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Code *</label>
                <Input placeholder="e.g. HQ" value={bForm.code} onChange={(e) => setBForm({ ...bForm, code: e.target.value.toUpperCase() })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Branch name *</label>
                <Input placeholder="e.g. Head Office" value={bForm.name} onChange={(e) => setBForm({ ...bForm, name: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Address</label>
                <Input placeholder="Optional" value={bForm.address} onChange={(e) => setBForm({ ...bForm, address: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Phone</label>
                <Input placeholder="Optional" value={bForm.phone} onChange={(e) => setBForm({ ...bForm, phone: e.target.value })} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setShowBranchForm(false)}>Cancel</Button>
              <Button onClick={createBranch} disabled={bForm.code.length < 2 || bForm.name.length < 2}>Create Branch</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* New department — dialog (errors show inside) */}
      {showDeptForm && (
        <Modal title="New department" error={modalError} onClose={() => { setShowDeptForm(false); setModalError(''); }}>
          <div className="space-y-3">
            <div className="text-xs text-gray-500">Departments group employees and route their requests to the right approvers.</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Code *</label>
                <Input placeholder="e.g. IT" value={dForm.code} onChange={(e) => setDForm({ ...dForm, code: e.target.value.toUpperCase() })} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Department name *</label>
                <Input placeholder="e.g. IT Department" value={dForm.name} onChange={(e) => setDForm({ ...dForm, name: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Branch</label>
                <select
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold w-full"
                  value={dForm.branchId}
                  onChange={(e) => setDForm({ ...dForm, branchId: e.target.value })}
                >
                  <option value="">— Branch (optional) —</option>
                  {branches.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setShowDeptForm(false)}>Cancel</Button>
              <Button onClick={createDept} disabled={dForm.code.length < 2 || dForm.name.length < 2}>Create Department</Button>
            </div>
          </div>
        </Modal>
      )}

      <Table head={['Department', 'Code', 'Branch', 'Head', 'Employees', 'Status', 'Actions']}>
        {depts.length === 0 && <tr><td colSpan={7}><Empty /></td></tr>}
        {depts.map((d) => (
          <tr key={d.id} className={`hover:bg-gray-50 ${!d.isActive ? 'opacity-60' : ''}`}>
            <td className="px-4 py-3 font-medium text-gray-800">{d.name}</td>
            <td className="px-4 py-3 text-gray-500">{d.code}</td>
            <td className="px-4 py-3">{d.branch?.name ?? '—'}</td>
            <td className="px-4 py-3">{d.headEmployee?.fullName ?? '—'}</td>
            <td className="px-4 py-3">{d._count?.employees ?? 0}</td>
            <td className="px-4 py-3"><Badge color={d.isActive ? 'green' : 'red'}>{d.isActive ? 'ACTIVE' : 'INACTIVE'}</Badge></td>
            <td className="px-4 py-3">
              {canManage && (
                <div className="flex flex-wrap justify-end gap-1.5">
                  <button className="text-xs px-2 py-1 rounded border border-yellow-300 text-yellow-700 hover:bg-yellow-50" onClick={() => toggleDept(d)}>
                    {d.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <button className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50" onClick={() => setMode({ kind: 'delDept', row: { ...d }, reason: '' })}>Delete</button>
                </div>
              )}
            </td>
          </tr>
        ))}
      </Table>

      <h3 className="font-semibold text-gray-800 mt-8 mb-2">Branches</h3>
      <Table head={['Code', 'Branch', 'Address', 'Phone', 'Status', 'Actions']}>
        {branches.length === 0 && <tr><td colSpan={6}><Empty /></td></tr>}
        {branches.map((b) => (
          <tr key={b.id} className={`hover:bg-gray-50 ${!b.isActive ? 'opacity-60' : ''}`}>
            <td className="px-4 py-3 font-mono text-xs text-gray-600">{b.code}</td>
            <td className="px-4 py-3 font-medium text-gray-800">{b.name}</td>
            <td className="px-4 py-3 text-gray-500">{b.address || '—'}</td>
            <td className="px-4 py-3 text-gray-500">{b.phone || '—'}</td>
            <td className="px-4 py-3"><Badge color={b.isActive ? 'green' : 'red'}>{b.isActive ? 'ACTIVE' : 'INACTIVE'}</Badge></td>
            <td className="px-4 py-3">
              {canManage && (
                <div className="flex flex-wrap justify-end gap-1.5">
                  <button className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50" onClick={() => setMode({ kind: 'editBranch', row: { ...b } })}>Edit</button>
                  <button className="text-xs px-2 py-1 rounded border border-yellow-300 text-yellow-700 hover:bg-yellow-50" onClick={() => toggleBranch(b)}>
                    {b.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <button className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50" onClick={() => setMode({ kind: 'delBranch', row: { ...b }, reason: '' })}>Delete</button>
                </div>
              )}
            </td>
          </tr>
        ))}
      </Table>

      {/* Edit branch modal */}
      {mode?.kind === 'editBranch' && (
        <Modal title={`Edit branch — ${mode.row.code}`} error={modalError} onClose={() => { setMode(null); setModalError(''); }}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Code (immutable)</label>
              <Input value={mode.row.code} disabled />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Name</label>
              <Input value={mode.row.name} onChange={(e) => setMode({ ...mode, row: { ...mode.row, name: e.target.value } })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Address</label>
              <Input value={mode.row.address ?? ''} onChange={(e) => setMode({ ...mode, row: { ...mode.row, address: e.target.value } })} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Phone</label>
              <Input value={mode.row.phone ?? ''} onChange={(e) => setMode({ ...mode, row: { ...mode.row, phone: e.target.value } })} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
              <Button onClick={saveBranch} disabled={mode.row.name.length < 2}>Save</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirm modal */}
      {mode && (mode.kind === 'delBranch' || mode.kind === 'delDept') && (
        <Modal title={`Delete ${mode.kind === 'delBranch' ? 'branch' : 'department'} — ${mode.row.name}`} error={modalError} onClose={() => { setMode(null); setModalError(''); }}>
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">
              {mode.kind === 'delBranch'
                ? 'A branch that still has departments or employees cannot be deleted — you will get a 409 Conflict. Deactivate it instead to keep history intact.'
                : 'A department that still has employees or requests cannot be deleted — you will get a 409 Conflict. Deactivate it instead to keep history intact.'}
            </p>
            <Input placeholder={`Type "${mode.row.name}" to confirm`} value={mode.reason} onChange={(e) => setMode({ ...mode, reason: e.target.value })} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
              <Button variant="danger" disabled={delConfirm !== delName} onClick={doDelete}>Delete Permanently</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
