import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';

@Injectable()
export class DelegationsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private audit: AuditService,
  ) {}

  async create(dto: { toUserId: string; startAt: string; endAt: string; reason?: string }, actor: Actor) {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException('Invalid dates');
    }
    if (startAt >= endAt) throw new BadRequestException('startAt must be before endAt');
    if (dto.toUserId === actor.userId) throw new BadRequestException('Cannot delegate to yourself');

    const target = await this.prisma.user.findUnique({ where: { id: dto.toUserId } });
    if (!target || target.status !== 'ACTIVE') throw new BadRequestException('Delegate user not found or inactive');

    // prevent overlapping active delegations from the same user
    const overlap = await this.prisma.approvalDelegation.findFirst({
      where: {
        fromUserId: actor.userId, status: 'ACTIVE',
        startAt: { lte: endAt }, endAt: { gte: startAt },
      },
    });
    if (overlap) throw new BadRequestException('You already have a delegation covering this period');

    const delegation = await this.prisma.approvalDelegation.create({
      data: {
        fromUserId: actor.userId,
        toUserId: dto.toUserId,
        startAt, endAt,
        reason: dto.reason,
      },
      include: { toUser: { select: { username: true, fullName: true } } },
    });

    await this.notifications.notify({
      userId: dto.toUserId,
      type: 'DELEGATED',
      title: 'Approval delegation received',
      body: `${actor.username} delegated approvals to you from ${startAt.toISOString()} to ${endAt.toISOString()}`,
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DELEGATION_CREATED', module: 'WORKFLOW', recordId: delegation.id,
      newValue: { to: dto.toUserId, startAt, endAt, reason: dto.reason },
    });

    return delegation;
  }

  async listMine(actor: Actor) {
    const [from, to] = await Promise.all([
      this.prisma.approvalDelegation.findMany({
        where: { fromUserId: actor.userId },
        orderBy: { createdAt: 'desc' },
        include: { toUser: { select: { username: true, fullName: true } } },
      }),
      this.prisma.approvalDelegation.findMany({
        where: { toUserId: actor.userId },
        orderBy: { createdAt: 'desc' },
        include: { fromUser: { select: { username: true, fullName: true } } },
      }),
    ]);
    return { given: from, received: to };
  }

  async end(id: string, actor: Actor) {
    const delegation = await this.prisma.approvalDelegation.findUnique({ where: { id } });
    if (!delegation) throw new NotFoundException('Delegation not found');
    if (delegation.fromUserId !== actor.userId) throw new ForbiddenException('Not your delegation');

    await this.prisma.approvalDelegation.update({ where: { id }, data: { status: 'ENDED' } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DELEGATION_ENDED', module: 'WORKFLOW', recordId: id,
      oldValue: { status: delegation.status }, newValue: { status: 'ENDED' },
    });
    return { success: true };
  }
}
