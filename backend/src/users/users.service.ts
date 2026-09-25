import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { LoginThrottleService } from '../auth/login-throttle.service';
import { RoleName, UserStatus } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private audit: AuditService, private loginThrottle: LoginThrottleService) {}

  async list(page = 1, pageSize = 25) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        orderBy: { username: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, username: true, fullName: true, email: true, status: true,
          lastLoginAt: true, createdAt: true,
          telegramChatId: true, telegramUsername: true,
          userRoles: { select: { role: { select: { name: true } } } },
        },
      }),
      this.prisma.user.count(),
    ]);
    return {
      items: items.map((u) => ({
        ...u,
        roles: u.userRoles.map((ur) => ur.role.name),
        userRoles: undefined,
        telegram: { linked: Boolean(u.telegramChatId), username: u.telegramUsername },
        telegramChatId: undefined,
        // login lockout (Too Many Attempts) — seconds remaining, null = not locked
        lockedSeconds: this.loginThrottle.lockedSeconds(u.username),
      })),
      total, page, pageSize,
    };
  }

  /**
   * Administration unlock — lifts a login lockout (Too Many Attempts) before
   * its 15-minute timer expires. Also resets the failure counters so the very
   * next login attempt starts clean.
   */
  async unlock(id: string, actor: { userId: string; username: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    const cleared = this.loginThrottle.unlockByUsername(user.username);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'USER_UNLOCKED', module: 'USERS', recordId: id,
      newValue: { username: user.username, throttleEntriesCleared: cleared },
    });
    return { success: true, cleared };
  }

  /** Administration: force-unbind a user's Telegram chat (lost phone, re-assignment…). */
  async unbindTelegram(id: string, actor: { userId: string; username: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.telegramChatId && !user.telegramBindCode) {
      throw new BadRequestException('User has no Telegram binding to remove');
    }
    await this.prisma.user.update({
      where: { id },
      data: { telegramChatId: null, telegramBindCode: null, telegramUsername: null },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TELEGRAM_ADMIN_UNBIND', module: 'USERS', recordId: id,
      oldValue: { username: user.username, telegramUsername: user.telegramUsername },
    });
    return { success: true };
  }

  async create(data: { username: string; password: string; fullName: string; email?: string; roles: RoleName[] }, actor: { userId: string; username: string }) {
    const exists = await this.prisma.user.findUnique({ where: { username: data.username } });
    if (exists) throw new BadRequestException('Username already exists');

    const user = await this.prisma.user.create({
      data: {
        username: data.username,
        fullName: data.fullName,
        email: data.email,
        passwordHash: await bcrypt.hash(data.password, 10),
        userRoles: { create: data.roles.map((name) => ({ role: { connect: { name } } })) },
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'USER_CREATED', module: 'USERS', recordId: user.id,
      newValue: { username: user.username, roles: data.roles },
    });
    return { id: user.id, username: user.username };
  }

  async update(id: string, data: { fullName?: string; email?: string; roles?: RoleName[] }, actor: { userId: string; username: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id },
        data: { fullName: data.fullName, email: data.email },
      });
      if (data.roles) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        const roleRows = await tx.role.findMany({ where: { name: { in: data.roles } } });
        await tx.userRole.createMany({
          data: roleRows.map((r) => ({ userId: id, roleId: r.id })),
        });
      }
      return u;
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'USER_UPDATED', module: 'USERS', recordId: id,
      oldValue: { fullName: user.fullName, email: user.email },
      newValue: { fullName: updated.fullName, email: updated.email, roles: data.roles },
    });
    return { id: updated.id };
  }

  async setStatus(id: string, status: UserStatus, actor: { userId: string; username: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (user.id === actor.userId && status !== 'ACTIVE') {
      throw new BadRequestException('You cannot disable your own account');
    }
    await this.prisma.user.update({ where: { id }, data: { status } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: `USER_${status}`, module: 'USERS', recordId: id,
      oldValue: { status: user.status }, newValue: { status },
      severity: 'WARNING',
    });
    return { id, status };
  }

  async resetPassword(id: string, newPassword: string, actor: { userId: string; username: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'USER_PASSWORD_RESET', module: 'USERS', recordId: id,
      severity: 'WARNING',
    });
    return { success: true };
  }

  async remove(id: string, actor: { userId: string; username: string }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (user.id === actor.userId) throw new BadRequestException('You cannot delete your own account');

    // hard delete is only safe when the account has no workflow history;
    // otherwise require deactivation instead
    const hasHistory =
      (await this.prisma.approvalAction.count({ where: { approverId: id } })) > 0 ||
      (await this.prisma.requestDocument.count({ where: { requesterId: id } })) > 0;
    if (hasHistory) {
      throw new ConflictException(
        'This user has request/approval history — disable the account instead of deleting (audit integrity).',
      );
    }

    await this.prisma.user.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'USER_DELETED', module: 'USERS', recordId: id,
      oldValue: { username: user.username, fullName: user.fullName },
      severity: 'CRITICAL',
    });
    return { success: true };
  }
}
