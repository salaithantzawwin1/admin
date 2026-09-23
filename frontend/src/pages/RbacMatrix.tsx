import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../api';
import { Badge, Button, PageHeader } from '../components/ui';

interface MatrixRole {
  role: string;
  permissions: string[];
}

const PERM_LABELS: Record<string, string> = {
  'users.read': 'View users',
  'users.manage': 'Manage users',
  'org.read': 'View org data',
  'org.manage': 'Manage org data',
  'requests.read.own': 'View own requests',
  'requests.read.all': 'View all requests',
  'requests.create': 'Create requests',
  'approvals.act': 'Act on approvals',
  'workflow.manage': 'Configure workflows',
  'fleet.read': 'View fleet',
  'fleet.manage': 'Manage fleet',
  'cars.assign': 'Assign vehicles/trips',
  'fleet.types.manage': 'Manage vehicle type master data',
  'meeting-rooms.assign': 'Assign meeting rooms',
  'meeting-rooms.facilities.manage': 'Manage meeting-room facility master data',
  'inventory.read': 'View inventory',
  'inventory.manage': 'Manage inventory & suppliers',
  'announcements.read': 'View announcements',
  'announcements.manage': 'Create & publish announcements',
  'audit.read': 'View audit logs',
  'attachments.use': 'Use attachments',
};

export default function RbacMatrix() {
  const [roles, setRoles] = useState<MatrixRole[]>([]);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [dirty, setDirty] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const canManage = hasPermission('users.manage');

  const load = useCallback(() => {
    api<{ catalog: string[]; roles: MatrixRole[] }>('/auth/permissions/matrix')
      .then((r) => {
        setRoles(r.roles);
        setCatalog(r.catalog);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const permsOf = (role: string): string[] =>
    dirty[role] ?? roles.find((r) => r.role === role)?.permissions ?? [];

  const toggle = (role: string, perm: string) => {
    if (role === 'SYSTEM_ADMIN') return; // superuser always full
    setDirty((prev) => {
      const current = permsOf(role);
      const next = current.includes(perm) ? current.filter((p) => p !== perm) : [...current, perm];
      return { ...prev, [role]: next };
    });
  };

  const save = async (role: string) => {
    setSaving(role);
    setError('');
    setNotice('');
    try {
      await api(`/auth/permissions/roles/${role}`, {
        method: 'PATCH',
        body: { permissions: permsOf(role) },
      });
      setDirty((prev) => {
        const next = { ...prev };
        delete next[role];
        return next;
      });
      setNotice(`${role} permissions saved`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(null);
    }
  };

  const dirtyCount = Object.keys(dirty).length;

  return (
    <div>
      <PageHeader
        title="RBAC — Permission Matrix"
        subtitle="Role-Based Access Control: which role can do what. SYSTEM_ADMIN always has full access."
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
      {notice && <div className="mb-4 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{notice}</div>}

      <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Permission</th>
              {roles.map((r) => (
                <th key={r.role} className="px-3 py-3 font-medium text-center">{r.role.replace(/_/g, ' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {catalog.map((perm) => (
              <tr key={perm} className="hover:bg-gray-50">
                <td className="px-4 py-2.5">
                  <div className="font-mono text-xs text-gray-700">{perm}</div>
                  <div className="text-[11px] text-gray-400">{PERM_LABELS[perm] ?? ''}</div>
                </td>
                {roles.map((r) => {
                  const on = permsOf(r.role).includes(perm);
                  const locked = r.role === 'SYSTEM_ADMIN';
                  return (
                    <td key={r.role} className="px-3 py-2.5 text-center">
                      {locked ? (
                        <span className="text-blue-500" title="Superuser — always granted">✓</span>
                      ) : canManage ? (
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(r.role, perm)}
                          className="w-4 h-4 cursor-pointer"
                        />
                      ) : (
                        <span className={on ? 'text-green-600' : 'text-gray-300'}>{on ? '✓' : '—'}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="mt-4 flex flex-wrap gap-2">
          {roles
            .filter((r) => r.role !== 'SYSTEM_ADMIN' && dirty[r.role])
            .map((r) => (
              <Button key={r.role} onClick={() => save(r.role)} disabled={saving === r.role}>
                {saving === r.role ? 'Saving…' : `Save ${r.role}`}
              </Button>
            ))}
          {dirtyCount === 0 && <span className="text-xs text-gray-400 self-center">No unsaved changes</span>}
        </div>
      )}

      {!canManage && (
        <p className="mt-4 text-xs text-gray-400">Read-only view — you need the “Manage users” permission to edit the matrix.</p>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <Badge color="blue">{catalog.length} permissions</Badge>
        <Badge color="gray">{roles.length} roles</Badge>
      </div>
    </div>
  );
}
