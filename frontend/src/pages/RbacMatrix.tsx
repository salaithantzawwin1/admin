import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, hasPermission } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
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
  // in-app confirm dialogs (replace window.confirm — native popups are banned app-wide)
  const [confirmLegacy, setConfirmLegacy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

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
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search permission…"
            className="border border-gray-200 rounded-lg pl-8 pr-8 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-gold/60 focus:border-gold"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-gray-300 hover:bg-gray-400 text-white text-[9px] leading-none flex items-center justify-center"
              title="Clear"
            >
              ✕
            </button>
          )}
        </div>
        {canManage && dirtyCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-3 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            {dirtyCount} role{dirtyCount > 1 ? 's' : ''} unsaved — Save below
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            All changes saved
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {sections.length > 0 && (
            <button
              onClick={() => setAll(!allOpen)}
              className="text-xs text-gray-600 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
            >
              {allOpen ? '⊟ Collapse all' : '⊞ Expand all'}
            </button>
          )}
          {canManage && (
            <span title="Revoke codes no longer in the catalog">
              <Button variant="ghost" onClick={() => setConfirmLegacy(true)} disabled={busy}>
                🧹 Clean legacy grants
              </Button>
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-full px-3 py-1.5">
            <b className="text-gray-800">{catalog.length}</b> permissions
            <span className="text-gray-300">·</span>
            <b className="text-gray-800">{roles.length}</b> roles
          </span>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-3 font-medium sticky left-0 bg-white z-10 shadow-[1px_0_0_0_#e5e7eb]">Permission</th>
              {roles.map((r) => (
                <th key={r.role} className={`px-3 py-3 font-medium text-center whitespace-nowrap ${dirty[r.role] ? 'bg-amber-50' : ''}`} title={r.role}>
                  {ROLE_LABELS[r.role] ?? r.role.replace(/_/g, ' ')}
                  {dirty[r.role] && <span className="ml-1 text-amber-500">●</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sections.map((sec) => (
              <>
                <tr key={sec.name} className="bg-gray-50/80 hover:bg-gray-100/80 cursor-pointer select-none" onClick={() => toggleGroup(sec.name)}>
                  <td colSpan={roles.length + 1} className="px-4 py-2" title={sec.open ? 'Collapse group' : 'Expand group'}>
                    <div className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      <span className={`text-gray-400 transition-transform ${sec.open ? 'rotate-90' : ''}`}>▶</span>
                      {sec.name}
                      <span className="text-gray-300 normal-case font-normal">({sec.perms.length})</span>
                    </div>
                  </td>
                </tr>
                {sec.open &&
                  sec.perms.map((perm) => (
                    <tr key={perm} className="hover:bg-gray-50">
                      <td className="px-4 py-2 sticky left-0 bg-white group-hover:bg-gray-50 hover:bg-gray-50 shadow-[1px_0_0_0_#e5e7eb] z-10">
                        <div className="font-mono text-xs text-gray-700">{perm}</div>
                        <div className="text-[11px] text-gray-400">{PERM_LABELS[perm] ?? ''}</div>
                      </td>
                      {roles.map((r) => {
                        const on = permsOf(r.role).includes(perm);
                        const locked = r.role === 'SYSTEM_ADMIN';
                        const orig = roles.find((x) => x.role === r.role)?.permissions.includes(perm) ?? false;
                        const changed = dirty[r.role] && on !== orig;
                        return (
                          <td key={r.role} className={`px-3 py-2 text-center ${changed ? 'bg-amber-50' : ''}`}>
                            {locked ? (
                              <span className="text-blue-500" title="Superuser — always granted">✓</span>
                            ) : canManage ? (
                              <input type="checkbox" checked={on} onChange={() => toggle(r.role, perm)} className="w-4 h-4 cursor-pointer accent-yellow-600" />
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
        <div className={`sticky bottom-0 -mx-1 px-1 py-2 mt-1 flex flex-wrap gap-2 items-center rounded-lg ${dirtyCount > 0 ? 'bg-amber-50/95 border border-amber-200 shadow-sm' : ''}`}>
          {dirtyCount > 0 && <span className="text-xs font-semibold text-amber-800 mr-1">Unsaved changes</span>}
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
              onClick={() => setConfirmDiscard(true)}
            >
              Discard all
            </Button>
          )}
          {dirtyCount === 0 && <span className="text-xs text-gray-400 self-center">No unsaved changes</span>}
        </div>
      )}

      {confirmLegacy && (
        <ConfirmDialog
          title="Clean legacy grants?"
          description={
            <>
              Revokes permission rows that are <b>no longer in the system catalog</b> (left over from removed
              features or renames) from every role. Current catalog permissions are untouched. The change is
              audit-logged as ROLE_PERMISSIONS_UPDATED.
            </>
          }
          confirmLabel="Clean up"
          variant="danger"
          onConfirm={async () => {
            await cleanupLegacy();
            setConfirmLegacy(false);
          }}
          onClose={() => setConfirmLegacy(false)}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard all unsaved changes?"
          description="Every ticked-but-not-saved checkbox returns to its last saved state."
          confirmLabel="Discard"
          variant="danger"
          onConfirm={async () => {
            setDirty({});
            setConfirmDiscard(false);
          }}
          onClose={() => setConfirmDiscard(false)}
        />
      )}

      {!canManage && (
        <p className="mt-4 text-xs text-gray-400">Read-only view — you need the “Manage users” permission to edit the matrix.</p>
      )}
    </div>
  );
}
