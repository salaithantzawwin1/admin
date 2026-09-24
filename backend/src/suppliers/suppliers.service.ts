import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.service';
import { Actor } from '../org/org.service';

/**
 * Supplier master — organization-level vendor data.
 * Used today by Inventory purchases (restock source); future modules
 * (Purchasing/PO, supplier bills, fleet maintenance vendors) share this master.
 */
@Injectable()
export class SuppliersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
    private workflow: WorkflowService,
  ) {}

  list(includeInactive = false) {
    return this.prisma.supplier.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async create(data: { name: string; phone?: string; address?: string; note?: string }, actor: Actor) {
    const name = data.name.trim();
    if (!name) throw new BadRequestException('Supplier name is required');
    const exists = await this.prisma.supplier.findUnique({ where: { name } });
    if (exists) throw new ConflictException(`Supplier "${name}" already exists`);
    const supplier = await this.prisma.supplier.create({
      data: { name, phone: data.phone, address: data.address, note: data.note },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_CREATED', module: 'SUPPLIERS', recordId: supplier.id,
      newValue: { name },
    });
    return supplier;
  }

  async update(id: string, data: { name?: string; phone?: string; address?: string; note?: string; isActive?: boolean }, actor: Actor) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new BadRequestException('Supplier name is required');
      const dup = await this.prisma.supplier.findFirst({ where: { name, id: { not: id } } });
      if (dup) throw new ConflictException(`Supplier "${name}" already exists`);
    }
    const updated = await this.prisma.supplier.update({ where: { id }, data: { name: data.name?.trim(), phone: data.phone, address: data.address, note: data.note, isActive: data.isActive } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_UPDATED', module: 'SUPPLIERS', recordId: id,
      oldValue: { name: supplier.name, phone: supplier.phone, isActive: supplier.isActive },
      newValue: data,
    });
    return updated;
  }

  /** Purchase history summary for one supplier (per-item lifetime totals). */
  async purchaseHistory(id: string, start?: string, end?: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const from = start ? new Date(start) : null;
    const to = end ? new Date(end) : null;
    if ((start && Number.isNaN(from!.getTime())) || (to && Number.isNaN(to.getTime()))) {
      throw new BadRequestException('Invalid date range');
    }
    if (from && to && to <= from) throw new BadRequestException('Invalid date range');
    const txs = await this.prisma.stockTransaction.findMany({
      where: {
        supplierId: id,
        type: 'PURCHASE',
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      },
      include: {
        item: { select: { name: true, unit: true } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const perItem = new Map<string, { name: string; unit: string; qty: number; cost: number }>();
    for (const t of txs) {
      const cur = perItem.get(t.itemId) ?? { name: t.item.name, unit: t.item.unit, qty: 0, cost: 0 };
      cur.qty += t.quantity;
      cur.cost += t.unitPrice ? Number(t.unitPrice) * t.quantity : 0;
      perItem.set(t.itemId, cur);
    }
    return {
      supplier: { id: supplier.id, name: supplier.name },
      totalCost: [...perItem.values()].reduce((s, x) => s + x.cost, 0),
      items: [...perItem.values()].sort((a, b) => b.cost - a.cost),
      recent: txs.slice(0, 100).map((t) => ({
        id: t.id,
        quantity: t.quantity,
        unitPrice: t.unitPrice,
        reference: t.reference,
        createdAt: t.createdAt,
        item: { name: t.item.name },
        recordedBy: t.createdBy.fullName,
      })),
    };
  }

  async remove(id: string, actor: Actor) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const txCount = await this.prisma.stockTransaction.count({ where: { supplierId: id } });
    if (txCount > 0) {
      throw new ConflictException(`Supplier has ${txCount} purchase record(s) — deactivate it instead`);
    }
    await this.prisma.supplier.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_DELETED', module: 'SUPPLIERS', recordId: id,
      oldValue: { name: supplier.name },
      severity: 'WARNING',
    });
    return { success: true };
  }

  // ---------- vendor management (Purchasing) ----------

  /** Contact log for one vendor — newest first. */
  async listContactLogs(supplierId: string) {
    return this.prisma.supplierContactLog.findMany({
      where: { supplierId },
      orderBy: { contactedAt: 'desc' },
      take: 100,
      include: { createdBy: { select: { fullName: true } } },
    });
  }

  async createContactLog(
    supplierId: string,
    data: { person?: string; channel?: string; summary: string; followUpAt?: string; contactedAt?: string },
    actor: Actor,
  ) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    if (!data.summary?.trim()) throw new BadRequestException('Summary is required');
    const log = await this.prisma.supplierContactLog.create({
      data: {
        supplierId,
        person: data.person?.trim() || null,
        channel: data.channel || 'CALL',
        summary: data.summary.trim(),
        followUpAt: data.followUpAt ? new Date(data.followUpAt) : null,
        contactedAt: data.contactedAt ? new Date(data.contactedAt) : undefined,
        createdById: actor.userId,
      },
      include: { createdBy: { select: { fullName: true } } },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_CONTACT_LOGGED', module: 'SUPPLIERS', recordId: supplierId,
      newValue: { channel: log.channel, person: log.person, summary: log.summary },
    });
    return log;
  }

  async deleteContactLog(supplierId: string, logId: string, actor: Actor) {
    const log = await this.prisma.supplierContactLog.findUnique({ where: { id: logId } });
    if (!log || log.supplierId !== supplierId) throw new NotFoundException('Contact log not found');
    if (log.createdById !== actor.userId) {
      // only the author (or a superuser) may retract a contact entry
      const isSuper = await this.prisma.userRole.findFirst({ where: { userId: actor.userId, role: { name: 'SYSTEM_ADMIN' } } });
      if (!isSuper) throw new ForbiddenException('Only the author can delete this entry');
    }
    await this.prisma.supplierContactLog.delete({ where: { id: logId } });
    return { success: true };
  }

  /** PO drafts for a vendor (DRAFT first, then submitted). */
  async listPurchaseDrafts(supplierId: string) {
    return this.prisma.supplierPurchaseDraft.findMany({
      where: { supplierId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 50,
      include: {
        lines: { include: { item: { select: { code: true, name: true, unit: true } } } },
        request: { select: { id: true, docNumber: true, status: true } },
        createdBy: { select: { fullName: true } },
      },
    });
  }

  async createPurchaseDraft(
    supplierId: string,
    data: { note?: string; lines: { itemId: string; quantity: number; unitPrice?: number }[] },
    actor: Actor,
  ) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    if (!data.lines?.length) throw new BadRequestException('At least one line is required');
    for (const l of data.lines) {
      if (!l.itemId || !Number.isInteger(l.quantity) || l.quantity <= 0) {
        throw new BadRequestException('Each line needs an item and a positive quantity');
      }
    }
    const items = await this.prisma.inventoryItem.findMany({ where: { id: { in: data.lines.map((l) => l.itemId) } } });
    if (items.length !== new Set(data.lines.map((l) => l.itemId)).size) {
      throw new BadRequestException('One of the items does not exist');
    }
    const draft = await this.prisma.supplierPurchaseDraft.create({
      data: {
        supplierId,
        note: data.note?.trim() || null,
        createdById: actor.userId,
        lines: {
          create: data.lines.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            unitPrice: l.unitPrice !== undefined ? l.unitPrice : null,
          })),
        },
      },
      include: { lines: { include: { item: { select: { code: true, name: true, unit: true } } } } },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_PO_DRAFT_CREATED', module: 'SUPPLIERS', recordId: draft.id,
      newValue: { supplier: supplier.name, lines: data.lines.length },
    });
    return draft;
  }

  async updatePurchaseDraft(
    supplierId: string,
    draftId: string,
    data: { note?: string; lines?: { itemId: string; quantity: number; unitPrice?: number }[] },
    actor: Actor,
  ) {
    const draft = await this.prisma.supplierPurchaseDraft.findUnique({ where: { id: draftId }, include: { lines: true } });
    if (!draft || draft.supplierId !== supplierId) throw new NotFoundException('PO draft not found');
    if (draft.status !== 'DRAFT') throw new ConflictException('Draft already submitted');
    await this.prisma.$transaction(async (tx) => {
      await tx.supplierPurchaseDraft.update({ where: { id: draftId }, data: { note: data.note?.trim() || null } });
      if (data.lines) {
        if (!data.lines.length) throw new BadRequestException('At least one line is required');
        for (const l of data.lines) {
          if (!l.itemId || !Number.isInteger(l.quantity) || l.quantity <= 0) {
            throw new BadRequestException('Each line needs an item and a positive quantity');
          }
        }
        await tx.supplierPurchaseDraftLine.deleteMany({ where: { draftId } });
        await tx.supplierPurchaseDraftLine.createMany({
          data: data.lines.map((l) => ({ draftId, itemId: l.itemId, quantity: l.quantity, unitPrice: l.unitPrice !== undefined ? l.unitPrice : null })),
        });
      }
    });
    return this.prisma.supplierPurchaseDraft.findUnique({
      where: { id: draftId },
      include: { lines: { include: { item: { select: { code: true, name: true, unit: true } } } } },
    });
  }

  async deletePurchaseDraft(supplierId: string, draftId: string, actor: Actor) {
    const draft = await this.prisma.supplierPurchaseDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.supplierId !== supplierId) throw new NotFoundException('PO draft not found');
    if (draft.status !== 'DRAFT') throw new ConflictException('Draft already submitted — it lives in the request workflow now');
    await this.prisma.supplierPurchaseDraft.delete({ where: { id: draftId } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_PO_DRAFT_DELETED', module: 'SUPPLIERS', recordId: draftId,
    });
    return { success: true };
  }

  /**
   * Submit a PO draft — raises a PURCHASE_REQUEST through the approval
   * workflow (PR-… doc number). The draft is marked SUBMITTED and keeps the
   * link to the raised document.
   */
  async submitPurchaseDraft(supplierId: string, draftId: string, actor: Actor) {
    const draft = await this.prisma.supplierPurchaseDraft.findUnique({
      where: { id: draftId },
      include: { supplier: true, lines: { include: { item: true } } },
    });
    if (!draft || draft.supplierId !== supplierId) throw new NotFoundException('PO draft not found');
    if (draft.status !== 'DRAFT') throw new ConflictException('Draft already submitted');
    if (draft.lines.length === 0) throw new BadRequestException('Draft has no lines');

    const title = `PO — ${draft.supplier.name}`;
    const description =
      `Vendor: ${draft.supplier.name}\n` +
      draft.lines.map((l) => `${l.item.code} ${l.item.name} ×${l.quantity} ${l.item.unit}${l.unitPrice !== null ? ` @ ${Number(l.unitPrice)}` : ''}`).join('\n') +
      (draft.note ? `\nNote: ${draft.note}` : '');
    const doc = await this.workflow.create({ title, description, docType: 'PURCHASE_REQUEST' }, actor);

    await this.prisma.supplierPurchaseDraft.update({
      where: { id: draftId },
      data: { status: 'SUBMITTED', requestId: doc.id },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'SUPPLIER_PO_DRAFT_SUBMITTED', module: 'SUPPLIERS', recordId: draftId,
      newValue: { requestDoc: doc.docNumber, supplier: draft.supplier.name },
    });
    return { draftId, requestId: doc.id, docNumber: doc.docNumber };
  }
}
