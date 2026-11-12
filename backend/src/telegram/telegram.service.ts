import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { EventsService } from '../events/events.service';
import { yangonShort, yangonClock } from '../util/yangon-time';

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

/**
 * One odometer capture waiting for the driver's number.
 *
 * Mirrored on the assignment row (`pendingOdo*`) so a deploy, restart or crash
 * cannot lose a photo the driver already sent — the bug that cost CAR-202611-0023
 * its return reading on 2026-11-10.
 */
interface OdoPending {
  assignmentId: string;
  stage: 'READY' | 'BACK';
  at: number;
  photo?: { buffer: Buffer; size: number };
  /** a number the driver typed BEFORE the photo — kept, never discarded */
  km?: number;
}

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
  message?: TgMessage;
  callback_query?: { id: string; data?: string; from?: { id: number }; message?: { chat: { id: number }; message_id: number } };
}

/** A Telegram message as the poll loop receives it (only the fields we use). */
export interface TgMessage {
  message_id?: number;
  chat: { id: number };
  text?: string;
  /** photo/text the subscriber typed under a photo — treated as message text */
  caption?: string;
  /** all photos of one album share this id, so bubbles can be grouped */
  media_group_id?: string;
  from?: { id: number; username?: string; first_name?: string };
  /** Telegram *Reply* — the ONLY reliable link to the message being answered */
  reply_to_message?: { message_id: number };
  document?: { file_id: string; file_name?: string };
  /** the driver's dashboard photo, or any photo a subscriber sends (sizes, largest last) */
  photo?: { file_id: string; file_size?: number; width?: number; height?: number }[];
}

/** What the inbound-message log needs from one update (plan §6 / P4). */
export interface InboundCaptureInput {
  chatId: string;
  messageId?: number;
  replyToMessageId?: number;
  mediaGroupId?: string;
  senderName?: string;
  text?: string;
  photo?: { fileId: string; width?: number; height?: number };
  documentName?: string;
}

export type InboundHandledBy =
  | 'ANNOUNCEMENT_REPLY'
  | 'GENERAL'
  | 'CAR_FORM'
  | 'REJECT_REASON'
  | 'ODOMETER'
  | 'ETA'
  | 'COMMAND';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  /** Wired by TelegramModule after both services exist (avoids constructor cycle). */
  approvals?: { handleAction(data: string, chatId: string, callbackId: string): Promise<boolean> };
  /** Slash-command surface (wired by CarsModule) — returns true when the text was handled. */
  commands?: { handleText(text: string, chatId: string): Promise<boolean> };
  /**
   * Subscriber-message log (wired by AnnouncementsModule). Capture never
   * consumes an update: the update still runs through every flow below, and the
   * row is labelled with whatever ended up handling it (plan §6 / P4).
   */
  inbound?: {
    capture(input: InboundCaptureInput): Promise<{ id: string; announcementId: string | null } | null>;
    markHandled(id: string | null | undefined, handledBy: InboundHandledBy): Promise<void>;
  };
  /** Reject-reason conversation state + handler (wired by CarsModule). */
  rejects?: {
    handleText(text: string, chatId: string): Promise<void>;
    hasPending(chatId: string): boolean;
  };
  /** /car request-form conversation (wired by CarsModule). */
  carRequests?: {
    /** true when the text was a /car command (or consumed by the form). */
    handleCommand(text: string, chatId: string): Promise<boolean>;
    handleText(text: string, chatId: string): Promise<void>;
    hasPending(chatId: string): boolean;
  };
  /** ⏰ Delay (driver-reported ETA) executor (wired by CarsModule → CarsService). */
  etaRef?: {
    reportEta(assignmentId: string, minutesOrText: number | string, chatId: string, callbackId?: string): Promise<void>;
  };
  /** 🛣️ Odometer capture executor (wired by CarsModule → CarsService.captureOdometer). */
  odoRef?: {
    capture(
      assignmentId: string,
      data: { stage: 'READY' | 'BACK'; km: number; photo?: { buffer: Buffer; size: number } },
      actor: { username: string },
    ): Promise<unknown>;
  };
  /** AnnouncementsService (wired by AnnouncementsModule) — audience checks for ack buttons. */
  announcementsRef?: { listMine(actor: { userId: string; username: string }): Promise<Array<{ id: string }>> };
  private polling = false;
  private loop: Promise<void> | null = null;
  private lastConfigCheck = 0;
  private cachedToken: string | null = null;
  private cachedEnabled = false;

  constructor(private prisma: PrismaService, private audit: AuditService, private permissions: PermissionsService, private events: EventsService) {}

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

  /** At most one deleteWebhook attempt per 10 minutes (conflict self-heal). */
  private lastWebhookDrop = 0;

  private async dropForeignWebhook() {
    if (Date.now() - this.lastWebhookDrop < 10 * 60_000) return;
    this.lastWebhookDrop = Date.now();
    const { token } = await this.config();
    if (!token) return;
    try {
      const res = await fetch(API(token, 'deleteWebhook'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: false }),
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      this.logger.log(`self-heal: dropped foreign webhook (${json.ok ? 'ok' : json.description})`);
      await this.audit.log({ action: 'TELEGRAM_WEBHOOK_DROPPED', module: 'SETTINGS', newValue: { reason: 'getUpdates conflict' } });
    } catch {
      /* retried on the next conflict */
    }
  }

  private async call<T = unknown>(method: string, payload?: Record<string, unknown>, opts?: { notModifiedIsOk?: boolean }): Promise<T | null> {
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
        // editing a card to the exact content it already shows is NOT an error
        // for our purposes — the card the user sees is already correct
        if (opts?.notModifiedIsOk && json.description?.includes('message is not modified')) {
          return true as T;
        }
        this.logger.warn(`Telegram ${method} failed: ${json.description ?? res.status}`);
        // another host re-registered a webhook — drop it (throttled) so the
        // poll loop recovers without a human (button acks/commands die otherwise)
        if (json.description?.includes('webhook is active')) await this.dropForeignWebhook();
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

  /**
   * Store a subscriber message via the wired inbound log. Best-effort and
   * insert-only: it returns null when capturing is off or the write failed, and
   * whatever comes back is used to label the message later.
   */
  private async captureInbound(
    chatId: string,
    m: TgMessage | undefined,
  ): Promise<{ id: string; announcementId: string | null } | null> {
    if (!this.inbound) return null;
    const sizes = m?.photo ?? [];
    const largest = sizes[sizes.length - 1]; // Telegram sends sizes smallest → largest
    try {
      return await this.inbound.capture({
        chatId,
        messageId: m?.message_id,
        replyToMessageId: m?.reply_to_message?.message_id,
        mediaGroupId: m?.media_group_id,
        senderName: m?.from?.first_name ?? (m?.from?.username ? `@${m.from.username}` : undefined),
        text: m?.text ?? m?.caption,
        photo: largest ? { fileId: largest.file_id, width: largest.width, height: largest.height } : undefined,
        documentName: m?.document?.file_name,
      });
    } catch (e) {
      this.logger.warn(`inbound capture failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Label what actually handled the message (no-op when capturing is off). */
  private async markInbound(id: string | null | undefined, handledBy: InboundHandledBy) {
    if (!id || !this.inbound) return;
    await this.inbound.markHandled(id, handledBy).catch(() => undefined);
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
      // announcement acknowledge buttons (anack:<announcementId>)
      if (u.callback_query.data.startsWith('anack:')) {
        await this.handleAnnouncementAck(u.callback_query.data.slice('anack:'.length), String(u.callback_query.from.id), u.callback_query.id).catch((err) =>
          this.logger.warn(`announcement ack failed: ${(err as Error).message}`),
        );
        return;
      }
      // 🛣️ "does this photo match the number you typed?" (odo:ok / odo:fix)
      if (u.callback_query.data.startsWith('odo:')) {
        await this.handleOdoCallback(u.callback_query.data, chatId, u.callback_query.id).catch((err) =>
          this.logger.warn(`odometer confirm failed: ${(err as Error).message}`),
        );
        return;
      }
      await this.handleCallback(u.callback_query.data, String(u.callback_query.from.id), u.callback_query.id);
      return;
    }
    const chatId = u.message?.chat?.id != null ? String(u.message.chat.id) : null;
    if (!chatId) return;
    const text = (u.message?.text ?? u.message?.caption)?.trim();
    // 📥 Store every subscriber message FIRST — text and photos, consumed by a
    // flow or not (plan §6 / P4). Insert-only: it never changes what the update
    // does next, and it never throws into the poll loop.
    const rec = await this.captureInbound(chatId, u.message);
    // R1 — an explicit Reply to one of OUR announcement cards is a subscriber
    // answer. No armed flow may swallow it, and no "photo first" nag is sent:
    // the odometer/whatsapp-style prompts would be nonsense for a card reply.
    if (rec?.announcementId) return;
    // R4 — /msg <text> files a message in the inbox without touching any flow.
    if (text && /^\/msg(@\w+)?(\s|$)/i.test(text)) {
      await this.markInbound(rec?.id, 'GENERAL');
      await this.call('sendMessage', { chat_id: chatId, text: '✓ မှတ်တမ်းတင်ပြီး' });
      return;
    }
    // 🛣️ dashboard photo for an armed Ready / Back-at-office capture
    // (the photo was just stored too — R2: consumed ≠ lost)
    if (u.message?.photo?.length && this.pendingOdo.has(chatId)) {
      await this.markInbound(rec?.id, 'ODOMETER');
      await this.handleOdoPhoto(chatId, u.message.photo).catch((err) =>
        this.logger.warn(`odometer photo failed: ${(err as Error).message}`),
      );
      return;
    }
    // 🛣️ A dashboard photo can arrive with NO capture armed: the window expired,
    // a deploy cleared the in-memory map, or the driver sent it just before the
    // tap. Storing it silently left the bot mute and the trip without its kilo, so
    // re-arm from the taps that already happened and take this photo as evidence.
    if (u.message?.photo?.length) {
      const resumed = await this.resumeOdometerCapture(chatId).catch(() => null);
      if (resumed) {
        this.armOdo(chatId, resumed.assignmentId, resumed.stage);
        await this.markInbound(rec?.id, 'ODOMETER');
        await this.handleOdoPhoto(chatId, u.message.photo).catch((err) =>
          this.logger.warn(`odometer photo failed: ${(err as Error).message}`),
        );
        return;
      }
    }
    if (!text) return;
    this.logger.log(`TG text update from ${chatId}: "${text}"`);
    // 🛣️ an armed odometer capture — the next number IS the reading (photo first).
    // A capture restored from the database (P8) is not in the map yet, so a bare
    // number or /cancel is let through to look it up: that is how a driver finishes
    // a capture the deploy interrupted.
    const bareNumber = /^\d{1,7}$/.test(text.replace(/[,\s]/g, ''));
    if (this.pendingOdo.has(chatId) || bareNumber || text === '/cancel') {
      const handled = await this.handleOdoText(chatId, text).catch(() => false);
      if (handled) {
        await this.markInbound(rec?.id, 'ODOMETER');
        return;
      }
    }
    // an in-progress reject conversation — the next text IS the reason (or /cancel aborts).
    // Any OTHER slash command aborts the conversation first, then runs normally
    // (so /assign etc. are never swallowed as a "reason").
    if (this.rejects?.hasPending(chatId)) {
      if (text === '/cancel' || !text.startsWith('/')) {
        await this.markInbound(rec?.id, text === '/cancel' ? 'COMMAND' : 'REJECT_REASON');
        await this.rejects.handleText(text, chatId).catch(() => undefined);
        return;
      }
      await this.markInbound(rec?.id, 'COMMAND');
      await this.rejects.handleText('/cancel', chatId).catch(() => undefined);
    }
    // an armed ⏰ custom-ETA entry — the next text IS the new expected return time
    if (this.pendingEtaCustom.has(chatId)) {
      const armed = this.pendingEtaCustom.get(chatId)!;
      if (text === '/cancel' || !text.startsWith('/')) {
        this.pendingEtaCustom.delete(chatId);
        if (text !== '/cancel' && this.etaRef) {
          await this.markInbound(rec?.id, 'ETA');
          await this.etaRef.reportEta(armed.assignmentId, text, chatId).catch(() => undefined);
        } else {
          await this.markInbound(rec?.id, 'COMMAND');
        }
        return;
      }
      this.pendingEtaCustom.delete(chatId); // any other slash command aborts the ETA entry
    }
    // an open /car form — the next text is field answers (or /cancel aborts).
    // Runs BEFORE the slash-command fallback so /car itself opens/refreshes
    // the form while it is already open, and other commands still abort it.
    if (this.carRequests?.hasPending(chatId)) {
      if (text === '/cancel' || text === '/car' || !text.startsWith('/')) {
        await this.markInbound(rec?.id, text.startsWith('/') ? 'COMMAND' : 'CAR_FORM');
        await this.carRequests.handleText(text, chatId).catch(() => undefined);
        return;
      }
      await this.markInbound(rec?.id, 'COMMAND');
      await this.carRequests.handleText('/cancel', chatId).catch(() => undefined);
    }
    // slash commands (except /start — the bind/join flow owns it)
    if (text.startsWith('/') && !text.startsWith('/start')) {
      await this.markInbound(rec?.id, 'COMMAND');
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
    await this.markInbound(rec?.id, 'COMMAND');
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
      // RBAC-native: whoever manages users gets join requests
      const userIds = await this.permissions.usersWithPermissions(['users.manage']);
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
            'TELEGRAM_ADMIN_UNBIND', 'TELEGRAM_JOIN_DELETED',
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
      } else if (l.action === 'TELEGRAM_JOIN_DELETED') {
        label = 'Deleted by Administration — removed from the join list';
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

  /**
   * Administration: permanently delete a join request from the list.
   * Approved joins are refused — unbind the chat first (that also drops the join
   * back to PENDING, where it can be deleted). Deleting a PENDING draft is safe:
   * if the person sends /start again they simply appear as a brand-new request.
   */
  async deleteJoin(joinId: string, actor: { userId: string; username: string }) {
    const join = await this.prisma.telegramJoinRequest.findUnique({ where: { id: joinId } });
    if (!join) throw new Error('Join request not found');
    if (join.status === 'APPROVED') throw new Error('This join is approved and linked — unbind it first, then delete');
    await this.prisma.telegramJoinRequest.delete({ where: { id: joinId } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TELEGRAM_JOIN_DELETED', module: 'SETTINGS', recordId: joinId,
      oldValue: { chatId: join.chatId, status: join.status, tgUsername: join.tgUsername, displayName: join.displayName },
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

  /**
   * Acknowledge an announcement straight from the Telegram button. The chat
   * must be bound to a user who is in the announcement's audience — upserts
   * the ack timestamp, repaints the button, and tells Administration in-app.
   */
  private async handleAnnouncementAck(announcementId: string, fromChatId: string, callbackId: string) {
    const user = await this.prisma.user.findFirst({ where: { telegramChatId: fromChatId }, select: { id: true, fullName: true } });
    if (!user) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'This AMS chat is not linked to a user account' });
      return;
    }
    const a = await this.prisma.announcement.findUnique({ where: { id: announcementId }, select: { id: true, code: true, title: true, requiresAck: true, status: true } });
    if (!a || a.status !== 'PUBLISHED' || !a.requiresAck) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'This announcement no longer accepts acknowledgements' });
      return;
    }
    // a bound user who was never targeted is told politely (no ack is recorded)
    const targeted = await this.isTargeted(announcementId, user.id);
    if (!targeted) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'This announcement was not addressed to you' });
      return;
    }
    const read = await this.prisma.announcementRead.findUnique({
      where: { announcementId_userId: { announcementId, userId: user.id } },
    });
    if (read?.ackAt) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: '✓ Already acknowledged' });
      return;
    }
    await this.prisma.announcementRead.upsert({
      where: { announcementId_userId: { announcementId, userId: user.id } },
      update: { ackAt: new Date(), readAt: read?.readAt ?? new Date() },
      create: { announcementId, userId: user.id, readAt: new Date(), ackAt: new Date() },
    });
    await this.audit.log({
      userId: user.id, username: user.fullName,
      action: 'ANNOUNCEMENT_ACKED', module: 'ANNOUNCEMENT', recordId: announcementId,
      newValue: { code: a.code, via: 'telegram' },
    });
    // repaint the message button as done
    const msgId = this.callbackMessages.get(`${fromChatId}:${callbackId}`);
    if (msgId) {
      await this.call('editMessageReplyMarkup', {
        chat_id: fromChatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: '✅ Acknowledged', callback_data: 'noop' }]] },
      }).catch(() => undefined);
    }
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: `✓ Acknowledged — thank you, ${user.fullName}` });
  }

  /** Reuse AnnouncementsService targeting logic for the Telegram ack guard. */
  private async isTargeted(announcementId: string, userId: string): Promise<boolean> {
    const svc = this.announcementsRef;
    if (!svc) return true; // unwired (tests) — permissive
    try {
      const mine = await svc.listMine({ userId, username: 'telegram' });
      return mine.some((a: { id: string }) => a.id === announcementId);
    } catch {
      return false;
    }
  }

  private async handleCallback(data: string, fromChatId: string, callbackId: string) {
    const [action, assignmentId] = data.split(':');
    if (!assignmentId) return;
    // ✅-labelled (grayed) buttons on a finished stage — acknowledge politely, change nothing
    if (action === 'noop') {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'Already done ✓' });
      return;
    }
    // ⏰ Delay (driver-reported ETA): data = eta:<minutes>:<assignmentId>, minutes=0
    // meaning "offer the quick options". Handled BEFORE the standard lookup — the
    // assignment id rides in slot 3 here, not slot 2.
    if (action === 'eta') {
      const minutes = Number(assignmentId);
      const targetId = data.split(':')[2] ?? '';
      if (!Number.isFinite(minutes) || !targetId) {
        await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'မမှန်ကန်သော delay တောင်းခံမှု' });
        return;
      }
      if (minutes === 0) {
        const options: { text: string; minutes: number }[] = [
          { text: '+30 မိနစ်', minutes: 30 },
          { text: '+1 နာရီ', minutes: 60 },
          { text: '+3 နာရီ', minutes: 180 },
        ];
        await this.call('sendMessage', {
          chat_id: fromChatId,
          text: '⏰ ဘယ်လောက်နောက်ကျမလဲ? — ကား ပြန်ရောက်မယ့် ခန့်မှန်းချိန် (ETA) ကို Administration နှင့် တောင်းခံသူ သိရမည်။',
          reply_markup: {
            inline_keyboard: [
              ...options.map((o) => [{ text: o.text, callback_data: `eta:${o.minutes}:${targetId}` }]),
              [{ text: '✏️ အချိန်ကိုယ်တိုင်ရေး', callback_data: `etacustom:${targetId}` }],
            ],
          },
        });
        await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'နောက်ကျမည့် အချိန်ကို ရွေးပါ' });
        return;
      }
      if (!this.etaRef) {
        await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'ETA handler not ready' });
        return;
      }
      await this.etaRef.reportEta(targetId, minutes, fromChatId, callbackId);
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
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'ခရီးစဉ် တာဝန်ပေးမှု မတွေ့ပါ' });
      return;
    }
    // Security: only the bound driver's chat may act on their assignment
    if (!assignment.driver?.telegramChatId || assignment.driver.telegramChatId !== fromChatId) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'ခွင့်ပြုချက် မရှိပါ' });
      return;
    }
    // Stale-card guard: re-assigning rewrites the same assignment row and sends a
    // fresh card, but the OLD message keeps its buttons forever — Telegram cannot
    // delete what the driver already scrolled to, and both cards look identical.
    // A tap on the old one used to stamp the NEW trip as Noted / Ready / Back
    // (the row is shared, so the write had no way to tell the cards apart).
    // The assignment stores the message id of the card it last sent; only a tap
    // on THAT message may drive the stage. Missing ids (map trimmed, older card,
    // repaint before the id was stored) stay permissive rather than locking the
    // driver out of their own trip.
    const tappedMessageId = this.callbackMessages.get(`${fromChatId}:${callbackId}`);
    if (tappedMessageId && assignment.telegramMessageId && String(tappedMessageId) !== assignment.telegramMessageId) {
      await this.call('answerCallbackQuery', {
        callback_query_id: callbackId,
        text: '⚠️ ဒီ message က ဟောင်းသွားပါပြီ — အသစ်ဆုံး assignment message ကို သုံးပါ',
      });
      return;
    }
    // "🏁 Back at Office — BOTH trips": two-tap confirm (arm → confirm within 30s)
    // — completing two requests from one tap must never be a single accidental press.
    // (AFTER the driver-binding check above — closing trips is a driver-only power.)
    if (action === 'b2b') {
      if (this.pendingCombinedBack.get(fromChatId) === assignmentId) {
        this.pendingCombinedBack.delete(fromChatId);
        try {
          await this.combinedBackAtOffice(assignmentId, { username: assignment.driver.name || 'driver-telegram' });
        } catch {
          /* the toast below still answers — completion failures surface via the per-trip stamps */
        }
        await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: '✅ ရုံးပြန်ရောက် — ခရီးစဉ် နှစ်ခုလုံး ပြီးပါပြီ' });
        return;
      }
      this.pendingCombinedBack.set(fromChatId, assignmentId);
      setTimeout(() => this.pendingCombinedBack.delete(fromChatId), 30_000).unref?.();
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'ခရီးစဉ် နှစ်ခုလုံး ပြီးကြောင်း အတည်ပြုရန် ထပ်နှိပ်ပါ' });
      return;
    }
    if (action === 'etacustom') {
      // arm the free-text ETA entry: the driver's next message becomes the ETA
      // (the assignment was already auth-checked above — this chat owns the card)
      this.pendingEtaCustom.set(fromChatId, { assignmentId: assignmentId, at: Date.now() });
      setTimeout(() => this.pendingEtaCustom.delete(fromChatId), 10 * 60_000).unref?.();
      await this.call('sendMessage', {
        chat_id: fromChatId,
        text: '✏️ ပြန်ရောက်မယ့် အချိန်ကို ရေးပါ — (ဥပမာ: 15:30 သို့မဟုတ် 3:30pm)',
      });
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'အချိန်ကို ရိုက်ထည့်ပါ' });
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
    // Stamp the stage BEFORE the completion step: completeAfterReturn() reads the
    // driver's own "Back at Office" as proof that a ride whose booking was released
    // at window end really happened (CAR-202611-0005). With the old order the stamp
    // was still missing at that moment, so the request stayed APPROVED and the list
    // kept calling it "not assigned".
    const updated = await this.applyAckStage(assignment.id, patch, action);
    if (action === 'returned') {
      await this.freeVehicle(assignment.id);
      await this.completeAfterReturn(assignment.requestId);
    }
    await this.editStageMessage(updated);
    await this.answerCallback(updated, callbackId, action);
    await this.audit.log({
      action: action === 'noted' ? 'DRIVER_NOTED' : action === 'arrived' ? 'DRIVER_ARRIVED' : 'DRIVER_RETURNED',
      module: 'CARS',
      recordId: updated.request.id,
      username: updated.driver?.name ?? 'driver',
      newValue: { driverNotedAt: updated.driverNotedAt, driverArrivedAt: updated.driverArrivedAt, driverBackAtOfficeAt: updated.driverBackAtOfficeAt },
    });
    // 🛣️ straight after the tap: ask for the dashboard photo, then the kilo
    if (action === 'arrived' || action === 'returned') {
      await this.askOdometer(updated.id, action === 'arrived' ? 'READY' : 'BACK').catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------
  // Odometer capture over Telegram (photo → kilo → recorded)
  // ------------------------------------------------------------------

  /**
   * Arm the capture for one assignment and ask the driver for the photo. The
   * stage itself was already stamped (the vehicle is free, the request closes);
   * this only fills in the distance so a forgotten photo can never stall a trip.
   */
  private async askOdometer(assignmentId: string, stage: 'READY' | 'BACK') {
    const a = await this.prisma.carAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        startOdoKm: true,
        endOdoKm: true,
        driver: { select: { telegramChatId: true } },
        request: { select: { docNumber: true } },
      },
    });
    const chatId = a?.driver?.telegramChatId;
    if (!a || !chatId) return;
    if (stage === 'READY' ? a.startOdoKm != null : a.endOdoKm != null) return; // already captured
    this.armOdo(chatId, assignmentId, stage);
    const head =
      stage === 'READY'
        ? `🚦 Ready ✓ — ${a.request.docNumber}\nကားမထွက်ခွာမီ odometer (ကီလိုမီတာ) ဓာတ်ပုံကို ဒီ chat ထဲ ပို့ပါ 📷`
        : `🏁 ရုံးပြန်ရောက် ✓ — ${a.request.docNumber}\nပြန်ရောက်ချိန် odometer ဓာတ်ပုံကို ဒီ chat ထဲ ပို့ပါ 📷`;
    await this.call('sendMessage', {
      chat_id: chatId,
      text: `${head}\nပြီးရင် ဂဏန်းကို ရိုက်ထည့်ပါ (ဥပမာ: 45210)။ /cancel ဖြင့် ပယ်ဖျက်နိုင်သည်။`,
    });
  }

  /**
   * Arm one chat for an odometer capture (photo → kilo) with an expiry.
   *
   * The window is 3 h, not 30 min: drivers tap "Back at office" and only send the
   * kilo after their next errand, and a capture that expired in between left the
   * photo unanswered (the bot went silent) and the trip without a return reading.
   */
  private armOdo(chatId: string, assignmentId: string, stage: 'READY' | 'BACK', photo?: { buffer: Buffer; size: number }, km?: number) {
    const at = Date.now();
    const entry: OdoPending = { assignmentId, stage, at };
    if (photo) entry.photo = photo;
    if (km != null) entry.km = km;
    this.pendingOdo.set(chatId, entry);
    // P8 — persist the capture. Memory alone lost the photo on every deploy; the
    // row now says which assignment/stage is waiting, and the file stays on disk.
    const data: Record<string, unknown> = { pendingOdoStage: stage, pendingOdoAt: new Date(at) };
    if (!photo) {
      // a fresh capture: the old photo belongs to a capture nobody finished
      data.pendingOdoPhoto = null;
      data.pendingOdoFileId = null;
    }
    if (km != null) data.pendingOdoKm = km;
    else if (!photo) data.pendingOdoKm = null;
    void Promise.resolve()
      .then(async () => {
        // A fresh capture orphans the file the previous stage left behind: the row
        // stops naming it and storePendingPhoto() only unlinks a file the column
        // still points at — so read the old name FIRST, then drop the file. This is
        // the "Ready photo sent, driver taps Back at office before typing the kilo"
        // path, which used to leave one JPEG per tap on the volume for ever.
        const old = !photo
          ? ((await this.prisma.carAssignment
              .findUnique({ where: { id: assignmentId }, select: { pendingOdoPhoto: true } })
              .catch(() => null))?.pendingOdoPhoto ?? null)
          : null;
        await this.prisma.carAssignment.update({ where: { id: assignmentId }, data });
        if (old && /^[0-9a-f-]{36}\.jpe?g$/i.test(old)) {
          try {
            fs.unlinkSync(path.join(this.pendingOdoDir(), old));
          } catch {
            /* already gone — nothing to reclaim */
          }
        }
      })
      .catch(() => undefined);
    setTimeout(() => {
      const p = this.pendingOdo.get(chatId);
      if (p && p.assignmentId === assignmentId && p.at === at) this.pendingOdo.delete(chatId);
    }, TelegramService.ODO_TTL_MS).unref?.();
  }

  /** Root of the upload volume — the same one CarsService stores photos under. */
  private uploadRoot(): string {
    return process.env.UPLOAD_PATH || '/app/uploads';
  }

  private pendingOdoDir(): string {
    return path.join(this.uploadRoot(), 'odometer', 'pending');
  }

  /**
   * Keep the driver's photo the moment it arrives.
   *
   * Until now it lived only in `pendingOdo`, so a deploy threw away photos the
   * driver had already sent. The file is written here and the row records which
   * assignment it belongs to; the reading itself is still the driver's typed
   * number, so this is evidence storage, nothing more.
   */
  private async storePendingPhoto(assignmentId: string, buffer: Buffer, fileId?: string): Promise<string | null> {
    try {
      fs.mkdirSync(this.pendingOdoDir(), { recursive: true });
      const name = `${randomUUID()}.jpg`;
      fs.writeFileSync(path.join(this.pendingOdoDir(), name), buffer, { mode: 0o600 });
      const old = await this.prisma.carAssignment
        .findUnique({ where: { id: assignmentId }, select: { pendingOdoPhoto: true } })
        .catch(() => null);
      await this.prisma.carAssignment.update({
        where: { id: assignmentId },
        data: { pendingOdoPhoto: name, pendingOdoFileId: fileId ?? null, pendingOdoAt: new Date() },
      });
      if (old?.pendingOdoPhoto && old.pendingOdoPhoto !== name) {
        try {
          fs.unlinkSync(path.join(this.pendingOdoDir(), old.pendingOdoPhoto));
        } catch {
          /* the row is the source of truth */
        }
      }
      return name;
    } catch (e) {
      this.logger.warn(`could not keep the pending odometer photo: ${(e as Error).message}`);
      return null;
    }
  }

  /** Read a kept photo back from disk (after a restart, or for the confirm tap). */
  private readPendingPhoto(name: string): { buffer: Buffer; size: number } | null {
    try {
      const buffer = fs.readFileSync(path.join(this.pendingOdoDir(), name));
      return buffer.length ? { buffer, size: buffer.length } : null;
    } catch {
      return null;
    }
  }

  private async pendingPhotoFromDb(assignmentId: string): Promise<{ buffer: Buffer; size: number } | null> {
    const row = await this.prisma.carAssignment
      .findUnique({ where: { id: assignmentId }, select: { pendingOdoPhoto: true } })
      .catch(() => null);
    return row?.pendingOdoPhoto ? this.readPendingPhoto(row.pendingOdoPhoto) : null;
  }

  /**
   * Rebuild an armed capture from the database — the whole point of persisting it:
   * a fresh process still knows which trip waits for its kilo, and still has the
   * photo, so the driver only has to type the number.
   */
  private async loadPending(chatId: string): Promise<OdoPending | null> {
    const since = new Date(Date.now() - TelegramService.ODO_PENDING_TTL_MS);
    const a = await this.prisma.carAssignment
      .findFirst({
        where: { pendingOdoStage: { not: null }, pendingOdoAt: { gte: since }, driver: { telegramChatId: chatId } },
        orderBy: { pendingOdoAt: 'desc' },
        select: { id: true, pendingOdoStage: true, pendingOdoAt: true, pendingOdoPhoto: true, pendingOdoKm: true },
      })
      .catch(() => null);
    if (!a?.pendingOdoStage || !a.pendingOdoAt) return null;
    const entry: OdoPending = {
      assignmentId: a.id,
      stage: a.pendingOdoStage === 'READY' ? 'READY' : 'BACK',
      at: a.pendingOdoAt.getTime(),
    };
    const photo = a.pendingOdoPhoto ? this.readPendingPhoto(a.pendingOdoPhoto) : null;
    if (photo) entry.photo = photo;
    if (a.pendingOdoKm != null) entry.km = a.pendingOdoKm;
    this.pendingOdo.set(chatId, entry);
    return entry;
  }

  /** Drop a capture: memory, the row's pending columns and the file on disk. */
  private async clearPending(assignmentId: string) {
    for (const [chatId, p] of this.pendingOdo) {
      if (p.assignmentId === assignmentId) this.pendingOdo.delete(chatId);
    }
    try {
      const row = await this.prisma.carAssignment.findUnique({
        where: { id: assignmentId },
        select: { pendingOdoPhoto: true },
      });
      // read the name off BEFORE the update clears the column — the row object can
      // be the same instance a mock/client hands back, and nulling first lost the file
      const photoName = row?.pendingOdoPhoto ?? null;
      await this.prisma.carAssignment.update({
        where: { id: assignmentId },
        data: { pendingOdoStage: null, pendingOdoPhoto: null, pendingOdoFileId: null, pendingOdoKm: null, pendingOdoAt: null },
      });
      if (photoName) {
        try {
          fs.unlinkSync(path.join(this.pendingOdoDir(), photoName));
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* best-effort — a stale row expires on its own */
    }
  }

  /**
   * [✓ မှန်] / [✏️ ဂဏန်း ပြင] on the "does this photo match the number" card.
   *
   * A photo that arrives AFTER a number is not recorded on its own: it could be a
   * fuel receipt or another car's dashboard, so the driver — who is looking at the
   * odometer — makes the pairing.
   */
  private async handleOdoCallback(data: string, chatId: string, callbackId: string) {
    const [, action, assignmentId] = data.split(':');
    const pending = this.pendingOdo.get(chatId) ?? (await this.loadPending(chatId));
    if (!pending || pending.assignmentId !== assignmentId) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'အချိန်ကုန်သွားပြီ — ဂဏန်း ပြန်ရိုက်ပါ' });
      return;
    }
    if (action === 'fix') {
      this.pendingOdo.set(chatId, { ...pending, km: undefined });
      void Promise.resolve()
        .then(() => this.prisma.carAssignment.update({ where: { id: assignmentId }, data: { pendingOdoKm: null } }))
        .catch(() => undefined);
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'ဂဏန်း ပြန်ရိုက်ပါ' });
      await this.call('sendMessage', {
        chat_id: chatId,
        text: '🔢 မှန်ကန်တဲ့ odometer ဂဏန်းကို ရိုက်ထည့်ပါ (ဥပမာ: 45210) — ဓာတ်ပုံက သိမ်းထားပြီးပါပြီ',
      });
      return;
    }
    const km = pending.km;
    const photo = pending.photo ?? (await this.pendingPhotoFromDb(assignmentId));
    if (km == null || !photo) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'မှတ်တမ်းတင် မရပါ — ဂဏန်း ပြန်ရိုက်ပါ' });
      return;
    }
    try {
      if (!this.odoRef) throw new Error('Odometer handler not ready');
      await this.odoRef.capture(assignmentId, { stage: pending.stage, km, photo }, { username: 'driver-telegram' });
      await this.clearPending(assignmentId);
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'မှတ်တမ်းတင်ပြီး' });
      await this.editCallbackMessage(chatId, callbackId, `✅ Odometer ${km.toLocaleString()} km မှတ်တမ်းတင်ပြီး`);
    } catch (e) {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: 'မှတ်တမ်းတင် မရပါ' });
      await this.call('sendMessage', {
        chat_id: chatId,
        text: `⚠️ ${(e as Error).message || 'မှတ်တမ်းတင် မရပါ'} — ဂဏန်း ပြန်ရိုက်ပါ သို့မဟုတ် /cancel`,
      });
    }
  }

  /**
   * Re-arm a capture the driver never finished — used when a photo arrives and no
   * capture is waiting for it (the window expired, or a deploy cleared it).
   *
   * Which stage? Only what the taps already prove: a returned trip whose return
   * kilo is missing wants BACK; an arrived trip whose departure kilo is missing
   * wants READY. Anything less certain returns null and the photo is just stored
   * (a fuel receipt must never become odometer evidence).
   */
  private async resumeOdometerCapture(chatId: string): Promise<{ assignmentId: string; stage: 'READY' | 'BACK' } | null> {
    const driver = await this.prisma.driver.findFirst({
      where: { telegramChatId: chatId },
      select: { id: true },
    }).catch(() => null);
    if (!driver) return null;
    // only the day's trips: an old unfinished row must not turn a receipt photo
    // sent today into yesterday's odometer evidence
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const trips = await this.prisma.carAssignment.findMany({
      where: {
        driverId: driver.id,
        OR: [{ driverBackAtOfficeAt: { gte: since } }, { driverArrivedAt: { gte: since } }],
      },
      orderBy: { assignedAt: 'desc' },
      take: 5,
      select: { id: true, startOdoKm: true, endOdoKm: true, driverArrivedAt: true, driverBackAtOfficeAt: true },
    }).catch(() => []);
    for (const t of trips) {
      if (t.driverBackAtOfficeAt && t.endOdoKm == null) return { assignmentId: t.id, stage: 'BACK' };
      if (t.driverArrivedAt && t.startOdoKm == null) return { assignmentId: t.id, stage: 'READY' };
    }
    return null;
  }

  /** Driver sent the dashboard photo: keep it until the number arrives. */
  private async handleOdoPhoto(chatId: string, photos: { file_id: string; file_size?: number }[]) {
    const pending = this.pendingOdo.get(chatId);
    if (!pending) return;
    const best = [...photos].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
    if (!best) return;
    if ((best.file_size ?? 0) > 5 * 1024 * 1024) {
      await this.call('sendMessage', { chat_id: chatId, text: '⚠️ ဓာတ်ပုံ ကြီးလွန်းသည် (အများဆုံး 5 MB) — သေးငယ်သော ဓာတ်ပုံ ပြန်ပို့ပါ' });
      return;
    }
    const photo = await this.fetchPhoto(best.file_id).catch(() => null);
    if (!photo) {
      await this.call('sendMessage', { chat_id: chatId, text: '⚠️ ဓာတ်ပုံ မရယူနိုင်ပါ — ထပ်ပို့ပါ' });
      return;
    }
    // keep the file (P8) and bind it to this assignment, then re-arm with a fresh window
    await this.storePendingPhoto(pending.assignmentId, photo.buffer, best.file_id);
    try {
      this.odoPhotoRef?.afterStore?.(pending.assignmentId, photo);
    } catch {
      /* the reader is an observer — it must never break the capture */
    }
    this.armOdo(chatId, pending.assignmentId, pending.stage, photo, pending.km);
    if (pending.km != null) {
      // P7 — the number came first, so the photo is offered as evidence and the
      // driver confirms the pairing (a receipt must never become the odometer)
      await this.call('sendMessage', {
        chat_id: chatId,
        text: `📷 ဓာတ်ပုံ ရပါပြီ — သင်ရိုက်ထည့်ထားတဲ့ ဂဏန်း ${pending.km.toLocaleString()} နှင့် ဒီဓာတ်ပုံ ကိုက်ညီပါသလား?`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✓ မှန်တယ် — မှတ်တမ်းတင်', callback_data: `odo:ok:${pending.assignmentId}` },
              { text: '✏️ ဂဏန်း ပြင်', callback_data: `odo:fix:${pending.assignmentId}` },
            ],
          ],
        },
      });
      return;
    }
    await this.call('sendMessage', {
      chat_id: chatId,
      text: '✅ ဓာတ်ပုံ ရပါပြီ — ယခု odometer ဂဏန်းကို ရိုက်ထည့်ပါ (ဥပမာ: 45210)',
    });
  }

  /** One photo from the bot's file API, size-checked. null = retry / too big / no token. */
  private async fetchPhoto(fileId: string): Promise<{ buffer: Buffer; size: number } | null> {
    const { token } = await this.config();
    if (!token) return null;
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file?.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
    return { buffer, size: buffer.length };
  }

  /**
   * The newest dashboard photo this chat already sent, from the inbound log.
   *
   * Drivers routinely send the photo a few seconds BEFORE they tap Ready / Back
   * (or send it twice and type the number later). That photo was stored (P4) but
   * the armed capture answered "send the photo first" — so the reading never made
   * it to the trip and the trip showed no kilo photo at all. Look the evidence up
   * instead of asking again. Never reaches past the assignment's own start (an
   * earlier trip's photo must not become this trip's evidence).
   */
  private async recentOdoPhoto(chatId: string, assignmentId: string): Promise<{ buffer: Buffer; size: number } | null> {
    const a = await this.prisma.carAssignment.findUnique({ where: { id: assignmentId }, select: { assignedAt: true } });
    if (!a) return null;
    const windowStart = new Date(Date.now() - 6 * 60 * 60_000);
    const since = a.assignedAt && a.assignedAt > windowStart ? a.assignedAt : windowStart;
    const row = await this.prisma.telegramInboundMessage.findFirst({
      where: { chatId, kind: 'PHOTO', photoFileId: { not: null }, announcementId: null, receivedAt: { gte: since } },
      orderBy: { receivedAt: 'desc' },
      select: { photoFileId: true },
    });
    if (!row?.photoFileId) return null;
    return this.fetchPhoto(row.photoFileId).catch(() => null);
  }

  /** Driver sent text while a capture is armed: the number (or /cancel). true = consumed. */
  private async handleOdoText(chatId: string, text: string): Promise<boolean> {
    // P8 — a capture survives a deploy: the row still says which trip is waiting
    const pending = this.pendingOdo.get(chatId) ?? (await this.loadPending(chatId));
    if (!pending) return false;
    if (text === '/cancel') {
      await this.clearPending(pending.assignmentId);
      await this.call('sendMessage', { chat_id: chatId, text: '🛣️ Odometer ထည့်သွင်းမှု ပယ်ဖျက်ပြီး — Administration မှ နောက်မှ ထည့်နိုင်သည်' });
      return true;
    }
    // any other command aborts the capture instead of being swallowed by it
    if (text.startsWith('/')) {
      this.pendingOdo.delete(chatId);
      return false;
    }
    // the photo may have arrived BEFORE the tap armed this capture (or before a
    // re-arm) — it is already in the inbound log, so use it rather than nagging
    let photo: { buffer: Buffer; size: number } | undefined = pending.photo;
    if (!photo) {
      photo = (await this.recentOdoPhoto(chatId, pending.assignmentId).catch(() => null)) ?? undefined;
      if (!photo) photo = (await this.pendingPhotoFromDb(pending.assignmentId)) ?? undefined;
      if (photo) this.pendingOdo.set(chatId, { ...pending, photo, at: Date.now() });
    }
    if (!photo) {
      // P7 — the number is KEPT, not thrown away: CAR-202611-0023 lost 341,363
      // exactly here (the driver typed it 80 minutes after the photo window shut).
      const digits = text.replace(/[,\s]/g, '');
      if (!/^\d{1,7}$/.test(digits)) {
        await this.call('sendMessage', {
          chat_id: chatId,
          text: '🔢 ဂဏန်းသက်သက် ရိုက်ထည့်ပါ သို့မဟုတ် odometer ဓာတ်ပုံကို ပို့ပါ (/cancel ဖြင့် ပယ်ဖျက်)',
        });
        return true;
      }
      const num = Number(digits);
      this.armOdo(chatId, pending.assignmentId, pending.stage, undefined, num);
      await this.call('sendMessage', {
        chat_id: chatId,
        text: `🔢 ဂဏန်း ${num.toLocaleString()} ကို မှတ်ထားပါတယ် — ယခု odometer ဓာတ်ပုံကို ပို့ပါ 📷\n(ဓာတ်ပုံ မပို့နိုင်ရင် Administration က နောက်မှ ဖြည့်နိုင်သည် — ဂဏန်း မပျောက်ပါ)`,
      });
      return true;
    }
    const clean = text.replace(/[,\s]/g, '');
    if (!/^\d{1,7}$/.test(clean)) {
      await this.call('sendMessage', { chat_id: chatId, text: '🔢 ဂဏန်းသက်သက် ရိုက်ထည့်ပါ (ဥပမာ: 45210)' });
      return true;
    }
    const km = Number(clean);
    this.pendingOdo.delete(chatId);
    try {
      if (!this.odoRef) throw new Error('Odometer handler not ready');
      await this.odoRef.capture(
        pending.assignmentId,
        { stage: pending.stage, km, photo },
        { username: 'driver-telegram' },
      );
      // the reading landed — the kept photo and the pending row are done
      await this.clearPending(pending.assignmentId);
      await this.call('sendMessage', {
        chat_id: chatId,
        text: `✅ Odometer ${km.toLocaleString()} km မှတ်တမ်းတင်ပြီး — ကျေးဇူးတင်ပါသည်`,
      });
    } catch (e) {
      // keep the capture armed so the driver can correct the number
      this.armOdo(chatId, pending.assignmentId, pending.stage, photo);
      await this.call('sendMessage', {
        chat_id: chatId,
        text: `⚠️ ${(e as Error).message || 'မှတ်တမ်းတင် မရပါ'} — ဂဏန်း ပြန်ရိုက်ထည့်ပါ သို့မဟုတ် /cancel`,
      });
    }
    return true;
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
    // live push — open Car Panels / dashboards refetch immediately (best-effort)
    try {
      this.events.publish('assignment.updated', { requestId: updated.request.id });
      this.events.publish('driver.updated', { driverId: updated.driver?.id });
    } catch {
      /* SSE push is best-effort */
    }
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
    // same order as the Telegram callback: stamp first, then complete
    const updated = await this.applyAckStage(assignmentId, patch, action);
    if (action === 'returned') {
      await this.freeVehicle(assignmentId);
      await this.completeAfterReturn(assignment.requestId);
    }
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: action === 'noted' ? 'DRIVER_NOTED' : action === 'arrived' ? 'DRIVER_ARRIVED' : 'DRIVER_RETURNED',
      module: 'CARS',
      recordId: updated.request.id,
      newValue: { manual: true, via: actor.username, ...patch },
    });
    return updated;
  }

  /**
   * Drop an armed odometer capture for this assignment — a re-assign or release
   * makes the driver's half-finished photo/number belong to a car that is no
   * longer theirs, and writing it to the new row would corrupt its history.
   */
  forgetOdometer(assignmentId: string) {
    // a re-assign/release makes a half-finished capture belong to nobody
    void this.clearPending(assignmentId);
  }

  /** "Back at Office": free the vehicle + driver immediately (also on re-assign paths). */
  private async freeVehicle(assignmentId: string) {
    const a = await this.prisma.carAssignment.findUnique({
      where: { id: assignmentId },
      select: { vehicleId: true, driverId: true, estimatedReturnAt: true, carRequest: { select: { sharedTripId: true } } },
    });
    if (!a) return;
    // Another LIVE assignment may still hold this car or driver — a stale driver
    // card (its request was released and the car re-assigned to someone else)
    // must not hand that trip's vehicle back to the pool. Convoy members of the
    // SAME group are one ride (one Back at Office ends it for all), so they do
    // not block. The guard is best-effort: a failed lookup keeps the old freeing
    // behaviour rather than blocking the driver's acknowledgement.
    const group = a.carRequest?.sharedTripId ?? null;
    let blocking: Array<{ vehicleId: string; driverId: string | null }> = [];
    try {
      const others = await this.prisma.carAssignment.findMany({
        where: {
          id: { not: assignmentId },
          releasedAt: null,
          driverBackAtOfficeAt: null,
          OR: [{ vehicleId: a.vehicleId }, ...(a.driverId ? [{ driverId: a.driverId }] : [])],
        },
        select: { vehicleId: true, driverId: true, carRequest: { select: { sharedTripId: true } } },
      });
      blocking = others
        .filter((o) => !(group && o.carRequest?.sharedTripId === group))
        .map((o) => ({ vehicleId: o.vehicleId, driverId: o.driverId }));
    } catch {
      /* guard is best-effort — never break the ack because a lookup failed */
    }
    if (!blocking.some((o) => o.vehicleId === a.vehicleId)) {
      await this.prisma.vehicle.update({ where: { id: a.vehicleId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
    }
    if (a.driverId && !blocking.some((o) => o.driverId === a.driverId)) {
      await this.prisma.driver.update({ where: { id: a.driverId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
    }
    // Back at Office is the physical truth — clear any ⏰ ETA so the car's
    // availability math falls back to the planned window immediately
    if (a.estimatedReturnAt != null) {
      await this.prisma.carAssignment.update({ where: { id: assignmentId }, data: { estimatedReturnAt: null } }).catch(() => undefined);
    }
  }

  /**
   * Auto-complete the request once the driver signalled "Back at Office".
   * Previously only the vehicle/driver were freed while the document stayed
   * IN_PROGRESS until Administration manually completed (or cancelled) it —
   * list views showed a physically finished trip as still running.
   * Guard: a trip the driver STARTED keeps its mileage close-out with the
   * Administration trip form (completeTrip); anything not live is untouched.
   * Best-effort — the driver's ack must never fail because of this.
   */
  private async completeAfterReturn(requestId: string | undefined) {
    if (!requestId) return;
    try {
      const done = await this.prisma.$transaction(async (tx: {
        requestDocument: { findUnique: (a: unknown) => Promise<{ status: string; docNumber: string; requesterId: string; carRequest?: { endDate?: Date | null } | null; carAssignment?: { releasedAt?: Date | null; driverBackAtOfficeAt?: Date | null; vehicleId?: string | null; driverId?: string | null; trip?: { status: string } | null } | null } | null>; update: (a: unknown) => Promise<unknown> };
        carRequest: { update: (a: unknown) => Promise<unknown> };
      }) => {
        const r = await tx.requestDocument.findUnique({
          where: { id: requestId },
          select: {
            status: true, docNumber: true, requesterId: true,
            carRequest: { select: { endDate: true } },
            carAssignment: {
              select: { releasedAt: true, driverBackAtOfficeAt: true, vehicleId: true, driverId: true, trip: { select: { status: true } } },
            },
          },
        });
        if (!r) return null;
        // The janitor releases a booking at its window end and re-queues the
        // request as APPROVED. A driver still on the road reaches Telegram a
        // minute later: the taps land on that released assignment, the trip did
        // happen, and gating completion on IN_PROGRESS alone left the request
        // APPROVED with every ack stamped (CAR-202611-0005 on 2026-11-02 —
        // vehicle 10:30 release, "back at office" 10:40). Accept the driver's
        // own return as proof, whatever the row status became meanwhile.
        // ...but only once that window really is over. An ADMIN release hands an
        // upcoming booking back to the assign queue: a tap from the driver's old
        // card (the car is already gone) closed a ride that has not happened yet
        // and left the request COMPLETED, so it could never be re-assigned.
        const windowEnded = !r.carRequest?.endDate || r.carRequest.endDate.getTime() <= Date.now();
        const releasedButReturned =
          r.status === 'APPROVED' && r.carAssignment?.driverBackAtOfficeAt != null && windowEnded;
        if (r.status !== 'IN_PROGRESS' && !releasedButReturned) return null;
        if (r.carAssignment?.trip?.status === 'STARTED') return null; // mileage open — Admin completes via the trip form
        await tx.carRequest.update({
          where: { requestId },
          data: {
            status: 'COMPLETED',
            // re-link the car and driver the janitor unlinked, so the closed
            // request keeps its cost/usage history
            ...(r.carAssignment?.vehicleId ? { vehicleId: r.carAssignment.vehicleId } : {}),
            ...(r.carAssignment?.driverId ? { driverId: r.carAssignment.driverId } : {}),
          },
        });
        await tx.requestDocument.update({ where: { id: requestId }, data: { status: 'COMPLETED' } });
        return r;
      });
      if (!done) return;
      await this.audit.log({
        action: 'REQUEST_AUTO_COMPLETED',
        module: 'CARS',
        recordId: requestId,
        newValue: {
          reason:
            done.status === 'IN_PROGRESS'
              ? 'Back at Office'
              : 'Back at Office — booking had already been released at window end',
          auto: true,
        },
      });
      await this.prisma.notification.create({
        data: {
          userId: done.requesterId,
          type: 'TRIP_COMPLETED',
          title: `✅ Trip completed — ${done.docNumber}`,
          body: 'Driver is back at office — the car request was closed automatically.',
          link: `/requests/${requestId}`,
          requestId,
        },
      });
      await this.mirrorToUser(done.requesterId, `✅ Trip completed — ${done.docNumber}`, 'Driver is back at office — the car request was closed automatically.', `/requests/${requestId}`).catch(() => undefined);
    } catch {
      /* best-effort — freeing the vehicle must never fail the driver's ack */
    }
  }

  private async answerCallback(
    a: PrismaCarAssignment,
    callbackId: string,
    action: string,
  ) {
    const label = action === 'noted'
      ? '✓ လက်ခံပြီး — Administration ကို အသိပေးပြီးပါပြီ'
      : action === 'arrived'
        ? '🚦 ကား အသင့် — တောင်းခံသူနှင့် Administration ကို အသိပေးပြီးပါပြီ'
        : '🏁 ရုံးပြန်ရောက်ပြီး — ကား ပြန်လွတ်ပါပြီ';
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: label });
  }

  private async notifyStage(
    a: PrismaCarAssignment,
    action: 'noted' | 'arrived' | 'returned',
  ) {
    const doc = a.request.docNumber;
    const driverName = a.driver?.name ?? 'Driver';
    // RBAC-native: the broadcast goes to whoever can assign cars/trips
    const adminIds = await this.permissions.usersWithPermissions(['cars.assign']);
    const link = `/requests/${a.request.id}`;
    // The admin who MADE this assignment watches the driver's progress live in
    // their own chat (they dispatched it — Noted/Ready/Back reach the dispatcher
    // too) — deduped against the broadcast so a chat never gets
    // the same stage message twice.
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
    sharedCtx?: { sharedTripId: string | null },
  ) {
    const btn = (done: boolean, label: string, action: string) => ({
      text: done ? `✅ ${label}` : label,
      callback_data: done ? 'noop' : `${action}:${assignmentId}`,
    });
    const rows = [[
      btn(!!a.driverNotedAt, '✓ Noted', 'noted'),
      btn(!!a.driverArrivedAt, '🚦 Ready', 'arrived'),
      btn(!!a.driverBackAtOfficeAt, '🏁 Back at Office', 'returned'),
    ]];
    // ⏰ Delay — running late? report the new expected return time. Quick options
    // (+30 မိနစ် / +1 နာရီ / +3 နာရီ) arm a one-tap report; AMS + the requester
    // are notified and the car stays blocked until the ETA (or Back at Office).
    if (!a.driverBackAtOfficeAt) {
      rows.push([{ text: '⏰ နောက်ကျ', callback_data: `eta:0:${assignmentId}` }]);
    }
    // shared trip: a one-tap way to close BOTH rides at once (two-tap confirm).
    // Only until this card's own Back is pressed — after that the peer keeps its
    // own button and the regular per-card flow finishes it.
    if (sharedCtx?.sharedTripId && !a.driverBackAtOfficeAt) {
      rows.push([{ text: '🏁 Back at Office — BOTH trips', callback_data: `b2b:${assignmentId}` }]);
    }
    return { inline_keyboard: rows };
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
      carRequest?: { destination: string; pickupLocation: string | null; startDate: Date; endDate: Date; timeSlot: string; purpose: string | null; specialRequest?: string | null; sharedTripId?: string | null; passengers?: number | null } | null;
      estimatedReturnAt?: Date | null;
      sharedRiders?: { docNumber: string; destination: string; requester: { fullName: string } }[] | null;
    },
    stages?: { noted?: Date | null; arrived?: Date | null; back?: Date | null } | null,
    sharedRiders?: { docNumber: string; destination: string; requester: { fullName: string } }[] | null,  ): string {
    const cr = a.carRequest;
    if (!cr) return escapeHtml(`🚗 ကား တာဝန်ပေးအပ်ပြီး — ${a.request.docNumber}`);
    // the rider list arrives as the 3rd parameter (sendAssignment / editStageMessage);
    // a.sharedRiders is kept as a legacy fallback — the prisma row never carries it,
    // so the section silently never rendered before this was fixed.
    const riders = sharedRiders ?? a.sharedRiders ?? null;
    const when = `${fmtDate(cr.startDate)} · ${fmtTime(cr.startDate)} – ${fmtTime(cr.endDate)} (${cr.timeSlot})`;
    const pickup = cr.pickupLocation || '—';
    const phone = a.request.requester.employee?.phone;
    const lines = [
      `<b>🚗 ကား တာဝန်ပေးအပ်ပြီး — ${escapeHtml(a.request.docNumber)} · ${escapeHtml(cr.destination)}</b>`,
      ``,
      `📅 ${escapeHtml(when)}`,
      `🚙 ${a.vehicle ? escapeHtml(`${a.vehicle.brandModel} · ${a.vehicle.vehicleNo}`) : '—'}`,
      `📍 ကားထွက်မည့်နေရာ: ${escapeHtml(pickup)}`,
      `🗺 သွားရမည့်နေရာ: ${escapeHtml(cr.destination)}`,
      `👥 လူဦးရေ: ${cr.passengers ?? 1}`,
      `👤 တောင်းခံသူ: ${escapeHtml(a.request.requester.fullName)}${phone ? ` (${escapeHtml(phone)})` : ''}`,
      cr.purpose ? `📝 ${escapeHtml(cr.purpose)}` : '',
      // driver-reported ETA (⏰ Delay) — replaces the planned end on the card
      // until Back at Office clears it
      a.estimatedReturnAt ? `⏰ ခန့်မှန်း ပြန်ရောက်ချိန်: ${fmtTime(a.estimatedReturnAt)} (${fmtDate(a.estimatedReturnAt)})` : '',
      // requester's special instruction ("wait and call me", "carrying goods…")
      // — the driver must see it BEFORE heading out
      cr.specialRequest ? `⭐ အထူး ညွှန်ကြားချက်: ${escapeHtml(cr.specialRequest)}` : '',
      // shared trip — the driver sees who else is riding the same car
      ...(riders && riders.length > 0
        ? [``, `<b>🧑‍🤝‍🧑 ခရီးစဉ် မျှဝေ</b>`, ...riders.map((r) => `• ${escapeHtml(r.docNumber)} — ${escapeHtml(r.destination)} · ${escapeHtml(r.requester.fullName)}`)]
        : []),
    ].filter((l) => l !== undefined);
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${pickup} to ${cr.destination}`)}`;
    // Burmese guidance — the #1 operational failure is a driver who never taps
    // "🏁 Back at Office" (the car then blocks until the auto-close cron fires)
    const guide = '<i>📌 Trip ပြီးရင် ရုံးပြန်ရောက်ချိန်မှာ "🏁 Back at Office" နှိပ်ပါ — မနှိပ်ဘဲထားခဲ့ရင် window ကုန်ပြီး မကြာမီ အလိုအလျောက် ပိတ်သွားမည်။</i>';
    if (stages) {
      if (stages.noted) lines.push(`✓ လက်ခံပြီး · ${fmtTime(stages.noted)}`);
      if (stages.arrived) lines.push(`🚦 ကား အသင့် · ${fmtTime(stages.arrived)}`);
      if (stages.back) lines.push(`🏁 ရုံးပြန်ရောက် · ${fmtTime(stages.back)}`);
      lines.push('', guide);
    } else {
      lines.push(`ခရီးစဉ်ကို လက်ခံကြောင်း သိရအောင် "✓ Noted" ကို နှိပ်ပါ။`, '', guide);
    }
    return `${lines.join('\n')}\n🗺 <a href="${mapsUrl}">မြေပုံတွင် ကြည့်ရန်</a>`;
  }

  /** Push the assignment message (all three stage buttons) to the driver's chat.
   *  editInPlace=true repaints the already-tracked card instead of posting a duplicate. */
  async sendAssignment(assignmentId: string, editInPlace = false) {
    const a = await this.prisma.carAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        driver: true,
        vehicle: true,
        carRequest: { select: { destination: true, pickupLocation: true, startDate: true, endDate: true, timeSlot: true, purpose: true, specialRequest: true, sharedTripId: true, passengers: true } },
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
    // shared trip: list the other riders of the same group for the driver
    const sharedRiders = await this.sharedRidersFor(a.request.docNumber, cr.sharedTripId);
    const { token, enabled } = await this.config();
    if (!token || !enabled) return;

    const keyboard = this.assignmentKeyboard(a, a.id, { sharedTripId: cr.sharedTripId ?? null });
    if (editInPlace && a.telegramMessageId) {
      const edited = await this.editMessage(a.driver.telegramChatId, Number(a.telegramMessageId), this.assignmentBody(a, { noted: a.driverNotedAt, arrived: a.driverArrivedAt, back: a.driverBackAtOfficeAt }, sharedRiders), keyboard).catch(() => false);
      if (edited) return; // card repainted in place — no duplicate posted
    }
    const message = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: a.driver.telegramChatId,
      text: this.assignmentBody(a, undefined, sharedRiders),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
    if (message?.message_id) {
      await this.prisma.carAssignment.update({
        where: { id: a.id },
        data: { telegramMessageId: String(message.message_id) },
      });
    }
    // NOTE: no automatic group fan-out here — sendAssignment is called per-card BY
    // repaintDriverCards(); fanning out from inside would recurse forever. Entry
    // points (share-assign, combined Back) call repaintDriverCards() explicitly.
  }

  /** Repaint the driver's message for the current stage — same card, progress lines + grayed buttons. */
  private async editStageMessage(a: PrismaCarAssignment) {
    if (!a.telegramMessageId || !a.driver?.telegramChatId) return;
    const { token, enabled } = await this.config();
    if (!token || !enabled) return;
    const sharedCtx = await this.sharedCtx(a.id);
    // stage repaints must keep the 🧑‍🤝‍🧑 rider section (and the combined Back button
    // stays until this card's own Back) — fetch riders for shared groups here too
    const riders = await this.sharedRidersFor(a.request.docNumber, sharedCtx?.sharedTripId).catch(() => null);

    await this.call('editMessageText', {
      chat_id: a.driver.telegramChatId,
      message_id: Number(a.telegramMessageId),
      text: this.assignmentBody(a, { noted: a.driverNotedAt, arrived: a.driverArrivedAt, back: a.driverBackAtOfficeAt }, riders),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: this.assignmentKeyboard(a, a.id, sharedCtx),
    });
  }

  /** sharedTripId of an assignment's car request (null when unshared / row missing). */
  private async sharedCtx(assignmentId: string): Promise<{ sharedTripId: string | null } | undefined> {
    try {
      const row = await this.prisma.carAssignment.findUnique({
        where: { id: assignmentId },
        select: { carRequest: { select: { sharedTripId: true } } },
      });
      return { sharedTripId: row?.carRequest?.sharedTripId ?? null };
    } catch {
      return undefined; // unmocked prisma in tests — plain keyboard, no combined row
    }
  }

  /** Other riders of a shared-trip group (doc, destination, requester) — null for solo trips. */
  private async sharedRidersFor(
    ownDocNumber: string,
    group: string | null | undefined,
  ): Promise<Array<{ docNumber: string; destination: string; requester: { fullName: string } }> | null> {
    if (!group) return null;
    const riders = await this.prisma.requestDocument.findMany({
      where: {
        docType: 'CAR_REQUEST',
        status: { in: ['APPROVED', 'IN_PROGRESS'] },
        carRequest: { sharedTripId: group },
      },
      select: { docNumber: true, requester: { select: { fullName: true } }, carRequest: { select: { destination: true } } },
      orderBy: { docNumber: 'asc' },
    });
    return riders
      .filter((r) => r.docNumber !== ownDocNumber)
      .map((r) => ({ docNumber: r.docNumber, destination: r.carRequest?.destination ?? '—', requester: { fullName: r.requester.fullName } }));
  }

  /**
   * Shared-trip repaint — re-render EVERY active member's driver card through the
   * real sendAssignment() so all cards carry the full 🧑‍🤝‍🧑 Shared trip rider list
   * and the combined Back button. Idempotent: cards already showing the same
   * content are a Telegram "message is not modified" no-op. Never throws.
   */
  async repaintDriverCards(assignmentId: string) {
    try {
      const row = await this.prisma.carAssignment.findUnique({
        where: { id: assignmentId },
        select: { carRequest: { select: { sharedTripId: true } } },
      });
      const group = row?.carRequest?.sharedTripId;
      if (!group) return; // plain solo trip — nothing to fan out
      const members = await this.prisma.requestDocument.findMany({
        where: {
          docType: 'CAR_REQUEST',
          status: 'IN_PROGRESS',
          carRequest: { sharedTripId: group },
        },
        select: { carAssignment: { select: { id: true } } },
        orderBy: { docNumber: 'asc' },
      });
      for (const m of members) {
        const id = m.carAssignment?.id;
        if (!id) continue;
        // prefer an IN-PLACE edit of the card the driver already has — sendAssignment
        // would post a DUPLICATE card every time the group changes (two joins = three
        // identical cards in the driver's chat)
        const a = await this.prisma.carAssignment.findUnique({ where: { id }, select: { telegramMessageId: true } }).catch(() => null);
        if (a?.telegramMessageId) {
          await this.sendAssignment(id, true).catch(() => undefined);
        } else {
          await this.sendAssignment(id).catch(() => undefined);
        }
      }
    } catch {
      /* repaint is a nicety — must never break assign/ack flows */
    }
  }

  /**
   * Combined "Back at Office — BOTH trips" for a shared pair: free the car+driver
   * ONCE, stage the ack timestamps on every still-active member, auto-complete
   * each request (same guards as a single Back), repaint both cards ✅.
   * Returns the per-trip outcomes for the audit log.
   */
  async combinedBackAtOffice(assignmentId: string, actor: { userId?: string; username: string }) {
    const first = await this.prisma.carAssignment.findUnique({ where: { id: assignmentId } });
    if (!first) return [];
    const row = await this.prisma.carAssignment.findUnique({
      where: { id: assignmentId },
      select: { carRequest: { select: { sharedTripId: true } } },
    });
    const group = row?.carRequest?.sharedTripId;
    const members: Array<{ carAssignment: { id: string } | null }> = group
      ? await this.prisma.requestDocument.findMany({
          where: { docType: 'CAR_REQUEST', status: 'IN_PROGRESS', carRequest: { sharedTripId: group } },
          select: { carAssignment: { select: { id: true } } },
          orderBy: { docNumber: 'asc' },
        })
      : [{ carAssignment: { id: assignmentId } }];
    const ids = [...new Set(members.map((m) => m.carAssignment?.id).filter((v): v is string => !!v))];
    if (!ids.includes(assignmentId)) ids.push(assignmentId);

    // mileage safety: if ANY member's trip was STARTED (odometer open), keep the
    // car+driver reserved — Administration must close the mileage via the trip
    // form first (same guard as the single Back-at-Office auto-complete)
    let anyStarted = false;
    for (const id of ids) {
      const t = await this.prisma.carAssignment.findUnique({ where: { id }, select: { trip: { select: { status: true } } } }).catch(() => null);
      if ((t as { trip?: { status?: string } } | null)?.trip?.status === 'STARTED') anyStarted = true;
    }
    if (!anyStarted) {
      await this.freeVehicle(assignmentId); // one car, one driver — freeing once is enough
    }
    const now = new Date();
    const results: Array<{ requestId: string; done: boolean }> = [];
    for (const id of ids) {
      const a = await this.prisma.carAssignment.findUnique({ where: { id } });
      if (!a || a.driverBackAtOfficeAt) {
        if (a) results.push({ requestId: a.requestId, done: false }); // already closed — skip
        continue;
      }
      await this.applyAckStage(id, {
        driverBackAtOfficeAt: now,
        ...(a.driverNotedAt ? {} : { driverNotedAt: now }),
        ...(a.driverArrivedAt ? {} : { driverArrivedAt: now }),
      }, 'returned');
      await this.completeAfterReturn(a.requestId);
      await this.audit.log({
        ...(actor.userId ? { userId: actor.userId } : {}), username: actor.username,
        action: 'DRIVER_RETURNED', module: 'CARS', recordId: a.requestId,
        newValue: { combinedBack: true, groupId: group ?? null, ...actor },
      });
      results.push({ requestId: a.requestId, done: true });
    }
    await this.repaintDriverCards(assignmentId);
    // 🛣️ the car came back: ask for the return odometer (photo → kilo)
    await this.askOdometer(assignmentId, 'BACK').catch(() => undefined);
    return results;
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

  /**
   * Administration shifted the trip time — tell the assigned driver directly
   * (they hold no AMS account) so they plan the new window.
   */
  async notifyDriverOfTimeChange(requestId: string, docNumber: string, driverId: string, start: Date, end: Date, comment?: string) {
    try {
      const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver?.telegramChatId) return;
      const lines = [
        `🕒 <b>${escapeHtml(docNumber)} — time changed by Administration</b>`,
        `New schedule: ${escapeHtml(yangonShort(start))} → ${escapeHtml(yangonShort(end))}.`,
      ];
      if (comment) lines.push(`Note: ${escapeHtml(comment)}`);
      await this.call('sendMessage', { chat_id: driver.telegramChatId, text: lines.join('\n'), parse_mode: 'HTML' });
      await this.audit.log({
        action: 'TELEGRAM_DRIVER_TIMECHANGE_NOTIFIED', module: 'CARS', recordId: requestId,
        newValue: { driver: driver.name, start: start.toISOString(), end: end.toISOString() },
      });
    } catch {
      /* notification must never break the time shift */
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
  /** message_id of the most recent successful sendMessage via sendRaw/call —
   *  lets the /car form track its live card without exposing call(). */
  lastSentMessageId?: number;

  async sendRaw(chatId: string, text: string, extra: Record<string, unknown> = {}) {
    const sent = await this.call<{ message_id?: number }>('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    if (sent?.message_id) this.lastSentMessageId = sent.message_id;
  }

  /**
   * Send up to 10 local image files as ONE Telegram photo album (sendMediaGroup,
   * multipart upload) — announcement photos arrive as real viewable photos, not
   * links. Caption rides on the first item. Silent no-op when disabled/unbound;
   * never throws (notifications must not break on Telegram hiccups).
   */
  async sendPhotoAlbum(chatId: string, files: string[], caption = ''): Promise<Array<{ message_id: number }> | null> {
    const paths = files
      .filter((p) => p && fs.existsSync(p) && fs.statSync(p).size <= 10 * 1024 * 1024)
      .slice(0, 10);
    if (paths.length === 0) return null;
    const { token, enabled } = await this.config();
    if (!token || !enabled) return null;
    try {
      if (paths.length === 1) {
        const one = await this.uploadMedia('sendPhoto', chatId, paths[0], caption ? { caption, parse_mode: 'HTML' } : {});
        return one ? [one] : null;
      }
      const fd = new FormData();
      fd.append('chat_id', chatId);
      fd.append('media', JSON.stringify(paths.map((p, i) => ({
        type: 'photo',
        media: `attach://photo${i}`,
        ...(i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
      }))));
      paths.forEach((p, i) => fd.append(`photo${i}`, new Blob([fs.readFileSync(p)]), path.basename(p)));
      const res = await fetch(API(token, 'sendMediaGroup'), { method: 'POST', body: fd });
      const json = (await res.json()) as { ok: boolean; result?: Array<{ message_id: number }>; description?: string };
      if (!json.ok) {
        this.logger.warn(`Telegram sendMediaGroup failed: ${json.description ?? res.status}`);
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      this.logger.warn(`Telegram sendMediaGroup error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Announcement card — IMPORTANT+ notices get a ✓ Acknowledge button right in
   * the chat (callback `anack:<id>`); NORMAL ones just get the album + text.
   * Only called for users in the audience, after the photo album.
   */
  async sendAnnouncementCard(
    chatId: string,
    a: { id: string; code: string; title: string; priority: string; requiresAck: boolean },
    body: string,
  ): Promise<{ message_id: number } | null> {
    const lines = [
      `${a.priority === 'NORMAL' ? '📢' : '🚨'} <b>${escapeHtml(a.priority === 'NORMAL' ? 'Announcement' : a.priority)} — ${escapeHtml(a.title)}</b>`,
      `🏷 ${escapeHtml(a.code)}`,
    ];
    if (body) lines.push(escapeHtml(body));
    const { webUrl } = await this.webUrl();
    const openRow = webUrl ? [{ text: 'Open in AMS', url: `${webUrl.replace(/\/$/, '')}/announcements` }] : [];
    const rows = a.requiresAck
      ? [[{ text: '✓ Acknowledge', callback_data: `anack:${a.id}` }], openRow]
      : [openRow];
    const res = await this.call<{ message_id?: number }>('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: rows.filter((r) => r.length > 0) },
    });
    // the id lets a Reply in the chat be matched back to this exact announcement
    // (plan §5 / P3) — null means Telegram did not accept the message
    return res && typeof res.message_id === 'number' ? { message_id: res.message_id } : null;
  }

  /** Upload one local file as a photo/document via multipart — never throws. */
  async uploadMedia(method: 'sendPhoto' | 'sendDocument', chatId: string, filePath: string, extra: Record<string, unknown> = {}): Promise<{ message_id: number } | null> {
    const { token, enabled } = await this.config();
    if (!token || !enabled) return null;
    if (!fs.existsSync(filePath)) return null;
    try {
      const fd = new FormData();
      fd.append('chat_id', chatId);
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null) fd.append(k, String(v));
      }
      fd.append(method === 'sendPhoto' ? 'photo' : 'document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
      const res = await fetch(API(token, method), { method: 'POST', body: fd });
      const json = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
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
  /** Edit a card message. Resolves true when the edit landed OR when Telegram
   *  reports "message is not modified" (the card already shows this content —
   *  callers treat that as success); false when the edit genuinely failed
   *  (message deleted, too old, network) so callers can fall back to sending. */
  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    keyboard?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
  ): Promise<boolean> {
    const res = await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }, { notModifiedIsOk: true });
    return res != null;
  }

  /** message_id per (chat, callback) seen in the poll loop — for editCallbackMessage. */
  private callbackMessages = new Map<string, number>();
  /** chatId → assignmentId armed for the two-tap "Back at Office — BOTH trips" confirm (30s TTL). */
  private pendingCombinedBack = new Map<string, string>();
  /** chatId → assignment armed for the ⏰ custom-ETA text entry (10 min TTL). */
  private pendingEtaCustom = new Map<string, { assignmentId: string; at: number }>();
  /** How long an armed odometer capture waits for the kilo (see armOdo). */
  private static readonly ODO_TTL_MS = 3 * 60 * 60_000;
  /** How long a persisted capture (photo on disk) is worth resuming after a restart. */
  private static readonly ODO_PENDING_TTL_MS = 24 * 60 * 60_000;
  /** 🛣️ odometer capture armed for this chat: waiting for the photo, then the kilo. */
  private pendingOdo = new Map<string, OdoPending>();
  /**
   * Hook wired by CarsModule: hand a photo that was just kept to the OCR reader.
   * Pure observer (shadow mode) — it never changes what gets recorded, and a
   * reader that throws is swallowed here.
   */
  odoPhotoRef?: { afterStore: (assignmentId: string, photo: { buffer: Buffer; size: number }) => void };

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
  carRequest?: { destination: string; pickupLocation: string | null; startDate: Date; endDate: Date; timeSlot: string; purpose: string | null; specialRequest?: string | null } | null;
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
  // verbose "29 Sept 2026" for announcement cards — explicit timeZone, TZ-safe
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Yangon' });
}

function fmtTime(d: Date) {
  // consolidated on the shared TZ-safe Yangon formatter (src/util/yangon-time.ts)
  return yangonClock(d);
}
