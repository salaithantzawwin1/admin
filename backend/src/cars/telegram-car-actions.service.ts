import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.module';
import { PermissionsService } from '../auth/permissions.service';
import { TelegramService } from '../telegram/telegram.service';
import { CarsService } from './cars.service';

/**
 * Telegram as a full administration surface (no AMS login needed):
 * a bound Administration user taps [Approve] on the Telegram mirror of a pending
 * car request, then picks a vehicle and a driver from inline lists — every tap is
 * executed BY THE BOUND AMS USER through the very same services the web UI uses
 * (role checks, separation of duties, overlap checks, audit — nothing bypassed).
 * Lives in CarsModule (needs CarsService); wires into TelegramService's poll loop.
 */
@Injectable()
export class TelegramCarActionsService {
  private readonly logger = new Logger(TelegramCarActionsService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private workflow: WorkflowService,
    private cars: CarsService,
    private telegram: TelegramService,
    private permissions: PermissionsService,
  ) {}

  /** Called by CarsModule bootstrap: hook the poll loop + the submit mirror. */
  wire() {
    this.telegram.approvals = {
      handleAction: (data, chatId, callbackId) => this.handleAction(data, chatId, callbackId),
    };
    this.telegram.commands = {
      handleText: (text, chatId) => this.handleCommand(text, chatId),
    };
    this.telegram.rejects = {
      handleText: (text, chatId) => this.handleRejectText(text, chatId),
      hasPending: (chatId) => this.pendingRejects.has(chatId),
    };
    this.workflow.onSubmittedTelegram = (requestId) => this.offerApprovalButtons(requestId);
  }

  /**
   * Slash commands (from the poll loop):
   *   /assign CAR-202609-0035 — re-offer the vehicle picker for an approved,
   *   unassigned car request (recovers a lost/scroll-past picker message)
   *   /assign              — list approved-unassigned car requests
   */
  async handleCommand(text: string, chatId: string): Promise<boolean> {
    this.logger.log(`/assign handler entered: "${text}" (chat ${chatId})`);
    const [rawCommand, ...rest] = text.replace(/\s+/, ' ').split(' ');
    const command = rawCommand.toLowerCase().replace(/@.*$/, ''); // strip /assign@BotName
    if (command !== '/assign') {
      this.logger.warn(`/assign handler: parsed command "${command}" did not match — ignoring`);
      return false;
    }
    const docNumber = rest.join(' ').trim().toUpperCase();
    try {
      const user = await this.boundUser(chatId);
      if (!user) {
        await this.telegram.sendRaw(chatId, '❌ Your Telegram is not linked to an AMS account.');
        return true;
      }
      // same gate as the web UI's @RequirePermissions(cars.assign)
      const perms = await this.permissions.forUser(user.id);
      if (!perms.includes('cars.assign')) {
        await this.telegram.sendRaw(chatId, '⛔ You need the car-assignment permission (cars.assign) to use /assign.');
        return true;
      }
      if (!docNumber) {
        await this.sendAssignQueue(chatId);
        return true;
      }
      const request = await this.prisma.requestDocument.findFirst({
        where: { docNumber, docType: 'CAR_REQUEST' },
        include: { carRequest: { select: { assignment: { select: { releasedAt: true } } } } },
      });
      if (!request || !request.carRequest) {
        await this.telegram.sendRaw(chatId, `❌ Car request ${escapeHtml(docNumber)} not found.`);
        return true;
      }
      if (request.status === 'APPROVED' && request.carRequest.assignment?.releasedAt === null) {
        await this.telegram.sendRaw(chatId, `ℹ️ ${escapeHtml(docNumber)} already has an active assignment. Use the web UI to change it.`);
        return true;
      }
      if (request.status !== 'APPROVED') {
        await this.telegram.sendRaw(chatId, `⚠️ ${escapeHtml(docNumber)} is ${request.status} — only APPROVED requests can be assigned.`);
        return true;
      }
      await this.offerAssignVehicle(request.id, chatId);
    } catch (e) {
      this.logger.warn(`/assign failed: ${(e as Error).message}`);
      await this.telegram.sendRaw(chatId, '⚠️ Something went wrong — please try again.').catch(() => undefined);
    }
    return true;
  }

  /** List approved-unassigned car requests with ready-to-tap /assign commands. */
  private async sendAssignQueue(chatId: string) {
    const rows = await this.prisma.requestDocument.findMany({
      where: { docType: 'CAR_REQUEST', status: 'APPROVED', carRequest: { vehicleId: null } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: {
        docNumber: true, title: true,
        requester: { select: { fullName: true } },
        carRequest: { select: { destination: true, startDate: true, endDate: true } },
      },
    });
    if (rows.length === 0) {
      await this.telegram.sendRaw(chatId, '🎉 No approved car requests are waiting for a vehicle.');
      return;
    }
    const lines = rows.map((r) => {
      const cr = r.carRequest;
      const when = cr ? `\n📅 ${new Date(cr.startDate).toLocaleString('en-GB')} → ${new Date(cr.endDate).toLocaleString('en-GB')}` : '';
      const dest = cr?.destination ? `\n🗺 ${escapeHtml(cr.destination)}` : '';
      return `🚗 <b>${escapeHtml(r.docNumber)}</b> — ${escapeHtml(r.title)}\n👤 ${escapeHtml(r.requester.fullName)}${dest}${when}\n➡️ /assign ${r.docNumber}`;
    });
    await this.telegram.sendRaw(chatId, `📋 <b>Approved — waiting for vehicle (${rows.length})</b>\n\n${lines.join('\n\n')}`);
  }

  /** Resolve the AMS user bound to this Telegram chat (null = not authorized). */
  private async boundUser(chatId: string) {
    return this.prisma.user.findFirst({
      where: { telegramChatId: chatId, status: 'ACTIVE' },
      select: { id: true, username: true, fullName: true },
    });
  }

  /**
   * Mirror of a pending CAR request gains [✅ Approve] — sent to every bound
   * ADMINISTRATION user. Called by WorkflowService after each submit.
   */
  async offerApprovalButtons(requestId: string) {
    try {
      const request = await this.prisma.requestDocument.findUnique({
        where: { id: requestId },
        include: {
          requester: { select: { fullName: true } },
          carRequest: { select: { destination: true, startDate: true, endDate: true, pickupLocation: true } },
        },
      });
      if (!request || request.status !== 'PENDING_APPROVAL' || !request.carRequest) return; // car flow only
      // RBAC-native: the approve card goes to whoever can act on approvals
      const approverIds = await this.permissions.usersWithPermissions(['approvals.act']);
      const approvers = await this.prisma.user.findMany({
        where: { id: { in: approverIds }, status: 'ACTIVE', telegramChatId: { not: null } },
        select: { telegramChatId: true },
      });
      const cr = request.carRequest;
      const when = `\n📅 ${new Date(cr.startDate).toLocaleString('en-GB')} → ${new Date(cr.endDate).toLocaleString('en-GB')}`;
      const dest = `\n🗺 ${cr.destination}${cr.pickupLocation ? ` (Pickup: ${cr.pickupLocation})` : ''}`;
      const text = `🆕 <b>New car request — ${escapeHtml(request.docNumber)}</b>\n${escapeHtml(request.title)}\n👤 ${escapeHtml(request.requester.fullName)}${when}${dest}`;
      for (const a of approvers) {
        if (!a.telegramChatId) continue;
        await this.telegram.sendRaw(a.telegramChatId, text, {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Approve', callback_data: `wfa:approve:${requestId}` },
              { text: '❌ Reject', callback_data: `wfa:rej:${requestId}` },
            ], [
              { text: '👁 Open in AMS', callback_data: `wfa:noop:${requestId}` },
            ]],
          },
        });
      }
    } catch (e) {
      this.logger.warn(`offerApprovalButtons failed: ${(e as Error).message}`);
    }
  }

  /**
   * Telegram caps inline-button callback_data at 64 BYTES — raw `wfa:pickv:<uuid>:<uuid>`
   * is 82+ bytes and was rejected with BUTTON_DATA_INVALID (the picker never rendered).
   * Pick buttons therefore carry short random tokens; the real ids live in this map
   * (bounded — stale buttons after a restart just answer "expired").
   * The [✅ Approve]/[❌ Reject] buttons keep their raw form: `wfa:approve:<uuid>` /
   * `wfa:rej:<uuid>` = 48 bytes ✓.
   */
  private pickTokens = new Map<string, { requestId: string; vehicleId?: string; driverId?: string }>();

  /**
   * Pending rejection reasons per chat — [❌ Reject] arms a conversation and the
   * next plain text from that chat IS the reason (Telegram has no native prompt).
   * Bounded + TTL'd so abandoned conversations expire silently (10 min).
   */
  private pendingRejects = new Map<string, { requestId: string; docNumber: string; messageId?: number; at: number }>();
  private static readonly REJECT_TTL_MS = 10 * 60 * 1000;

  private newToken(payload: { requestId: string; vehicleId?: string; driverId?: string }): string {
    if (this.pickTokens.size > 1000) this.pickTokens.clear(); // bounded — pickers are transient
    const token = Math.random().toString(16).slice(2, 10) + Date.now().toString(36).slice(-3); // 11 chars → `wfa:pd:<token>` = 18 bytes
    this.pickTokens.set(token, payload);
    return token;
  }

  /** Entry point for wfa:* callbacks coming from the poll loop (prefix pre-checked). */
  async handleAction(data: string, chatId: string, callbackId: string): Promise<boolean> {
    const [prefix, action, arg1] = data.split(':');
    if (prefix !== 'wfa') return false; // defensive — poll loop already filtered
    if (action === 'noop') {
      await this.telegram.answer(callbackId, 'Open AMS in your browser to view details');
      return true;
    }

    const user = await this.boundUser(chatId);
    if (!user) {
      await this.telegram.answer(callbackId, 'Not authorized — your Telegram is not linked to an AMS account');
      return true;
    }
    const actor = { userId: user.id, username: user.username };

    if (action === 'approve') {
      await this.actApprove(arg1 ?? '', chatId, callbackId, actor);
      return true;
    }
    if (action === 'rej') {
      await this.actBeginReject(arg1 ?? '', chatId, callbackId);
      return true;
    }
    if (action === 'av') {
      // [🚗 Assign Car] on the approved stamp — re-offers the vehicle picker (repeatable)
      const payload = this.pickTokens.get(arg1 ?? '');
      if (!payload) {
        await this.telegram.answer(callbackId, 'This button expired — send /assign <doc number> again');
        return true;
      }
      await this.offerAssignVehicle(payload.requestId, chatId);
      await this.telegram.answer(callbackId, 'Pick a vehicle');
      return true;
    }
    if (action === 'pv') {
      await this.actPickVehicle(arg1 ?? '', chatId, callbackId);
      return true;
    }
    if (action === 'pd') {
      await this.actPickDriver(arg1 ?? '', chatId, callbackId, actor);
      return true;
    }
    return true;
  }

  /** [✅ Approve] — full AMS checks, then paint the outcome and offer vehicles. */
  private async actApprove(requestId: string, chatId: string, callbackId: string, actor: { userId: string; username: string }) {
    const request = await this.prisma.requestDocument.findUnique({ where: { id: requestId } });
    if (!request) {
      await this.telegram.answer(callbackId, 'Request not found');
      return;
    }
    const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    this.pendingRejects.delete(chatId); // approving supersedes any armed reject conversation in this chat
    try {
      await this.workflow.approve(requestId, 'Approved via Telegram', actor as never);
      // Staged buttons (requested UX): approve FIRST, then assign — the persistent
      // [🚗 Assign Car] button also recovers a lost/scrolled-away picker message.
      await this.telegram.editCallbackMessage(
        chatId,
        callbackId,
        `✅ Approved — ${escapeHtml(request.docNumber)} · ${stamp} · by ${escapeHtml(actor.username)}`,
        {
          inline_keyboard: [
            [{ text: '🚗 Assign Car', callback_data: `wfa:av:${this.newToken({ requestId })}` }],
            [{ text: '👁 Open in AMS', callback_data: `wfa:noop:${requestId}` }],
          ],
        },
      );
      await this.telegram.answer(callbackId, 'Approved — tap Assign Car next');
    } catch (e) {
      await this.telegram.editCallbackMessage(chatId, callbackId, `⚠️ ${escapeHtml((e as Error).message || 'Failed')}`);
      await this.telegram.answer(callbackId, 'Could not approve — see message');
    }
  }

  /** [❌ Reject] — arm the conversation; the reason arrives as the very next text message. */
  private async actBeginReject(requestId: string, chatId: string, callbackId: string) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      select: { docNumber: true, status: true },
    });
    if (!request) {
      await this.telegram.answer(callbackId, 'Request not found');
      return;
    }
    if (request.status !== 'PENDING_APPROVAL') {
      await this.telegram.answer(callbackId, `Already ${request.status.toLowerCase()} — nothing to reject`);
      return;
    }
    if (this.pendingRejects.size > 200) {
      for (const [k, v] of this.pendingRejects) {
        if (Date.now() - v.at > TelegramCarActionsService.REJECT_TTL_MS) this.pendingRejects.delete(k);
      }
    }
    this.pendingRejects.set(chatId, {
      requestId,
      docNumber: request.docNumber,
      messageId: this.telegram.peekCallbackMessage(chatId, callbackId),
      at: Date.now(),
    });
    await this.telegram.sendRaw(
      chatId,
      `❌ Rejecting <b>${escapeHtml(request.docNumber)}</b> — please type the reason for the requester (or /cancel to abort).`,
    );
    await this.telegram.answer(callbackId, 'Type the rejection reason');
  }

  /** The text that follows an armed [❌ Reject]: the reason (or /cancel). */
  private async handleRejectText(text: string, chatId: string) {
    const pending = this.pendingRejects.get(chatId);
    if (!pending) return;
    if (Date.now() - pending.at > TelegramCarActionsService.REJECT_TTL_MS) {
      this.pendingRejects.delete(chatId);
      await this.telegram.sendRaw(chatId, `⌛ The rejection window for ${escapeHtml(pending.docNumber)} expired — tap ❌ Reject on the request to start again.`).catch(() => undefined);
      return;
    }
    if (text.startsWith('/cancel')) {
      this.pendingRejects.delete(chatId);
      await this.telegram.sendRaw(chatId, `↩️ Rejection of ${escapeHtml(pending.docNumber)} cancelled — the request is still waiting for approval.`);
      return;
    }
    const user = await this.boundUser(chatId);
    if (!user) {
      this.pendingRejects.delete(chatId);
      await this.telegram.sendRaw(chatId, '❌ Your Telegram is not linked to an AMS account.');
      return;
    }
    const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    try {
      // same engine as the web UI: role/step checks, comment required, requester notification + audit
      await this.workflow.reject(pending.requestId, text, { userId: user.id, username: user.username } as never);
      this.pendingRejects.delete(chatId);
      const outcome = `❌ Rejected — ${escapeHtml(pending.docNumber)}\n📝 ${escapeHtml(text)}\n· by ${escapeHtml(user.username)} · ${stamp}`;
      if (pending.messageId) {
        await this.telegram.editMessage(chatId, pending.messageId, outcome).catch(() => undefined);
      } else {
        await this.telegram.sendRaw(chatId, outcome);
      }
    } catch (e) {
      this.pendingRejects.delete(chatId);
      this.logger.warn(`telegram reject failed: ${(e as Error).message}`);
      await this.telegram
        .sendRaw(chatId, `⚠️ Reject failed: ${escapeHtml((e as Error).message || 'unknown error')}\nThe request is unchanged — tap ❌ Reject to try again.`)
        .catch(() => undefined);
    }
  }

  /** After approval (or /assign): inline list of available vehicles for this request's window. */
  private async offerAssignVehicle(requestId: string, chatId: string) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: {
        requester: { select: { fullName: true } },
        carRequest: { select: { destination: true, startDate: true, endDate: true, assignment: { select: { releasedAt: true } } } },
      },
    });
    if (!request?.carRequest) return;
    if (request.carRequest.assignment?.releasedAt === null) {
      await this.telegram.sendRaw(chatId, `ℹ️ ${escapeHtml(request.docNumber)} already has an active assignment. Use the web UI to change it.`);
      return;
    }
    const cr = request.carRequest;
    const busy = await this.prisma.carRequest.findMany({
      where: { requestId: { not: requestId }, status: 'IN_PROGRESS', startDate: { lt: cr.endDate }, endDate: { gt: cr.startDate } },
      select: { vehicleId: true },
    });
    const busyIds = busy.map((b) => b.vehicleId).filter(Boolean) as string[];
    const vehicles = await this.prisma.vehicle.findMany({
      where: { status: 'AVAILABLE', ...(busyIds.length ? { id: { notIn: busyIds } } : {}) },
      take: 8,
      select: { id: true, vehicleNo: true, brandModel: true },
    });
    const when = `\n📅 ${new Date(cr.startDate).toLocaleString('en-GB')} → ${new Date(cr.endDate).toLocaleString('en-GB')}`;
    const dest = cr.destination ? `\n🗺 ${escapeHtml(cr.destination)}` : '';
    const who = `\n👤 ${escapeHtml(request.requester.fullName)}`;
    if (vehicles.length === 0) {
      await this.telegram.sendRaw(
        chatId,
        `🚗 <b>Assign a vehicle — ${escapeHtml(request.docNumber)}</b>${who}${dest}${when}\n\n⚠️ No AVAILABLE vehicles for this window right now — free one up or retry later with <b>/assign ${escapeHtml(request.docNumber)}</b>`,
      );
      return;
    }
    await this.telegram.sendRaw(
      chatId,
      `🚗 <b>Assign a vehicle — ${escapeHtml(request.docNumber)}</b>${who}${dest}${when}`,
      {
        reply_markup: {
          inline_keyboard: vehicles.map((v) => [{ text: `${v.vehicleNo} — ${v.brandModel}`, callback_data: `wfa:pv:${this.newToken({ requestId: request.id, vehicleId: v.id })}` }]),
        },
      },
    );
  }

  /** Vehicle chosen (token → ids) → offer drivers. */
  private async actPickVehicle(token: string, chatId: string, callbackId: string) {
    const payload = this.pickTokens.get(token);
    if (!payload) {
      await this.telegram.answer(callbackId, 'This button expired — send /assign <doc number> again');
      return;
    }
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: payload.requestId },
      select: { docNumber: true, status: true },
    });
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: payload.vehicleId }, select: { vehicleNo: true, brandModel: true } });
    if (!request || !vehicle) {
      await this.telegram.answer(callbackId, 'Request or vehicle not found');
      return;
    }
    if (request.status !== 'APPROVED') {
      await this.telegram.answer(callbackId, `Request is ${request.status} — not assignable`);
      return;
    }
    await this.telegram.editCallbackMessage(chatId, callbackId, `🚗 ${escapeHtml(request.docNumber)} · ${escapeHtml(vehicle.vehicleNo)} (${escapeHtml(vehicle.brandModel)}) — pick a driver:`);
    // AVAILABLE and not on planned absence during this trip's window
    const cr = await this.prisma.requestDocument.findUnique({
      where: { id: payload.requestId },
      select: { carRequest: { select: { startDate: true, endDate: true } } },
    });
    const busyDriverIds = cr?.carRequest
      ? (await this.prisma.driverAbsence.findMany({
          where: { status: 'ACTIVE', startsAt: { lt: cr.carRequest.endDate }, endsAt: { gt: cr.carRequest.startDate } },
          select: { driverId: true },
        })).map((x) => x.driverId)
      : [];
    const drivers = await this.prisma.driver.findMany({
      where: { status: 'AVAILABLE', ...(busyDriverIds.length ? { id: { notIn: busyDriverIds } } : {}) },
      take: 8,
      select: { id: true, name: true },
    });
    await this.telegram.sendRaw(chatId, `👤 <b>Pick a driver — ${escapeHtml(request.docNumber)}</b>`, {
      reply_markup: {
        inline_keyboard: [
          ...drivers.map((d) => [{ text: d.name, callback_data: `wfa:pd:${this.newToken({ requestId: payload.requestId, vehicleId: payload.vehicleId, driverId: d.id })}` }]),
          [{ text: 'No driver (car only)', callback_data: `wfa:pd:${this.newToken({ requestId: payload.requestId, vehicleId: payload.vehicleId, driverId: '-' })}` }],
        ],
      },
    });
    await this.telegram.answer(callbackId, 'Now pick a driver');
  }

  /** Driver chosen (token → ids) → run the real assign() (overlap checks + driver message) and paint the result. */
  private async actPickDriver(
    token: string,
    chatId: string,
    callbackId: string,
    actor: { userId: string; username: string },
  ) {
    const payload = this.pickTokens.get(token);
    if (!payload?.vehicleId) {
      await this.telegram.answer(callbackId, 'This button expired — send /assign <doc number> again');
      return;
    }
    const request = await this.prisma.requestDocument.findUnique({ where: { id: payload.requestId }, select: { docNumber: true } });
    if (!request) {
      await this.telegram.answer(callbackId, 'Request not found');
      return;
    }
    const driverId = payload.driverId ?? '-';
    const driverName = driverId === '-' ? '' : ((await this.prisma.driver.findUnique({ where: { id: driverId }, select: { name: true } }))?.name ?? '');
    const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    try {
      await this.cars.assign(payload.requestId, { vehicleId: payload.vehicleId, driverId: driverId === '-' ? undefined : driverId }, actor as never);
      this.pickTokens.delete(token); // one-shot — a second tap must not double-assign
      const who = driverName ? `\n👤 ${escapeHtml(driverName)}` : '';
      await this.telegram.editCallbackMessage(chatId, callbackId, `✅ Assigned — ${escapeHtml(request.docNumber)}${who}\n· by ${escapeHtml(actor.username)} · ${stamp}`);
      await this.telegram.answer(callbackId, 'Assigned — driver notified');
    } catch (e) {
      await this.telegram.editCallbackMessage(chatId, callbackId, `⚠️ ${escapeHtml((e as Error).message || 'Assign failed')}`);
      await this.telegram.answer(callbackId, 'Assign failed — see message');
    }
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
