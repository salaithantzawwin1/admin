import { PrismaService } from '../prisma/prisma.module';
import { ALL_PERMISSION_CODES, PERMISSIONS } from './permissions';

/**
 * Default role → permission grants applied when the role has NO grant for the
 * permission yet (never overrides matrix edits made from the UI).
 */
const DEFAULT_GRANTS: Record<string, string[]> = {
  // Plan §12: Administration runs the store; employees read the catalog + request
  ADMINISTRATION: ['inventory.read', 'inventory.manage', 'announcements.read', 'announcements.manage', 'fleet.types.manage', 'meeting-rooms.facilities.manage'],
  EMPLOYEE: ['inventory.read', 'announcements.read'],
  DEPARTMENT_HEAD: ['inventory.read', 'announcements.read'],
  MANAGEMENT: ['inventory.read', 'announcements.read'],
  MAINTENANCE_COORDINATOR: ['inventory.read', 'announcements.read'],
  PURCHASING: ['announcements.read'],
  FINANCE: ['announcements.read'],
  SYSTEM_ADMIN: [], // superuser — every code is granted dynamically
};

/**
 * Ensures every permission code in the backend catalog exists in the permissions
 * table (idempotent, safe on every boot). Runs at startup before guards query it.
 * Also applies DEFAULT_GRANTS for codes a role has never been granted.
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

    // default grants for newly-introduced codes (roles keep their matrix edits)
    for (const [roleName, codes] of Object.entries(DEFAULT_GRANTS)) {
      const role = await prisma.role.findUnique({ where: { name: roleName as never } });
      if (!role || codes.length === 0) continue;
      for (const code of codes) {
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
