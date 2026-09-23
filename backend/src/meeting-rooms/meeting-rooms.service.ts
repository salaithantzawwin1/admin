import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, WorkflowStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { TelegramService } from '../telegram/telegram.service';
import { Actor } from '../org/org.service';

const ACTIVE: WorkflowStatus[] = ['PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'];

@Injectable()
export class MeetingRoomsService {
  private logger = new Logger('MeetingRooms');

  constructor(
    private prisma: PrismaService,
    private numbering: NumberingService,
    private notifications: NotificationsService,
    private audit: AuditService,
    private telegram: TelegramService,
  ) {}

  /** Create a meeting room request (DRAFT) — requester then submits it. */
  async create(data: {
    title: string;
    description?: string;
    attendees?: number;
    startTime: string;
    endTime?: string; // optional — defaults to +1h (same-day)
    meetingType?: string;
    externalCompanies?: string;
    attendeeNames?: string;
    itAssist?: boolean;
    reservedDriver?: boolean;
    services?: string;
  }, actor: Actor) {
    const startTime = new Date(data.startTime);
    // End optional: default start + 1 hour
    const endTime = data.endTime ? new Date(data.endTime) : new Date(startTime.getTime() + 60 * 60 * 1000);
    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
      throw new BadRequestException('Invalid times');
    }
    if (endTime <= startTime) throw new BadRequestException('endTime must be after startTime');

    const request = await this.prisma.requestDocument.create({
      data: {
        docNumber: await this.numbering.next('MTG'),
        docType: 'MEETING_ROOM_REQUEST',
        title: `Meeting: ${data.title}`,
        description: data.description,
        requesterId: actor.userId,
        departmentId: (await this.prisma.employee.findFirst({ where: { userId: actor.userId } }))?.departmentId,
      },
    });

    const mr = await this.prisma.meetingRoomRequest.create({
      data: {
        requestId: request.id,
        title: data.title,
        attendees: data.attendees ?? 1,
        startTime,
        endTime,
        meetingType: (data.meetingType || 'INTERNAL') as never,
        externalCompanies: data.externalCompanies,
        attendeeNames: data.attendeeNames,
        itAssist: data.itAssist ?? false,
        reservedDriver: data.reservedDriver ?? false,
        services: data.services,
      },
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MEETING_REQUEST_CREATED', module: 'MEETING_ROOMS', recordId: request.id,
      newValue: { docNumber: request.docNumber, title: data.title, startTime, endTime },
    });

    return { ...request, meetingRequest: mr };
  }

  /** Meeting detail for the request detail page. */
  async findByRequest(requestId: string) {
    return this.prisma.meetingRoomRequest.findUnique({
      where: { requestId },
      include: { room: true },
    });
  }

  /**
   * Rooms overview for requesters (information only): each room's status plus
   * booked windows over the next 7 days from live meeting requests.
   */
  async roomsOverview() {
    const now = new Date();
    const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [rooms, bookings] = await Promise.all([
      this.prisma.meetingRoom.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.meetingRoomRequest.findMany({
        where: {
          status: { in: ACTIVE },
          roomId: { not: null },
          startTime: { lt: in7days },
          endTime: { gt: now },
        },
        select: { roomId: true, startTime: true, endTime: true, request: { select: { docNumber: true } } },
        orderBy: { startTime: 'asc' },
      }),
    ]);

    // also show unassigned pending windows per capacity? keep simple: rooms with bookings
    return rooms.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      capacity: r.capacity,
      facilities: r.facilities,
      status: r.status,
      bookings: bookings
        .filter((b) => b.roomId === r.id)
        .map((b) => ({ docNumber: b.request?.docNumber, startTime: b.startTime, endTime: b.endTime })),
    }));
  }

  /**
   * Monthly availability calendar (Plan §7): per-room bookings for one month.
   * Default window = current month; explicit ISO bounds may be passed.
   */
  async monthlyAvailability(monthStart?: string, monthEnd?: string) {
    const now = new Date();
    const start = monthStart ? new Date(monthStart) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = monthEnd ? new Date(monthEnd) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid month window');
    }

    const [rooms, bookings] = await Promise.all([
      this.prisma.meetingRoom.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.meetingRoomRequest.findMany({
        where: {
          status: { in: ACTIVE },
          roomId: { not: null },
          startTime: { lt: end },
          endTime: { gt: start },
        },
        select: {
          roomId: true, requestId: true, startTime: true, endTime: true, status: true, title: true, attendees: true,
          request: { select: { docNumber: true, requester: { select: { fullName: true } } } },
        },
        orderBy: { startTime: 'asc' },
      }),
    ]);

    return {
      monthStart: start.toISOString(),
      monthEnd: end.toISOString(),
      rooms: rooms.map((r) => ({
        id: r.id,
        name: r.name,
        location: r.location,
        capacity: r.capacity,
        facilities: r.facilities,
        status: r.status,
        bookings: bookings
          .filter((b) => b.roomId === r.id)
          .map((b) => ({
            requestId: b.requestId,
            docNumber: b.request?.docNumber,
            requester: b.request?.requester?.fullName,
            title: b.title,
            attendees: b.attendees,
            status: b.status,
            startTime: b.startTime.toISOString(),
            endTime: b.endTime.toISOString(),
          })),
      })),
    };
  }

  /** Clash preview for a time window (before submitting). */
  async checkWindowConflicts(startTime: string, endTime: string, attendees?: number) {
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid window');
    }
    const conflicts = await this.prisma.meetingRoomRequest.findMany({
      where: {
        status: { in: ACTIVE },
        roomId: { not: null },
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: {
        startTime: true, endTime: true, title: true,
        room: { select: { name: true } },
        request: { select: { docNumber: true } },
      },
      orderBy: { startTime: 'asc' },
      take: 10,
    });

    // suggested rooms: right size, available status, free in the window —
    // ordered best-fit first (smallest room that still seats everyone)
    const rooms = await this.prisma.meetingRoom.findMany({
      where: { status: { notIn: ['OUT_OF_SERVICE', 'UNDER_MAINTENANCE'] } },
      select: { id: true, name: true, location: true, capacity: true },
    });
    const busy = new Set(conflicts.map((c) => c.room?.name).filter(Boolean));
    const busyRoomIds = new Set(
      (
        await this.prisma.meetingRoomRequest.findMany({
          where: {
            status: { in: ACTIVE },
            roomId: { not: null },
            startTime: { lt: end },
            endTime: { gt: start },
          },
          select: { roomId: true },
        })
      ).map((b) => b.roomId!),
    );
    const pax = Math.max(1, attendees ?? 1);
    const fits = rooms
      .filter((r) => r.capacity >= pax && !busyRoomIds.has(r.id))
      .sort((a, b) => a.capacity - b.capacity);
    const tooSmall = rooms.filter((r) => r.capacity < pax).length;
    const suggestions = fits.slice(0, 3).map((r) => ({
      id: r.id, name: r.name, location: r.location, capacity: r.capacity,
      label: `Room ${r.name} fits ${pax} pax`,
    }));

    return {
      conflicts,
      suggestions,
      /** true when every room is either too small or booked in this window */
      noneAvailable: rooms.length > 0 && fits.length === 0,
      tooSmallCount: tooSmall,
    };
  }

  /** Google Calendar "add event" link — dates in UTC basic format (yyyymmddTHHMMSSZ). */
  private calendarLink(title: string, details: string, start: Date, end: Date): string {
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const params = new URLSearchParams({
      action: 'TEMPLATE', text: title, details,
      dates: `${fmt(start)}/${fmt(end)}`,
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  /** Telegram HTML card for a room assignment — details + Add-to-calendar button. */
  private meetingCalendarCard(
    request: { docNumber: string; requester: { telegramChatId: string | null } },
    mr: { title: string; startTime: Date; endTime: Date; attendees: number },
    room: { name: string; location: string | null },
  ): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const when = `${mr.startTime.toLocaleString('en-GB', { timeZone: 'Asia/Yangon' })} → ${mr.endTime.toLocaleString('en-GB', { timeZone: 'Asia/Yangon' })}`;
    const details = `Room ${room.name}${room.location ? ` (${room.location})` : ''} · ${mr.attendees} pax · ${request.docNumber}`;
    const link = this.calendarLink(`${mr.title} — ${room.name}`, details, mr.startTime, mr.endTime);
    return [
      `<b>📅 Meeting room assigned — ${esc(mr.title)}</b>`,
      ``,
      `🏢 ${esc(room.name)}${room.location ? ` · ${esc(room.location)}` : ''}`,
      `🕐 ${esc(when)}`,
      `👥 ${mr.attendees} attendees`,
      ``,
      `<a href="${link}">📅 Add to calendar</a>`,
    ].join('\n');
  }

  /** Administration assigns a room to an APPROVED meeting request. */
  async assign(requestId: string, roomId: string | undefined, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { meetingRequest: true, requester: { select: { telegramChatId: true } } },
    });
    if (!request || !request.meetingRequest) throw new NotFoundException('Meeting request not found');
    if (request.status !== 'APPROVED') {
      throw new BadRequestException(`Only APPROVED requests can be assigned (current: ${request.status})`);
    }

    const mr = request.meetingRequest;

    if (!roomId) {
      // clear the room (re-open the booking)
      await this.prisma.meetingRoomRequest.update({ where: { requestId }, data: { roomId: null } });
      return { success: true };
    }

    const room = await this.prisma.meetingRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.status === 'OUT_OF_SERVICE' || room.status === 'UNDER_MAINTENANCE') {
      throw new ConflictException(`Room ${room.name} is ${room.status}`);
    }
    if (mr.attendees > room.capacity) {
      throw new ConflictException(`Room ${room.name} seats ${room.capacity} — ${mr.attendees} attendees requested`);
    }

    // double-booking prevention: overlap re-check
    const conflicts = await this.prisma.meetingRoomRequest.findMany({
      where: {
        roomId, requestId: { not: requestId },
        status: { in: ACTIVE },
        startTime: { lt: mr.endTime },
        endTime: { gt: mr.startTime },
      },
      select: { request: { select: { docNumber: true } }, startTime: true, endTime: true },
    });
    if (conflicts.length > 0) {
      throw new ConflictException(
        `Room ${room.name} is already booked ${conflicts[0].startTime.toISOString()} → ${conflicts[0].endTime.toISOString()} (${conflicts[0].request.docNumber})`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.meetingRoomRequest.update({ where: { requestId }, data: { roomId, status: 'IN_PROGRESS' } });
      await tx.requestDocument.update({ where: { id: requestId }, data: { status: 'IN_PROGRESS' } });
      await tx.meetingRoom.update({ where: { id: roomId }, data: { status: 'IN_USE' } });
    });

    await this.notifications.notify({
      userId: request.requesterId,
      type: 'MEETING_ROOM_ASSIGNED',
      title: `Room assigned to ${request.docNumber}`,
      body: `${room.name}${room.location ? ` (${room.location})` : ''} has been booked for your meeting.`,
      link: `/requests/${requestId}`, requestId,
    });

    // Telegram card gets a one-tap "Add to calendar" button — fewer no-shows
    await this.telegram
      .sendRaw(request.requester.telegramChatId ?? '', this.meetingCalendarCard(request, mr, room))
      .catch(() => undefined);

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MEETING_ROOM_ASSIGNED', module: 'MEETING_ROOMS', recordId: requestId,
      newValue: { roomId, roomName: room.name },
    });

    return { success: true };
  }

  /** Administration shifts the meeting time (requester is notified). */
  async adminShiftTime(requestId: string, data: { startTime: string; endTime: string; comment?: string }, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { meetingRequest: true },
    });
    if (!request || !request.meetingRequest) throw new NotFoundException('Meeting request not found');
    if (!['APPROVED', 'PENDING_APPROVAL', 'IN_PROGRESS'].includes(request.status)) {
      throw new BadRequestException(`Cannot shift time from status ${request.status}`);
    }

    const start = new Date(data.startTime);
    const end = new Date(data.endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid time window');
    }

    // if a room is already assigned, the new window must stay conflict-free
    if (request.meetingRequest.roomId) {
      const conflicts = await this.prisma.meetingRoomRequest.findMany({
        where: {
          roomId: request.meetingRequest.roomId,
          requestId: { not: requestId },
          status: { in: ACTIVE },
          startTime: { lt: end },
          endTime: { gt: start },
        },
      });
      if (conflicts.length > 0) {
        throw new ConflictException('The room is already booked in the new window — unassign it or pick another window');
      }
    }

    await this.prisma.meetingRoomRequest.update({
      where: { requestId },
      data: { startTime: start, endTime: end },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MEETING_TIME_SHIFTED', module: 'MEETING_ROOMS', recordId: requestId,
      oldValue: { start: request.meetingRequest.startTime, end: request.meetingRequest.endTime },
      newValue: { start, end },
    });
    await this.notifications.notify({
      userId: request.requesterId, type: 'RETURNED' as never,
      title: `Request ${request.docNumber} time changed by Administration`,
      body: `New schedule: ${start.toLocaleString()} → ${end.toLocaleString()}.${data.comment ? ` Note: ${data.comment}` : ''}`,
      link: `/requests/${requestId}`, requestId,
    });
    return { success: true };
  }

  /** Mark a live meeting as COMPLETED and free the assigned room. */
  async complete(requestId: string, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { meetingRequest: true },
    });
    if (!request || !request.meetingRequest) throw new NotFoundException('Meeting request not found');
    if (request.status !== 'IN_PROGRESS') {
      throw new BadRequestException(`Only IN_PROGRESS meetings can be completed (current: ${request.status})`);
    }

    const mr = request.meetingRequest;

    // free the room only when no OTHER live booking still uses it
    await this.prisma.$transaction(async (tx) => {
      if (mr.roomId) {
        const others = await tx.meetingRoomRequest.count({
          where: { roomId: mr.roomId, requestId: { not: requestId }, status: { in: ACTIVE } },
        });
        if (others === 0) {
          await tx.meetingRoom.update({ where: { id: mr.roomId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
        }
      }
      await tx.meetingRoomRequest.update({ where: { requestId }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await tx.requestDocument.update({ where: { id: requestId }, data: { status: 'COMPLETED' } });
    });

    await this.audit.log({
      userId: actor.userId || undefined, username: actor.username,
      action: 'MEETING_COMPLETED', module: 'MEETING_ROOMS', recordId: requestId,
      oldValue: { status: 'IN_PROGRESS' }, newValue: { status: 'COMPLETED' },
    });
    await this.notifications.notify({
      userId: request.requesterId,
      type: 'MEETING_COMPLETED' as never,
      title: `Meeting completed — ${request.docNumber}`,
      body: `Your meeting "${mr.title}" is marked as completed. Thank you.`,
      link: `/requests/${requestId}`, requestId,
    });
    return { success: true };
  }

  /**
   * Auto-complete: an assigned meeting whose window has ended is completed by a
   * half-hourly pass (mirrors the cars auto-release cron) so rooms do not stay
   * IN_USE forever and requesters see the real status.
   */
  async autoCompleteEnded(): Promise<number> {
    const now = new Date();
    const stuck = await this.prisma.meetingRoomRequest.findMany({
      where: { status: 'IN_PROGRESS', endTime: { lt: now } },
      select: { requestId: true },
    });
    let done = 0;
    for (const { requestId } of stuck) {
      try {
        // system actor — no user id (audit log stores username 'system' only)
        await this.complete(requestId, { userId: '', username: 'system' });
        done++;
      } catch (e) {
        this.logger.warn(`auto-complete failed for ${requestId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return done;
  }

  // every 30 minutes — release rooms whose meetings have ended
  @Cron('0 */30 * * * *')
  async autoCompleteEndedCron() {
    const done = await this.autoCompleteEnded();
    if (done > 0) this.logger.log(`auto-completed ${done} ended meeting(s)`);
  }

  /**
   * Daily 08:30 — approved meetings still without a room 24h+ after submission
   * (and still upcoming) → one consolidated reminder to Administration,
   * with Telegram mirror via notifyMany.
   */
  @Cron('0 30 8 * * *')
  async unassignedMeetingReminderCron() {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
    const rows = await this.prisma.requestDocument.findMany({
      where: {
        status: 'APPROVED',
        submittedAt: { lt: cutoff },
        meetingRequest: { roomId: null, startTime: { gt: new Date() } },
      },
      select: {
        docNumber: true, title: true,
        meetingRequest: { select: { startTime: true, attendees: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    if (rows.length === 0) return;
    const admins = await this.prisma.userRole.findMany({
      where: { role: { name: 'ADMINISTRATION' }, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    const userIds = [...new Set(admins.map((r) => r.userId))];
    if (userIds.length === 0) return;
    const list = rows
      .map((r) => {
        const when = r.meetingRequest?.startTime
          ? new Date(r.meetingRequest.startTime).toLocaleString('en-GB', { timeZone: 'Asia/Yangon' })
          : '?';
        return `• ${r.docNumber} — ${r.title} (${when}, ${r.meetingRequest?.attendees ?? 1} pax)`;
      })
      .join('\n');
    await this.notifications.notifyMany(userIds, {
      type: 'REMINDER',
      title: `⏰ ${rows.length} approved meeting(s) still waiting for a room`,
      body: `Waiting more than 24h without a room assignment:\n${list}`,
      link: '/meeting-rooms?tab=requests',
    });
    this.logger.log(`unassigned-meeting reminder sent for ${rows.length} request(s) to ${userIds.length} admin(s)`);
  }

  /** Administration cancels a live meeting request (frees the room). */
  async adminCancel(requestId: string, comment: string | undefined, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { meetingRequest: true },
    });
    if (!request || !request.meetingRequest) throw new NotFoundException('Meeting request not found');
    if (!['APPROVED', 'PENDING_APPROVAL', 'IN_PROGRESS'].includes(request.status)) {
      throw new BadRequestException(`Cannot cancel from status ${request.status}`);
    }

    await this.prisma.$transaction(async (tx) => {
      const mr = request.meetingRequest!;
      // free the room only when no OTHER live booking still uses it
      if (mr.roomId) {
        const others = await tx.meetingRoomRequest.count({
          where: { roomId: mr.roomId, requestId: { not: requestId }, status: { in: ACTIVE } },
        });
        if (others === 0) {
          await tx.meetingRoom.update({ where: { id: mr.roomId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
        }
      }
      await tx.meetingRoomRequest.update({ where: { requestId }, data: { roomId: null, status: 'CANCELLED' } });
      await tx.requestDocument.update({ where: { id: requestId }, data: { status: 'CANCELLED' } });
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MEETING_ADMIN_CANCELLED', module: 'MEETING_ROOMS', recordId: requestId,
      newValue: { comment },
    });
    await this.notifications.notify({
      userId: request.requesterId, type: 'CANCELLED',
      title: `Request ${request.docNumber} cancelled by Administration`,
      body: comment || 'Your meeting request was cancelled by the Administration Department.',
      link: `/requests/${requestId}`, requestId,
    });
    return { success: true };
  }

  /** Administration queue: APPROVED meeting requests with no room yet. */
  async listApprovedUnassigned() {
    return this.prisma.requestDocument.findMany({
      where: {
        docType: 'MEETING_ROOM_REQUEST',
        status: 'APPROVED',
        meetingRequest: { roomId: null },
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        requester: { select: { username: true, fullName: true } },
        department: { select: { name: true } },
        meetingRequest: { select: { title: true, attendees: true, startTime: true, endTime: true } },
      },
    });
  }

  // ---------- room setup CRUD (Administration) ----------

  listRooms() {
    return this.prisma.meetingRoom.findMany({ orderBy: { name: 'asc' } });
  }

  // ---------- facility master data (Plan §7) ----------

  /** Exact-token CSV check — "TV" must NOT match a room storing "Apple TV". */
  private facilityCsvHas(csv: string | null | undefined, name: string): boolean {
    return (csv ?? '').split(',').map((x) => x.trim()).includes(name);
  }

  /** Facilities + how many rooms use each (UI shows the count, warns before delete). */
  async listFacilities() {
    const [facilities, rooms] = await Promise.all([
      this.prisma.facilityMaster.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
      this.prisma.meetingRoom.findMany({ select: { facilities: true } }),
    ]);
    return facilities.map((f) => ({
      ...f,
      roomCount: rooms.filter((r) => this.facilityCsvHas(r.facilities, f.name)).length,
    }));
  }

  async createFacility(name: string, active: boolean | undefined, actor: Actor) {
    const exists = await this.prisma.facilityMaster.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (exists) throw new ConflictException(`Facility "${exists.name}" already exists`);
    const facility = await this.prisma.facilityMaster.create({ data: { name, active } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'FACILITY_CREATED', module: 'MEETING_ROOMS', recordId: facility.id,
      newValue: { name: facility.name },
    });
    return facility;
  }

  /** Toggle active (hide from the picker). Renames are not allowed — rooms
   *  store facilities as a CSV of names. */
  async updateFacility(id: string, data: { active?: boolean }, actor: Actor) {
    const facility = await this.prisma.facilityMaster.findUnique({ where: { id } });
    if (!facility) throw new NotFoundException('Facility not found');
    const updated = await this.prisma.facilityMaster.update({ where: { id }, data: { active: data.active } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'FACILITY_UPDATED', module: 'MEETING_ROOMS', recordId: id,
      oldValue: { active: facility.active }, newValue: { active: updated.active },
    });
    return updated;
  }

  /**
   * Delete only when no room references the facility name —
   * otherwise deactivate it so existing rooms stay correct.
   */
  async deleteFacility(id: string, actor: Actor) {
    const facility = await this.prisma.facilityMaster.findUnique({ where: { id } });
    if (!facility) throw new NotFoundException('Facility not found');
    // exact-token match — a plain contains() would wrongly block "TV" because of "Apple TV"
    const rooms = await this.prisma.meetingRoom.findMany({ select: { facilities: true } });
    const used = rooms.filter((r) => this.facilityCsvHas(r.facilities, facility.name)).length;
    if (used > 0) {
      throw new ConflictException(`Cannot delete "${facility.name}": ${used} room(s) use it — deactivate it instead`);
    }
    await this.prisma.facilityMaster.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'FACILITY_DELETED', module: 'MEETING_ROOMS', recordId: id,
      oldValue: { name: facility.name },
    });
    return { ok: true };
  }

  async createRoom(data: { name: string; location?: string; capacity?: number; facilities?: string }, actor: Actor) {
    const name = data.name?.trim() ?? '';
    if (name.length < 2 || name.length > 100) throw new BadRequestException('Room name must be 2–100 characters');
    if (data.capacity != null && (data.capacity < 1 || data.capacity > 9999)) throw new BadRequestException('Capacity must be between 1 and 9999');
    const exists = await this.prisma.meetingRoom.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (exists) throw new ConflictException(`Room "${exists.name}" already exists`);
    const room = await this.prisma.meetingRoom.create({
      data: {
        name: data.name,
        location: data.location,
        capacity: data.capacity ?? 8,
        facilities: data.facilities,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MEETING_ROOM_CREATED', module: 'MEETING_ROOMS', recordId: room.id,
      newValue: { name: room.name, capacity: room.capacity },
    });
    return room;
  }

  async updateRoom(id: string, data: { name?: string; location?: string; capacity?: number; facilities?: string; status?: string }, actor: Actor) {
    if (data.name != null) {
      data.name = data.name.trim();
      if (data.name.length < 2 || data.name.length > 100) throw new BadRequestException('Room name must be 2–100 characters');
    }
    if (data.capacity != null && (data.capacity < 1 || data.capacity > 9999)) throw new BadRequestException('Capacity must be between 1 and 9999');
    const room = await this.prisma.meetingRoom.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    if (data.name && data.name !== room.name) {
      const dup = await this.prisma.meetingRoom.findFirst({ where: { name: { equals: data.name, mode: 'insensitive' } } });
      if (dup) throw new ConflictException(`Room "${dup.name}" already exists`);
    }
    const updated = await this.prisma.meetingRoom.update({
      where: { id },
      data: {
        name: data.name,
        location: data.location,
        capacity: data.capacity,
        facilities: data.facilities,
        status: data.status as never,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MEETING_ROOM_UPDATED', module: 'MEETING_ROOMS', recordId: id,
      newValue: data,
    });
    return updated;
  }

  async deleteRoom(id: string, actor: Actor) {
    const room = await this.prisma.meetingRoom.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    const active = await this.prisma.meetingRoomRequest.count({
      where: { roomId: id, status: { in: ACTIVE } },
    });
    if (active > 0) {
      throw new ConflictException(`Room ${room.name} has ${active} active booking(s) — cancel them first`);
    }
    await this.prisma.meetingRoom.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MEETING_ROOM_DELETED', module: 'MEETING_ROOMS', recordId: id,
      oldValue: { name: room.name },
    });
    return { success: true };
  }
}
