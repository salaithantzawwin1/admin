import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { Actor } from '../org/org.service';

export interface PoItemInput {
  description: string;
  inventoryItemId?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
}

export interface CreatePoInput {
  purchaseRequestId?: string;
  supplierId: string;
  expectedDelivery?: string;
  deliveryAddress?: string;
  paymentTerms?: string;
  deliveryTerms?: string;
  note?: string;
  items: PoItemInput[];
}

export interface GrnItemInput {
  poItemId: string;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty?: number;
  condition?: string;
}

export interface CreateGrnInput {
  deliveryNoteNo?: string;
  locationId?: string;
  remarks?: string;
  items: GrnItemInput[];
}

/** §16 status machine — which transitions are legal. */
const PO_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['APPROVED', 'CANCELLED'],
  APPROVED: ['SENT_TO_VENDOR', 'CANCELLED'],
  SENT_TO_VENDOR: ['PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_RECEIVED', 'FULLY_RECEIVED'],
  FULLY_RECEIVED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

/**
 * Procurement Phase 3 (design §15–20, roadmap R5): Purchase Order + GRN.
 *
 * Design §35 controls implemented here:
 *  • Control 1 — no approval, no PO: a PO can only leave DRAFT when its linked
 *    PR's base document is APPROVED (POs created without a PR are approved
 *    explicitly via the same transition — an auditable act, not a silent one).
 *  • Control 2 — PO-required receiving: every GRN references a PO line.
 *  • Over-receiving guard: accepted qty across all GRNs can never exceed the
 *    ordered qty per line (partial deliveries §19 via multiple GRNs).
 *
 * GRN posts accepted consumable quantity as PURCHASE stock IN into the
 * EXISTING StockTransaction ledger (spec §23 — transactions are the source of
 * truth; no parallel stock system). Asset/service lines carry no itemId and
 * post nothing.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
    private inventory: InventoryService,
  ) {}

  // ---------- PO lifecycle ----------

  async list(params: { page: number; pageSize: number; status?: string }) {
    const where = params.status ? { status: params.status } : undefined;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.purchaseOrder.count({ where }),
      this.prisma.purchaseOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          supplier: { select: { id: true, name: true } },
          purchaseRequest: { select: { request: { select: { id: true, docNumber: true, status: true } } } },
          items: true,
          _count: { select: { goodsReceipts: true } },
        },
      }),
    ]);
    return { items: rows, total, page: params.page, pageSize: params.pageSize };
  }

  async byId(id: string) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: true,
        purchaseRequest: { select: { request: { select: { id: true, docNumber: true, status: true } } } },
        items: { orderBy: { id: 'asc' }, include: { inventoryItem: { select: { id: true, code: true, name: true, unit: true, balance: true } }, grnItems: true } },
        goodsReceipts: { orderBy: { receivedAt: 'desc' }, include: { items: true, receivedBy: { select: { fullName: true } } } },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    // received-to-date per line for the UI's partial-delivery progress
    const received = new Map<string, number>();
    for (const it of po.items) {
      received.set(it.id, it.grnItems.reduce((sum, g) => sum + g.acceptedQty, 0));
    }
    return { ...po, receivedByItem: Object.fromEntries(received) };
  }

  async create(data: CreatePoInput, actor: Actor) {
    if (!data.items?.length) throw new BadRequestException('At least one item is required');
    const supplier = await this.prisma.supplier.findUnique({ where: { id: data.supplierId } });
    if (!supplier || !supplier.isActive) throw new BadRequestException('A valid, active supplier is required');

    let purchaseRequestId: string | undefined;
    if (data.purchaseRequestId) {
      const pr = await this.prisma.purchaseRequest.findUnique({
        where: { requestId: data.purchaseRequestId },
        include: { request: { select: { status: true, docNumber: true } } },
      });
      if (!pr) throw new NotFoundException('Purchase request not found');
      // Control 1 (§35): no approval, no PO
      if (pr.request.status !== 'APPROVED') {
        throw new ConflictException(`PR ${pr.request.docNumber} is not approved yet (${pr.request.status}) — no approval, no PO`);
      }
      purchaseRequestId = pr.id;
    }

    const items = data.items.map((it, idx) => this.normalizePoItem(it, idx));
    const po = await this.prisma.purchaseOrder.create({
      data: {
        poNumber: await this.numbering.next('PO'),
        purchaseRequestId,
        supplierId: data.supplierId,
        status: 'DRAFT',
        expectedDelivery: data.expectedDelivery ? new Date(data.expectedDelivery) : undefined,
        deliveryAddress: data.deliveryAddress?.trim() || undefined,
        paymentTerms: data.paymentTerms?.trim() || undefined,
        deliveryTerms: data.deliveryTerms?.trim() || undefined,
        note: data.note?.trim() || undefined,
        createdById: actor.userId,
        items: { create: items },
      },
      include: { items: true },
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'PO_CREATED', module: 'PROCUREMENT', recordId: po.id,
      newValue: { poNumber: po.poNumber, supplier: supplier.name, items: items.length },
    });
    return po;
  }

  /** §16 transition with guard checks (approve = Control 1 enforcement point for ad-hoc POs). */
  async transition(id: string, action: 'approve' | 'send' | 'close' | 'cancel', actor: Actor) {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: { purchaseRequest: { include: { request: { select: { status: true, docNumber: true } } } } } });
    if (!po) throw new NotFoundException('Purchase order not found');

    const next: Record<string, { to: string; stamp?: string } | undefined> = {
      approve: { to: 'APPROVED' },
      send: { to: 'SENT_TO_VENDOR', stamp: 'sentToVendorAt' },
      close: { to: 'CLOSED', stamp: 'closedAt' },
      cancel: { to: 'CANCELLED', stamp: 'cancelledAt' },
    };
    const target = next[action];
    if (!target) throw new BadRequestException('Unknown action');
    if (!PO_TRANSITIONS[po.status]?.includes(target.to)) {
      throw new ConflictException(`Cannot ${action} a PO in status ${po.status}`);
    }

    // Control 1: approving an ad-hoc PO (no PR) is an explicit, audited act;
    // a PR-linked PO must show an APPROVED PR (defense in depth — create blocks it already)
    if (action === 'approve' && po.purchaseRequest && po.purchaseRequest.request.status !== 'APPROVED') {
      throw new ConflictException(`Linked PR is ${po.purchaseRequest.request.status} — no approval, no PO`);
    }

    // only a fully-received PO may close
    if (action === 'close') {
      const agg = await this.prisma.goodsReceiptItem.aggregate({
        where: { poItem: { purchaseOrderId: id } },
        _sum: { acceptedQty: true },
      });
      const ordered = await this.prisma.purchaseOrderItem.aggregate({
        where: { purchaseOrderId: id },
        _sum: { quantity: true },
      });
      if ((agg._sum.acceptedQty ?? 0) < (ordered._sum.quantity ?? 0)) {
        throw new ConflictException('Cannot close before every line is fully received');
      }
    }

    const updated = await this.prisma.purchaseOrder.update({
      where: { id },
      data: { status: target.to, ...(target.stamp ? { [target.stamp]: new Date() } : {}) },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: `PO_${action.toUpperCase()}`, module: 'PROCUREMENT', recordId: id,
      oldValue: { status: po.status }, newValue: { status: target.to },
    });
    return updated;
  }

  // ---------- GRN (receiving) ----------

  async createGrn(poId: string, data: CreateGrnInput, actor: Actor) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    // Control 2 (§35): PO-required receiving — status must be past APPROVED
    if (!['SENT_TO_VENDOR', 'PARTIALLY_RECEIVED'].includes(po.status)) {
      throw new ConflictException(`Receiving requires a PO sent to the vendor (current: ${po.status})`);
    }
    if (!data.items?.length) throw new BadRequestException('At least one received line is required');

    // already-accepted per line (across prior GRNs) → over-receiving guard
    const prior = await this.prisma.goodsReceiptItem.groupBy({
      by: ['poItemId'],
      where: { poItem: { purchaseOrderId: poId } },
      _sum: { acceptedQty: true },
    });
    const accepted = new Map(prior.map((p) => [p.poItemId, p._sum.acceptedQty ?? 0]));

    const lines = data.items.map((it, idx) => {
      const poItem = po.items.find((p) => p.id === it.poItemId);
      if (!poItem) throw new BadRequestException(`Line ${idx + 1}: unknown PO item`);
      const receivedQty = Math.floor(Number(it.receivedQty));
      const acceptedQty = Math.floor(Number(it.acceptedQty));
      const rejectedQty = Math.floor(Number(it.rejectedQty ?? 0));
      if (!Number.isFinite(receivedQty) || receivedQty < 0) throw new BadRequestException(`Line ${idx + 1}: invalid receivedQty`);
      if (!Number.isFinite(acceptedQty) || acceptedQty < 0) throw new BadRequestException(`Line ${idx + 1}: invalid acceptedQty`);
      if (!Number.isFinite(rejectedQty) || rejectedQty < 0) throw new BadRequestException(`Line ${idx + 1}: invalid rejectedQty`);
      if (acceptedQty + rejectedQty !== receivedQty) {
        throw new BadRequestException(`Line ${idx + 1}: accepted + rejected must equal received`);
      }
      if (acceptedQty === 0 && rejectedQty === 0) throw new BadRequestException(`Line ${idx + 1}: nothing received`);
      const already = accepted.get(poItem.id) ?? 0;
      if (already + acceptedQty > poItem.quantity) {
        throw new ConflictException(`Line ${idx + 1}: would exceed the ordered quantity (${already}/${poItem.quantity} already accepted)`);
      }
      return {
        poItemId: poItem.id,
        orderedQty: poItem.quantity,
        receivedQty,
        acceptedQty,
        rejectedQty,
        condition: it.condition?.trim() || undefined,
        inventoryItemId: poItem.inventoryItemId, // for stock posting
        unitPrice: Number(poItem.unitPrice), // ledger spending data (Decimal → number)
        description: poItem.description,
      };
    });

    const grnNumber = await this.numbering.next('GRN');
    const stockLines = lines.filter((l) => l.inventoryItemId && l.acceptedQty > 0);

    const grn = await this.prisma.$transaction(async (tx) => {
      const created = await tx.goodsReceipt.create({
        data: {
          grnNumber,
          purchaseOrderId: poId,
          receivedById: actor.userId,
          locationId: data.locationId || undefined,
          deliveryNoteNo: data.deliveryNoteNo?.trim() || undefined,
          remarks: data.remarks?.trim() || undefined,
          items: {
            create: lines.map((l) => ({
              poItemId: l.poItemId, orderedQty: l.orderedQty, receivedQty: l.receivedQty,
              acceptedQty: l.acceptedQty, rejectedQty: l.rejectedQty, condition: l.condition,
            })),
          },
        },
        include: { items: true },
      });

      // stock IN into the existing ledger via the inventory engine (row-locked,
      // balanceAfter computed, immutable audit trail) — accepted consumables only
      for (const l of stockLines) {
        await this.inventory.postStockIn({
          itemId: l.inventoryItemId!,
          quantity: l.acceptedQty,
          reference: `${grnNumber} / ${po.poNumber} — ${l.description}`,
          actor,
          client: tx,
          unitPrice: l.unitPrice,
          supplierId: po.supplierId,
        });
      }
      return created;
    });

    // recompute PO status from receipts (PARTIALLY_RECEIVED / FULLY_RECEIVED)
    const after = await this.prisma.goodsReceiptItem.groupBy({
      by: ['poItemId'],
      where: { poItem: { purchaseOrderId: poId } },
      _sum: { acceptedQty: true },
    });
    const ordered = await this.prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId: poId }, select: { quantity: true } });
    const totalOrdered = ordered.reduce((s, o) => s + o.quantity, 0);
    const totalAccepted = after.reduce((s, a) => s + (a._sum.acceptedQty ?? 0), 0);
    const newStatus = totalAccepted >= totalOrdered ? 'FULLY_RECEIVED' : 'PARTIALLY_RECEIVED';
    if (['PARTIALLY_RECEIVED', 'FULLY_RECEIVED'].includes(newStatus)) {
      await this.prisma.purchaseOrder.update({
        where: { id: poId },
        data: { status: newStatus },
      });
    }

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'GRN_CREATED', module: 'PROCUREMENT', recordId: grn.id,
      newValue: {
        grnNumber, po: po.poNumber,
        lines: lines.length,
        accepted: lines.reduce((s, l) => s + l.acceptedQty, 0),
        rejected: lines.reduce((s, l) => s + l.rejectedQty, 0),
        stockPosted: stockLines.reduce((s, l) => s + l.acceptedQty, 0),
        poStatus: newStatus,
      },
    });
    return { ...grn, poStatus: newStatus };
  }

  private normalizePoItem(it: PoItemInput, idx: number) {
    const description = (it.description ?? '').trim();
    if (!description) throw new BadRequestException(`Item ${idx + 1}: description is required`);
    const quantity = Math.floor(Number(it.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) throw new BadRequestException(`Item ${idx + 1}: quantity must be at least 1`);
    const unitPrice = Number(it.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new BadRequestException(`Item ${idx + 1}: unit price must be a positive number`);
    return {
      description,
      inventoryItemId: it.inventoryItemId || undefined,
      quantity,
      unit: it.unit?.trim() || undefined,
      unitPrice,
    };
  }
}
