import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { TelegramService } from '../telegram/telegram.service';
import { Actor } from '../org/org.service';

export interface TelegramConfig {
  /** masked for display — the real token never leaves the server */
  botToken: string;
  /** is a token stored at all (the UI cannot tell from the mask) */
  botTokenSet: boolean;
  enabled: boolean;
  webUrl: string;
}

const KEYS = ['telegram.bot_token', 'telegram.enabled', 'telegram.web_url'] as const;

/**
 * The bot token is a credential: anyone reading it can post as the bot. The API
 * returns only a hint of it, and a value that comes back still carrying the mask
 * is treated as "unchanged" — otherwise the Settings form would save its own
 * placeholder over the real token.
 */
const MASK_CHAR = '•';

function maskToken(token: string): string {
  if (!token) return '';
  return `${MASK_CHAR.repeat(8)}${token.slice(-4)}`;
}

const looksMasked = (value: string) => value.includes(MASK_CHAR);

/** Telegram bot configuration — same storage pattern as the AD/LDAP settings. */
@Injectable()
export class TelegramConfigService {
  constructor(private prisma: PrismaService, private audit: AuditService, private telegram: TelegramService) {}

  async getConfig(): Promise<TelegramConfig> {
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { in: [...KEYS] } } });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const token = map['telegram.bot_token'] ?? '';
    return {
      botToken: maskToken(token),
      botTokenSet: token !== '',
      enabled: map['telegram.enabled'] === 'true',
      webUrl: map['telegram.web_url'] ?? '',
    };
  }

  async setConfig(patch: Partial<TelegramConfig>, actor: Actor): Promise<TelegramConfig> {
    const before = await this.getConfig();
    const wanted = patch.botToken?.trim();
    // empty = keep what is stored; masked = the form echoing it back, not a secret
    const nextToken = wanted && !looksMasked(wanted) ? wanted : undefined;
    const entries: [string, string | undefined][] = [
      ['telegram.bot_token', nextToken],
      ['telegram.enabled', patch.enabled === undefined ? undefined : String(patch.enabled)],
      ['telegram.web_url', patch.webUrl === undefined ? undefined : patch.webUrl.trim()],
    ];
    for (const [key, value] of entries) {
      if (value === undefined) continue;
      await this.prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    // polling loop picks up the new config on its next cycle; also refresh immediately
    this.telegram.invalidateConfig();
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TELEGRAM_CONFIG_UPDATED', module: 'SETTINGS',
      oldValue: { enabled: before.enabled, tokenSet: before.botTokenSet, webUrl: before.webUrl },
      newValue: { enabled: patch.enabled ?? before.enabled, tokenSet: Boolean(nextToken) || before.botTokenSet, webUrl: patch.webUrl ?? before.webUrl },
    });
    return this.getConfig();
  }

  /** Pass-through for the Settings "Send test message" button. */
  sendTest(chatId: string) {
    return this.telegram.sendTest(chatId);
  }

  /** Telegram users who /start-ed the bot, waiting for approval. */
  listJoins(status?: string) {
    return this.telegram.listJoins(status);
  }

  /** Move an approved join's chat to a different user/driver (fix wrong assign). */
  reassignJoin(joinId: string, target: { userId?: string; driverId?: string }, actor: { userId: string; username: string }) {
    return this.telegram.reassignJoin(joinId, target, actor);
  }

  /** Approve a join draft — bind to the picked system user or driver. */
  approveJoin(joinId: string, target: { userId?: string; driverId?: string }, actor: { userId: string; username: string }) {
    return this.telegram.approveJoin(joinId, target, actor);
  }

  /** Bind-history timeline for one chat (Settings → Telegram Joins → History). */
  chatHistory(chatId: string) {
    return this.telegram.chatHistory(chatId);
  }

  /** Reject a join draft. */
  rejectJoin(joinId: string, actor: { userId: string; username: string }) {
    return this.telegram.rejectJoin(joinId, actor);
  }

  /** Release an approved chat from its holder (Settings → Telegram Joins → Unbind). */
  unbindJoinChat(joinId: string, actor: { userId: string; username: string }) {
    return this.telegram.unbindJoinChat(joinId, actor);
  }

  /** Permanently delete a join request (Settings → Telegram Joins → Delete). */
  deleteJoin(joinId: string, actor: { userId: string; username: string }) {
    return this.telegram.deleteJoin(joinId, actor);
  }
}
