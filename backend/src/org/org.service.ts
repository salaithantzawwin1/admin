import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';

/** Unusable bcrypt hash — AD accounts never authenticate with a local password. */
const AD_UNUSABLE_HASH = '$2a$10$disabled$account$uses$ad$auth$0000000000000000000000';

@Injectable()
export class OrgService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  // ---------- Branches ----------
  listBranches() {
    return this.prisma.branch.findMany({ orderBy: { code: 'asc' } });
  }

  async createBranch(data: { code: string; name: string; address?: string; phone?: string }, actor: Actor) {
    const branch = await this.prisma.branch.create({ data });
    await this.audit.log({ ...actor, action: 'BRANCH_CREATED', module: 'ORG', recordId: branch.id, newValue: data });
    return branch;
  }

  async updateBranch(id: string, data: { name?: string; address?: string; phone?: string; isActive?: boolean }, actor: Actor) {
    const old = await this.mustFindBranch(id);
    const branch = await this.prisma.branch.update({ where: { id }, data });
    await this.audit.log({ ...actor, action: 'BRANCH_UPDATED', module: 'ORG', recordId: id, oldValue: old, newValue: data });
    return branch;
  }

  // ---------- Departments ----------
  listDepartments() {
    return this.prisma.department.findMany({
      orderBy: { code: 'asc' },
      include: { branch: true, headEmployee: true, _count: { select: { employees: true } } },
    });
  }

  async createDepartment(data: { code: string; name: string; branchId?: string }, actor: Actor) {
    const dept = await this.prisma.department.create({ data });
    await this.audit.log({ ...actor, action: 'DEPARTMENT_CREATED', module: 'ORG', recordId: dept.id, newValue: data });
    return dept;
  }

  async updateDepartment(id: string, data: { name?: string; branchId?: string; headEmployeeId?: string; isActive?: boolean }, actor: Actor) {
    const old = await this.mustFindDepartment(id);
    const dept = await this.prisma.department.update({ where: { id }, data });
    await this.audit.log({ ...actor, action: 'DEPARTMENT_UPDATED', module: 'ORG', recordId: id, oldValue: old, newValue: data });
    return dept;
  }

  // ---------- Employees ----------
  async listEmployees(page = 1, pageSize = 25, departmentId?: string) {
    const where = departmentId ? { departmentId } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        orderBy: { employeeNo: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { department: true, branch: true, user: { select: { username: true, userRoles: { select: { role: { select: { name: true } } } } } } },
      }),
      this.prisma.employee.count({ where }),
    ]);
    return {
      items: items.map((e) => ({
        ...e,
        roles: e.user?.userRoles?.map((ur) => ur.role.name) ?? [],
        user: e.user ? { username: e.user.username } : null,
      })),
      total, page, pageSize,
    };
  }

  /**
   * Create an employee, optionally creating the linked login account in
   * the same transaction (A: Employee + login in one step).
   */
  async createEmployee(data: {
    employeeNo: string; fullName: string; email?: string; phone?: string; position?: string;
    departmentId?: string; branchId?: string;
    // login account (optional) — LOCAL validates the password here, AD delegates it to the directory
    username?: string; password?: string; roles?: RoleName[]; authSource?: 'LOCAL' | 'AD';
  }, actor: Actor) {
    const wantsLogin = !!data.username;
    const isAd = data.authSource === 'AD';
    if (wantsLogin && !isAd && !data.password) {
      throw new BadRequestException('Password is required for a local account');
    }
    if (wantsLogin && (!data.roles || data.roles.length === 0)) {
      throw new BadRequestException('Select at least one role for the login account');
    }
    if (wantsLogin) {
      const exists = await this.prisma.user.findUnique({ where: { username: data.username! } });
      if (exists) throw new ConflictException('Username already exists');
    }

    const employee = await this.prisma.$transaction(async (tx) => {
      let userId: string | undefined;
      if (wantsLogin) {
        const user = await tx.user.create({
          data: {
            username: data.username!,
            fullName: data.fullName,
            email: data.email,
            passwordHash: isAd ? AD_UNUSABLE_HASH : await bcrypt.hash(data.password!, 10),
            authSource: isAd ? 'AD' : 'LOCAL',
            userRoles: { create: (data.roles ?? []).map((name) => ({ role: { connect: { name } } })) },
          },
        });
        userId = user.id;
      }
      return tx.employee.create({
        data: {
          employeeNo: data.employeeNo,
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          position: data.position,
          departmentId: data.departmentId,
          branchId: data.branchId,
          userId,
        },
      });
    });

    await this.audit.log({
      ...actor, action: 'EMPLOYEE_CREATED', module: 'ORG', recordId: employee.id,
      newValue: { ...data, password: undefined },
    });
    return employee;
  }

  /**
   * Attach a login account to an existing employee (Edit modal).
   *
   * Two modes:
   * - `userId` given → link an EXISTING user account (e.g. one created on the
   *   Users page) — the missing half of the Link-User CRUD.
   * - otherwise create a NEW account (username/password/authSource required).
   */
  async linkLogin(id: string, data: { userId?: string; username?: string; password?: string; roles?: RoleName[]; authSource?: 'LOCAL' | 'AD' }, actor: Actor) {
    const employee = await this.prisma.employee.findUnique({ where: { id }, include: { user: true } });
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.user) throw new ConflictException('Employee already has a login account');

    // ---- mode A: link an existing user ----
    if (data.userId) {
      if (data.username) throw new BadRequestException('Pick either an existing user or a new username, not both');
      const target = await this.prisma.user.findUnique({ where: { id: data.userId }, include: { employee: true } });
      if (!target) throw new NotFoundException('User not found');
      if (target.employee) throw new ConflictException(`User "${target.username}" is already linked to employee ${target.employee.employeeNo}`);
      await this.prisma.employee.update({ where: { id }, data: { userId: target.id } });
      await this.audit.log({
        ...actor, action: 'EMPLOYEE_LOGIN_LINKED', module: 'ORG', recordId: id,
        newValue: { linkedUserId: target.id, username: target.username, existing: true },
      });
      return this.employeeRoles(id);
    }

    // ---- mode B: create a new account and link it ----
    const username = data.username ?? '';
    if (username.length < 3) throw new BadRequestException('Username is required');
    if (!data.roles || data.roles.length === 0) {
      throw new BadRequestException('Select at least one role');
    }
    const isAd = data.authSource === 'AD';
    if (!isAd && !data.password) {
      throw new BadRequestException('Password is required for a local account');
    }
    const exists = await this.prisma.user.findUnique({ where: { username } });
    if (exists) throw new ConflictException('Username already exists');

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username,
          fullName: employee.fullName,
          email: employee.email ?? undefined,
          passwordHash: isAd ? AD_UNUSABLE_HASH : await bcrypt.hash(data.password!, 10),
          authSource: isAd ? 'AD' : 'LOCAL',
          userRoles: { create: data.roles!.map((name) => ({ role: { connect: { name } } })) },
        },
      });
      await tx.employee.update({ where: { id }, data: { userId: user.id } });
    });

    await this.audit.log({
      ...actor, action: 'EMPLOYEE_LOGIN_LINKED', module: 'ORG', recordId: id,
      newValue: { username, roles: data.roles },
    });
    return this.employeeRoles(id);
  }

  /**
   * Remove the employee ↔ user link — the Link-User Delete (un CRUD မပါတဲ့ အပိုင်း).
   * The login account itself is NOT deleted (it may hold workflow history);
   * it simply becomes a standalone account on the Users page.
   */
  async unlinkLogin(id: string, actor: Actor) {
    const employee = await this.prisma.employee.findUnique({ where: { id }, include: { user: true } });
    if (!employee) throw new NotFoundException('Employee not found');
    if (!employee.user) throw new BadRequestException('This employee has no linked login account');
    const username = employee.user.username;
    const userId = employee.user.id;
    await this.prisma.employee.update({ where: { id }, data: { userId: null } });
    await this.audit.log({
      ...actor, action: 'EMPLOYEE_LOGIN_UNLINKED', module: 'ORG', recordId: id,
      oldValue: { userId, username },
      newValue: { username },
    });
    return { success: true, username };
  }

  /** Read the linked user's roles (for the Employee page role column). */
  async employeeRoles(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: { user: { include: { userRoles: { select: { role: { select: { name: true } } } } } } },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return { employeeId: id, username: employee.user?.username, roles: employee.user?.userRoles.map((ur) => ur.role.name) ?? [] };
  }

  /** Replace the linked user's roles (role chips on the Employee page). */
  async setEmployeeRoles(id: string, roles: RoleName[], actor: Actor) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: { user: { include: { userRoles: { select: { role: { select: { name: true } } } } } } },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    if (!employee.user) throw new BadRequestException('This employee has no login account');

    const oldRoles = employee.user.userRoles.map((ur) => ur.role.name);
    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId: employee.user.id } }),
      ...roles.map((name) =>
        this.prisma.userRole.create({
          data: { user: { connect: { id: employee.user!.id } }, role: { connect: { name } } },
        })),
    ]);
    await this.audit.log({
      ...actor, action: 'EMPLOYEE_ROLES_UPDATED', module: 'ORG', recordId: id,
      oldValue: { roles: oldRoles },
      newValue: { roles },
    });
    return this.employeeRoles(id);
  }

  async updateEmployee(id: string, data: {
    fullName?: string; email?: string; phone?: string; position?: string;
    departmentId?: string; branchId?: string; status?: 'ACTIVE' | 'INACTIVE';
  }, actor: Actor) {
    const old = await this.mustFindEmployee(id);
    // keep the linked account's name/email in sync with the employee master record
    const sync: { fullName?: string; email?: string | null } = {};
    if (data.fullName && data.fullName !== old.fullName) sync.fullName = data.fullName;
    if (data.email !== undefined && data.email !== old.email) sync.email = data.email || null;
    const employee = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({ where: { id }, data });
      if (updated.userId && Object.keys(sync).length > 0) {
        await tx.user.update({ where: { id: updated.userId }, data: sync }).catch(() => undefined);
      }
      return updated;
    });
    await this.audit.log({ ...actor, action: 'EMPLOYEE_UPDATED', module: 'ORG', recordId: id, oldValue: old, newValue: data });
    return employee;
  }

  // ---------- Deletes (with referential-integrity protection) ----------

  async deleteBranch(id: string, actor: Actor) {
    const branch = await this.mustFindBranch(id);
    const [depts, employees] = await Promise.all([
      this.prisma.department.count({ where: { branchId: id } }),
      this.prisma.employee.count({ where: { branchId: id } }),
    ]);
    if (depts > 0 || employees > 0) {
      throw new ConflictException(
        `Branch has ${depts} department(s) and ${employees} employee(s) — reassign or deactivate instead.`,
      );
    }
    await this.prisma.branch.delete({ where: { id } });
    await this.audit.log({ ...actor, action: 'BRANCH_DELETED', module: 'ORG', recordId: id, oldValue: { code: branch.code }, severity: 'WARNING' });
    return { success: true };
  }

  async deleteDepartment(id: string, actor: Actor) {
    const dept = await this.mustFindDepartment(id);
    const employees = await this.prisma.employee.count({ where: { departmentId: id } });
    const requests = await this.prisma.requestDocument.count({ where: { departmentId: id } });
    if (employees > 0 || requests > 0) {
      throw new ConflictException(
        `Department has ${employees} employee(s) and ${requests} request(s) — reassign or deactivate instead.`,
      );
    }
    await this.prisma.department.delete({ where: { id } });
    await this.audit.log({ ...actor, action: 'DEPARTMENT_DELETED', module: 'ORG', recordId: id, oldValue: { code: dept.code }, severity: 'WARNING' });
    return { success: true };
  }

  async deleteEmployee(id: string, actor: Actor) {
    const employee = await this.mustFindEmployee(id);
    const requests = employee.userId
      ? await this.prisma.requestDocument.count({ where: { requesterId: employee.userId } })
      : 0;
    const heads = await this.prisma.department.count({ where: { headEmployeeId: id } });
    if (requests > 0 || heads > 0) {
      throw new ConflictException(
        `Employee has ${requests} request(s) or heads ${heads} department(s) — set INACTIVE instead.`,
      );
    }
    await this.prisma.employee.delete({ where: { id } });
    await this.audit.log({ ...actor, action: 'EMPLOYEE_DELETED', module: 'ORG', recordId: id, oldValue: { employeeNo: employee.employeeNo }, severity: 'WARNING' });
    return { success: true };
  }

  // ---------- helpers ----------
  private async mustFindBranch(id: string) {
    const b = await this.prisma.branch.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Branch not found');
    return b;
  }

  private async mustFindDepartment(id: string) {
    const d = await this.prisma.department.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Department not found');
    return d;
  }

  private async mustFindEmployee(id: string) {
    const e = await this.prisma.employee.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Employee not found');
    return e;
  }
}

export interface Actor {
  userId: string;
  username: string;
}
