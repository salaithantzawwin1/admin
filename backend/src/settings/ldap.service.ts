import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as ldap from 'ldapjs';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

export interface AdConfig {
  url: string;
  baseDn: string;
  bindDn: string;
  bindPassword: string;
  defaultRole: string;
  enabled: boolean;
}

const KEYS = ['ad.url', 'ad.baseDn', 'ad.bindDn', 'ad.bindPassword', 'ad.defaultRole', 'ad.enabled'] as const;

/** Unusable bcrypt hash — AD accounts never authenticate with a local password. */
const AD_UNUSABLE_HASH = '$2a$10$disabled$account$uses$ad$auth$0000000000000000000000';

@Injectable()
export class LdapService {
  constructor(private prisma: PrismaService) {}

  async getConfig(): Promise<AdConfig> {
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { in: [...KEYS] } } });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      url: map['ad.url'] ?? '',
      baseDn: map['ad.baseDn'] ?? '',
      bindDn: map['ad.bindDn'] ?? '',
      bindPassword: map['ad.bindPassword'] ?? '',
      defaultRole: map['ad.defaultRole'] ?? 'EMPLOYEE',
      enabled: map['ad.enabled'] === 'true',
    };
  }

  async setConfig(patch: Partial<AdConfig>) {
    const entries: [string, string | undefined][] = [
      ['ad.url', patch.url],
      ['ad.baseDn', patch.baseDn],
      ['ad.bindDn', patch.bindDn],
      ['ad.bindPassword', patch.bindPassword],
      ['ad.defaultRole', patch.defaultRole],
      ['ad.enabled', patch.enabled === undefined ? undefined : String(patch.enabled)],
    ];
    for (const [key, value] of entries) {
      if (value === undefined) continue;
      await this.prisma.systemSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    }
    return this.getConfig();
  }

  /** Try to bind as the service account — used by the Settings "Test connection" button. */
  async testConnection(cfg?: AdConfig): Promise<{ ok: boolean; error?: string }> {
    const config = cfg ?? (await this.getConfig());
    if (!config.url || !config.bindDn) return { ok: false, error: 'URL and bind DN are required' };
    return new Promise((resolve) => {
      const client = ldap.createClient({ url: config.url, timeout: 5000, connectTimeout: 5000 });
      client.bind(config.bindDn, config.bindPassword, (err) => {
        const ok = !err;
        const error = err?.message;
        client.destroy();
        resolve(ok ? { ok: true } : { ok: false, error });
      });
    });
  }

  /**
   * Authenticate a user against AD, then (on success) upsert the local
   * mirror user. AD is identity only — AMS roles decide authorization.
   */
  async authenticateAndProvision(username: string, password: string): Promise<{ username: string; fullName: string; email?: string } | null> {
    const cfg = await this.getConfig();
    if (!cfg.enabled || !cfg.url || !cfg.baseDn) return null;

    const bindAs = `${cfg.baseDn.split(',').length ? '' : ''}CN=${username},${cfg.baseDn}`;
    const auth = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const client = ldap.createClient({ url: cfg.url, timeout: 5000, connectTimeout: 5000 });
      client.bind(bindAs, password, (err) => {
        const ok = !err;
        const error = err?.message;
        client.destroy();
        resolve(ok ? { ok: true } : { ok: false, error });
      });
    });
    if (!auth.ok) throw new UnauthorizedException('Invalid credentials');

    // Pre-provisioned accounts (admin created them with department/role info)
    // already exist here — just log in. Unknown AD users get a bare mirror
    // with the default role; LOCAL accounts are never touched by AD login.
    const existing = await this.prisma.user.findUnique({ where: { username } });
    if (!existing) {
      const created = await this.prisma.user.create({
        data: {
          username,
          fullName: username, // refined below when attribute search is configured
          passwordHash: AD_UNUSABLE_HASH,
          authSource: 'AD',
        },
      });
      await this.prisma.userRole.create({
        data: {
          user: { connect: { id: created.id } },
          role: { connect: { name: cfg.defaultRole as RoleName } },
        },
      });
    }
    return { username, fullName: existing?.fullName ?? username };
  }
}
