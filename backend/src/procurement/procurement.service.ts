import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.service';
import { Actor } from '../org/org.service';

export interface PrItemInput {
  description: string;
  quantity: number;
  unit?: string;
  estimatedUnitPrice?: number;
  accountId?: string;
  assetId?: string;
}

export interface CreatePrInput {
  title?: string;
  justification?: string;
  requiredDate?: string;
  priority?: string;
  budgetCode?: string;
  items: PrItemInput[];
}

/**
 * Procurement — Purchase Request (design §5–7, phase P1).
 *
 * The approval side lives on RequestDocument (docType = PURCHASE_REQUEST,
 * doc number PR-…, DRAFT → submit → multi-level approval via the shared
 * workflow engine). This service carries the procurement-specific fields:
 * required date, priority, justification, budget code and line items with
 * optional Account/Asset references (spec §17–18).
 */
@Injectable()
export class ProcurementService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
    private workflow: WorkflowService,
  ) {}

  // ---------- master lookups (form pickers) ----------

  listAccounts(activeOnly = true) {
    return this.prisma.account.findMany({
      where: activeOnly ? { active: true } : undefined,
      orderBy: { name: 'asc' },
      include: { category: true },
    });
  }

  listAssets() {
    return this.prisma.asset.findMany({
      orderBy: { assetCode: 'asc' },
      include: { category: true, location: true },
    });
  }

  // ---------- purchase requests ----------

  /** Lists PRs — every requester sees their own; procurement.read sees all. */
  async list(params: { page: number; pageSize: number; status?: string; canReadAll: boolean; actor: Actor }) {
    const where = {
      docType: 'PURCHASE_REQUEST' as never,
      ...(params.status ? { status: params.status as never } : {}),
      ...(!params.canReadAll ? { requesterId: params.actor.userId } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.requestDocument.count({ where }),
      this.prisma.requestDocument.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          requester: { select: { id: true, fullName: true } },
          department: { select: { id: true, name: true } },
          purchaseRequest: { include: { items: true } },
        },
      }),
    ]);
    return { items: rows, total, page: params.page, pageSize: params.pageSize };
  }

  /** One PR with its items — owner or procurement.read. */
  async byRequest(requestId: string, actor: Actor & { canReadAll?: boolean }) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: {
        requester: { select: { id: true, fullName: true } },
        department: { select: { id: true, name: true } },
      },
    });
    if (!request || request.docType !== 'PURCHASE_REQUEST') throw new NotFoundException('Purchase request not found');
    if (request.requesterId !== actor.userId && !actor.canReadAll) {
      throw new ForbiddenException('Not your request');
    }
    const pr = await this.prisma.purchaseRequest.findUnique({
      where: { requestId },
      include: {
        items: {
          orderBy: { id: 'asc' },
          include: {
            account: { include: { category: true } },
            asset: true,
          },
        },
      },
    });
    return { ...request, purchaseRequest: pr };
  }

  /**
   * Creates a PR as a workflow document (DRAFT). The requester submits it via
   * the standard POST /requests/:id/submit afterwards — same flow as car and
   * meeting-room requests.
   */
  async create(data: CreatePrInput, actor: Actor) {
    const items = this.normalizeItems(data.items);
    const total = items.reduce((sum, it) => sum + (it.estimatedUnitPrice ?? 0) * it.quantity, 0);
    const title = (data.title?.trim() || items[0].description).slice(0, 200);
    const priority = data.priority === 'URGENT' ? 'URGENT' : 'NORMAL';
    const requiredDate = data.requiredDate ? new Date(data.requiredDate) : undefined;
    if (requiredDate && Number.isNaN(requiredDate.getTime())) throw new BadRequestException('Invalid requiredDate');

    const request = await this.prisma.requestDocument.create({
      data: {
        docNumber: await this.numbering.next('PR'),
        docType: 'PURCHASE_REQUEST',
        title: `Purchase: ${title}`,
        description: this.describe(items, data.justification),
        requesterId: actor.userId,
        departmentId: (await this.prisma.employee.findFirst({ where: { userId: actor.userId } }))?.departmentId,
      },
    });

    const pr = await this.prisma.purchaseRequest.create({
      data: {
        requestId: request.id,
        requiredDate,
        priority: priority as never,
        justification: data.justification?.trim() || undefined,
        budgetCode: data.budgetCode?.trim() || undefined,
        items: {
          create: items.map((it) => ({
            description: it.description,
            quantity: it.quantity,
            unit: it.unit,
            estimatedUnitPrice: it.estimatedUnitPrice,
            accountId: it.accountId,
            assetId: it.assetId,
          })),
        },
      },
      include: { items: true },
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'PURCHASE_REQUEST_CREATED', module: 'PROCUREMENT', recordId: request.id,
      newValue: { docNumber: request.docNumber, items: items.length, estimatedTotal: total, priority },
    });

    return { ...request, purchaseRequest: pr };
  }

  /** Edit a PR draft — owner only, only while DRAFT, replaces the items wholesale. */
  async update(requestId: string, data: CreatePrInput, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({ where: { id: requestId } });
    if (!request || request.docType !== 'PURCHASE_REQUEST') throw new NotFoundException('Purchase request not found');
    if (request.requesterId !== actor.userId) throw new ForbiddenException('Not your request');
    if (request.status !== 'DRAFT') throw new BadRequestException('Only DRAFT purchase requests can be edited');

    const items = this.normalizeItems(data.items);
    const pr = await this.prisma.purchaseRequest.findUnique({ where: { requestId } });
    if (!pr) throw new NotFoundException('Purchase request not found');

    const priority = data.priority === 'URGENT' ? 'URGENT' : 'NORMAL';
    const requiredDate = data.requiredDate ? new Date(data.requiredDate) : null;
    if (data.requiredDate && Number.isNaN(requiredDate!.getTime())) throw new BadRequestException('Invalid requiredDate');

    await this.prisma.$transaction([
      this.prisma.purchaseRequestItem.deleteMany({ where: { purchaseRequestId: pr.id } }),
      this.prisma.purchaseRequest.update({
        where: { id: pr.id },
        data: {
          requiredDate,
          priority: priority as never,
          justification: data.justification?.trim() || null,
          budgetCode: data.budgetCode?.trim() || null,
          items: {
            create: items.map((it) => ({
              description: it.description,
              quantity: it.quantity,
              unit: it.unit,
              estimatedUnitPrice: it.estimatedUnitPrice,
              accountId: it.accountId,
              assetId: it.assetId,
            })),
          },
        },
      }),
      this.prisma.requestDocument.update({
        where: { id: requestId },
        data: {
          title: `Purchase: ${(data.title?.trim() || items[0].description).slice(0, 200)}`,
          description: this.describe(items, data.justification),
        },
      }),
    ]);

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'PURCHASE_REQUEST_UPDATED', module: 'PROCUREMENT', recordId: requestId,
      oldValue: { items: (await this.prisma.purchaseRequestItem.count({ where: { purchaseRequestId: pr.id } })) },
      newValue: { items: items.length },
    });

    return this.byRequest(requestId, { ...actor, canReadAll: true });
  }

  /**
   * Bridge: submit a Supplier PO draft → a real PR (phase P1 replaces the old
   * "lines as text description" conversion). Creates the workflow document and
   * the PR entity with one item per draft line, then returns both ids.
   */
  async createFromSupplierDraft(draft: {
    supplier: { name: string };
    lines: { item: { code: string; name: string; unit: string | null }; quantity: number; unitPrice: unknown }[];
    note?: string;
  }, actor: Actor) {
    const items: PrItemInput[] = draft.lines.map((l) => ({
      description: `${l.item.name} (${l.item.code})`,
      quantity: l.quantity,
      unit: l.item.unit ?? undefined,
      estimatedUnitPrice: l.unitPrice === null || l.unitPrice === undefined ? undefined : Number(l.unitPrice),
    }));
    return this.create(
      {
        title: `${draft.supplier.name}${draft.note ? ` — ${draft.note}` : ''}`.slice(0, 200),
        justification: draft.note ? `Vendor PO draft — ${draft.supplier.name}. ${draft.note}` : `Vendor PO draft — ${draft.supplier.name}.`,
        items,
      },
      actor,
    );
  }

  // ---------- master CRUD (procurement.manage) ----------

  /** Creates an account, auto-creating its category when a new name is given. */
  async createAccount(data: { name: string; code?: string; categoryName?: string }, actor: Actor) {
    const name = data.name?.trim();
    if (!name) throw new BadRequestException('Account name is required');
    const dup = await this.prisma.account.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (dup) throw new BadRequestException(`Account "${dup.name}" already exists`);

    let categoryId: string | undefined;
    if (data.categoryName?.trim()) {
      const categoryName = data.categoryName.trim();
      const category = await this.prisma.accountCategory.upsert({
        where: { name: categoryName },
        update: {},
        create: { name: categoryName },
      });
      categoryId = category.id;
    }
    const account = await this.prisma.account.create({
      data: { name, code: data.code?.trim() || undefined, categoryId },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ACCOUNT_CREATED', module: 'PROCUREMENT', recordId: account.id,
      newValue: { name: account.name, code: account.code },
    });
    return account;
  }

  /** Toggle/rename an account (deactivate hides it from the PR form picker). */
  async updateAccount(id: string, data: { name?: string; active?: boolean }, actor: Actor) {
    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('Account not found');
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new BadRequestException('Account name is required');
      const dup = await this.prisma.account.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, id: { not: id } } });
      if (dup) throw new BadRequestException(`Account "${dup.name}" already exists`);
    }
    const updated = await this.prisma.account.update({
      where: { id },
      data: { name: data.name?.trim(), active: data.active },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ACCOUNT_UPDATED', module: 'PROCUREMENT', recordId: id,
      oldValue: { name: account.name, active: account.active },
      newValue: data,
    });
    return updated;
  }

  // ---------- helpers ----------

  /** Validates + normalizes PR line items (shared by create/update/bridge). */
  private normalizeItems(items: PrItemInput[] | undefined) {
    if (!items || items.length === 0) throw new BadRequestException('At least one item is required');
    return items.map((it, idx) => {
      const description = (it.description ?? '').trim();
      if (!description) throw new BadRequestException(`Item ${idx + 1}: description is required`);
      const quantity = Math.floor(Number(it.quantity));
      if (!Number.isFinite(quantity) || quantity < 1) throw new BadRequestException(`Item ${idx + 1}: quantity must be at least 1`);
      const price = it.estimatedUnitPrice === undefined || it.estimatedUnitPrice === null ? undefined : Number(it.estimatedUnitPrice);
      if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
        throw new BadRequestException(`Item ${idx + 1}: invalid estimated unit price`);
      }
      return {
        description,
        quantity,
        unit: it.unit?.trim() || undefined,
        estimatedUnitPrice: price,
        accountId: it.accountId || undefined,
        assetId: it.assetId || undefined,
      };
    });
  }

  /** PR summary for the workflow document description (readable in approvals). */
  private describe(items: { description: string; quantity: number; unit?: string; estimatedUnitPrice?: number }[], justification?: string): string {
    const lines = items.map(
      (it) =>
        `• ${it.description} ×${it.quantity}${it.unit ? ` ${it.unit}` : ''}${it.estimatedUnitPrice !== undefined ? ` @ ${it.estimatedUnitPrice}` : ''}`,
    );
    const total = items.reduce((sum, it) => sum + (it.estimatedUnitPrice ?? 0) * it.quantity, 0);
    const parts = [...lines, `Estimated total: ${total.toLocaleString()}`];
    if (justification?.trim()) parts.unshift(`Purpose: ${justification.trim()}`);
    return parts.join('\n');
  }
}
