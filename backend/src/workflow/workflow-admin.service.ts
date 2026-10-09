import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';

/**
 * Admin CRUD for approval workflows and their amount bands (design §8).
 * The engine (WorkflowService.workflowFor) reads these rows at submit time,
 * so editing here changes routing without a deploy. GUARDED rules:
 *  • a band workflow must have at least one bound (min or max) — the fully
 *    unbounded default is created separately;
 *  • every module keeps at least one ACTIVE workflow (deactivating the last
 *    active one would strand submits at the GENERIC_REQUEST fallback);
 *  • at most one ACTIVE fully-unbounded workflow per module (the default);
 *  • bands of one active module must not overlap each other, so routing stays
 *    deterministic (first-match would otherwise depend on DB order).
 * Steps are read-only here for now — editors use the matrix roles; rename /
 * re-leveling happens through a create-new + deactivate cycle to keep running
 * APPROVALS stable (ApprovalAction rows reference step ids… via level/role,
 * but in-flight documents must finish on the workflow they started with).
 */
@Injectable()
export class WorkflowAdminService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  list() {
    return this.prisma.approvalWorkflow.findMany({
      orderBy: [{ module: 'asc' }, { minAmount: 'asc' }],
      include: { steps: { orderBy: { level: 'asc' } } },
    });
  }

  async availableModules() {
    // docTypes the workflow engine actually resolves + which ones route by amount
    const rows = await this.prisma.requestDocument.groupBy({ by: ['docType'] });
    const seeded = ['GENERIC_REQUEST', 'PURCHASE_REQUEST', 'OFFICE_SUPPLY_REQUEST', 'TRAVEL_REQUEST', 'MAINTENANCE_REQUEST', 'MEETING_ROOM_REQUEST'];
    return [...new Set([...rows.map((r) => r.docType as string), ...seeded])].sort();
  }

  private validateBand(data: { minAmount?: number | null; maxAmount?: number | null; requireBound?: boolean }) {
    const min = data.minAmount ?? null;
    const max = data.maxAmount ?? null;
    if (min !== null && max !== null && min >= max) {
      throw new BadRequestException('minAmount must be less than maxAmount');
    }
    if (data.requireBound && min === null && max === null) {
      throw new BadRequestException('A band workflow needs at least one bound — leave both empty for the module default');
    }
    return { min, max };
  }

  private async assertNoBandOverlap(module: string, min: number | null, max: number | null, excludeId?: string) {
    if (min === null && max === null) return; // the default workflow — not a band
    const others = await this.prisma.approvalWorkflow.findMany({
      where: { module, active: true, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, name: true, minAmount: true, maxAmount: true },
    });
    for (const o of others) {
      const oMin = o.minAmount === null ? null : Number(o.minAmount);
      const oMax = o.maxAmount === null ? null : Number(o.maxAmount);
      if (oMin === null && oMax === null) continue; // unbounded default coexists fine (used when amount is null)
      // interval overlap test with nulls as ±infinity: min ≤ oMax && oMin ≤ max
      // (two bands must be disjoint, otherwise routing depends on DB order)
      const overlaps = (min === null || oMax === null || min <= oMax) && (max === null || oMin === null || max >= oMin);
      if (overlaps) {
        throw new ConflictException(`Amount band overlaps active workflow "${o.name}" of ${module} — bands must be disjoint so routing stays deterministic`);
      }
    }
  }

  async create(data: {
    module: string; name: string; minAmount?: number | null; maxAmount?: number | null;
    steps: { level: number; roleName: string; minApprovals?: number }[];
  }, actor: Actor) {
    if (!data.module || !data.name?.trim()) throw new BadRequestException('module and name are required');
    const { min, max } = this.validateBand(data);
    if (min === null && max === null) {
      // activating a new unbounded default requires no other active default in the module
      const otherDefaults = await this.prisma.approvalWorkflow.count({
        where: { module: data.module, active: true, minAmount: null, maxAmount: null },
      });
      if (otherDefaults > 0) throw new ConflictException(`${data.module} already has an active default workflow — deactivate it first`);
    }
    await this.assertNoBandOverlap(data.module, min, max);

    const steps = (data.steps ?? []).map((s, i) => ({
      level: s.level ?? i + 1,
      roleName: s.roleName as never,
      minApprovals: Math.max(1, s.minApprovals ?? 1),
    }));
    if (steps.length === 0) throw new BadRequestException('At least one approval step is required');

    const wf = await this.prisma.approvalWorkflow.create({
      data: {
        module: data.module,
        name: data.name.trim(),
        active: true,
        minAmount: min,
        maxAmount: max,
        steps: { create: steps },
      },
      include: { steps: { orderBy: { level: 'asc' } } },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'WORKFLOW_CREATED', module: 'WORKFLOW', recordId: wf.id,
      newValue: { module: wf.module, name: wf.name, minAmount: min, maxAmount: max, steps: steps.length },
    });
    return wf;
  }

  /**
   * Update name/bounds/activity. Steps are replaced wholesale (delete + recreate)
   * ONLY when the workflow has no in-flight approvals — in-flight documents must
   * keep the step rows they were submitted on.
   */
  async update(id: string, data: {
    name?: string; active?: boolean; minAmount?: number | null; maxAmount?: number | null;
    steps?: { level: number; roleName: string; minApprovals?: number }[];
  }, actor: Actor) {
    const wf = await this.prisma.approvalWorkflow.findUnique({ where: { id }, include: { steps: true } });
    if (!wf) throw new NotFoundException('Workflow not found');

    // figure out the resulting bounds (partial patch over existing)
    let min = data.minAmount !== undefined ? (data.minAmount ?? null) : (wf.minAmount === null ? null : Number(wf.minAmount));
    let max = data.maxAmount !== undefined ? (data.maxAmount ?? null) : (wf.maxAmount === null ? null : Number(wf.maxAmount));
    const { min: vmin, max: vmax } = this.validateBand({ minAmount: min, maxAmount: max });
    min = vmin; max = vmax;

    const willBeActive = data.active ?? wf.active;
    const isBand = min !== null || max !== null;
    if (willBeActive && isBand) await this.assertNoBandOverlap(wf.module, min, max, id);
    if (willBeActive && !isBand) {
      // activating the unbounded default requires no other active default in the module
      const otherDefaults = await this.prisma.approvalWorkflow.count({
        where: { module: wf.module, active: true, minAmount: null, maxAmount: null, id: { not: id } },
      });
      if (otherDefaults > 0) throw new ConflictException(`${wf.module} already has an active default workflow — deactivate it first`);
    }
    // never allow deactivating the LAST active workflow of a module
    if (willBeActive === false && wf.active) {
      const others = await this.prisma.approvalWorkflow.count({ where: { module: wf.module, active: true, id: { not: id } } });
      if (others === 0) throw new ConflictException('Cannot deactivate the last active workflow of a module — submissions would fall back to GENERIC_REQUEST');
    }

    // Steps are immutable once the workflow's module has ANY approval action: the
    // audit trail records (requestId, level, role-based step resolution) — changing
    // levels would corrupt it. Trivial updates (name/bounds/activity) stay allowed.
    if (data.steps) {
      const anyAction = await this.prisma.approvalAction.findFirst({
        where: { request: { docType: wf.module as never } },
        select: { id: true },
      });
      const stepsChanged =
        data.steps.length !== wf.steps.length ||
        wf.steps.some((s, i) => data.steps![i] && (data.steps![i].roleName !== s.roleName || (data.steps![i].minApprovals ?? 1) !== s.minApprovals));
      if (anyAction && stepsChanged) {
        throw new ConflictException('This workflow already has approval history — steps are immutable; create a NEW workflow and deactivate this one');
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (data.steps) {
        if (data.steps.length === 0) throw new BadRequestException('At least one approval step is required');
        await tx.approvalStep.deleteMany({ where: { workflowId: id } });
        for (const [i, s] of data.steps.entries()) {
          await tx.approvalStep.create({
            data: { workflowId: id, level: s.level ?? i + 1, roleName: s.roleName as never, minApprovals: Math.max(1, s.minApprovals ?? 1) },
          });
        }
      }
      return tx.approvalWorkflow.update({
        where: { id },
        data: {
          name: data.name?.trim() || undefined,
          active: data.active,
          minAmount: data.minAmount !== undefined ? min : undefined,
          maxAmount: data.maxAmount !== undefined ? max : undefined,
        },
        include: { steps: { orderBy: { level: 'asc' } } },
      });
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'WORKFLOW_UPDATED', module: 'WORKFLOW', recordId: id,
      oldValue: { name: wf.name, active: wf.active, minAmount: wf.minAmount, maxAmount: wf.maxAmount, steps: wf.steps.length },
      newValue: { name: updated.name, active: updated.active, minAmount: updated.minAmount, maxAmount: updated.maxAmount, steps: updated.steps.length },
    });
    return updated;
  }
}
