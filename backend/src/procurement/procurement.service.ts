import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { AuditService } from '../audit/audit.service';
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
 * Procurement — Purchase Request (design §5–7, phase P1) + RFQ/Quotation
 * (design §11–14, phase P3/P4).
 *
 * The approval side lives on RequestDocument (docType = PURCHASE_REQUEST |
 * RFQ, doc number PR-/RFQ-…, multi-level approval via the shared workflow
 * engine). This service carries the procurement-specific fields.
 */
@Injectable()
export class ProcurementService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
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

  // ---------- chart of accounts (Settings → Accounts; CRUD master data) ----------
  listAccountCategories() {
    return this.prisma.accountCategory.findMany({ orderBy: { name: 'asc' } });
  }

  async createAccount(
    data: { code?: string; name: string; categoryId?: string; active?: boolean },
    actor: Actor,
  ) {
    const code = data.code?.trim() || null;
    if (code) {
      const taken = await this.prisma.account.findUnique({ where: { code } });
      if (taken) throw new ConflictException(`Account code "${code}" already exists`);
    }
    if (data.categoryId) {
      const cat = await this.prisma.accountCategory.findUnique({ where: { id: data.categoryId } });
      if (!cat) throw new BadRequestException('Unknown account category');
    }
    const account = await this.prisma.account.create({
      data: {
        code,
        name: data.name.trim(),
        categoryId: data.categoryId || null,
        active: data.active ?? true,
      },
      include: { category: true },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ACCOUNT_CREATED', module: 'PROCUREMENT', recordId: account.id,
      newValue: { code, name: account.name, category: account.category?.name, active: account.active },
    });
    return account;
  }

  async updateAccount(
    id: string,
    data: { code?: string; name?: string; categoryId?: string; active?: boolean },
    actor: Actor,
  ) {
    const prev = await this.prisma.account.findUnique({ where: { id }, include: { category: true } });
    if (!prev) throw new NotFoundException('Account not found');
    // code: undefined = keep, '' = clear, other = set (unique check against the rest of the chart)
    const code = data.code === undefined ? prev.code : (data.code.trim() || null);
    if (code && code !== prev.code) {
      const taken = await this.prisma.account.findUnique({ where: { code } });
      if (taken) throw new ConflictException(`Account code "${code}" already exists`);
    }
    if (data.categoryId) {
      const cat = await this.prisma.accountCategory.findUnique({ where: { id: data.categoryId } });
      if (!cat) throw new BadRequestException('Unknown account category');
    }
    const account = await this.prisma.account.update({
      where: { id },
      data: {
        ...(data.code !== undefined ? { code } : {}),
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.categoryId !== undefined ? { categoryId: data.categoryId || null } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
      include: { category: true },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ACCOUNT_UPDATED', module: 'PROCUREMENT', recordId: id,
      oldValue: { code: prev.code, name: prev.name, category: prev.category?.name, active: prev.active },
      newValue: { code: account.code, name: account.name, category: account.category?.name, active: account.active },
    });
    return account;
  }

  /**
   * Hard delete only when the account has NO history (PR/PO/invoice lines,
   * monthly budgets) — same audit-integrity rule as user deletion. Accounts
   * WITH history must be deactivated (active=false) instead, so old documents
   * keep pointing at a real row and the account leaves every form picker.
   */
  async deleteAccount(id: string, actor: Actor) {
    const account = await this.prisma.account.findUnique({
      where: { id },
      include: { _count: { select: { prItems: true, poItems: true, invoiceItems: true, monthlyBudgets: true } } },
    });
    if (!account) throw new NotFoundException('Account not found');
    const c = account._count;
    const usedIn: string[] = [];
    if (c.prItems) usedIn.push(`${c.prItems} purchase-request line${c.prItems === 1 ? '' : 's'}`);
    if (c.poItems) usedIn.push(`${c.poItems} PO line${c.poItems === 1 ? '' : 's'}`);
    if (c.invoiceItems) usedIn.push(`${c.invoiceItems} invoice line${c.invoiceItems === 1 ? '' : 's'}`);
    if (c.monthlyBudgets) usedIn.push(`${c.monthlyBudgets} monthly budget${c.monthlyBudgets === 1 ? '' : 's'}`);
    if (usedIn.length) {
      throw new ConflictException(
        `Account "${account.code ? `${account.code} — ` : ''}${account.name}" is used by ${usedIn.join(', ')} — deactivate it instead of deleting (audit integrity)`,
      );
    }
    await this.prisma.account.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ACCOUNT_DELETED', module: 'PROCUREMENT', recordId: id,
      oldValue: { code: account.code, name: account.name, active: account.active },
    });
    return { id, deleted: true };
  }

  // ---------- purchase requests ----------
  /** Lists PRs — every requester sees their own; procurement.read sees all. */
  async list(params: { page: number; pageSize: number; status?: string; canReadAll: boolean; actor: Actor }) {
    const where = {
      docType: 'PURCHASE_REQUEST' as const,
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

  /** Creates a PR as a workflow document (DRAFT). The requester submits it via the standard POST /requests/:id/submit afterwards — same flow as car and meeting-room requests. */
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
      oldValue: { items: await this.prisma.purchaseRequestItem.count({ where: { purchaseRequestId: pr.id } }) },
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

  // ---------- RFQ (design §11): Request for Quotation ----------
  /**
   * RFQ is a workflow document too (docType = 'RFQ'), so its approval runs on
   * the existing engine. The RFQ row carries the procurement fields; RFQ
   * vendors (which suppliers were asked) and per-vendor quotations attach for
   * traceability (design §11-12).
   */

  /** Lists RFQs — every vendor attempt the workflow exposed (purchasing view). */
  async listRfqs(params: { page: number; pageSize: number }) {
    const where = { docType: 'RFQ' as const };
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
          rfq: {
            include: {
              rfqVendors: { include: { supplier: { select: { id: true, name: true } } } },
              quotations: { select: { id: true, supplier: { select: { name: true } } } },
              comparison: { include: { recommendedSupplier: { select: { id: true, name: true } } } },
            },
          },
        },
      }),
    ]);
    return { items: rows, total, page: params.page, pageSize: params.pageSize };
  }

  async byRfq(rfqId: string, actor: Actor & { canReadAll?: boolean }) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: rfqId },
      include: {
        requester: { select: { id: true, fullName: true } },
        department: { select: { id: true, name: true } },
        rfq: {
          include: {
            rfqVendors: { include: { supplier: true }, orderBy: { priority: 'asc' } },
            quotations: { include: { supplier: true, items: { orderBy: { id: 'asc' } } }, orderBy: { quoteDate: 'desc' } },
            comparison: { include: { recommendedSupplier: true, recommendedQuote: { include: { items: true } } } },
          },
        },
      },
    });
    if (!request || request.docType !== 'RFQ') throw new NotFoundException('RFQ not found');
    if (request.requesterId !== actor.userId && !actor.canReadAll) {
      throw new ForbiddenException('Not your RFQ');
    }
    return { ...request, rfq: request.rfq };
  }

  async createRfq(data: {
    title: string;
    specification?: string;
    notes?: string;
    dueDate?: string; // quotation due date (design §11)
    vendors?: { supplierId: string }[];
  }, actor: Actor) {
    if (!data.title?.trim()) throw new BadRequestException('RFQ title is required');
    const supplierIds = [...new Set((data.vendors ?? []).map((v) => v.supplierId))];
    if (supplierIds.length) {
      const count = await this.prisma.supplier.count({ where: { id: { in: supplierIds }, isActive: true } });
      if (count !== supplierIds.length) throw new BadRequestException('All vendors must exist and be active suppliers');
    }
    const dueDate = data.dueDate ? new Date(data.dueDate) : undefined;
    if (dueDate && Number.isNaN(dueDate.getTime())) throw new BadRequestException('Invalid dueDate');

    const request = await this.prisma.requestDocument.create({
      data: {
        docNumber: await this.numbering.next('RFQ'),
        docType: 'RFQ',
        title: data.title.trim().slice(0, 200),
        description: data.specification?.trim() || data.notes?.trim() || undefined,
        requesterId: actor.userId,
        departmentId: (await this.prisma.employee.findFirst({ where: { userId: actor.userId } }))?.departmentId,
      },
    });

    const rfq = await this.prisma.rfq.create({
      data: {
        requestId: request.id,
        dueDate,
        specification: data.specification?.trim() || undefined,
        notes: data.notes?.trim() || undefined,
        createdById: actor.userId,
      },
    });

    const createdVendors = await Promise.all(
      supplierIds.map((supplierId) => this.inviteVendor(rfq.id, supplierId, actor.userId)),
    );{}

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'RFQ_CREATED', module: 'PROCUREMENT', recordId: request.id,
      newValue: { docNumber: request.docNumber, vendors: createdVendors.length },
    });

    return { ...request, rfq: { ...rfq, rfqVendors: createdVendors } };
  }

  /** Edit an RFQ draft — only while the workflow document is still DRAFT. */
  async updateRfq(rfqId: string, data: {
    title?: string;
    specification?: string;
    notes?: string;
    dueDate?: string;
    vendors?: { supplierId: string }[];
  }, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({ where: { id: rfqId }, include: { rfq: true } });
    if (!request || request.docType !== 'RFQ' || !request.rfq) throw new NotFoundException('RFQ not found');
    if (request.requesterId !== actor.userId) throw new ForbiddenException('Only the requester can edit the RFQ');
    if (request.status !== 'DRAFT') throw new BadRequestException('Only DRAFT RFQs can be edited');

    const dueDate = data.dueDate ? new Date(data.dueDate) : undefined;
    if (dueDate && Number.isNaN(dueDate.getTime())) throw new BadRequestException('Invalid dueDate');

    if (data.vendors) {
      const supplierIds = [...new Set(data.vendors.map((v) => v.supplierId))];
      if (supplierIds.length) {
        const count = await this.prisma.supplier.count({ where: { id: { in: supplierIds }, isActive: true } });
        if (count !== supplierIds.length) throw new BadRequestException('All vendors must exist and be active suppliers');
      }
      const existing = await this.prisma.rfqVendor.findMany({ where: { rfqId: request.rfq.id }, select: { supplierId: true } });
      const existingIds = new Set(existing.map((e) => e.supplierId));
      await Promise.all(
        supplierIds.filter((s) => !existingIds.has(s)).map((supplierId) => this.inviteVendor(request.rfq!.id, supplierId, actor.userId)),
      );
    }

    await this.prisma.$transaction([
      this.prisma.rfq.update({
        where: { id: request.rfq!.id },
        data: {
          dueDate,
          specification: data.specification?.trim() || undefined,
          notes: data.notes?.trim() || undefined,
        },
      }),
      this.prisma.requestDocument.update({
        where: { id: rfqId },
        data: {
          title: data.title?.trim() ? data.title.trim().slice(0, 200) : undefined,
          description: data.specification?.trim() || data.notes?.trim() || undefined,
        },
      }),
    ]);

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'RFQ_UPDATED', module: 'PROCUREMENT', recordId: rfqId,
      newValue: { vendors: data.vendors?.length, dueDate: data.dueDate },
    });
    return this.byRfq(rfqId, { ...actor, canReadAll: true });
  }

  /** Which suppliers received this RFQ. */
  async listRfqVendors(rfqId: string) {
    const rfq = await this.getRfq(rfqId);
    return this.prisma.rfqVendor.findMany({
      where: { rfqId: rfq.id },
      orderBy: { priority: 'asc' },
      include: { supplier: true },
    });
  }

  /** Supplier invite (design §11) — one vendor per RFQ, priority ordering. */
  async addRfqVendor(rfqId: string, data: { supplierId: string; priority?: number; contactReason?: string }, actor: Actor) {
    const rfq = await this.getRfq(rfqId);
    const supplier = await this.prisma.supplier.findUnique({ where: { id: data.supplierId } });
    if (!supplier || !supplier.isActive) throw new BadRequestException('A valid, active supplier is required');

    let vendor;
    try {
      vendor = await this.prisma.rfqVendor.create({
        data: {
          rfqId: rfq.id,
          supplierId: data.supplierId,
          priority: data.priority ?? 0,
          contactReason: data.contactReason?.trim() || 'RFQ invite',
          createdById: actor.userId,
        },
        include: { supplier: true },
      });
    } catch {
      throw new ConflictException(`${supplier.name} is already invited on this RFQ`);
    }

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'RFQ_VENDOR_ADDED', module: 'PROCUREMENT', recordId: rfqId,
      newValue: { supplier: supplier.name },
    });
    return vendor;
  }

  /** RFQ closure (design §11): only APPROVED RFQs may close — the workflow doc goes CLOSED. */
  async updateRfqStatus(rfqId: string, status: string, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({ where: { id: rfqId }, include: { rfq: true } });
    if (!request || request.docType !== 'RFQ') throw new NotFoundException('RFQ not found');
    if (status !== 'CLOSED') throw new BadRequestException('RFQ documents support only the CLOSED status — open/close the workflow via its own endpoints');
    if (request.status !== 'APPROVED') throw new BadRequestException('RFQ must be APPROVED (workflow) before closing');

    const updated = await this.prisma.requestDocument.update({
      where: { id: rfqId },
      data: { status: 'CLOSED' },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'RFQ_CLOSED', module: 'PROCUREMENT', recordId: rfqId,
      oldValue: { status: request.status }, newValue: { status: 'CLOSED' },
    });
    return updated;
  }

  async closeRfq(rfqId: string, actor: Actor) {
    return this.updateRfqStatus(rfqId, 'CLOSED', actor);
  }

  // ---------- quotations (design §12) ----------
  /** Per-vendor answers on an RFQ. */
  async listQuotations(rfqId: string) {
    const rfq = await this.getRfq(rfqId);
    return this.prisma.quotation.findMany({
      where: { rfqId: rfq.id },
      include: {
        supplier: true,
        items: { orderBy: { id: 'asc' } },
      },
      orderBy: { quoteDate: 'desc' },
    });
  }

  async addQuotation(rfqId: string, data: {
    supplierId: string;
    quoteNumber: string;
    quoteDate?: string;
    dueDate?: string;
    validUntil?: string;
    paymentTerms?: string;
    taxIncluded?: boolean;
    note?: string;
    items: { description: string; quantity: number; unit?: string; unitPrice: number; taxPercent?: number; deliveryDays?: number; warrantyMonths?: number; discountPercent?: number }[];
  }, actor: Actor) {
    const rfq = await this.getRfq(rfqId);
    const supplier = await this.prisma.supplier.findUnique({ where: { id: data.supplierId } });
    if (!supplier || !supplier.isActive) throw new BadRequestException('A valid, active supplier is required');
    if (!data.quoteNumber?.trim()) throw new BadRequestException('Vendor quotation number is required');
    if (await this.prisma.quotation.findFirst({ where: { rfqId: rfq.id, supplierId: data.supplierId, quoteNumber: data.quoteNumber.trim() } })) {
      throw new ConflictException(`Quotation ${data.quoteNumber} already recorded for ${supplier.name} on this RFQ`);
    }
    if (await this.prisma.quotation.findFirst({ where: { rfqId: rfq.id, supplierId: data.supplierId } })) {
      throw new ConflictException(`${supplier.name} already answered this RFQ — one quotation per vendor (design §12)`);
    }
    const invited = await this.prisma.rfqVendor.findFirst({ where: { rfqId: rfq.id, supplierId: data.supplierId } });
    if (!invited) throw new BadRequestException(`${supplier.name} is not invited on this RFQ — add the vendor first`);

    const quotation = await this.prisma.quotation.create({
      data: {
        rfqId: rfq.id,
        supplierId: data.supplierId,
        quoteNumber: data.quoteNumber.trim(),
        quoteDate: data.quoteDate ? new Date(data.quoteDate) : new Date(),
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
        paymentTerms: data.paymentTerms?.trim() || undefined,
        taxIncluded: data.taxIncluded ?? true,
        note: data.note?.trim() || undefined,
        createdById: actor.userId,
        items: {
          create: data.items.map((it, idx) => ({
            ...this.normalizeQuotationItem(it, idx),
            createdById: actor.userId,
          })),
        },
      },
      include: { items: true, supplier: true },
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'QUOTATION_CREATED', module: 'PROCUREMENT', recordId: quotation.id,
      newValue: { rfqNumber: (await this.prisma.requestDocument.findUnique({ where: { id: rfqId } }))?.docNumber, supplier: supplier.name, quoteNumber: quotation.quoteNumber, items: quotation.items.length },
    });
    return quotation;
  }

  /** Live comparison read model (design §13): per-quote line totals sorted top-down. */
  async compareQuotations(rfqId: string) {
    const rfq = await this.getRfq(rfqId);
    const quotes = await this.prisma.quotation.findMany({
      where: { rfqId: rfq.id },
      include: { supplier: { select: { id: true, name: true } }, items: true },
    });
    const rows = quotes.map((q) => {
      const lines = q.items.map((it) => {
        const discount = Number(it.discountPercent ?? 0);
        const net = Number(it.unitPrice) * it.quantity * (1 - discount / 100);
        const tax = net * (Number(it.taxPercent ?? 0) / 100);
        return {
          description: it.description, quantity: it.quantity, unitPrice: Number(it.unitPrice),
          discountPercent: discount, taxPercent: Number(it.taxPercent ?? 0), lineTotal: net + tax,
          deliveryDays: it.deliveryDays, warrantyMonths: it.warrantyMonths,
        };
      });
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      return {
        quotationId: q.id, quoteNumber: q.quoteNumber, supplierId: q.supplier.id, supplier: q.supplier.name,
        taxIncluded: q.taxIncluded, paymentTerms: q.paymentTerms, validUntil: q.validUntil,
        lines, subtotal, lineCount: lines.length,
      };
    });
    return rows.sort((a, b) => a.subtotal - b.subtotal);
  }

  // ---------- comparison / vendor selection (design §13-14) ----------
  async findComparison(rfqId: string) {
    const rfq = await this.getRfq(rfqId);
    return this.prisma.quotationComparison.findUnique({
      where: { rfqId: rfq.id },
      include: {
        recommendedSupplier: true,
        recommendedQuote: { include: { items: true, supplier: true } },
        createdBy: { select: { id: true, fullName: true } },
      },
    });
  }

  async createComparison(rfqId: string, data: {
    recommendedSupplierId: string;
    recommendedQuoteId: string;
    selectionReason: string;
    supportingDocument?: string;
  }, actor: Actor) {
    const rfq = await this.getRfq(rfqId);
    const quote = await this.prisma.quotation.findUnique({
      where: { id: data.recommendedQuoteId },
      include: { supplier: { select: { name: true } } },
    });
    if (!quote || quote.rfqId !== rfq.id) throw new NotFoundException('The recommended quotation is not on this RFQ');
    if (quote.supplierId !== data.recommendedSupplierId) {
      throw new BadRequestException('The quoted supplier must own the recommended quotation');
    }
    if (!data.selectionReason?.trim()) throw new BadRequestException('The selection reason is required (design §14 justification)');
    if (await this.prisma.quotationComparison.findUnique({ where: { rfqId: rfq.id } })) {
      throw new ConflictException('One comparison decision per RFQ (§14)');
    }

    const comparison = await this.prisma.quotationComparison.create({
      data: {
        rfqId: rfq.id,
        recommendedSupplierId: data.recommendedSupplierId,
        recommendedQuoteId: data.recommendedQuoteId,
        selectionReason: data.selectionReason.trim(),
        supportingDocument: data.supportingDocument?.trim() || undefined,
        status: 'SELECTED',
        createdById: actor.userId,
      },
      include: { recommendedSupplier: true, recommendedQuote: { include: { items: true } } },
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'COMPARISON_CREATED', module: 'PROCUREMENT', recordId: comparison.id,
      newValue: { rfqId, recommendedSupplier: comparison.recommendedSupplier.name, selectionReason: comparison.selectionReason },
    });
    return comparison;
  }

  // ---------- helpers ----------
  private async getRfq(rfqId: string) {
    const rfq = await this.prisma.rfq.findUnique({ where: { requestId: rfqId } });
    if (!rfq) {
      const request = await this.prisma.requestDocument.findUnique({ where: { id: rfqId }, include: { rfq: true } });
      if (!request || request.docType !== 'RFQ' || !request.rfq) throw new NotFoundException('RFQ not found');
      return request.rfq;
    }
    return rfq;
  }

  private async inviteVendor(rfqId: string, supplierId: string, actorUserId: string, reason = 'RFQ invite') {
    try {
      return await this.prisma.rfqVendor.create({
        data: { rfqId, supplierId, priority: 0, contactReason: reason, createdById: actorUserId },
        include: { supplier: true },
      });
    } catch {
      return this.prisma.rfqVendor.findUnique({ where: { rfqId_supplierId: { rfqId, supplierId } }, include: { supplier: true } });
    }
  }

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

  /** Validates + normalizes one quotation line (shared by addQuotation). */
  private normalizeQuotationItem(it: {
    description: string; quantity: number; unit?: string; unitPrice: number;
    taxPercent?: number; deliveryDays?: number; warrantyMonths?: number; discountPercent?: number;
  }, idx: number) {
    const description = (it.description ?? '').trim();
    if (!description) throw new BadRequestException(`Quote line ${idx + 1}: description is required`);
    const quantity = Math.floor(Number(it.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) throw new BadRequestException(`Quote line ${idx + 1}: quantity must be at least 1`);
    const unitPrice = Number(it.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new BadRequestException(`Quote line ${idx + 1}: unit price must be a positive number`);

    const pct = (v: number | undefined, name: string) => {
      const n = Number(v ?? 0);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new BadRequestException(`Quote line ${idx + 1}: ${name} must be 0..100`);
      return n;
    };
    const delivery = it.deliveryDays === undefined || it.deliveryDays === null ? undefined : Math.floor(Number(it.deliveryDays));
    const warranty = it.warrantyMonths === undefined || it.warrantyMonths === null ? undefined : Math.floor(Number(it.warrantyMonths));

    return {
      description,
      quantity,
      unit: it.unit?.trim() || undefined,
      unitPrice,
      taxPercent: pct(it.taxPercent, 'taxPercent'),
      deliveryDays: Number.isFinite(delivery as number) && (delivery as number) >= 0 ? delivery : undefined,
      warrantyMonths: Number.isFinite(warranty as number) && (warranty as number) >= 0 ? warranty : undefined,
      discountPercent: pct(it.discountPercent, 'discountPercent'),
    };
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
