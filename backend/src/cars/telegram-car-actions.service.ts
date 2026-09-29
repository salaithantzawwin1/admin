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
    this.telegram.carRequests = {
      handleCommand: async (text, chatId) => {
        await this.handleCarCommand(text, chatId);
        return true;
      },
      handleText: (text, chatId) => this.handleCarText(text, chatId),
      hasPending: (chatId) => this.pendingCarRequests.has(chatId),
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
    if (command === '/car') {
      await this.handleCarCommand(text, chatId);
      return true;
    }
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
    // /car form buttons — slot pick, quick time, extra fields toggle, submit, cancel
    if (action === 'carslot') {
      await this.actCarSlot(arg1 ?? '', chatId, callbackId);
      return true;
    }
    if (action === 'carquick') {
      await this.actCarQuickTime(data.slice('wfa:carquick:'.length), chatId, callbackId);
      return true;
    }
    if (action === 'carextra') {
      const entry = this.pendingCarRequests.get(chatId);
      if (!entry) {
        await this.telegram.answer(callbackId, 'Expired — send /car again');
        return true;
      }
      entry.at = Date.now();
      entry.draft.showExtra = entry.draft.showExtra ? undefined : 1;
      await this.telegram.answer(callbackId, entry.draft.showExtra ? 'ထပ်ဖြည့်ရန် ပြလိုက်ပါပြီ' : 'ဖျောက်လိုက်ပါပြီ');
      await this.sendRawCard(chatId, this.renderCarCard(chatId));
      return true;
    }
    if (action === 'carback') {
      await this.actCarBack(chatId, callbackId);
      return true;
    }
    if (action === 'carsubmit') {
      await this.actCarSubmit(chatId, callbackId);
      return true;
    }
    if (action === 'carcancel') {
      await this.actCarCancel(chatId, callbackId);
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
      // base document status — CarRequest.status is only a mirror
      where: { requestId: { not: requestId }, request: { status: 'IN_PROGRESS' }, startDate: { lt: cr.endDate }, endDate: { gt: cr.startDate } },
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
      ? [
          // planned absence during the trip window
          ...(await this.prisma.driverAbsence.findMany({
            where: { status: 'ACTIVE', startsAt: { lt: cr.carRequest.endDate }, endsAt: { gt: cr.carRequest.startDate } },
            select: { driverId: true },
          })).map((x) => x.driverId),
          // already driving an overlapping IN_PROGRESS trip (not yet Back at Office)
          ...(await this.prisma.carRequest.findMany({
            where: {
              request: { status: 'IN_PROGRESS' }, // base document status — mirror-safe
              driverId: { not: null },
              requestId: { not: payload.requestId },
              startDate: { lt: cr.carRequest.endDate },
              endDate: { gt: cr.carRequest.startDate },
              assignment: { releasedAt: null, driverBackAtOfficeAt: null },
            },
            select: { driverId: true },
          })).map((x) => x.driverId),
        ].filter(Boolean)
      : [];
    const drivers = await this.prisma.driver.findMany({
      where: { status: 'AVAILABLE', ...(busyDriverIds.length ? { id: { notIn: busyDriverIds as string[] } } : {}) },
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

  // ============================================================ /car — conversational request form

  /** TTL for an open /car conversation (plan: 15 min). */
  private static readonly CAR_TTL_MS = 15 * 60 * 1000;
  /** Vehicle types accepted in the bot (mirrors CarsController's web list). */
  private static readonly CAR_VEHICLE_TYPES = [
    'SEDAN', 'SUV', 'PICKUP', 'VAN', 'BUS', 'TRUCK', 'OTHER',
    'MINIVAN', 'MINIBUS', 'LIMOUSINE', 'STAFF_BUS', 'VAN_CARGO',
  ];

  /** One /car form draft — every field optional until Submit validates. */
  /**
   * Pending /car form drafts per chat. The card lists every field at once;
   * the user answers with `Field: value` lines in any order (all at once or
   * gradually), the card re-renders after each reply, Submit validates.
   */
  private pendingCarRequests = new Map<string, { draft: Record<string, string | number | undefined>; at: number }>();

  /** Bare one-word slot answers — "full day", "am", "custom" … (no label needed). */
  private static readonly BARE_SLOTS: Record<string, string> = {
    full: 'FULL_DAY',
    fullday: 'FULL_DAY',
    am: 'HALF_DAY_AM',
    halfam: 'HALF_DAY_AM',
    morning: 'HALF_DAY_AM',
    pm: 'HALF_DAY_PM',
    halfpm: 'HALF_DAY_PM',
    afternoon: 'HALF_DAY_PM',
    evening: 'HALF_DAY_PM',
    custom: 'CUSTOM_HOURS',
    customhours: 'CUSTOM_HOURS',
  };

  /** "Heading back to Head Office" intents — a rider at an offsite destination
   *  wants the return trip with minimum typing. Bare words, both languages. */
  private static readonly RETURN_INTENTS = new Set([
    'ပြန်မယ်', 'ပြန်ချင်တယ်', 'ရုံးပြန်', 'ရုံးချုပ်ပြန်', 'ပြန်ရံ',
    'back', 'backoffice', 'headoffice', 'return', 'returntrip', 'goback',
  ]);

  /** Field aliases — Burmese-first + English, matched case-insensitively. */
  private static readonly CAR_FIELDS: { key: string; aliases: string[] }[] = [
    { key: 'destination', aliases: ['destination', 'dest', 'သွားမယ့်နေရာ', 'သွားရန်နေရာ'] },
    { key: 'start', aliases: ['start', 'start time', 'ထွက်မယ့်အချိန်', 'ထွက်ချိန်'] },
    { key: 'slot', aliases: ['slot', 'time slot', 'အချိန်အပိုင်းအခြား'] },
    { key: 'end', aliases: ['end', 'end time', 'ပြန်ရောက်မည့်အချိန်', 'ပြန်ချိန်'] },
    { key: 'passengers', aliases: ['passengers', 'pax', 'လိုက်ပါသူ', 'လိုက်သူ'] },
    { key: 'vehicle', aliases: ['vehicle', 'vehicle type', 'ကားအမျိုးအစား', 'ကား'] },
    { key: 'pickup', aliases: ['pickup', 'pickup location', 'တက်မည့်နေရာ', 'တက်ရမည့်နေရာ'] },
    { key: 'purpose', aliases: ['purpose', 'ရည်ရွယ်ချက်'] },
    { key: 'notes', aliases: ['notes', 'description', 'မှတ်ချက်'] },
  ];

  /** /car — open (or re-show) the request form card. `/car <destination>` prefills the destination. */
  async handleCarCommand(text: string, chatId: string): Promise<void> {
    const user = await this.boundUser(chatId);
    if (!user) {
      await this.telegram.sendRaw(chatId, '❌ Your Telegram is not linked to an AMS account.');
      return;
    }
    // fresh draft (re-issuing /car resets the form — deliberate and predictable);
    // `/car မန္တလေး` style starts with the destination already filled
    const rest = text.split(/\s+/).slice(1).join(' ').trim();
    const draft: Record<string, string | number | undefined> = {};
    if (rest) draft.destination = rest;
    this.pendingCarRequests.set(chatId, { draft, at: Date.now() });
    this.sweepCarDrafts();
    await this.sendRawCard(chatId, this.renderCarCard(chatId));
  }

  /** Track the live form card per chat so every answer EDITS that one card
   *  instead of piling a new card per keystroke (the #1 UX complaint). */
  private carCardMessages = new Map<string, number>();

  /** Text arriving while a /car conversation is open — field answers or /cancel. */
  async handleCarText(text: string, chatId: string): Promise<void> {
    const entry = this.pendingCarRequests.get(chatId);
    if (!entry) return;
    if (Date.now() - entry.at > TelegramCarActionsService.CAR_TTL_MS) {
      this.pendingCarRequests.delete(chatId);
      await this.sendRawCard(chatId, '⌛ ကားတောင်းခံမှု form က အချိန်ကုန်သွားပါပြီ — /car ကို ပြန်ရိုက်ပါ။ (The form expired — send /car again.)');
      return;
    }
    if (text === '/cancel') {
      this.pendingCarRequests.delete(chatId);
      await this.sendRawCard(chatId, '↩️ ကားတောင်းခံမှု ပယ်ဖျက်လိုက်ပါပြီ။ (Request cancelled — nothing was submitted.)');
      return;
    }
    // re-issuing /car while the form is open re-opens a FRESH form (same as the
    // first /car) — handleUpdate routes bare '/car' here instead of the command
    // handler, so without this the command text became the destination.
    if (text === '/car' || text.startsWith('/car ')) {
      await this.handleCarCommand(text, chatId);
      return;
    }

    entry.at = Date.now(); // touch — an active conversation never TTLs mid-typing
    // keyboards vary: fullwidth colons, non-breaking spaces, Myanmar digits —
    // normalise BEFORE parsing so none of them silently break a field answer
    const normalized = TelegramCarActionsService.toAsciiDigits(text.replace(/：/g, ':').replace(/\u00A0/g, ' '));
    const unknownKeys: string[] = [];
    const fieldWarnings: string[] = [];
    for (const rawLine of normalized.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      // "ပြန်မယ်" / "back" — the rider at an offsite destination wants the return
      // trip NOW: fill Destination = Head Office + smart pickup, one bare word
      if (TelegramCarActionsService.RETURN_INTENTS.has(line.toLowerCase().replace(/[\s!。，,\.]/g, ''))) {
        await this.prefillReturnTrip(entry.draft, chatId);
        await this.sendRawCard(chatId, this.renderCarCard(chatId));
        return;
      }
      const sep = line.indexOf(':');
      if (sep < 0) {
        // bare answer (no colon) — plain typing just works:
        // slot keyword → date/time (fills Start, then End) → Destination;
        // anything else is flagged so the hint can teach the labelled form
        const bareSlot = TelegramCarActionsService.BARE_SLOTS[line.toLowerCase().replace(/[\s_-]/g, '')];
        if (bareSlot) {
          entry.draft.slot = bareSlot;
          continue;
        }
        if (TelegramCarActionsService.parseCarDateStatic(line)) {
          // second bare date only fills End when Custom hours are on — otherwise
          // the End value would silently change the meaning of a Full-day request
          this.setCarField(entry.draft, entry.draft.slot === 'CUSTOM_HOURS' && entry.draft.start ? 'end' : 'start', line);
          continue;
        }
        if (!entry.draft.destination) {
          this.setCarField(entry.draft, 'destination', line);
          continue;
        }
        unknownKeys.push(line.slice(0, 40));
        continue;
      }
      if (sep === 0) {
        unknownKeys.push(line.slice(0, 40));
        continue;
      }
      const key = line.slice(0, sep).trim().toLowerCase();
      const value = line.slice(sep + 1).trim();
      const field = TelegramCarActionsService.CAR_FIELDS.find((f) => f.aliases.includes(key));
      if (!field) {
        // the "colon" may be the TIME separator of a bare date — "5/10 09:00"
        // has no field label at all. Before flagging it unknown, try the bare
        // date / slot readings so plain typing still lands in the right field.
        const bareSlot2 = TelegramCarActionsService.BARE_SLOTS[line.toLowerCase().replace(/[\s_-]/g, '')];
        if (bareSlot2) {
          entry.draft.slot = bareSlot2;
          continue;
        }
        if (TelegramCarActionsService.parseCarDateStatic(line)) {
          this.setCarField(entry.draft, entry.draft.slot === 'CUSTOM_HOURS' && entry.draft.start ? 'end' : 'start', line);
          continue;
        }
        unknownKeys.push(key);
        continue;
      }
      const warning = this.setCarField(entry.draft, field.key, value);
      if (warning) fieldWarnings.push(warning);
    }

    if (unknownKeys.length > 0) {
      await this.telegram.sendRaw(
        chatId,
        `❓ မသိပါသော အကွက်များ — ${escapeHtml(unknownKeys.join(', '))}\n` +
          'အကွက်အမည် ရှေ့တွင် ထည့်ရေးပါ — ဥပမာ <b>သွားမယ့်နေရာ:</b> မန္တလေး\n' +
          'ရိုးရိုးရေးလည်းရ — "မန္တလေး" (နေရာ) / "5/10 09:00" (အချိန်)\n' +
          escapeHtml(TelegramCarActionsService.CAR_FIELDS.map((f) => f.aliases[0]).join(', ')),
      );
    }
    await this.sendRawCard(chatId, (fieldWarnings.length > 0 ? `${fieldWarnings.join('\n')}\n\n` : '') + this.renderCarCard(chatId));
  }

  /** Returns an optional warning line — silently ignored values were a UX trap. */
  private setCarField(draft: Record<string, unknown>, key: string, value: string): string | undefined {
    const v = value.trim();
    const empty = v === '' || v === '-' || v === '/skip';
    switch (key) {
      case 'destination':
      case 'pickup':
      case 'purpose':
      case 'notes':
        if (empty) delete draft[key];
        else draft[key] = v;
        break;
      case 'start':
      case 'end': {
        if (empty) {
          delete draft[key];
          break;
        }
        const parsed = TelegramCarActionsService.parseCarDateStatic(v);
        if (parsed) {
          draft[key] = v; // keep the human-readable value; ISO derived at submit
        } else if (/^\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?$/.test(v.replace(/\s+.*$/, ''))) {
          draft[key] = v; // d/m[/y] shape — parseCarDateStatic's day-first fallback reads it
        } else {
          return `⚠️ ${key === 'start' ? 'ထွက်မယ့်အချိန်' : 'ပြန်ရောက်မည့်အချိန်'} နားမလည်ပါ — ရက်စွဲပုံစံ ဥပမာ <b>2026-10-05 08:30</b> (ဒါမှမဟုတ် 5/10 08:30)`;
        }
        break;
      }
      case 'slot':
        if (empty) delete draft.slot;
        else {
          const s = v.toLowerCase().replace(/[\s_-]/g, '');
          if (s.startsWith('full')) draft.slot = 'FULL_DAY';
          else if (s.startsWith('halfam') || s.startsWith('am')) draft.slot = 'HALF_DAY_AM';
          else if (s.startsWith('halfpm') || s.startsWith('pm')) draft.slot = 'HALF_DAY_PM';
          else if (s.startsWith('custom')) draft.slot = 'CUSTOM_HOURS';
          // unmatched → left unchanged; the card still shows the previous value
        }
        break;
      case 'passengers': {
        if (empty) {
          delete draft.passengers;
          break;
        }
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 60) draft.passengers = n;
        else return '⚠️ လိုက်ပါသူ အရေအတွက် မမှန်ပါ — 1 မှ 60 အတွင်း ဂဏန်းဖြင့် ရေးပါ';
        break;
      }
      case 'vehicle': {
        if (empty) {
          delete draft.vehicle;
          break;
        }
        const wanted = v.toUpperCase().replace(/[\s_-]/g, '');
        const hit = TelegramCarActionsService.CAR_VEHICLE_TYPES.find((t) => t.replace(/[\s_-]/g, '') === wanted)
          ?? TelegramCarActionsService.CAR_VEHICLE_TYPES.find((t) => t.replace(/[\s_-]/g, '').startsWith(wanted) && wanted.length >= 3);
        if (hit) draft.vehicle = hit;
        else return `⚠️ ကားအမျိုးအစား နားမလည်ပါ — ရွေးချယ်စရာများ- ${TelegramCarActionsService.CAR_VEHICLE_TYPES.join(', ')}`;
        break;
      }
    }
    return undefined;
  }

  /** "Heading back to Head Office": one tap on the card (or a bare "ပြန်မယ်")
   *  fills Destination = Head Office and prefills Pickup from where the user's
   *  last/current trip actually went (elsewhere → that place; unknown → blank).
   *  Used by wfa:carback and the bare-intent reading in handleCarText. */
  private async prefillReturnTrip(draft: Record<string, string | number | undefined>, chatId: string): Promise<void> {
    draft.destination = 'Head Office';
    draft.returnTrip = 1; // the rider is AT the pickup point — Start means "car comes to fetch me"
    delete draft.pickup; // stale value from a previous draft must not survive
    delete draft.notes;
    // a return trip is almost always SAME-DAY: prefill Start = now (Yangon wall
    // clock, rounded up to the next half hour) so the day question disappears —
    // the quick-time buttons or typing remain there to change it
    const now = new Date(Date.now() + 6.5 * 3600 * 1000); // Yangon = UTC+06:30, no DST
    now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30, 0, 0); // setMinutes(60) rolls into the next hour
    const p = (n: number) => String(n).padStart(2, '0');
    draft.start = `${now.getDate()}/${now.getMonth() + 1} ${p(now.getHours())}:${p(now.getMinutes())}`;
    let lastDest: string | null = null;
    try {
      const user = await this.boundUser(chatId);
      if (user) {
        const mine = await this.prisma.requestDocument.findFirst({
          where: { requesterId: user.id, docType: 'CAR_REQUEST', status: { in: ['APPROVED', 'IN_PROGRESS', 'COMPLETED'] as never } },
          orderBy: { createdAt: 'desc' },
          select: { carRequest: { select: { destination: true } } },
        });
        lastDest = mine?.carRequest?.destination ?? null;
      }
    } catch {
      /* best-effort — the request must never fail because of the prefill */
    }
    if (lastDest && lastDest.trim() && lastDest.trim().toLowerCase() !== 'head office') {
      draft.pickup = lastDest.trim();
      draft.notes = `Return trip — pickup from ${lastDest.trim()}`;
    } else {
      draft.notes = 'Return trip to Head Office';
    }
  }

  /** [↩️ ရုံးချုပ်ပြန်] on the card — instant return-trip draft. */
  private async actCarBack(chatId: string, callbackId: string): Promise<void> {
    const entry = this.pendingCarRequests.get(chatId);
    if (!entry) {
      await this.telegram.answer(callbackId, 'Expired — send /car again');
      return;
    }
    entry.at = Date.now();
    await this.prefillReturnTrip(entry.draft, chatId);
    await this.telegram.answer(callbackId, 'ပြန်တောင်းခံမှု အသင့် — ကားလာခေါ်မယ့်အချိန် ဒီနေ့အတွက် ဖြည့်ပြီး (ပြောင်းချင်ရင် အချိန်ခလုတ် နှိပ်ပါ)');
    await this.sendRawCard(chatId, this.renderCarCard(chatId));
  }

  /** Slot chosen via the card's inline buttons. */
  private async actCarSlot(slot: string, chatId: string, callbackId: string): Promise<void> {
    const entry = this.pendingCarRequests.get(chatId);
    if (!entry) {
      await this.telegram.answer(callbackId, 'Expired — send /car again');
      return;
    }
    entry.at = Date.now();
    entry.draft.slot = slot;
    await this.telegram.answer(callbackId, 'Slot updated');
    await this.sendRawCard(chatId, this.renderCarCard(chatId));
  }

  /** Quick-pick time tapped on the card — fills Start (Yangon today/tomorrow). */
  private async actCarQuickTime(raw: string, chatId: string, callbackId: string): Promise<void> {
    const entry = this.pendingCarRequests.get(chatId);
    if (!entry) {
      await this.telegram.answer(callbackId, 'Expired — send /car again');
      return;
    }
    entry.at = Date.now();
    // payload `today:09:00` / `tomorrow:13:00` / `now` → "29/9 14:30"-style short date in the draft
    const [when, hhmm] = raw.split('|');
    const d = new Date();
    if (when === 'tomorrow') d.setDate(d.getDate() + 1);
    if (when === 'now') {
      // "heading out right now" — round UP to the next quarter hour
      d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    } else {
      const hh = Math.min(23, Math.max(0, Number(hhmm?.slice(0, 2)) || 0));
      const mm = Math.min(59, Math.max(0, Number(hhmm?.slice(3, 5)) || 0));
      d.setHours(hh, mm, 0, 0);
    }
    const p = (n: number) => String(n).padStart(2, '0');
    const label = `${d.getDate()}/${d.getMonth() + 1} ${p(d.getHours())}:${p(d.getMinutes())}`;
    entry.draft.start = label;
    await this.telegram.answer(callbackId, `Start: ${label}`);
    await this.sendRawCard(chatId, this.renderCarCard(chatId));
  }

  /** ✅ Submit — validate, create + submit as the bound user, confirm. */
  private async actCarSubmit(chatId: string, callbackId: string): Promise<void> {
    const entry = this.pendingCarRequests.get(chatId);
    if (!entry) {
      await this.telegram.answer(callbackId, 'Expired — send /car again');
      return;
    }
    const user = await this.boundUser(chatId);
    if (!user) {
      this.pendingCarRequests.delete(chatId);
      await this.telegram.answer(callbackId, 'Not authorized');
      return;
    }
    const draft = entry.draft as Record<string, string | number | undefined>;
    const str = (k: string): string | undefined => (typeof draft[k] === 'string' ? (draft[k] as string) : undefined);
    const num = (k: string): number | undefined => (typeof draft[k] === 'number' ? (draft[k] as number) : undefined);
    const problems: string[] = [];
    const destination = str('destination');
    if (!destination || destination.trim().length < 2) problems.push('❌ သွားမယ့်နေရာ (Destination) လိုအပ်ပါသည်');
    const startRaw = str('start');
    const startIso = startRaw ? TelegramCarActionsService.parseCarDateStatic(startRaw) : null;
    if (!startIso) problems.push('❌ ထွက်မယ့်အချိန် (Start) — ဥပမာ 2026-09-28 08:30 ဒါမှမဟုတ် 5/10 09:00');
    let endIso: string | null = null;
    if (draft.slot === 'CUSTOM_HOURS') {
      const endRaw = str('end');
      endIso = endRaw ? TelegramCarActionsService.parseCarDateStatic(endRaw) : null;
      if (!endIso) problems.push('❌ ပြန်ရောက်မည့်အချိန် (End) — Custom slot အတွက် လိုအပ်ပါသည်');
    }
    if (problems.length > 0) {
      await this.telegram.answer(callbackId, 'ဖြည့်စွက်ရန် လိုအပ်သေးသည်');
      await this.sendRawCard(chatId, `${problems.map((p) => `• ${p}`).join('\n')}\n\n${this.renderCarCard(chatId)}`);
      return;
    }

    const actor = { userId: user.id, username: user.username };
    try {
      // pre-flight the workflow BEFORE creating the DRAFT document — a "no active
      // workflow configured" failure used to leave a stray DRAFT request behind
      // on every submit while the workflow was switched off in Settings.
      // Mirrors WorkflowService.workflowFor: module-specific, else GENERIC_REQUEST.
      const wf =
        (await this.prisma.approvalWorkflow.findFirst({
          where: { module: 'CAR_REQUEST', active: true },
          select: { id: true, steps: { select: { id: true } } },
        })) ??
        (await this.prisma.approvalWorkflow.findFirst({
          where: { module: 'GENERIC_REQUEST', active: true },
          select: { id: true, steps: { select: { id: true } } },
        }));
      if (!wf || wf.steps.length === 0) {
        throw new Error('Workflow for car requests is not configured — ask Administration to enable it (Settings → Workflows).');
      }
      const created = await this.cars.createCarRequest(
        {
          destination: destination!,
          startDate: startIso!,
          endDate: endIso ?? undefined,
          timeSlot: (draft.slot as 'FULL_DAY' | 'HALF_DAY_AM' | 'HALF_DAY_PM' | 'CUSTOM_HOURS' | undefined) ?? 'FULL_DAY',
          passengers: num('passengers') ?? 1,
          vehicleTypeRequired: str('vehicle'),
          pickupLocation: str('pickup'),
          purpose: str('purpose'),
          description: str('notes'),
        },
        actor as never,
      );
      await this.workflow.submit(created.id, actor as never);
      this.pendingCarRequests.delete(chatId);
      await this.telegram.answer(callbackId, 'တောင်းခံလိုက်ပါပြီ');
      await this.telegram.sendRaw(
        chatId,
        `✅ တောင်းခံလိုက်ပါပြီ — <b>${escapeHtml(created.docNumber)}</b> — ခွင့်ပြုချက် စောင့်နေပါသည်။\n(Submitted — waiting for approval.)`,
        await this.openInAmsRow(`/requests/${created.id}`),
      );
    } catch (e) {
      // creation/validation errors stay on the card; the conversation stays open for fixing
      await this.telegram.answer(callbackId, 'မအောင်မြင်ပါ — စစ်ကြည့်ပါ');
      await this.sendRawCard(chatId, `⚠️ ${escapeHtml((e as Error).message || 'Submit failed')}\n\n${this.renderCarCard(chatId)}`);
    }
  }

  private async actCarCancel(chatId: string, callbackId: string): Promise<void> {
    this.pendingCarRequests.delete(chatId);
    await this.telegram.answer(callbackId, 'ပယ်ဖျက်လိုက်ပါသည်');
    await this.sendRawCard(chatId, '↩️ ကားတောင်းခံမှု ပယ်ဖျက်လိုက်ပါပြီ။ (Request cancelled — nothing was submitted.)');
  }

  /** The live form card — required fields up top; optional fields hidden behind
   *  [➕ ထပ်ဖြည့်မယ်] until the user opens them (9 always-on rows felt like homework). */
  private renderCarCard(chatId: string): string {
    const entry = this.pendingCarRequests.get(chatId);
    const draft = (entry?.draft ?? {}) as Record<string, string | number | undefined>;
    const sval = (k: string): string => (typeof draft[k] === 'string' ? (draft[k] as string) : '');
    const ok = (label: string, value: string | number | undefined) =>
      value != null && value !== '' ? `✅ ${label}: ${escapeHtml(String(value))}` : `➖ ${label}: —`;
    const bad = (label: string) => `❌ ${label}: (မမှန်ပါ)`;
    const startRaw = sval('start');
    const endRaw = sval('end');
    const startOk = startRaw ? TelegramCarActionsService.parseCarDateStatic(startRaw) != null : false;
    const endOk = endRaw ? TelegramCarActionsService.parseCarDateStatic(endRaw) != null : false;
    const slotLabel: Record<string, string> = {
      FULL_DAY: 'Full day',
      HALF_DAY_AM: 'Half AM',
      HALF_DAY_PM: 'Half PM',
      CUSTOM_HOURS: 'Custom',
    };
    const startLabel = draft.returnTrip === 1 ? 'ကားလာခေါ်မယ့်အချိန်' : 'ထွက်မယ့်အချိန်';
    const required = [
      '🚗 <b>ကားတောင်းခံမှု — New car request</b>',
      '────────────────',
      draft.destination ? `✅ သွားမယ့်နေရာ: ${escapeHtml(String(draft.destination))}` : '1️⃣ သွားမယ့်နေရာ — ဒီ chat မှာ ရေးပါ (ဥပမာ မန္တလေး)',
      draft.start ? (startOk ? `✅ ${startLabel}: ${escapeHtml(startRaw)}` : bad(startLabel)) : `2️⃣ ${startLabel} — အောက်က ခလုတ်နှိပ် / ရေးပါ (ဥပမာ 5/10 09:00)`,
      `• အချိန်အပိုင်းအခြား: ${draft.slot ? slotLabel[String(draft.slot)] : 'Full day'}${draft.slot === 'CUSTOM_HOURS' ? (endOk ? ` (✅ ပြန်ရောက်: ${escapeHtml(endRaw)})` : ' (❌ ပြန်ရောက်ချိန် လိုအပ်)') : ' (ပြန်ရောက် 17:00 အလိုအလျောက်)'}`,
    ];
    const optional = [
      ok('လိုက်ပါသူ', draft.passengers ?? 1),
      draft.vehicle ? `✅ ကားအမျိုးအစား: ${escapeHtml(String(draft.vehicle))}` : '➖ ကားအမျိုးအစား: —',
      draft.pickup ? `✅ တက်မည့်နေရာ: ${escapeHtml(String(draft.pickup))}` : '➖ တက်မည့်နေရာ: —',
      draft.purpose ? `✅ ရည်ရွယ်ချက်: ${escapeHtml(String(draft.purpose))}` : '➖ ရည်ရွယ်ချက်: —',
      draft.notes ? `✅ မှတ်ချက်: ${escapeHtml(String(draft.notes))}` : '➖ မှတ်ချက်: —',
    ];
    // auto-reveal once the user has actually filled an optional field
    const showExtra = !!draft.showExtra || ['vehicle', 'pickup', 'purpose', 'notes'].some((k) => draft[k] != null);
    const lines = [
      ...required,
      '────────────────',
      ...(showExtra ? optional : ['➕ ကားအမျိုးအစား / တက်မည့်နေရာ / ရည်ရွယ်ချက် / မှတ်ချက် ထပ်ဖြည့်ချင်ရင် — အောက်က [➕ ထပ်ဖြည့်မယ်] နှိပ်ပါ']),
      '────────────────',
      'ရိုးရိုးရေးလည်းရ — "မန္တလေး" (နေရာ) · "5/10 09:00" (အချိန်) · "full day" · "ပြန်မယ်" (ရုံးချုပ်ပြန်)',
      '<i>အမြန်စတင် — /car မန္တလေး</i>',
    ];
    return lines.join('\n');
  }

  /** Keyboard for the live card — quick Start times, slot shortcuts,
   *  [➕ ထပ်ဖြည့်မယ်] toggle and Submit/Cancel. */
  private carKeyboard(draft: Record<string, unknown>): { inline_keyboard: { text: string; callback_data: string }[][] } {
    const slot = draft.slot;
    const b = (text: string, data: string) => ({ text, callback_data: data });
    const rows: { text: string; callback_data: string }[][] = [
      // one-tap office hours for Start — the trip that is "today 9" covers most requests;
      // ⚡ အခု covers "heading back/out right now" (no day thinking needed)
      [
        b('⚡ အခု', 'wfa:carquick:now'),
        b('🕘 ယနေ့ 09:00', 'wfa:carquick:today|09:00'),
        b('🕐 ယနေ့ 13:00', 'wfa:carquick:today|13:00'),
      ],
      [
        b('🌅 မနက်ဖြန် 09:00', 'wfa:carquick:tomorrow|09:00'),
        b('🌆 မနက်ဖြန် 13:00', 'wfa:carquick:tomorrow|13:00'),
      ],
      // heading back to Head Office — instant return-trip draft (pickup prefilled from the last trip)
      [b('↩️ ရုံးချုပ်ပြန်', 'wfa:carback')],
      [
        b(slot === 'FULL_DAY' ? '☀️ Full day ✓' : '☀️ Full day', 'wfa:carslot:FULL_DAY'),
        b(slot === 'HALF_DAY_AM' ? '🌅 Half AM ✓' : '🌅 Half AM', 'wfa:carslot:HALF_DAY_AM'),
        b(slot === 'HALF_DAY_PM' ? '🌆 Half PM ✓' : '🌆 Half PM', 'wfa:carslot:HALF_DAY_PM'),
        b(slot === 'CUSTOM_HOURS' ? '⏱ Custom ✓' : '⏱ Custom', 'wfa:carslot:CUSTOM_HOURS'),
      ],
      [b(draft.showExtra ? '➖ ထပ်ဖြည့်ဖျောက်' : '➕ ထပ်ဖြည့်မယ်', 'wfa:carextra')],
      [b('✅ Submit', 'wfa:carsubmit'), b('❌ Cancel', 'wfa:carcancel')],
    ];
    return { inline_keyboard: rows };
  }

  /** The live form card — EDIT the tracked message when we have it, send a new
   *  one only as a fallback (first render, deleted message, other-chat glitch).
   *  Keeps the whole conversation at ONE card, never a pile of stale cards. */
  private async sendRawCard(chatId: string, text: string): Promise<void> {
    const keyboard = this.carKeyboard(this.pendingCarRequests.get(chatId)?.draft ?? {});
    const tracked = this.carCardMessages.get(chatId);
    if (tracked) {
      try {
        await this.telegram.editMessage(chatId, tracked, text, keyboard);
        return; // edited in place — no new bubble
      } catch {
        this.carCardMessages.delete(chatId); // message gone (deleted/cleared) — fall back below
      }
    }
    await this.telegram.sendRaw(chatId, text, { reply_markup: keyboard });
    // sendRaw hides the sendMessage result — capture the message id via the bot API
    // response mirror kept by TelegramService is unavailable, so track via lastCall hook:
    const last = (this.telegram as unknown as { lastSentMessageId?: number }).lastSentMessageId;
    if (last) this.carCardMessages.set(chatId, last);
    if (this.carCardMessages.size > 500) this.carCardMessages.clear(); // bounded, like other state
  }

  /** "YYYY-MM-DD HH:MM" / "DD/MM HH:MM" / "DD/MM/YYYY HHMM" → ISO (Yangon = +06:30, no DST).
   *  Static so field parsing (setCarField) and submit validation share ONE parser. */
  private static parseCarDateStatic(raw: string): string | null {
    const t = raw.trim();
    // full form: 2026-09-28 08:30 / 2026-09-28 0830 / 2026-09-28T08:30
    const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):?(\d{2})?$/);
    if (m) {
      const [, y, mo, d, h, mi] = m;
      const hour = Math.min(23, Number(h));
      const minute = Number(mi ?? '0');
      if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
      const dt = new Date(`${y}-${mo}-${d}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+06:30`);
      return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
    }
    // short form: D/M[/YY or YYYY] [HH[:]MM] — day-first (Myanmar usage),
    // 09:00 default when the time is omitted; year <100 → 2000+
    const s = t.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?:\s+(\d{1,2})[:.]?(\d{2})?)?$/);
    if (s) {
      const [, dRaw, moRaw, yRaw, hRaw, miRaw] = s;
      let day = Number(dRaw);
      let month = Number(moRaw);
      // month-first speakers (9/29 = Sep 29) hit an impossible 29th month —
      // when only one side can be a month, read the other as the day
      if (month > 12 && day <= 12) {
        [day, month] = [month, day];
      }
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      let year = yRaw ? Number(yRaw) : new Date().getFullYear();
      if (year < 100) year += 2000;
      const hour = hRaw != null ? Math.min(23, Number(hRaw)) : 9;
      const minute = miRaw != null ? Number(miRaw) : 0;
      const dt = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+06:30`);
      return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
    }
    return null;
  }

  /** Myanmar digits (၇ → 7 …) → ASCII digits. */
  private static toAsciiDigits(text: string): string {
    return text.replace(/[\u1040-\u1049]/g, (ch) => String(ch.charCodeAt(0) - 0x1040));
  }

  /** "Open in AMS" button row when a web URL is configured. */
  private async openInAmsRow(link: string): Promise<Record<string, unknown>> {
    const { webUrl } = await this.telegramWebUrl();
    if (!webUrl) return {};
    return { reply_markup: { inline_keyboard: [[{ text: '👁 Open in AMS', url: `${webUrl.replace(/\/$/, '')}${link}` }]] } };
  }

  private async telegramWebUrl(): Promise<{ webUrl: string | null }> {
    // TelegramService keeps the config logic private — mirror the system_setting read
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'telegram.web_url' } });
    const webUrl = (row?.value ?? '').trim().replace(/^"|"$/g, '');
    return { webUrl: webUrl || null };
  }

  private sweepCarDrafts() {
    const now = Date.now();
    for (const [k, v] of this.pendingCarRequests) {
      if (now - v.at > TelegramCarActionsService.CAR_TTL_MS) this.pendingCarRequests.delete(k);
    }
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
