/** Read-only RBAC probe: who holds requests.create? what does employee1 actually have? */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const p = new PrismaService();
  const perm = await p.permission.findUnique({ where: { code: 'requests.create' }, select: { id: true, description: true } });
  if (!perm) { console.log('requests.create permission row: MISSING'); } else {
    const grants = await p.rolePermission.findMany({ where: { permissionId: perm.id }, include: { role: { select: { name: true } } } });
    console.log('requests.create granted to roles:', grants.map((g) => g.role.name).join(', ') || '(none)');
  }
  const empRole = await p.role.findUnique({ where: { name: 'EMPLOYEE' } });
  const empPerms = await p.rolePermission.findMany({ where: { roleId: empRole.id }, include: { permission: { select: { code: true } } } });
  const denied = await p.rolePermissionDenied.findMany({ where: { roleId: empRole.id }, include: { permission: { select: { code: true } } } });
  console.log('EMPLOYEE role permissions:', empPerms.map((x) => x.permission.code).sort().join(', '));
  console.log('EMPLOYEE role denied:', denied.map((x) => x.permission.code).join(', ') || '(none)');
  const u = await p.user.findUnique({ where: { username: 'employee1' }, include: { userRoles: { include: { role: true } } } });
  console.log('employee1 roles:', u?.userRoles.map((r) => r.role.name).join(', '));
  const usersWithCreate = await p.userRole.findMany({ where: { role: { permissions: { some: { permission: { code: 'requests.create' } } } } }, include: { user: { select: { username: true } }, role: { select: { name: true } } } });
  console.log('users holding requests.create via role:', usersWithCreate.map((x) => `${x.user.username}(${x.role.name})`).slice(0, 15).join(', '));
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
