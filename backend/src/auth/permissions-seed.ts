import { PrismaService } from '../prisma/prisma.module';
import { ALL_PERMISSION_CODES, PERMISSIONS } from './permissions';

/**
 * Default role → permission grants. A grant is applied ONLY when the role has
 * never expressed a decision on that code (see deniedPermissions below) —
 * never overrides matrix edits made from the UI.
 */
const DEFAULT_GRANTS: Record<string, string[]> = {
  // Plan §12: Administration runs the store; employees read the catalog + request
  // org.read → department/branch pickers (announcement targeting, employee forms)
  // departments.manage → Administration owns department CRUD (Plan §3)
  ADMINISTRATION: ['inventory.read', 'inventory.manage', 'suppliers.read', 'suppliers.manage', 'announcements.read', 'announcements.manage', 'fleet.types.manage', 'meeting-rooms.facilities.manage', 'org.read', 'departments.manage', 'employees.manage'],
  EMPLOYEE: ['inventory.read', 'announcements.read'],
  DEPARTMENT_HEAD: ['inventory.read', 'announcements.read'],
  MANAGEMENT: ['inventory.read', 'announcements.read'],
  MAINTENANCE_COORDINATOR: ['inventory.read', 'announcements.read'],
  // PURCHASING/FINANCE browse the catalog to raise purchase requests (Plan §6);
  // PURCHASING also owns the vendor master
  PURCHASING: ['announcements.read', 'inventory.read', 'suppliers.read', 'suppliers.manage'],
  FINANCE: ['announcements.read', 'inventory.read', 'suppliers.read'],
  SYSTEM_ADMIN: [], // superuser — every code is granted dynamically
};

/**
 * Codes a role has DELIBERATELY been denied via the RBAC matrix UI (ticked off
 * and saved). These are remembered here forever: without this memory the
 * next backend restart re-granted every DEFAULT_GRANTS code (grant-only
 * seeding), silently resurrecting matrix revocations — that is how
 * suppliers.read kept coming back for FINANCE after being unticked.
 *
 * To re-grant a code later, delete its row here (and restart), or grant it
 * from the matrix — the matrix PATCH syncs this memory automatically.
 */
const DENIED_BY_ROLE: Record<string, string[]> = {
  FINANCE: ['suppliers.read'],
};

/**
 * Ensures every permission code in the backend catalog exists in the permissions
 * table (idempotent, safe on every boot). Runs at startup before guards query it.
 * Also applies DEFAULT_GRANTS for codes a role has never been granted — unless
 * the code is recorded as deliberately denied for that role.
 */
export async function seedPermissions() {
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    for (const code of ALL_PERMISSION_CODES) {
      const description = PERMISSIONS[code.toUpperCase().replace(/\./g, '_') as keyof typeof PERMISSIONS];
      await prisma.permission.upsert({
        where: { code },
        update: { description },
        create: { code, description },
      });
    }
    console.log(`RBAC: permission catalog synced (${ALL_PERMISSION_CODES.length} codes).`);

    // default grants for newly-introduced codes (roles keep their matrix edits;
    // deliberately-denied codes — DENIED_BY_ROLE + role_permissions_denied — are never re-granted)
    for (const [roleName, codes] of Object.entries(DEFAULT_GRANTS)) {
      const role = await prisma.role.findUnique({ where: { name: roleName as never } });
      if (!role || codes.length === 0) continue;
      for (const code of codes) {
        if (await isDenied(prisma, role.id, roleName, code)) continue;
        const permission = await prisma.permission.findUnique({ where: { code } });
        if (!permission) continue;
        const existing = await prisma.rolePermission.findFirst({
          where: { roleId: role.id, permissionId: permission.id },
        });
        if (!existing) {
          await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
          console.log(`RBAC: default grant ${code} → ${roleName}`);
        }
      }
    }
  } catch (e) {
    console.error('RBAC: permission catalog sync failed:', e);
  } finally {
    await prisma.$disconnect();
  }
}

/** True when this role/code pair is recorded as deliberately denied. */
async function isDenied(prisma: PrismaService, roleId: string, roleName: string, code: string): Promise<boolean> {
  // static memory (deployed code) — applies on every host, no DB dependency
  if ((DENIED_BY_ROLE[roleName] ?? []).includes(code)) return true;
  // runtime memory (matrix saves) — lives in the DB, survives restarts & redeploys
  const denied = await prisma.rolePermissionDenied.findFirst({
    where: { roleId, permission: { code } },
    select: { roleId: true },
  });
  return !!denied;
}

export interface MatrixEditActor {
  userId: string;
  username: string;
}

/**
 * Syncs the runtime deny-memory with a matrix save: codes present in
 * `codes` are cleared from role_permissions_denied; codes dropped from the
 * role but belonging to its DEFAULT_GRANTS are recorded as denied so the
 * next boot does not resurrect them.
 */
export async function syncDenyMemoryOnSave(
  prisma: PrismaService,
  roleId: string,
  codes: string[],
): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) return;
  const defaults = DEFAULT_GRANTS[role.name] ?? [];

  // grant-saved codes → clear any stale deny rows (matrix re-grant wins)
  await prisma.rolePermissionDenied.deleteMany({
    where: { roleId, permission: { code: { in: codes } } },
  });

  // default codes dropped by this save → remember the deliberate deny
  const dropped = defaults.filter((c) => !codes.includes(c));
  if (dropped.length === 0) return;
  const perms = await prisma.permission.findMany({ where: { code: { in: dropped } } });
  for (const p of perms) {
    await prisma.rolePermissionDenied.upsert({
      where: { roleId_permissionId: { roleId, permissionId: p.id } },
      update: {},
      create: { roleId, permissionId: p.id },
    });
  }
}
