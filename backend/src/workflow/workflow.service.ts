import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApprovalActionType, Prisma, RequestDocType, WorkflowStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';

const DOC_PREFIX: Record<string, string> = {
  GENERIC_REQUEST: 'GEN',
  CAR_REQUEST: 'CAR',
  MEETING_ROOM_REQUEST: 'MTG',
  PURCHASE_REQUEST: 'PR',
  OFFICE_SUPPLY_REQUEST: 'OSR',
  TRAVEL_REQUEST: 'TRV',
  MAINTENANCE_REQUEST: 'MRQ',
};

const OPEN_STATUSES: WorkflowStatus[] = ['SUBMITTED', 'PENDING_APPROVAL', 'ON_HOLD', 'IN_PROGRESS'];

@Injectable()
export class WorkflowService {
  private logger = new Logger('Workflow');
  /** Injected post-boot to avoid a circular dependency (inventory ↔ workflow). */
  private inventoryHook?: { fulfill(requestId: string, actor: Actor): Promise<unknown> };

  constructor(
    private prisma: PrismaService,
    private numbering: NumberingService,
    private notifications: NotificationsService,
    private audit: AuditService,
  ) {}  /** Register a module hook fired when its docType reaches final approval. */
  /** Optional Telegram-approval hook (wired by TelegramModule at bootstrap). */
  onSubmittedTelegram?: (requestId: string) => Promise<void>;

  registerFinalApproveHook(docType: RequestDocType, hook: (requestId: string, actor: Actor) => Promise<unknown>) {
    this.finalApproveHooks.set(docType, hook);
  }

  private finalApproveHooks = new Map<RequestDocType, (requestId: string, actor: Actor) => Promise<unknown>>();

  /** Register a module hook used when the requester cancels an APPROVED request. */
  registerCancelHook(docType: RequestDocType, hook: (requestId: string, actor: Actor) => Promise<unknown>) {
    this.cancelHooks.set(docType, hook);
  }

  private cancelHooks = new Map<RequestDocType, (requestId: string, actor: Actor) => Promise<unknown>>();

  // ---------- helpers ----------

  private async resolveDelegation(userId: string, at: Date): Promise<string[]> {
    // returns [actual userId, ...delegate targets] — approvals made by a delegate
    // are credited to the real approver
    const active = await this.prisma.approvalDelegation.findMany({
      where: { toUserId: userId, status: 'ACTIVE', startAt: { lte: at }, endAt: { gte: at } },
    });
    return active.map((d) => d.fromUserId);
  }

  private async userRoleNames(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId, role: { name: { not: undefined } } },
      include: { role: true },
    });
    return rows.map((r) => r.role.name as string);
  }

  /** Resolve the workflow for a docType: module-specific if defined, else GENERIC_REQUEST fallback. */
  private async workflowFor(docType: string) {
    let workflow = await this.prisma.approvalWorkflow.findUnique({
      where: { module: docType },
      include: { steps: { orderBy: { level: 'asc' } } },
    });
    if (!workflow || !workflow.active || workflow.steps.length === 0) {
      workflow = await this.prisma.approvalWorkflow.findUnique({
        where: { module: 'GENERIC_REQUEST' },
        include: { steps: { orderBy: { level: 'asc' } } },
      });
    }
    return workflow;
  }

  private async notifyApprovers(requestId: string, level: number, type: Parameters<NotificationsService['notifyMany']>[1]['type'], title: string, body: string) {
    const request = await this.prisma.requestDocument.findUnique({ where: { id: requestId }, select: { docType: true } });
    const module = await this.prisma.approvalWorkflow.findFirst({
      where: { OR: [{ module: request?.docType as string }, { module: 'GENERIC_REQUEST' }], active: true },
      orderBy: { module: 'desc' }, // prefer module-specific workflow
    });
    const step = await this.prisma.approvalStep.findFirstOrThrow({
      where: { workflowId: module!.id, level },
    });
    const usersWithRole = await this.prisma.userRole.findMany({
      where: { role: { name: step.roleName }, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    let userIds = usersWithRole.map((u) => u.userId);
    // notify delegates too
    const delegations = await this.prisma.approvalDelegation.findMany({
      where: { status: 'ACTIVE', startAt: { lte: new Date() }, endAt: { gte: new Date() }, fromUserId: { in: userIds } },
      select: { toUserId: true },
    });
    userIds = [...userIds, ...delegations.map((d) => d.toUserId)];
    await this.notifications.notifyMany([...new Set(userIds)], { type, title, body, link: `/requests/${requestId}`, requestId });
  }

  // ---------- CRUD ----------

  async create(data: { title: string; description?: string; docType?: string }, actor: Actor) {
    const docType = (data.docType || 'GENERIC_REQUEST') as keyof typeof DOC_PREFIX;
    const docNumber = await this.numbering.next(DOC_PREFIX[docType] || 'GEN');

    const employee = await this.prisma.employee.findFirst({ where: { userId: actor.userId } });

    const request = await this.prisma.requestDocument.create({
      data: {
        docNumber,
        docType: docType as never,
        title: data.title,
        description: data.description,
        requesterId: actor.userId,
        departmentId: employee?.departmentId,
      },
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'REQUEST_CREATED', module: 'WORKFLOW', recordId: request.id,
      newValue: { docNumber, title: data.title },
    });

    return request;
  }

  async update(id: string, data: { title?: string; description?: string }, actor: Actor) {
    const request = await this.mustFind(id);
    if (request.requesterId !== actor.userId) throw new ForbiddenException('Not your request');
    if (request.status !== 'DRAFT') throw new BadRequestException('Only DRAFT requests can be edited');

    const updated = await this.prisma.requestDocument.update({
      where: { id },
      data: { title: data.title, description: data.description },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'REQUEST_UPDATED', module: 'WORKFLOW', recordId: id,
      oldValue: { title: request.title, description: request.description },
      newValue: data,
    });
    return updated;
  }

  async list(params: { page: number; pageSize: number; status?: string; mine?: boolean; dept?: boolean; docType?: string; archived?: string }, actor: Actor) {
    const where: Prisma.RequestDocumentWhereInput = {};
    if (params.mine) where.requesterId = actor.userId;
    if (params.status) where.status = params.status as WorkflowStatus;
    if (params.docType) where.docType = params.docType as RequestDocType;
    // auto-archived (cancelled >30d) docs are hidden unless explicitly requested:
    //   ?archived=exclude (default) · ?archived=only (archive view) · ?archived=all
    if (params.archived === 'only') where.archivedAt = { not: null };
    else if (params.archived !== 'all') where.archivedAt = null;
    if (params.dept) {
      const employee = await this.prisma.employee.findFirst({ where: { userId: actor.userId } });
      where.departmentId = employee?.departmentId;
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.requestDocument.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          requester: { select: { username: true, fullName: true } },
          department: { select: { name: true } },
          _count: { select: { attachments: true } },
        },
      }),
      this.prisma.requestDocument.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  async detail(id: string, actor: Actor) {
    const request = await this.mustFind(id);
    const roles = await this.userRoleNames(actor.userId);
    const isOwner = request.requesterId === actor.userId;
    // approver = any role appearing in the resolved workflow's steps (workflow-specific)
    const wf = await this.workflowFor(request.docType as string);
    const stepRoles = (wf?.steps ?? []).map((s) => s.roleName as string);
    const isApprover = roles.includes('SYSTEM_ADMIN') || stepRoles.some((r) => roles.includes(r));

    if (!isOwner && !isApprover) throw new ForbiddenException('No access');

    const [actions, attachments] = await Promise.all([
      this.prisma.approvalAction.findMany({
        where: { requestId: id },
        orderBy: { createdAt: 'asc' },
        include: { approver: { select: { username: true, fullName: true } } },
      }),
      this.prisma.attachment.findMany({ where: { requestId: id }, orderBy: { createdAt: 'desc' } }),
    ]);

    // current step info for approvers
    let currentStep: Awaited<ReturnType<typeof this.prisma.approvalStep.findFirst>> = null;
    if (request.status === 'PENDING_APPROVAL' || request.status === 'SUBMITTED') {
      const wf = await this.workflowFor(request.docType as string);
      if (wf) {
        currentStep = await this.prisma.approvalStep.findFirst({
          where: { workflowId: wf.id, level: request.currentLevel },
        });
      }
    }

    return { ...request, actions, attachments, currentStep, isOwner };
  }

  // ---------- workflow transitions ----------

  async submit(id: string, actor: Actor) {
    const request = await this.mustFind(id);
    if (request.requesterId !== actor.userId) throw new ForbiddenException('Only the requester can submit');
    if (request.status !== 'DRAFT') throw new BadRequestException(`Cannot submit from status ${request.status}`);

    const workflow = await this.workflowFor(request.docType as string);
    if (!workflow || !workflow.active || workflow.steps.length === 0) {
      throw new BadRequestException('No active workflow configured');
    }

    const firstLevel = workflow.steps[0].level;
    const updated = await this.prisma.requestDocument.update({
      where: { id },
      data: {
        status: 'PENDING_APPROVAL',
        currentLevel: firstLevel,
        totalLevels: workflow.steps.length,
        submittedAt: new Date(),
      },
    });

    await this.prisma.approvalAction.create({
      data: {
        requestId: id, level: 0, approverId: actor.userId,
        action: 'SUBMIT', previousStatus: 'DRAFT', newStatus: 'PENDING_APPROVAL',
      },
    });

    await this.notifyApprovers(id, firstLevel, 'SUBMITTED', `New request ${request.docNumber}`, `${request.title} awaits approval`);
    // Telegram surface: bound Administration users get [Approve]/[Reject] buttons (optional hook)
    await this.onSubmittedTelegram?.(id).catch(() => undefined);

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'REQUEST_SUBMITTED', module: 'WORKFLOW', recordId: id,
      oldValue: { status: 'DRAFT' }, newValue: { status: 'PENDING_APPROVAL', level: firstLevel },
    });

    return updated;
  }

  async approve(id: string, comment: string | undefined, actor: Actor) {
    const request = await this.mustFind(id);
    if (request.status !== 'PENDING_APPROVAL') throw new BadRequestException(`Cannot approve from status ${request.status}`);
    // separation of duties: a requester can never approve/reject their own request
    if (request.requesterId === actor.userId) {
      throw new ForbiddenException('You cannot act on your own request');
    }

    const workflow = await this.workflowFor(request.docType as string);
    if (!workflow) throw new BadRequestException('No active workflow configured');
    const step = await this.prisma.approvalStep.findFirstOrThrow({
      where: { workflowId: workflow.id, level: request.currentLevel },
    });
    const roles = await this.userRoleNames(actor.userId);
    const now = new Date();

    const isDirect = roles.includes(step.roleName) || roles.includes('SYSTEM_ADMIN');
    let actingFor: string | null = null; // delegation: approve on behalf of
    if (!isDirect) {
      const delegations = await this.resolveDelegation(actor.userId, now);
      const delegateUserRoles = await this.prisma.userRole.findMany({
        where: { userId: { in: delegations }, role: { name: step.roleName } },
      });
      if (delegateUserRoles.length > 0) {
        actingFor = delegateUserRoles[0].userId;
      } else {
        throw new ForbiddenException(`Requires role ${step.roleName} (or a delegation)`);
      }
    }

    const isLastLevel = request.currentLevel >= request.totalLevels;
    const newStatus: WorkflowStatus = isLastLevel ? 'APPROVED' : 'PENDING_APPROVAL';
    const nextLevel = isLastLevel ? request.currentLevel : request.currentLevel + 1;

    const updated = await this.prisma.$transaction(async (tx) => {
      const r = await tx.requestDocument.update({
        where: { id },
        data: { status: newStatus, currentLevel: nextLevel },
      });
      await tx.approvalAction.create({
        data: {
          requestId: id, level: request.currentLevel, approverId: actor.userId,
          action: isLastLevel ? 'FINAL_APPROVE' : 'APPROVE',
          comment, previousStatus: request.status, newStatus,
        },
      });
      return r;
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: isLastLevel ? 'REQUEST_FINAL_APPROVED' : 'REQUEST_APPROVED',
      module: 'WORKFLOW', recordId: id,
      oldValue: { status: request.status, level: request.currentLevel },
      newValue: { status: newStatus, level: nextLevel, actingFor },
    });

    if (isLastLevel) {
      await this.notifications.notify({
        userId: request.requesterId, type: 'FINAL_APPROVED',
        title: `Request ${request.docNumber} approved`,
        body: 'Your request has been fully approved.',
        link: `/requests/${id}`, requestId: id,
      });
      // module hook (e.g. office supply → stock deduction / fulfillment)
      const hook = this.finalApproveHooks.get(request.docType);
      if (hook) {
        try {
          await hook(id, actor);
        } catch (e) {
          // the approval stands; fulfillment issues are surfaced in the module + logs
          this.logger.warn(`post-approval hook failed for ${request.docNumber}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } else {
      await this.notifyApprovers(id, nextLevel, 'SUBMITTED', `Request ${request.docNumber} needs approval (L${nextLevel})`, request.title);
    }

    return updated;
  }

  /**
   * Approver authority check shared by approve/reject/return: the actor must hold the
   * current workflow step's role (or act via an active delegation). Used by the
   * reject/return paths which the controller-level guards cannot scope per-request.
   */
  private async assertApproverForStep(request: { docType: string; currentLevel: number; requesterId?: string }, actor: Actor) {
    // separation of duties: a requester can never act on their own request
    if (request.requesterId === actor.userId) {
      throw new ForbiddenException('You cannot act on your own request');
    }
    const workflow = await this.workflowFor(request.docType as string);
    if (!workflow) throw new BadRequestException('No active workflow configured');
    const step = await this.prisma.approvalStep.findFirstOrThrow({
      where: { workflowId: workflow.id, level: request.currentLevel },
    });
    const roles = await this.userRoleNames(actor.userId);
    if (roles.includes('SYSTEM_ADMIN') || roles.includes(step.roleName)) return;

    const delegations = await this.resolveDelegation(actor.userId, new Date());
    if (delegations.length > 0) {
      const delegateUserRoles = await this.prisma.userRole.findMany({
        where: { userId: { in: delegations }, role: { name: step.roleName } },
      });
      if (delegateUserRoles.length > 0) return;
    }
    throw new ForbiddenException(`Requires role ${step.roleName} (or a delegation)`);
  }

  async reject(id: string, comment: string | undefined, actor: Actor) {
    const request = await this.mustFind(id);
    if (request.status !== 'PENDING_APPROVAL') throw new BadRequestException(`Cannot reject from status ${request.status}`);
    if (!comment) throw new BadRequestException('A comment is required when rejecting');
    await this.assertApproverForStep(request, actor);

    const updated = await this.prisma.$transaction(async (tx) => {
      const r = await tx.requestDocument.update({
        where: { id },
        data: { status: 'REJECTED' },
      });
      await tx.approvalAction.create({
        data: {
          requestId: id, level: request.currentLevel, approverId: actor.userId,
          action: 'REJECT', comment, previousStatus: request.status, newStatus: 'REJECTED',
        },
      });
      return r;
    });

    await this.notifications.notify({
      userId: request.requesterId, type: 'REJECTED',
      title: `Request ${request.docNumber} rejected`,
      body: comment, link: `/requests/${id}`, requestId: id,
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'REQUEST_REJECTED', module: 'WORKFLOW', recordId: id,
      oldValue: { status: request.status }, newValue: { status: 'REJECTED' },
    });

    return updated;
  }

  /** Return to requester for correction → back to DRAFT, requester can resubmit. */
  async returnToRequester(id: string, comment: string | undefined, actor: Actor) {
    const request = await this.mustFind(id);
    if (request.status !== 'PENDING_APPROVAL') throw new BadRequestException(`Cannot return from status ${request.status}`);
    await this.assertApproverForStep(request, actor);

    const updated = await this.prisma.$transaction(async (tx) => {
      const r = await tx.requestDocument.update({
        where: { id },
        data: { status: 'DRAFT', currentLevel: 0 },
      });
      await tx.approvalAction.create({
        data: {
          requestId: id, level: request.currentLevel, approverId: actor.userId,
          action: 'RETURN', comment, previousStatus: request.status, newStatus: 'DRAFT',
        },
      });
      return r;
    });

    await this.notifications.notify({
      userId: request.requesterId, type: 'RETURNED',
      title: `Request ${request.docNumber} returned`,
      body: comment || 'Please review and resubmit.',
      link: `/requests/${id}`, requestId: id,
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'REQUEST_RETURNED', module: 'WORKFLOW', recordId: id,
      oldValue: { status: request.status }, newValue: { status: 'DRAFT' },
    });

    return updated;
  }

  async cancel(id: string, actor: Actor) {
    const request = await this.mustFind(id);
    if (request.requesterId !== actor.userId) throw new ForbiddenException('Only the requester can cancel');
    if (!['DRAFT', 'PENDING_APPROVAL', 'SUBMITTED'].includes(request.status)) {
      throw new BadRequestException(`Cannot cancel from status ${request.status}`);
    }

    const updated = await this.prisma.requestDocument.update({
      where: { id }, data: { status: 'CANCELLED' },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'REQUEST_CANCELLED', module: 'WORKFLOW', recordId: id,
      oldValue: { status: request.status }, newValue: { status: 'CANCELLED' },
    });
    // the current-level approvers may still have it in their inbox — clear the stale entry
    try {
      const module = await this.prisma.approvalWorkflow.findFirst({
        where: { OR: [{ module: request.docType as string }, { module: 'GENERIC_REQUEST' }], active: true },
        orderBy: { module: 'desc' },
      });
      const step = module
        ? await this.prisma.approvalStep.findFirst({ where: { workflowId: module.id, level: request.currentLevel } })
        : null;
      if (step) {
        const holders = await this.prisma.userRole.findMany({
          where: { role: { name: step.roleName }, user: { status: 'ACTIVE' } },
          select: { userId: true },
        });
        for (const h of holders) {
          if (h.userId === actor.userId) continue;
          await this.notifications.notify({
            userId: h.userId, type: 'CANCELLED',
            title: `Request ${request.docNumber} withdrawn by requester`,
            body: `${request.title} was cancelled while awaiting approval.`,
            link: `/requests/${id}`, requestId: id,
          });
        }
      }
    } catch {
      // notification is best-effort; the cancellation itself must not fail
    }
    return updated;
  }

  /**
   * Requester-initiated cancel of an APPROVED (or in-flight) request —
   * "I no longer need this". Delegates to the owning module's admin-cancel so
   * the vehicle/room is freed and Administration + the driver are notified
   * (in-app + Telegram mirror). Only the requester may do this.
   */
  async cancelApproved(id: string, actor: Actor) {
    const request = await this.mustFind(id);
    if (request.requesterId !== actor.userId) throw new ForbiddenException('Only the requester can cancel their request');
    if (!['APPROVED', 'IN_PROGRESS'].includes(request.status)) {
      throw new BadRequestException(`Cannot cancel from status ${request.status} — use Recall while awaiting approval`);
    }
    const hook = this.cancelHooks.get(request.docType);
    if (hook) {
      await hook(id, actor);
    } else {
      // no module hook (generic requests) — just close the document
      await this.prisma.requestDocument.update({ where: { id }, data: { status: 'CANCELLED' } });
    }
    return { success: true };
  }

  /** Approvals inbox: pending requests whose resolved workflow step matches my roles (per docType). */
  async inbox(actor: Actor, page = 1, pageSize = 20) {
    const roles = await this.userRoleNames(actor.userId);
    const now = new Date();

    // delegations I am acting for
    const delegations = await this.prisma.approvalDelegation.findMany({
      where: { toUserId: actor.userId, status: 'ACTIVE', startAt: { lte: now }, endAt: { gte: now } },
    });
    const effectiveRoleSets: string[][] = [roles];
    for (const d of delegations) {
      effectiveRoleSets.push(await this.userRoleNames(d.fromUserId));
    }
    const allRoles = [...new Set(effectiveRoleSets.flat())];

    // resolve the applicable workflow per docType, then match (docType, level) pairs
    // by role — prevents cross-workflow level leakage (e.g. head seeing CAR requests)
    const pendingDocTypes = await this.prisma.requestDocument.findMany({
      where: { status: 'PENDING_APPROVAL' },
      select: { docType: true },
      distinct: ['docType'],
    });

    const or: Prisma.RequestDocumentWhereInput[] = [];
    for (const { docType } of pendingDocTypes) {
      const wf = await this.workflowFor(docType as string);
      if (!wf || !wf.active) continue;
      for (const step of wf.steps) {
        if (allRoles.includes(step.roleName as string)) {
          or.push({ docType: docType as RequestDocType, currentLevel: step.level });
        }
      }
    }

    const where: Prisma.RequestDocumentWhereInput = or.length > 0
      ? { status: 'PENDING_APPROVAL', OR: or }
      : { status: 'PENDING_APPROVAL', id: { in: [] } };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.requestDocument.findMany({
        where,
        orderBy: { submittedAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { requester: { select: { username: true, fullName: true } }, department: { select: { name: true } } },
      }),
      this.prisma.requestDocument.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * Auto-archive: CANCELLED requests older than 30 days leave the default lists
   * (soft archive — archivedAt set; ?archived=only/all still reaches them).
   * Kept REJECTED out of scope on purpose: rejections may still be contested.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async archiveStaleCancelled() {
    const days = Number(process.env.ARCHIVE_AFTER_DAYS || 30);
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const res = await this.prisma.requestDocument.updateMany({
      where: { status: 'CANCELLED', archivedAt: null, updatedAt: { lt: cutoff } },
      data: { archivedAt: new Date() },
    });
    if (res.count > 0) {
      this.logger.log(`auto-archived ${res.count} cancelled request(s) older than ${days}d`);
      await this.audit.log({
        action: 'REQUESTS_AUTO_ARCHIVED', module: 'WORKFLOW',
        newValue: { count: res.count, olderThanDays: days },
      });
    }
  }

  /** Escalation: escalate pending L1 requests older than N days to MANAGEMENT (Plan §5). */
  @Cron(CronExpression.EVERY_HOUR)
  async escalateStaleRequests() {
    const hours = Number(process.env.ESCALATION_AFTER_HOURS || 72);
    const cutoff = new Date(Date.now() - hours * 3600 * 1000);

    const stale = await this.prisma.requestDocument.findMany({
      where: { status: 'PENDING_APPROVAL', currentLevel: 1, escalated: false, submittedAt: { lt: cutoff } },
      take: 50,
    });

    for (const request of stale) {
      // only escalate when the resolved workflow actually has a next level
      const wf = await this.workflowFor(request.docType as string);
      const next = (wf?.steps ?? []).find((s) => s.level > request.currentLevel);
      if (!next) continue; // single-level workflow — nothing to escalate to
      await this.prisma.requestDocument.update({
        where: { id: request.id },
        data: { escalated: true, currentLevel: next.level },
      });
      await this.prisma.approvalAction.create({
        data: {
          requestId: request.id, level: request.currentLevel, approverId: request.requesterId,
          action: 'RETURN', comment: `Auto-escalated to ${next.roleName} after ${hours}h pending`,
          previousStatus: 'PENDING_APPROVAL', newStatus: 'PENDING_APPROVAL',
        },
      });
      await this.notifyApprovers(request.id, next.level, 'ESCALATED', `Escalated: ${request.docNumber}`, `Pending > ${hours}h at level 1`);
      await this.notifications.notify({
        userId: request.requesterId, type: 'ESCALATED',
        title: `Request ${request.docNumber} escalated`,
        body: 'Your request is taking longer than usual and has been escalated.',
        link: `/requests/${request.id}`, requestId: request.id,
      });
    }
    if (stale.length > 0) console.log(`[workflow] escalated ${stale.length} stale request(s)`);
  }

  private async mustFind(id: string) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id },
      include: {
        requester: { select: { id: true, username: true, fullName: true } },
        department: { select: { id: true, name: true } },
      },
    });
    if (!request) throw new NotFoundException('Request not found');
    return request;
  }
}
