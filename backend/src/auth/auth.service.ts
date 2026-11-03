import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { LdapService } from '../settings/ldap.service';
import { assertStrongPassword } from '../util/password-policy';

/** A bcrypt hash of a value nobody knows — compared when the user does not
 *  exist, so a missing account and a wrong password take the same time
 *  (no username enumeration by response time). */
const DUMMY_HASH = '$2a$10$at2wFn0PcsOFQR4gpooxNOUKr6qUdXOrz3y/t6G6Yv4BlxJ7AoN7W';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private audit: AuditService,
    private ldap: LdapService,
  ) {}

  async login(username: string, password: string, ip?: string, userAgent?: string) {
    let user = await this.prisma.user.findUnique({
      where: { username },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) await bcrypt.compare(password, DUMMY_HASH);
    let valid = !!(user && user.status === 'ACTIVE' && (await bcrypt.compare(password, user.passwordHash)));

    // AD fallback: when local check fails and AD is enabled, try directory
    // bind + auto-provision. AD is identity only; AMS roles authorize.
    if (!valid) {
      try {
        const ad = await this.ldap.authenticateAndProvision(username, password);
        if (ad) {
          user = await this.prisma.user.findUnique({
            where: { username },
            include: { userRoles: { include: { role: true } } },
          });
          valid = !!user && user.status === 'ACTIVE';
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err; // explicit AD rejection
        // connection/config errors fall through to generic failure
      }
    }

    if (!valid) {
      await this.audit.log({
        action: 'LOGIN_FAILED',
        module: 'AUTH',
        username,
        ipAddress: ip,
        userAgent,
        severity: 'WARNING',
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const u = user!;
    const roles = u.userRoles.map((ur) => ur.role);
    const payload = { sub: u.id, username: u.username, roles: roles.map((r) => r.name) };
    const accessToken = await this.jwt.signAsync(payload);

    await this.prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({
      userId: u.id,
      username: u.username,
      action: 'LOGIN_SUCCESS',
      module: 'AUTH',
      ipAddress: ip,
      userAgent,
    });

    return {
      accessToken,
      user: {
        id: u.id,
        username: u.username,
        fullName: u.fullName,
        roles: roles.map((r) => r.name),
      },
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    assertStrongPassword(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 10),
        // ends every session opened before this moment (jwt.strategy)
        passwordChangedAt: new Date(),
      },
    });
    await this.audit.log({
      userId,
      username: user.username,
      action: 'PASSWORD_CHANGED',
      module: 'AUTH',
      severity: 'WARNING',
    });
    return { success: true };
  }

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        lastLoginAt: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    return {
      ...user,
      roles: user?.userRoles?.map((ur) => ur.role.name) ?? [],
      userRoles: undefined,
    };
  }
}
