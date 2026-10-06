/** Align role grants for the 3 request codes between stacks.
 *  DUMP mode (default): print role lists per code (run on prod).
 *  APPLY=1: copy a hardcoded role list onto this stack (run on testing). */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
const CODES = ['requests.create', 'requests.read.own', 'attachments.use'];
(async () => {
  const p = new PrismaService();
  if (process.env.APPLY === '1') {
    // taken from PROD dump (2026-10-06): role lists per code
    const GRANTS = {
      'requests.create': ['SYSTEM_ADMIN', 'MANAGEMENT', 'DEPARTMENT_HEAD', 'MAINTENANCE_COORDINATOR', 'EMPLOYEE', 'PURCHASING', 'ADMINISTRATION'],
      'requests.read.own': ['SYSTEM_ADMIN', 'MANAGEMENT', 'DEPARTMENT_HEAD', 'MAINTENANCE_COORDINATOR', 'EMPLOYEE', 'PURCHASING', 'FINANCE', 'ADMINISTRATION'],
      'attachments.use': ['SYSTEM_ADMIN', 'MANAGEMENT', 'DEPARTMENT_HEAD', 'MAINTENANCE_COORDINATOR', 'EMPLOYEE', 'PURCHASING', 'FINANCE', 'ADMINISTRATION'],
    };
    for (const code of CODES) {
      const perm = await p.permission.findUnique({ where: { code } });
      if (!perm) { console.log(`permission ${code} missing — skip`); continue; }
      for (const roleName of GRANTS[code]) {
        const role = await p.role.findUnique({ where: { name: roleName } });
        if (!role) continue;
        const exists = await p.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
        if (!exists) {
          await p.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
          console.log(`granted ${code} -> ${roleName}`);
        }
      }
    }
    console.log('APPLY done');
  } else {
    for (const code of CODES) {
      const perm = await p.permission.findUnique({ where: { code }, select: { id: true } });
      if (!perm) { console.log(`${code}: MISSING`); continue; }
      const grants = await p.rolePermission.findMany({ where: { permissionId: perm.id }, include: { role: { select: { name: true } } } });
      console.log(`${code}: [${grants.map((g) => g.role.name).sort().join(', ')}]`);
    }
  }
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
