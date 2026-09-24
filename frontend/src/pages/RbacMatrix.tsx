import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, hasPermission } from '../api';
import { Badge, Button, PageHeader } from '../components/ui';

interface MatrixRole {
  role: string;
  permissions: string[];
}

/** Groups shown in the matrix — order defines display order. */
const GROUPS: { name: string; prefix: string; description: string }[] = [
  { name: 'Users & Org', prefix: 'users.', description: 'User accounts, branches' },
  { name: 'Departments', prefix: 'departments.', description: 'Department lists and CRUD' },
  { name: 'Employees', prefix: 'employees.', description: 'Employee directory and CRUD, login links' },
  { name: 'Requests & Workflow', prefix: 'requests.', description: 'Create, view and read requests; approval acting' },
  { name: 'Approvals', prefix: 'approvals.', description: 'Act on approval inbox' },
  { name: 'Fleet & Cars', prefix: 'fleet.', description: 'Vehicles, drivers, trips, vehicle types' },
  { name: 'Meeting Rooms', prefix: 'meeting-rooms.', description: 'Room assignment, facility master data' },
  { name: 'Inventory', prefix: 'inventory.', description: 'Item catalog, stock, spending, suppliers' },
  { name: 'Announcements', prefix: 'announcements.', description: 'Company notices, publishing, read stats' },
  { name: 'System', prefix: 'workflow.', description: 'Workflow configuration' },
  { name: 'System', prefix: 'audit.', description: 'Audit trail' },
  { name: 'System', prefix: 'attachments.', description: 'File uploads' },
];

const PERM_LABELS: Record<string, string> = {
  'users.read': 'View users',
  'users.manage': 'Manage users',
  'org.read': 'View org data',
  'org.manage': 'Manage org data',
  'departments.read': 'View departments',
  'departments.manage': 'Manage departments',
  'employees.read': 'View employees',
  'employees.manage': 'Manage employees',
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

function groupOf(perm: string): string {
  const g = GROUPS.find((g) => perm.startsWith(g.prefix));
  return g ? g.name : 'Other';
}

const GROUP_ORDER = [...new Set(GROUPS.map((g) => g.name)), 'Other'];

/** Friendly role labels shown as column headers. */
const ROLE_LABELS: Record<string, string> = {
  SYSTEM_ADMIN: 'System Admin',
  ADMINISTRATION: 'Administration',
  DEPARTMENT_HEAD: 'Dept Head',
  MANAGEMENT: 'Management',
  MAINTENANCE_COORDINATOR: 'Maintenance Coord.',
  PURCHASING: 'Purchasing',
  FINANCE: 'Finance',
  EMPLOYEE: 'Employee',
};

export default function RbacMatrix() {
  const [roles, setRoles] = useState<MatrixRole[]>([]);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [dirty, setDirty] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  // group collapse state persists per browser (default: all expanded)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('rbac-groups-collapsed');
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const [busy, setBusy] = useState(false);

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
      setNotice(`${ROLE_LABELS[role] ?? role} permissions saved — users see changes after their next request (permission cache refreshes per request).`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(null);
    }
  };

  const dirtyCount = Object.keys(dirty).length;

  // group catalog into sections; 'cars.' folds into Fleet & Cars display
  const sections = useMemo(() => {
    const filtered = catalog.filter(
      (p) => !search || p.toLowerCase().includes(search.toLowerCase()) || (PERM_LABELS[p] ?? '').toLowerCase().includes(search.toLowerCase()),
    );
    const byGroup = new Map<string, string[]>();
    for (const p of filtered) {
      const g = groupOf(p);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(p);
    }
    // merge cars.* into the Fleet group visually
    const cars = byGroup.get('Other')?.filter((p) => p.startsWith('cars.')) ?? [];
    if (cars.length) {
      byGroup.set('Other', (byGroup.get('Other') ?? []).filter((p) => !p.startsWith('cars.')));
      const fleet = byGroup.get('Fleet & Cars') ?? [];
      byGroup.set('Fleet & Cars', [...fleet, ...cars]);
    }
    // permissions sorted A→Z inside every group
    for (const list of byGroup.values()) list.sort((a, b) => a.localeCompare(b));
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
      name: g,
      perms: byGroup.get(g)!,
      open: expanded[g] ?? true,
    }));
  }, [catalog, search, expanded]);

  const toggleGroup = (g: string) =>
    setExpanded((prev) => {
      const next = { ...prev, [g]: !(prev[g] ?? true) };
      try {
        localStorage.setItem('rbac-groups-collapsed', JSON.stringify(next));
      } catch {
        /* private mode — state still works for this session */
      }
      return next;
    });

  const allOpen = sections.every((s) => s.open);
  const setAll = (open: boolean) => {
    const next: Record<string, boolean> = {};
    for (const g of GROUP_ORDER) next[g] = open;
    setExpanded(next);
    try {
      localStorage.setItem('rbac-groups-collapsed', JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  /** One-click cleanup: revoke codes that the backend catalog no longer knows (stale legacy grants). */
  const cleanupLegacy = async () => {
    if (!window.confirm('Revoke permissions that are no longer in the system catalog from all roles?')) return;
    setBusy(true);
    setError('');
    try {
      for (const r of roles) {
        if (r.role === 'SYSTEM_ADMIN') continue;
        const stale = r.permissions.filter((p) => !catalog.includes(p));
        if (stale.length === 0) continue;
        await api(`/auth/permissions/roles/${r.role}`, {
          method: 'PATCH',
          body: { permissions: r.permissions.filter((p) => catalog.includes(p)) },
        });
      }
      setNotice('Legacy grants cleaned up.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cleanup failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="RBAC — Permission Matrix"
        subtitle="Role-Based Access Control: which role can do what. SYSTEM_ADMIN always has full access."
      />

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
      {notice && <div className="mb-4 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">{notice}</div>}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search permission…"
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-56"
        />
        {canManage && dirtyCount > 0 && (
          <span className="text-xs font-medium text-amber-700 bg-amber-50 rounded-full px-2.5 py-1">
            {dirtyCount} role{dirtyCount > 1 ? 's' : ''} with unsaved changes
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {sections.length > 0 && (
            <button
              onClick={() => setAll(!allOpen)}
              className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 transition-colors"
            >
              {allOpen ? '⊟ Collapse all' : '⊞ Expand all'}
            </button>
          )}
          {canManage && (
            <span title="Revoke codes no longer in the catalog">
              <Button variant="ghost" onClick={cleanupLegacy} disabled={busy}>
                🧹 Clean legacy grants
              </Button>
            </span>
          )}
          <Badge color="blue">{catalog.length} permissions</Badge>
          <Badge color="gray">{roles.length} roles</Badge>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium">Permission</th>
              {roles.map((r) => (
                <th key={r.role} className={`px-3 py-3 font-medium text-center ${dirty[r.role] ? 'bg-amber-50' : ''}`} title={r.role}>
                  {ROLE_LABELS[r.role] ?? r.role.replace(/_/g, ' ')}
                  {dirty[r.role] && <span className="ml-1 text-amber-500">●</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sections.map((sec) => (
              <>
                <tr key={sec.name} className="bg-gray-50/80">
                  <td colSpan={roles.length + 1} className="px-4 py-1.5">
                    <button className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-700" onClick={() => toggleGroup(sec.name)}>
                      <span>{sec.open ? '▾' : '▸'}</span> {sec.name}
                      <span className="text-gray-300 normal-case font-normal">({sec.perms.length})</span>
                    </button>
                  </td>
                </tr>
                {sec.open &&
                  sec.perms.map((perm) => (
                    <tr key={perm} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5">
                        <div className="font-mono text-xs text-gray-700">{perm}</div>
                        <div className="text-[11px] text-gray-400">{PERM_LABELS[perm] ?? ''}</div>
                      </td>
                      {roles.map((r) => {
                        const on = permsOf(r.role).includes(perm);
                        const locked = r.role === 'SYSTEM_ADMIN';
                        const orig = roles.find((x) => x.role === r.role)?.permissions.includes(perm) ?? false;
                        const changed = dirty[r.role] && on !== orig;
                        return (
                          <td key={r.role} className={`px-3 py-2.5 text-center ${changed ? 'bg-amber-50' : ''}`}>
                            {locked ? (
                              <span className="text-blue-500" title="Superuser — always granted">✓</span>
                            ) : canManage ? (
                              <input type="checkbox" checked={on} onChange={() => toggle(r.role, perm)} className="w-4 h-4 cursor-pointer" />
                            ) : (
                              <span className={on ? 'text-green-600' : 'text-gray-300'}>{on ? '✓' : '—'}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </>
            ))}
            {sections.length === 0 && (
              <tr>
                <td colSpan={roles.length + 1} className="text-center text-sm text-gray-400 py-8">
                  No permissions match “{search}”
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="mt-4 flex flex-wrap gap-2 items-center">
          {roles
            .filter((r) => r.role !== 'SYSTEM_ADMIN' && dirty[r.role])
            .map((r) => (
              <Button key={r.role} onClick={() => save(r.role)} disabled={saving === r.role}>
                {saving === r.role ? 'Saving…' : `Save ${ROLE_LABELS[r.role] ?? r.role}`}
              </Button>
            ))}
          {canManage && dirtyCount > 0 && (
            <Button
              variant="ghost"
              disabled={saving !== null}
              onClick={() => {
                if (window.confirm('Discard all unsaved changes?')) setDirty({});
              }}
            >
              Discard all
            </Button>
          )}
          {dirtyCount === 0 && <span className="text-xs text-gray-400 self-center">No unsaved changes</span>}
        </div>
      )}

      {!canManage && (
        <p className="mt-4 text-xs text-gray-400">Read-only view — you need the “Manage users” permission to edit the matrix.</p>
      )}
    </div>
  );
}
