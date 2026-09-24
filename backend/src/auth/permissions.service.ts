import { Injectable } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';

export interface AuthUserShape {
  id: string;
  username: string;
  roles: { name: string }[];
}

@Injectable()
export class PermissionsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Effective permission codes for a user = union of permissions of all their roles. */
  async forUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { role: { userRoles: { some: { userId } } } },
      select: { permission: { select: { code: true } } },
    });
    const codes = [...new Set(rows.map((r) => r.permission.code))];

    // SYSTEM_ADMIN is a superuser — grant all catalog codes even if matrix is edited later
    const sysAdmin = await this.prisma.userRole.findFirst({
      where: { userId, role: { name: 'SYSTEM_ADMIN' } },
      select: { userId: true },
    });
    if (sysAdmin) {
      const all = await this.prisma.permission.findMany({ select: { code: true } });
      return [...new Set([...codes, ...all.map((p) => p.code)])];
    }
    return codes;
  }

  /** Resolve permission codes for a set of role names (used for role inspection / preview). */
  async forRoleNames(roleNames: RoleName[]): Promise<string[]> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { role: { name: { in: roleNames } } },
      select: { permission: { select: { code: true } } },
    });
    return [...new Set(rows.map((r) => r.permission.code))];
  }

  /** True when the user holds the given permission (used by service-level checks). */
  async userHas(userId: string, code: string): Promise<boolean> {
    return (await this.forUser(userId)).includes(code);
  }

  /**
   * All ACTIVE users holding any of the given permission codes — the RBAC-native
   * replacement for hard-coded role lookups when broadcasting notifications
   * (e.g. the people who can manage announcements, not "role X").
   */
  async usersWithPermissions(codes: string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const roles = await this.prisma.role.findMany({
      where: { permissions: { some: { permission: { code: { in: codes } } } } },
      select: { userRoles: { select: { userId: true }, where: { user: { status: 'ACTIVE' } } } },
    });
    const userIds = roles.flatMap((r) => r.userRoles.map((u) => u.userId));
    return [...new Set(userIds)];
  }

  /** Full role→permissions matrix for the admin editor UI. */
  async matrixView(): Promise<{ role: string; permissions: string[] }[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
      select: { name: true, permissions: { select: { permission: { select: { code: true } } } } },
    });
    const result: { role: string; permissions: string[] }[] = [];
    for (const r of roles) {
      let codes = r.permissions.map((p) => p.permission.code);
      if (r.name === 'SYSTEM_ADMIN') {
        // superuser always sees full catalog
        const all = await this.prisma.permission.findMany({ select: { code: true } });
        codes = [...new Set([...codes, ...all.map((p) => p.code)])];
      }
      result.push({ role: r.name, permissions: codes });
    }
    return result;
  }

  /** Replace the permission set of a role (admin editor). */
  async setRolePermissions(roleName: string, codes: string[], actor: { userId: string; username: string }) {
    const role = await this.prisma.role.findUnique({ where: { name: roleName as RoleName } });
    if (!role) return null;

    const perms = await this.prisma.permission.findMany({ where: { code: { in: codes } } });
    await this.audit.log({
      userId: actor.userId,
      username: actor.username,
      action: 'ROLE_PERMISSIONS_UPDATED',
      module: 'RBAC',
      recordId: role.id,
      newValue: { role: roleName, permissions: codes.sort() },
      severity: 'WARNING',
    });
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
      this.prisma.rolePermission.createMany({
        data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
        skipDuplicates: true,
      }),
    ]);
    return this.forRoleNames([roleName as RoleName]);
  }
}
