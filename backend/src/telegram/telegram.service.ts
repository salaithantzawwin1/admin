import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';

/**
 * Telegram driver-notification bot (Plan: Car assignment → Noted/Arrived/Back flow).
 *
 * Uses the raw Bot API over HTTPS (no client dependency): sendMessage with an
 * inline keyboard whose buttons advance through the ack stages. Runs on
 * long-polling (getUpdates) because this server sits on a LAN without public
 * HTTPS, so webhooks are not an option.
 *
 * Every entry point is a silent no-op when the bot token is unset or the
 * feature is disabled — assignment flows must never fail because of Telegram.
 */

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

const KEY_TOKEN = 'telegram.bot_token';
const KEY_ENABLED = 'telegram.enabled';
const KEY_WEB_URL = 'telegram.web_url';

/** Days a bind code stays valid before it must be regenerated. */
const BIND_CODE_TTL_MS = 7 * 24 * 3600 * 1000;

/** Any chat may hold at most one binding — a user code wins over a stale driver link. */
const CODE_PREFIXES = ['USR-', 'DRV-'] as const;

/** Long-poll timeout passed to getUpdates (seconds). */
const POLL_TIMEOUT_S = 30;

/** Re-check settings/config at most this often while polling. */
const CONFIG_REFRESH_MS = 60_000;

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { id: number; username?: string; first_name?: string } };
  callback_query?: { id: string; data?: string; from?: { id: number }; message?: { chat: { id: number }; message_id: number } };
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  /** Wired by TelegramModule after both services exist (avoids constructor cycle). */
  approvals?: { handleAction(data: string, chatId: string, callbackId: string): Promise<boolean> };
  /** Slash-command surface (wired by CarsModule) — returns true when the text was handled. */
  commands?: { handleText(text: string, chatId: string): Promise<boolean> };
  /** Reject-reason conversation state + handler (wired by CarsModule). */
  rejects?: {
    handleText(text: string, chatId: string): Promise<void>;
    /** true while this chat owes a rejection reason (next text = the reason). */
    hasPending(chatId: string): boolean;
  };
  private polling = false;
  private loop: Promise<void> | null = null;
  private lastConfigCheck = 0;
  private cachedToken: string | null = null;
  private cachedEnabled = false;

  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async onModuleInit() {
    this.polling = true;
    this.loop = this.pollLoop();
  }

  async onModuleDestroy() {
    this.polling = false;
    await this.loop?.catch(() => undefined);
  }

  /** Bot config — token from system_settings (Settings → Telegram tab), feature flag. */
  private async config(): Promise<{ token: string | null; enabled: boolean }> {
    const now = Date.now();
    if (now - this.lastConfigCheck > CONFIG_REFRESH_MS) {
      try {
        const rows = await this.prisma.systemSetting.findMany({
          where: { key: { in: [KEY_TOKEN, KEY_ENABLED] } },
        });
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        this.cachedToken = map[KEY_TOKEN] || null;
        this.cachedEnabled = map[KEY_ENABLED] === 'true';
        this.lastConfigCheck = now;
      } catch {
        /* DB hiccup — keep last known config */
      }
    }
    return { token: this.cachedToken, enabled: this.cachedEnabled };
  }

  /** Invalidate the cached config so a Settings save takes effect immediately. */
  invalidateConfig() {
    this.lastConfigCheck = 0;
  }

  private async call<T = unknown>(method: string, payload?: Record<string, unknown>): Promise<T | null> {
    const { token, enabled } = await this.config();
    if (!token || !enabled) return null;
    try {
      const res = await fetch(API(token, method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!json.ok) {
        this.logger.warn(`Telegram ${method} failed: ${json.description ?? res.status}`);
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      this.logger.warn(`Telegram ${method} error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Exposed for the Settings "Send test message" button (fails loudly with reason). */
  async sendTest(chatId: string): Promise<{ ok: boolean; error?: string }> {
    const { token, enabled } = await this.config();
    if (!token) return { ok: false, error: 'Bot token is not set' };
    if (!enabled) return { ok: false, error: 'Telegram integration is disabled' };
    try {
      const res = await fetch(API(token, 'sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: '✅ AMS test message — Telegram integration is working.' }),
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      return json.ok ? { ok: true } : { ok: false, error: json.description ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------- polling

  private async pollLoop() {
    let offset = 0;
    while (this.polling) {
      try {
        const { token, enabled } = await this.config();
        if (!token || !enabled) {
          await sleep(15_000);
          continue;
        }
        const updates = await this.call<TgUpdate[]>('getUpdates', {
          timeout: POLL_TIMEOUT_S,
          offset,
          allowed_updates: ['message', 'callback_query'],
        });
        if (Array.isArray(updates)) {
          for (const u of updates) {
            offset = Math.max(offset, u.update_id + 1);
            await this.handleUpdate(u).catch((err) => this.logger.warn(`update handling failed: ${(err as Error).message}`));
          }
        }
      } catch (err) {
        this.logger.warn(`poll error: ${(err as Error).message}`);
        await sleep(5_000);
      }
    }
  }

  private async handleUpdate(u: TgUpdate) {
    if (u.callback_query?.data && u.callback_query.from?.id) {
      const chatId = String(u.callback_query.message?.chat?.id ?? u.callback_query.from.id);
      if (u.callback_query.message?.message_id) {
        this.callbackMessages.set(`${chatId}:${u.callback_query.id}`, u.callback_query.message.message_id);
        if (this.callbackMessages.size > 500) this.callbackMessages.clear(); // bounded
      }
      // Telegram-approval flow (wfa:*) first — driver acks and others fall through
      if (u.callback_query.data.startsWith('wfa:')) {
        await this.approvals?.handleAction(u.callback_query.data, String(u.callback_query.from.id), u.callback_query.id).catch(() => undefined);
        return;
      }
      await this.handleCallback(u.callback_query.data, String(u.callback_query.from.id), u.callback_query.id);
      return;
    }
    const text = u.message?.text?.trim();
    const chatId = u.message?.chat?.id != null ? String(u.message.chat.id) : null;
    if (!text || !chatId) return;
    this.logger.log(`TG text update from ${chatId}: "${text}"`);
    // an in-progress reject conversation — the next text IS the reason (or /cancel aborts).
    // Any OTHER slash command aborts the conversation first, then runs normally
    // (so /assign etc. are never swallowed as a "reason").
    if (this.rejects?.hasPending(chatId)) {
      if (text === '/cancel' || !text.startsWith('/')) {
        await this.rejects.handleText(text, chatId).catch(() => undefined);
        return;
      }
      await this.rejects.handleText('/cancel', chatId).catch(() => undefined);
    }
    // slash commands (except /start — the bind/join flow owns it)
    if (text.startsWith('/') && !text.startsWith('/start')) {
      const handled = await this.commands
        ?.handleText(text, chatId)
        .catch((err) => {
          this.logger.warn(`TG command handler error for "${text}": ${(err as Error).message}`);
          return false;
        });
      if (!handled) this.logger.warn(`TG command NOT handled: "${text}" (hook: ${this.commands ? 'wired' : 'MISSING'})`);
      return;
    }
    if (!text.startsWith('/start')) return;
    const code = text.replace('/start', '').trim();
    if (code) {
      await this.handleBind(code, chatId, u.message?.from?.username, u.message?.from?.first_name);
      return;
    }
    // plain /start: register the chat as a PENDING join draft for admin approval
    const tgUsername = u.message?.from?.username ?? null;
    const displayName = u.message?.from?.first_name ?? null;
    const alreadyUser = await this.prisma.user.findFirst({ where: { telegramChatId: chatId } });
    const alreadyDriver = await this.prisma.driver.findFirst({ where: { telegramChatId: chatId } });
    if (alreadyUser || alreadyDriver) {
      const name = alreadyUser?.fullName ?? alreadyDriver?.name;
      await this.call('sendMessage', { chat_id: chatId, text: `✅ You are already linked as ${escapeHtml(name ?? 'a registered account')}.` });
      return;
    }
    await this.prisma.telegramJoinRequest.upsert({
      where: { chatId },
      create: { chatId, tgUsername, displayName },
      update: { tgUsername, displayName, status: 'PENDING', boundUserId: null, boundDriverId: null, decidedById: null, decidedAt: null },
    });
    await this.call('sendMessage', {
      chat_id: chatId,
      text: '👋 Welcome! Your request to join AMS notifications has been recorded and is waiting for Administration approval. You will receive a confirmation here once it is approved.',
    });
    await this.audit.log({ action: 'TELEGRAM_JOIN_REQUESTED', module: 'SETTINGS', recordId: chatId, newValue: { tgUsername, displayName } });
    // admin pings are best-effort and never block the user's /start reply
    this.notifyAdminsOfJoin(displayName, tgUsername, chatId).catch(() => undefined);
  }

  /** Tell Administration + sysadmins a new join draft is waiting (in-app + Telegram mirror). */
  private async notifyAdminsOfJoin(displayName: string | null, tgUsername: string | null, chatId: string) {
    try {
      const admins = await this.prisma.userRole.findMany({
        where: { role: { name: { in: ['ADMINISTRATION', 'SYSTEM_ADMIN'] } }, user: { status: 'ACTIVE' } },
        select: { userId: true },
      });
      const userIds = [...new Set(admins.map((r) => r.userId))];
      const who = [displayName, tgUsername ? `@${tgUsername}` : null].filter(Boolean).join(' · ') || chatId;
      const title = `📨 Telegram join request — ${who}`;
      const body = `"${displayName ?? chatId}"${tgUsername ? ` (@${tgUsername})` : ''} sent /start to the bot and is waiting for approval. Open Settings → Telegram Joins to link them to a system user or driver.`;
      const link = '/settings?tab=joins';
      if (userIds.length) {
        await this.prisma.notification.createMany({
          data: userIds.map((userId) => ({ userId, type: 'TELEGRAM_JOIN_REQUESTED' as const, title, body, link })),
        });
        for (const userId of userIds) {
          await this.mirrorToUser(userId, title, body, link).catch(() => undefined);
        }
      }
    } catch (e) {
      this.logger.warn(`join notification failed: ${(e as Error).message}`);
    }
  }

  /** Administration: join drafts — by default PENDING; pass status=ALL for everything. */
  async listJoins(status = 'PENDING') {
    const rows = await this.prisma.telegramJoinRequest.findMany({
      where: status && status !== 'ALL' ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // enrich approved rows with the LIVE binding state (an admin may have moved
    // the chat to another account afterwards — surface the drift)
    const users = await this.prisma.user.findMany({
      where: { telegramChatId: { not: null } },
      select: { id: true, username: true, fullName: true, telegramChatId: true, telegramUsername: true },
    });
    const drivers = await this.prisma.driver.findMany({
      where: { telegramChatId: { not: null } },
      select: { id: true, name: true, telegramChatId: true, telegramUsername: true },
    });
    return rows.map((j) => {
      const boundUser = users.find((u) => u.telegramChatId === j.chatId);
      const boundDriver = drivers.find((d) => d.telegramChatId === j.chatId);
      return {
        ...j,
        bound: boundUser
          ? { kind: 'user' as const, id: boundUser.id, name: `${boundUser.fullName} (${boundUser.username})`, telegramUsername: boundUser.telegramUsername }
          : boundDriver
            ? { kind: 'driver' as const, id: boundDriver.id, name: boundDriver.name, telegramUsername: boundDriver.telegramUsername }
            : null,
      };
    });
  }

  /**
   * Bind-history timeline for one Telegram chat — every join / bind / re-assign /
   * unbind / reject event recorded in the audit log, resolved to human labels.
   */
  async chatHistory(chatId: string) {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        action: {
          in: [
            'TELEGRAM_JOIN_REQUESTED', 'TELEGRAM_JOIN_APPROVED', 'TELEGRAM_JOIN_REJECTED',
            'TELEGRAM_JOIN_REASSIGNED', 'TELEGRAM_USER_BOUND', 'TELEGRAM_DRIVER_BOUND',
            'TELEGRAM_ADMIN_UNBIND',
          ],
        },
        OR: [{ recordId: chatId }, { newValue: { path: ['chatId'], equals: chatId } }, { oldValue: { path: ['chatId'], equals: chatId } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return logs.map((l) => {
      const nv = (l.newValue ?? {}) as Record<string, unknown>;
      const ov = (l.oldValue ?? {}) as Record<string, unknown>;
      let label = l.action;
      let account: string | null = null;
      if (l.action === 'TELEGRAM_JOIN_REQUESTED') {
        label = 'Joined the bot (/start) — draft request';
      } else if (l.action === 'TELEGRAM_JOIN_APPROVED') {
        account = (nv.boundUser as string) ?? (nv.boundDriver as string) ?? null;
        label = 'Approved & linked';
      } else if (l.action === 'TELEGRAM_JOIN_REASSIGNED') {
        account = (nv.boundUser as string) ?? (nv.boundDriver as string) ?? null;
        label = typeof ov.holder === 'string' && ov.holder ? `Re-assigned (was ${ov.holder})` : 'Re-assigned';
      } else if (l.action === 'TELEGRAM_JOIN_REJECTED') {
        label = 'Join request rejected';
      } else if (l.action === 'TELEGRAM_USER_BOUND') {
        account = typeof l.username === 'string' ? l.username : null;
        label = 'Linked via /start code (self bind)';
      } else if (l.action === 'TELEGRAM_DRIVER_BOUND') {
        account = (nv.driver as string) ?? null;
        label = 'Linked via /start code (driver)';
      } else if (l.action === 'TELEGRAM_ADMIN_UNBIND') {
        label = 'Unlinked by Administration';
      }
      return { at: l.createdAt, action: l.action, label, account, by: l.username ?? 'system' };
    });
  }

  /**
   * Administration: move an APPROVED join's chat to a different system user or
   * driver (fixing a wrong "assign" — users mis-pick all the time).
   * The previous holder loses the chat atomically; both sides get a Telegram notice.
   */
  async reassignJoin(joinId: string, target: { userId?: string; driverId?: string }, actor: { userId: string; username: string }) {
    const join = await this.prisma.telegramJoinRequest.findUnique({ where: { id: joinId } });
    if (!join) throw new Error('Join request not found');
    if (join.status !== 'APPROVED') throw new Error('Only approved joins can be re-assigned');
    if (!target.userId === !target.driverId) throw new Error('Pick exactly one system user or driver');

    const prevUser = await this.prisma.user.findFirst({ where: { telegramChatId: join.chatId } });
    const prevDriver = prevUser ? null : await this.prisma.driver.findFirst({ where: { telegramChatId: join.chatId } });
    const prevLabel = prevUser ? `${prevUser.fullName} (${prevUser.username})` : prevDriver?.name;

    if (target.userId) {
      const user = await this.prisma.user.findUnique({ where: { id: target.userId } });
      if (!user) throw new Error('User not found');
      const clash = await this.prisma.user.findFirst({ where: { telegramChatId: join.chatId, id: { not: user.id } } });
      if (clash && clash.id !== prevUser?.id) {
        throw new Error(`This chat is already linked to user "${clash.fullName}" — unbind first`);
      }
      if (prevUser?.id === user.id) throw new Error('Already linked to that user — pick a different account');
      await this.prisma.$transaction([
        // strip the chat from the previous holder (user or driver) in the same transaction
        ...(prevUser ? [this.prisma.user.update({ where: { id: prevUser.id }, data: { telegramChatId: null, telegramUsername: null } })] : []),
        ...(prevDriver ? [this.prisma.driver.update({ where: { id: prevDriver.id }, data: { telegramChatId: null, telegramUsername: null } })] : []),
        this.prisma.user.update({ where: { id: user.id }, data: { telegramChatId: join.chatId, telegramUsername: join.tgUsername } }),
        this.prisma.telegramJoinRequest.update({
          where: { id: joinId },
          data: { boundUserId: user.id, boundDriverId: null, decidedById: actor.userId, decidedAt: new Date() },
        }),
      ]);
      // politely tell the previous holder they were moved
      if (prevUser || prevDriver) {
        await this.call('sendMessage', {
          chat_id: join.chatId,
          text: `ℹ️ This chat is now linked to ${escapeHtml(user.fullName)} (previously ${escapeHtml(prevLabel ?? 'another account')}).`,
        }).catch(() => undefined);
      }
      await this.audit.log({
        userId: actor.userId, username: actor.username,
        action: 'TELEGRAM_JOIN_REASSIGNED', module: 'SETTINGS', recordId: joinId,
        oldValue: { chatId: join.chatId, holder: prevLabel },
        newValue: { chatId: join.chatId, boundUserId: user.id, boundUser: user.username },
      });
      return { ok: true, moved: prevLabel ?? null, to: user.fullName };
    }

    const driver = await this.prisma.driver.findUnique({ where: { id: target.driverId! } });
    if (!driver) throw new Error('Driver not found');
    if (driver.telegramChatId && driver.telegramChatId !== join.chatId) {
      throw new Error(`Driver ${driver.name} is already linked to another chat — unbind or re-link that one first`);
    }
    if (prevDriver?.id === driver.id) throw new Error('Already linked to that driver — pick a different driver');
    await this.prisma.$transaction([
      ...(prevUser ? [this.prisma.user.update({ where: { id: prevUser.id }, data: { telegramChatId: null, telegramUsername: null } })] : []),
      ...(prevDriver ? [this.prisma.driver.update({ where: { id: prevDriver.id }, data: { telegramChatId: null, telegramUsername: null } })] : []),
      this.prisma.driver.update({ where: { id: driver.id }, data: { telegramChatId: join.chatId, telegramUsername: join.tgUsername } }),
      this.prisma.telegramJoinRequest.update({
        where: { id: joinId },
        data: { boundDriverId: driver.id, boundUserId: null, decidedById: actor.userId, decidedAt: new Date() },
      }),
    ]);
    if (prevUser || prevDriver) {
      await this.call('sendMessage', {
        chat_id: join.chatId,
        text: `ℹ️ This chat is now linked to driver ${escapeHtml(driver.name)} (previously ${escapeHtml(prevLabel ?? 'another account')}).`,
      }).catch(() => undefined);
    }
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TELEGRAM_JOIN_REASSIGNED', module: 'SETTINGS', recordId: joinId,
      oldValue: { chatId: join.chatId, holder: prevLabel },
      newValue: { chatId: join.chatId, boundDriverId: driver.id, boundDriver: driver.name },
    });
    // the newly linked driver may already hold an active assignment
    await this.resendActiveAssignments(driver.id);
    return { ok: true, moved: prevLabel ?? null, to: driver.name };
  }

  /** Administration: approve a join draft and bind it to the chosen AMS user or driver. */
  async approveJoin(joinId: string, target: { userId?: string; driverId?: string }, actor: { userId: string; username: string }) {
    const join = await this.prisma.telegramJoinRequest.findUnique({ where: { id: joinId } });
    if (!join) throw new Error('Join request not found');
    if (join.status !== 'PENDING') throw new Error(`Join request already ${join.status.toLowerCase()}`);
    if (!target.userId === !target.driverId) throw new Error('Pick exactly one system user or driver');

    if (target.userId) {
      const user = await this.prisma.user.findUnique({ where: { id: target.userId } });
      if (!user) throw new Error('User not found');
      const clash = await this.prisma.user.findFirst({ where: { telegramChatId: join.chatId, id: { not: user.id } } });
      if (clash) throw new Error(`This Telegram account is already linked to user "${clash.fullName}" — unbind first`);
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: { telegramChatId: join.chatId, telegramUsername: join.tgUsername },
        }),
        this.prisma.telegramJoinRequest.update({
          where: { id: joinId },
          data: { status: 'APPROVED', boundUserId: user.id, decidedById: actor.userId, decidedAt: new Date() },
        }),
      ]);
      await this.call('sendMessage', {
        chat_id: join.chatId,
        text: `✅ Approved! You are now linked to AMS as ${escapeHtml(user.fullName)}. Notifications will arrive here.`,
      });
      await this.audit.log({
        userId: actor.userId, username: actor.username,
        action: 'TELEGRAM_JOIN_APPROVED', module: 'SETTINGS', recordId: joinId,
        newValue: { chatId: join.chatId, boundUserId: user.id, boundUser: user.username },
      });
      return { ok: true };
    }
    const driver = await this.prisma.driver.findUnique({ where: { id: target.driverId! } });
    if (!driver) throw new Error('Driver not found');
    if (driver.telegramChatId && driver.telegramChatId !== join.chatId) {
      throw new Error(`Driver ${driver.name} is already linked to another chat — regenerate the bind code or unbind first`);
    }
    await this.prisma.$transaction([
      this.prisma.driver.update({
        where: { id: driver.id },
        data: { telegramChatId: join.chatId, telegramUsername: join.tgUsername },
      }),
      this.prisma.telegramJoinRequest.update({
        where: { id: joinId },
        data: { status: 'APPROVED', boundDriverId: driver.id, decidedById: actor.userId, decidedAt: new Date() },
      }),
    ]);      await this.call('sendMessage', {
        chat_id: join.chatId,
        text: `✅ Approved! You are now linked to AMS as driver ${escapeHtml(driver.name)}. Car assignments will arrive here.`,
      });
      // deliver any trip already assigned to this driver before they were linked
      await this.resendActiveAssignments(driver.id);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TELEGRAM_JOIN_APPROVED', module: 'SETTINGS', recordId: joinId,
      newValue: { chatId: join.chatId, boundDriverId: driver.id, boundDriver: driver.name },
    });
    return { ok: true };
  }

  /** Administration: reject a join draft. */
  async rejectJoin(joinId: string, actor: { userId: string; username: string }) {
    const join = await this.prisma.telegramJoinRequest.findUnique({ where: { id: joinId } });
    if (!join) throw new Error('Join request not found');
    if (join.status !== 'PENDING') throw new Error(`Join request already ${join.status.toLowerCase()}`);
    await this.prisma.telegramJoinRequest.update({
      where: { id: joinId },
      data: { status: 'REJECTED', decidedById: actor.userId, decidedAt: new Date() },
    });
    await this.call('sendMessage', {
      chat_id: join.chatId,
      text: '❌ Your join request was not approved. Contact Administration if you believe this is a mistake — then send /start again.',
    }).catch(() => undefined);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TELEGRAM_JOIN_REJECTED', module: 'SETTINGS', recordId: joinId,
      oldValue: { chatId: join.chatId },
    });
    return { ok: true };
  }

  /** Bind a chat via /start <code> — USR- codes link a system user, DRV- codes a driver. */
  private async handleBind(rawCode: string, chatId: string, tgUsername?: string, displayName?: string) {
    const norm = rawCode.toUpperCase();
    const prefix = norm.slice(0, 4);
    if (!CODE_PREFIXES.some((p) => prefix === p)) {
      await this.call('sendMessage', { chat_id: chatId, text: '❌ Invalid bind code. Use the code shown in AMS (Profile → Telegram or Fleet → Drivers).' });
      return;
    }
    if (prefix === 'USR-') {
      const user = await this.prisma.user.findFirst({ where: { telegramBindCode: { startsWith: norm } } });
      // consume any pending join draft — the code flow supersedes it
      await this.prisma.telegramJoinRequest.updateMany({
        where: { chatId, status: 'PENDING' },
        data: { status: 'SUPERSEDED', displayName: displayName ?? null, tgUsername: tgUsername ?? null },
      });
      if (!user || !user.telegramBindCode) {
        await this.call('sendMessage', { chat_id: chatId, text: '❌ Invalid or expired code. Generate a new one in AMS (My Profile → Telegram).' });
        return;
      }
      if (Date.now() - this.codeCreatedAt(user.telegramBindCode) > BIND_CODE_TTL_MS) {
        await this.call('sendMessage', { chat_id: chatId, text: '❌ This code has expired. Generate a new one in AMS (My Profile → Telegram).' });
        return;
      }
      const clash = await this.prisma.user.findFirst({ where: { telegramChatId: chatId, id: { not: user.id } } });
      if (clash) {
        await this.call('sendMessage', {
          chat_id: chatId,
          text: `⚠️ This Telegram account is already linked to user “${clash.fullName}”. Unbind it there first.`,
        });
        return;
      }
      await this.prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: chatId, telegramBindCode: null, telegramUsername: tgUsername ?? null },
      });
      await this.call('sendMessage', {
        chat_id: chatId,
        text: `✅ Linked! You will now receive AMS notifications (approvals, assignments, alerts) for *${escapeMarkdown(user.fullName)}*.`,
        parse_mode: 'MarkdownV2',
      }).catch(() =>
        this.call('sendMessage', { chat_id: chatId, text: `✅ Linked! You will now receive AMS notifications (approvals, assignments, alerts) for ${user.fullName}.` }),
      );
      await this.audit.log({
        action: 'TELEGRAM_USER_BOUND', module: 'AUTH', recordId: user.id,
        username: user.username, newValue: { telegramUsername: tgUsername ?? null, chatId },
      });
      return;
    }
    // DRV- code: link a driver
    const driver = await this.prisma.driver.findFirst({ where: { telegramBindCode: { startsWith: norm } } });
    await this.prisma.telegramJoinRequest.updateMany({
      where: { chatId, status: 'PENDING' },
      data: { status: 'SUPERSEDED', displayName: displayName ?? null, tgUsername: tgUsername ?? null },
    });
    if (!driver || !driver.telegramBindCode) {
      await this.call('sendMessage', { chat_id: chatId, text: '❌ Invalid or expired bind code. Ask Administration for a new code.' });
      return;
    }
    if (Date.now() - this.codeCreatedAt(driver.telegramBindCode) > BIND_CODE_TTL_MS) {
      await this.call('sendMessage', { chat_id: chatId, text: '❌ This bind code has expired. Ask Administration to regenerate it.' });
      return;
    }
    if (driver.telegramChatId && driver.telegramChatId !== chatId) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: '⚠️ This driver account is already linked to another Telegram chat. Ask Administration to regenerate the code.',
      });
      return;
    }
    await this.prisma.driver.update({
      where: { id: driver.id },
      data: { telegramChatId: chatId, telegramBindCode: null, telegramUsername: tgUsername ?? null },
    });
    await this.audit.log({
      action: 'TELEGRAM_DRIVER_BOUND', module: 'FLEET', recordId: driver.id,
      newValue: { chatId, driver: driver.name, telegramUsername: tgUsername ?? null },
    });
    // the driver may already hold an active assignment (assigned before linking)
    await this.resendActiveAssignments(driver.id);
    await this.call('sendMessage', {
      chat_id: chatId,
      text: `✅ Linked! You are now registered as driver *${escapeMarkdown(driver.name)}*.\nYou will receive car assignments here.`,
      parse_mode: 'MarkdownV2',
    }).catch(() =>
      // Markdown escaping edge cases should never lose the confirmation
      this.call('sendMessage', { chat_id: chatId, text: `✅ Linked! You are now registered as driver ${driver.name}.\nYou will receive car assignments here.` }),
    );
  }

  private codeCreatedAt(code: string): number {
    // Codes are `<PREFIX>-<base36 timestamp>-<rand>` — timestamp is embedded on generation
    const parts = code.split('-');
    const ts = Number.parseInt(parts[1] ?? '', 36);
    return Number.isFinite(ts) ? ts : 0;
  }

  /** Generate a bind code for a system user (self-service, Profile → Telegram). */
  async regenerateUserBindCode(userId: string) {
    const code = `USR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    await this.prisma.user.update({ where: { id: userId }, data: { telegramBindCode: code } });
    return code;
  }

  /** Binding state for the Profile UI. */
  async userBinding(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true, telegramBindCode: true, telegramUsername: true },
    });
    return {
      telegramChatId: user?.telegramChatId ?? null,
      telegramBindCode: user?.telegramBindCode ?? null,
      telegramUsername: user?.telegramUsername ?? null,
    };
  }

  /** Unbind a user's chat (self-service or admin). */
  async unbindUser(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: null, telegramBindCode: null, telegramUsername: null },
    });
  }

  /**
   * Administration: release an approved chat from its holder (user or driver).
   * The chat itself is told what happened; the join row flips back to PENDING so
   * the same Telegram account can be re-linked (or the person re-/starts).
   */
  async unbindJoinChat(joinId: string, actor: { userId: string; username: string }) {
    const join = await this.prisma.telegramJoinRequest.findUnique({ where: { id: joinId } });
    if (!join) throw new Error('Join request not found');
    const prevUser = await this.prisma.user.findFirst({ where: { telegramChatId: join.chatId } });
    const prevDriver = prevUser ? null : await this.prisma.driver.findFirst({ where: { telegramChatId: join.chatId } });
    if (!prevUser && !prevDriver) throw new Error('This chat is not linked to any account');
    const prevLabel = prevUser ? `${prevUser.fullName} (${prevUser.username})` : prevDriver?.name ?? 'unknown';

    await this.prisma.$transaction([
      prevUser
        ? this.prisma.user.update({ where: { id: prevUser.id }, data: { telegramChatId: null, telegramUsername: null } })
        : this.prisma.driver.update({ where: { id: prevDriver!.id }, data: { telegramChatId: null, telegramUsername: null } }),
      this.prisma.telegramJoinRequest.update({
        where: { id: joinId },
        data: { status: 'PENDING', boundUserId: null, boundDriverId: null, decidedById: null, decidedAt: null },
      }),
    ]);

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TELEGRAM_ADMIN_UNBIND', module: 'SETTINGS', recordId: joinId,
      oldValue: { chatId: join.chatId, holder: prevLabel },
      newValue: { chatId: join.chatId, holder: prevLabel, via: 'joins-ui' },
    });

    await this.call('sendMessage', {
      chat_id: join.chatId,
      text: `ℹ️ Your chat has been unlinked from ${escapeHtml(prevLabel)} by Administration. Send /start if you want to join again.`,
    }).catch(() => undefined);

    return { unbound: prevLabel };
  }

  /**
   * Push the ACTIVE assignment card(s) to a freshly (re)bound driver's chat —
   * covers "assigned first, linked later": without this, a driver who binds after
   * the assignment never receives the trip card (sendAssignment is assign-time only).
   */
  async resendActiveAssignments(driverId: string) {
    try {
      const assignments = await this.prisma.carAssignment.findMany({
        where: { driverId, releasedAt: null },
        select: { id: true },
        take: 3, // requestId is unique on car_assignments — at most one active per request
      });
      for (const a of assignments) {
        await this.sendAssignment(a.id);
      }
    } catch (e) {
      this.logger.warn(`resendActiveAssignments failed: ${(e as Error).message}`);
    }
  }

  /** Bot identity for the Settings/Profile UI (@botname from getMe). */
  async getMe(): Promise<{ username?: string; configured: boolean }> {
    const { token } = await this.config();
    if (!token) return { configured: false };
    const res = await this.call<{ username?: string }>('getMe');
    return { username: res?.username, configured: true };
  }

  // -------------------------------------------------------------- callbacks

  private async handleCallback(data: string, fromChatId: string, callbackId: string) {
    const [action, assignmentId] = data.split(':');
    if (!assignmentId) return;
    // ✅-labelled (grayed) buttons on a finished stage — acknowledge politely, change nothing
    if (action === 'noop') {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'Already done ✓' });
      return;
    }
    const assignment = await this.prisma.carAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        driver: true,
        vehicle: true,
        carRequest: { select: { destination: true, pickupLocation: true, startDate: true, endDate: true, timeSlot: true, purpose: true } },
        request: { select: { id: true, docNumber: true, requesterId: true, requester: { select: { fullName: true, employee: { select: { phone: true } } } } } },
      },
    });
    if (!assignment) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'Assignment not found' });
      return;
    }
    // Security: only the bound driver's chat may act on their assignment
    if (!assignment.driver?.telegramChatId || assignment.driver.telegramChatId !== fromChatId) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'Not authorized' });
      return;
    }
    // Stage machine: each action only fires from its own stage (or later, filling gaps)
    const now = new Date();
    const patch: Record<string, Date> = {};
    if (action === 'noted' && !assignment.driverNotedAt) patch.driverNotedAt = now;
    else if (action === 'arrived' && !assignment.driverArrivedAt) {
      patch.driverArrivedAt = now;
      if (!assignment.driverNotedAt) patch.driverNotedAt = now;
    } else if (action === 'returned' && !assignment.driverBackAtOfficeAt) {
      patch.driverBackAtOfficeAt = now;
      if (!assignment.driverNotedAt) patch.driverNotedAt = now;
      if (!assignment.driverArrivedAt) patch.driverArrivedAt = now;
    } else {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'Already done' });
      return;
    }
    if (action === 'returned') await this.freeVehicle(assignment.id);

    const updated = await this.applyAckStage(assignment.id, patch, action);
    await this.editStageMessage(updated);
    await this.answerCallback(updated, callbackId, action);
    await this.audit.log({
      action: action === 'noted' ? 'DRIVER_NOTED' : action === 'arrived' ? 'DRIVER_ARRIVED' : 'DRIVER_RETURNED',
      module: 'CARS',
      recordId: updated.request.id,
      username: updated.driver?.name ?? 'driver',
      newValue: { driverNotedAt: updated.driverNotedAt, driverArrivedAt: updated.driverArrivedAt, driverBackAtOfficeAt: updated.driverBackAtOfficeAt },
    });
  }

  /** Core stage machine shared by the Telegram callback and the manual admin override. */
  private async applyAckStage(assignmentId: string, patch: Record<string, Date>, action: string) {
    const updated = (await this.prisma.carAssignment.update({
      where: { id: assignmentId },
      data: patch,
      include: {
        driver: true,
        vehicle: true,
        carRequest: { select: { destination: true, pickupLocation: true, startDate: true, endDate: true, timeSlot: true, purpose: true } },
        request: { select: { id: true, docNumber: true, requesterId: true, requester: { select: { fullName: true, employee: { select: { phone: true } } } } } },
      },
    })) as PrismaCarAssignment;
    await this.notifyStage(updated, action as 'noted' | 'arrived' | 'returned');
    return updated;
  }

  /**
   * Administration manual override — mark an ack stage from AMS itself
   * (e.g. the driver confirmed by phone and Telegram is down). Same routing
   * and vehicle-freeing effects as the driver's Telegram buttons.
   */
  async manualAck(assignmentId: string, action: 'noted' | 'arrived' | 'returned', actor: { userId: string; username: string }) {
    const assignment = await this.prisma.carAssignment.findUnique({ where: { id: assignmentId } });
    if (!assignment) return null;
    const now = new Date();
    const patch: Record<string, Date> = {};
    if (action === 'noted' && !assignment.driverNotedAt) patch.driverNotedAt = now;
    else if (action === 'arrived' && !assignment.driverArrivedAt) {
      patch.driverArrivedAt = now;
      if (!assignment.driverNotedAt) patch.driverNotedAt = now;
    } else if (action === 'returned' && !assignment.driverBackAtOfficeAt) {
      patch.driverBackAtOfficeAt = now;
      if (!assignment.driverNotedAt) patch.driverNotedAt = now;
      if (!assignment.driverArrivedAt) patch.driverArrivedAt = now;
    } else return null; // already done
    if (action === 'returned') await this.freeVehicle(assignmentId);
    const updated = await this.applyAckStage(assignmentId, patch, action);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: action === 'noted' ? 'DRIVER_NOTED' : action === 'arrived' ? 'DRIVER_ARRIVED' : 'DRIVER_RETURNED',
      module: 'CARS',
      recordId: updated.request.id,
      newValue: { manual: true, via: actor.username, ...patch },
    });
    return updated;
  }

  /** "Back at Office": free the vehicle + driver immediately (also on re-assign paths). */
  private async freeVehicle(assignmentId: string) {
    const a = await this.prisma.carAssignment.findUnique({ where: { id: assignmentId } });
    if (!a) return;
    await this.prisma.vehicle.update({ where: { id: a.vehicleId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
    if (a.driverId) {
      await this.prisma.driver.update({ where: { id: a.driverId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
    }
  }

  private async answerCallback(
    a: PrismaCarAssignment,
    callbackId: string,
    action: string,
  ) {
    const label = action === 'noted' ? 'Noted — Administration notified' : action === 'arrived' ? 'Car ready — requester & Administration notified' : 'Back at office — car is available again';
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: label });
  }

  private async notifyStage(
    a: PrismaCarAssignment,
    action: 'noted' | 'arrived' | 'returned',
  ) {
    const doc = a.request.docNumber;
    const driverName = a.driver?.name ?? 'Driver';
    const admins = await this.prisma.userRole.findMany({
      where: { role: { name: 'ADMINISTRATION' }, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    const link = `/requests/${a.request.id}`;
    // The admin who MADE this assignment watches the driver's progress live in
    // their own chat (they dispatched it — Noted/Ready/Back reach the dispatcher
    // too) — deduped against the ADMINISTRATION broadcast so a chat never gets
    // the same stage message twice.
    const adminIds = [...new Set(admins.map((r) => r.userId))];
    let assignerChatId: string | null = null;
    try {
      const assigner = await this.prisma.user.findUnique({ where: { id: a.assignedById }, select: { telegramChatId: true } });
      assignerChatId = assigner?.telegramChatId ?? null;
    } catch {
      assignerChatId = null;
    }
    const recipients = assignerChatId && !adminIds.includes(a.assignedById) ? [...adminIds, a.assignedById] : adminIds;
    if (action === 'noted') {
      const userIds = recipients;
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          type: 'CAR_DRIVER_NOTED' as const,
          title: `✓ ${driverName} noted ${doc}`,
          body: 'Driver acknowledged the car assignment.',
          link,
          requestId: a.request.id,
        })),
      });
      for (const userId of userIds) {
        await this.mirrorToUser(userId, `✓ ${driverName} noted ${doc}`, 'Driver acknowledged the car assignment.', link).catch(() => undefined);
      }
      // the requester also learns their trip is acknowledged — with WHO is coming
      const notedBody = `Driver ${driverName} (${a.vehicle?.brandModel ?? 'vehicle'} · ${a.vehicle?.vehicleNo ?? '-'}) acknowledged the trip and is on the way. Pickup: ${a.carRequest?.pickupLocation || '-'} → ${a.carRequest?.destination ?? ''}.`;
      await this.prisma.notification.create({
        data: {
          userId: a.request.requesterId,
          type: 'CAR_DRIVER_NOTED' as const,
          title: `✓ Driver noted — ${doc}`,
          body: notedBody,
          link,
          requestId: a.request.id,
        },
      });
      await this.mirrorToUser(a.request.requesterId, `✓ Driver noted — ${doc}`, notedBody, link).catch(() => undefined);
    } else if (action === 'arrived') {
      // requester gets the rich "your car is ready" message…
      const requesterBody = `Driver ${driverName} (${a.vehicle?.brandModel ?? 'vehicle'} · ${a.vehicle?.vehicleNo ?? '-'}) is ready. Pickup: ${a.carRequest?.pickupLocation || '-'} → ${a.carRequest?.destination ?? ''}.`;
      await this.prisma.notification.create({
        data: {
          userId: a.request.requesterId,
          type: 'CAR_DRIVER_ARRIVED' as const,
          title: `🚗 Car is ready — ${doc}`,
          body: requesterBody,
          link,
          requestId: a.request.id,
        },
      });
      await this.mirrorToUser(a.request.requesterId, `🚗 Car is ready — ${doc}`, requesterBody, link).catch(() => undefined);
      // …and Administration sees the driver's Ready report too (fleet oversight)
      const userIds = recipients;
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          type: 'CAR_DRIVER_ARRIVED' as const,
          title: `🚦 ${driverName} ready — ${doc}`,
          body: 'Driver reports the car is ready — the requester has been notified.',
          link,
          requestId: a.request.id,
        })),
      });
      for (const userId of userIds) {
        await this.mirrorToUser(userId, `🚦 ${driverName} ready — ${doc}`, 'Driver reports the car is ready — the requester has been notified.', link).catch(() => undefined);
      }
    } else {
      const userIds = recipients;
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          type: 'CAR_DRIVER_RETURNED' as const,
          title: `🏁 Car available — ${doc}`,
          body: `${driverName} is back at office — ${a.vehicle?.vehicleNo ?? 'vehicle'} is available for the next trip.`,
          link,
          requestId: a.request.id,
        })),
      });
      for (const userId of userIds) {
        await this.mirrorToUser(userId, `🏁 Car available — ${doc}`, `${driverName} is back at office — ${a.vehicle?.vehicleNo ?? 'vehicle'} is available for the next trip.`, link).catch(() => undefined);
      }
    }
  }

  // ------------------------------------------------------------- assignment

  /**
   * Driver keyboard — ALL THREE buttons always visible in order (Noted → Ready →
   * Back at Office); completed ones are labelled ✅ and act as no-ops, so the
   * layout the driver sees never changes shape (only grays out stage by stage).
   */
  private assignmentKeyboard(
    a: { driverNotedAt?: Date | null; driverArrivedAt?: Date | null; driverBackAtOfficeAt?: Date | null },
    assignmentId: string,
  ) {
    const btn = (done: boolean, label: string, action: string) => ({
      text: done ? `✅ ${label}` : label,
      callback_data: done ? 'noop' : `${action}:${assignmentId}`,
    });
    return {
      inline_keyboard: [[
        btn(!!a.driverNotedAt, '✓ Noted', 'noted'),
        btn(!!a.driverArrivedAt, '🚦 Ready', 'arrived'),
        btn(!!a.driverBackAtOfficeAt, '🏁 Back at Office', 'returned'),
      ]],
    };
  }

  /**
   * Body of the driver's assignment message — the SAME full card at every stage
   * (route, vehicle, requester, maps link); only the progress timestamp lines
   * appear under it as the driver works through Noted → Ready → Back.
   */
  private assignmentBody(
    a: {
      request: { docNumber: string; requester: { fullName: string; employee?: { phone: string | null } | null } };
      vehicle?: { brandModel: string; vehicleNo: string } | null;
      carRequest?: { destination: string; pickupLocation: string | null; startDate: Date; endDate: Date; timeSlot: string; purpose: string | null } | null;
    },
    stages?: { noted?: Date | null; arrived?: Date | null; back?: Date | null } | null,
  ): string {
    const cr = a.carRequest;
    if (!cr) return escapeHtml(`🚗 Car Assigned — ${a.request.docNumber}`);
    const when = `${fmtDate(cr.startDate)} · ${fmtTime(cr.startDate)} – ${fmtTime(cr.endDate)} (${cr.timeSlot})`;
    const pickup = cr.pickupLocation || '—';
    const phone = a.request.requester.employee?.phone;
    const lines = [
      `<b>🚗 Car Assigned — ${escapeHtml(a.request.docNumber)} · ${escapeHtml(cr.destination)}</b>`,
      ``,
      `📅 ${escapeHtml(when)}`,
      `🚙 ${a.vehicle ? escapeHtml(`${a.vehicle.brandModel} · ${a.vehicle.vehicleNo}`) : '—'}`,
      `📍 Pickup: ${escapeHtml(pickup)}`,
      `🗺 Destination: ${escapeHtml(cr.destination)}`,
      `👤 Requester: ${escapeHtml(a.request.requester.fullName)}${phone ? ` (${escapeHtml(phone)})` : ''}`,
      cr.purpose ? `📝 ${escapeHtml(cr.purpose)}` : '',
    ].filter((l) => l !== undefined);
    if (stages) {
      if (stages.noted) lines.push(`✓ Noted · ${fmtTime(stages.noted)}`);
      if (stages.arrived) lines.push(`🚦 Car ready · ${fmtTime(stages.arrived)}`);
      if (stages.back) lines.push(`🏁 Back at office · ${fmtTime(stages.back)}`);
    } else {
      lines.push(`Tap "✓ Noted" to acknowledge the route.`);
    }
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${pickup} to ${cr.destination}`)}`;
    return `${lines.join('\n')}\n🗺 <a href="${mapsUrl}">Open in Maps</a>`;
  }

  /** Push the assignment message (all three stage buttons) to the driver's chat. */
  async sendAssignment(assignmentId: string) {
    const a = await this.prisma.carAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        driver: true,
        vehicle: true,
        carRequest: { select: { destination: true, pickupLocation: true, startDate: true, endDate: true, timeSlot: true, purpose: true } },
        request: {
          select: {
            docNumber: true,
            requester: { select: { fullName: true, employee: { select: { phone: true } } } },
          },
        },
      },
    });
    if (!a?.driver?.telegramChatId) return; // never assigned a driver, or not bound yet — silent
    const cr = a.carRequest;
    if (!cr) return;
    const { token, enabled } = await this.config();
    if (!token || !enabled) return;

    const message = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: a.driver.telegramChatId,
      text: this.assignmentBody(a),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: this.assignmentKeyboard(a, a.id),
    });
    if (message?.message_id) {
      await this.prisma.carAssignment.update({
        where: { id: a.id },
        data: { telegramMessageId: String(message.message_id) },
      });
    }
  }

  /** Repaint the driver's message for the current stage — same card, progress lines + grayed buttons. */
  private async editStageMessage(a: PrismaCarAssignment) {
    if (!a.telegramMessageId || !a.driver?.telegramChatId) return;
    const { token, enabled } = await this.config();
    if (!token || !enabled) return;

    await this.call('editMessageText', {
      chat_id: a.driver.telegramChatId,
      message_id: Number(a.telegramMessageId),
      text: this.assignmentBody(a, { noted: a.driverNotedAt, arrived: a.driverArrivedAt, back: a.driverBackAtOfficeAt }),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: this.assignmentKeyboard(a, a.id),
    });
  }

  /**
   * The assignment was handed to a different vehicle/driver — tell the PREVIOUS
   * driver directly (they hold no AMS account) so they know they're off the trip.
   */
  async notifyDriverOfReassign(requestId: string, docNumber: string, previousDriverId: string, newVehicleLabel: string) {
    try {
      const prev = await this.prisma.driver.findUnique({ where: { id: previousDriverId } });
      if (!prev?.telegramChatId) return;
      const lines = [
        `🔄 <b>${escapeHtml(docNumber)} was reassigned</b>`,
        `This trip is no longer yours — the vehicle went to ${escapeHtml(newVehicleLabel)}.`,
        `You are free for other duties.`,
      ];
      await this.call('sendMessage', {
        chat_id: prev.telegramChatId,
        text: lines.join('\n'),
        parse_mode: 'HTML',
      });
      await this.audit.log({
        action: 'TELEGRAM_DRIVER_REASSIGN_NOTIFIED', module: 'CARS', recordId: requestId,
        newValue: { driver: prev.name, chatId: prev.telegramChatId },
      });
    } catch {
      /* notification must never break the reassignment */
    }
  }

  /** Regenerate (or create) a bind code for a driver — used by Settings/Drivers UI. */
  async regenerateBindCode(driverId: string) {
    const code = `DRV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    await this.prisma.driver.update({ where: { id: driverId }, data: { telegramBindCode: code, telegramChatId: null } });
    return code;
  }

  /**
   * Mirror an in-app notification to the user's Telegram chat (if bound).
   * Used by NotificationsService so every AMS notification also reaches Telegram.
   * With `telegram.web_url` configured, a link path becomes an "Open in AMS" button.
   */
  async mirrorToUser(userId: string, title: string, body?: string, link?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { telegramChatId: true } });
    if (!user?.telegramChatId) return;
    await this.sendToChat(user.telegramChatId, title, body, link);
  }

  /**
   * Administration cancelled an approved car booking — reply directly to the
   * driver's Telegram chat (they don't hold an AMS account) so they know the
   * trip is off and can plan the rest of their day.
   */
  async notifyDriverOfCancellation(requestId: string, docNumber: string, comment?: string) {
    try {
      const a = await this.prisma.carAssignment.findFirst({
        where: { requestId },
        orderBy: { assignedAt: 'desc' },
        include: { driver: true, vehicle: true },
      });
      if (!a?.driver?.telegramChatId) return;
      const lines = [
        `❌ <b>${escapeHtml(docNumber)} was cancelled by Administration</b>`,
        `Vehicle ${escapeHtml(a.vehicle?.vehicleNo ?? '-')} — no longer needed.`,
      ];
      if (comment) lines.push(`Reason: ${escapeHtml(comment)}`);
      await this.call('sendMessage', {
        chat_id: a.driver.telegramChatId,
        text: lines.join('\n'),
        parse_mode: 'HTML',
      });
      await this.audit.log({
        action: 'TELEGRAM_DRIVER_CANCEL_NOTIFIED', module: 'CARS', recordId: requestId,
        newValue: { driver: a.driver.name, chatId: a.driver.telegramChatId },
      });
    } catch (e) {
      this.logger.warn(`driver cancel notice failed: ${(e as Error).message}`);
    }
  }

  /** Raw HTML message with an arbitrary keyboard — used by the Telegram-approval flow. */
  async sendRaw(chatId: string, text: string, extra: Record<string, unknown> = {}) {
    await this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }

  /** Acknowledge a callback query (toast in the Telegram UI). */
  async answer(callbackId: string, text: string) {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text });
  }

  /** Replace the message that carried the pressed button — paints the outcome stamp (and optionally a new keyboard). */
  async editCallbackMessage(
    chatId: string,
    callbackId: string,
    text: string,
    keyboard?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
  ) {
    // callback queries carry the message id — resolve it from the last poll update cache
    const msgId = this.callbackMessages.get(`${chatId}:${callbackId}`);
    if (!msgId) return;
    await this.editMessage(chatId, msgId, text, keyboard);
  }

  /** message_id that a recent callback belonged to (lookup without consuming) — for the reject conversation. */
  peekCallbackMessage(chatId: string, callbackId: string): number | undefined {
    return this.callbackMessages.get(`${chatId}:${callbackId}`);
  }

  /** Edit an arbitrary bot message by (chatId, messageId) — used by the reject conversation's later outcome stamp. */
  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    keyboard?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
  ) {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  /** message_id per (chat, callback) seen in the poll loop — for editCallbackMessage. */
  private callbackMessages = new Map<string, number>();

  /** Shared notification payload — text plus an optional "Open in AMS" deep link. */
  private async sendToChat(chatId: string, title: string, body?: string, link?: string) {
    const lines = [`🔔 ${escapeHtml(title)}`];
    if (body) lines.push(escapeHtml(body));
    const { webUrl } = await this.webUrl();
    const keyboard = webUrl && link?.startsWith('/')
      ? { inline_keyboard: [[{ text: 'Open in AMS', url: `${webUrl.replace(/\/$/, '')}${link}` }]] }
      : undefined;
    await this.call('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  /** Optional public AMS URL for deep links (system setting telegram.web_url). */
  private async webUrl(): Promise<{ webUrl: string }> {
    try {
      const row = await this.prisma.systemSetting.findUnique({ where: { key: KEY_WEB_URL } });
      return { webUrl: row?.value ?? '' };
    } catch {
      return { webUrl: '' };
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type PrismaCarAssignment = {
  id: string;
  driverId: string | null;
  vehicleId: string;
  telegramMessageId: string | null;
  assignedById: string;
  driverNotedAt: Date | null;
  driverArrivedAt: Date | null;
  driverBackAtOfficeAt: Date | null;
  driver: { id: string; name: string; telegramChatId: string | null } | null;
  vehicle?: { id: string; vehicleNo: string; brandModel: string } | null;
  carRequest?: { destination: string; pickupLocation: string | null; startDate: Date; endDate: Date; timeSlot: string; purpose: string | null } | null;
  request: {
    id: string;
    docNumber: string;
    requesterId: string;
    requester: { fullName: string; employee?: { phone: string | null } | null };
  };
};

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeMarkdown(s: string) {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function fmtDate(d: Date) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Yangon' });
}

function fmtTime(d: Date) {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Yangon' });
}
