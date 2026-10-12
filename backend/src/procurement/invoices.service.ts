import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';

export interface InvoiceItemInput {
  description: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  accountId?: string;
  assetId?: string;
}

export interface CreateInvoiceInput {
  supplierId: string;
  supplierInvoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  purchaseOrderId?: string;
  goodsReceiptId?: string;
  tax?: number;
  note?: string;
  items: InvoiceItemInput[];
}

/** §25 — invoice lifecycle aligned to the accounting flow. */
const INVOICE_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED'],
  APPROVED: ['POSTED', 'CANCELLED'],
  POSTED: [],
  REJECTED: ['DRAFT'],
  CANCELLED: [],
};

/** Tolerance for unit-price comparison (MMK has no minor unit; 0.01 buys precision). */
const PRICE_TOLERANCE = 0.011;

/**
 * Procurement Phase 4 (roadmap R6, design §22–25): vendor invoices + the
 * three-way match.
 *
 * §35 controls implemented here:
 *  • Control 3 — GRN check: SUBMIT requires a PO, and the PO must have at
 *    least one GRN (warning/hold → invoice cannot proceed to approval
 *    against phantom deliveries).
 *  • Control 4 — invoice ≤ PO amount: routed into the match verdict.
 *  • Control 5 — duplicate invoice: UNIQUE (supplierId, supplierInvoiceNumber).
 *
 * Three-way match (§23) compares per description line:
 *   PO ordered qty + PO price  ←→  GRN accepted qty  ←→  invoice billed
 * Verdicts: MATCHED / PARTIAL_MATCH / MISMATCH (+ NO_MATCH when no PO link).
 * Mismatches block approval — Resolve first (§25 "Resolve" branch).
 */
@Injectable()
export class InvoicesService {
  constructor(
    private prisma: PrismaService,
    private numbering: NumberingService,
    private audit: AuditService,
  ) {}

  async list(params: { page: number; pageSize: number; status?: string }) {
    const where = params.status ? { status: params.status } : undefined;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          supplier: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, poNumber: true, status: true } },
          items: true,
        },
      }),
    ]);
    return { items: rows, total, page: params.page, pageSize: params.pageSize };
  }

  async byId(id: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        supplier: true,
        purchaseOrder: {
          select: {
            id: true, poNumber: true, status: true, orderDate: true,
            items: true,
            goodsReceipts: { select: { id: true, grnNumber: true, receivedAt: true, items: true } },
          },
        },
        goodsReceipt: { select: { id: true, grnNumber: true, receivedAt: true } },
        createdBy: { select: { fullName: true } },
        items: { orderBy: { id: 'asc' } },
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  async create(data: CreateInvoiceInput, actor: Actor) {
    return this.createWithStatus(data, actor, 'DRAFT');
  }

  /** create + immediately submit (same validation path, one audited act). */
  async createAndSubmit(data: CreateInvoiceInput, actor: Actor) {
    return this.createWithStatus(data, actor, 'SUBMITTED');
  }

  private async createWithStatus(data: CreateInvoiceInput, actor: Actor, status: 'DRAFT' | 'SUBMITTED') {
    if (!data.items?.length) throw new BadRequestException('At least one invoice line is required');

    const supplier = await this.prisma.supplier.findUnique({ where: { id: data.supplierId } });
    if (!supplier || !supplier.isActive) throw new BadRequestException('A valid, active supplier is required');

    const supplierInvoiceNumber = data.supplierInvoiceNumber?.trim();
    if (!supplierInvoiceNumber) throw new BadRequestException("The vendor's invoice number is required");
    // Control 5 (§35): duplicate vendor bill guard
    const dup = await this.prisma.invoice.findFirst({
      where: { supplierId: data.supplierId, supplierInvoiceNumber },
      select: { invoiceNumber: true, status: true },
    });
    if (dup) {
      throw new ConflictException(`Duplicate invoice: supplier ${supplier.name} already has ${dup.invoiceNumber} (${dup.status}) for bill #${supplierInvoiceNumber}`);
    }

    const items = data.items.map((it, idx) => this.normalizeItem(it, idx));
    const subtotal = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
    const tax = Number(data.tax ?? 0);
    if (!Number.isFinite(tax) || tax < 0) throw new BadRequestException('Tax must be a non-negative number');
    const total = subtotal + tax;

    if (data.purchaseOrderId) {
      const po = await this.prisma.purchaseOrder.findUnique({ where: { id: data.purchaseOrderId } });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (!['APPROVED', 'SENT_TO_VENDOR', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED'].includes(po.status)) {
        throw new BadRequestException(`PO ${po.poNumber} is ${po.status} — invoices reference an active PO`);
      }
    }
    if (data.goodsReceiptId) {
      const grn = await this.prisma.goodsReceipt.findUnique({ where: { id: data.goodsReceiptId } });
      if (!grn) throw new NotFoundException('GRN not found');
      if (data.purchaseOrderId && grn.purchaseOrderId !== data.purchaseOrderId) {
        throw new BadRequestException('The linked GRN belongs to a different PO');
      }
    }

    const inv = await this.prisma.invoice.create({
      data: {
        invoiceNumber: await this.numbering.next('INV'),
        supplierInvoiceNumber,
        supplierId: data.supplierId,
        status,
        invoiceDate: new Date(data.invoiceDate),
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        purchaseOrderId: data.purchaseOrderId || undefined,
        goodsReceiptId: data.goodsReceiptId || undefined,
        subtotal,
        tax,
        total,
        note: data.note?.trim() || undefined,
        createdById: actor.userId,
        items: {
          create: items.map((it) => ({
            description: it.description,
            quantity: it.quantity,
            unit: it.unit,
            unitPrice: it.unitPrice,
            accountId: it.accountId || undefined,
            assetId: it.assetId || undefined,
          })),
        },
      },
      include: { items: true },
    });

    // a created-to-submit invoice computes its match immediately
    if (status === 'SUBMITTED') await this.recomputeMatch(inv.id);

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: status === 'DRAFT' ? 'INVOICE_CREATED' : 'INVOICE_CREATED_SUBMITTED',
      module: 'PROCUREMENT', recordId: inv.id,
      newValue: { invoiceNumber: inv.invoiceNumber, supplier: supplier.name, supplierBillNo: supplierInvoiceNumber, total, items: items.length },
    });
    return inv;
  }

  /** §23 — recompute the three-way match for an invoice (persisted for the UI). */
  async recomputeMatch(invoiceId: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: true, purchaseOrder: { include: { items: true, goodsReceipts: { include: { items: true } } } } },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (!inv.purchaseOrder) {
      return this.prisma.invoice.update({
        where: { id: invoiceId },
        data: { matchStatus: 'NO_MATCH', matchDetail: { reason: 'No PO reference — service/direct bill, not matched' } },
      });
    }

    const po = inv.purchaseOrder;
    // GRN accepted qty per PO line across ALL GRNs of the PO
    const accepted = new Map<string, number>();
    for (const g of po.goodsReceipts) for (const gi of g.items) {
      accepted.set(gi.poItemId, (accepted.get(gi.poItemId) ?? 0) + gi.acceptedQty);
    }

    const lines = inv.items.map((item) => {
      // PO/GRN side is keyed by description (PO has no productId; this
      // organisation writes descriptions identically on PR → PO → invoice)
      const poItem = [...po.items]
        .find((p) => p.description.localeCompare(item.description, undefined, { sensitivity: 'base' }) === 0);
      const grnAccepted = poItem ? (accepted.get(poItem.id) ?? 0) : 0;
      const ordered = poItem?.quantity ?? 0;
      const poPrice = Number(poItem?.unitPrice ?? 0);

      const priceOk = poPrice > 0 && Math.abs(Number(item.unitPrice) - poPrice) <= PRICE_TOLERANCE * Math.max(poPrice, 1);
      const amountTolerance = Math.max(ordered * poPrice * 0.01, 100); // §22-style small rounding window
      const invoiceTooHigh = item.quantity * Number(item.unitPrice) > ordered * poPrice + amountTolerance;

      // §23 quantity ladder: billing more than GRN-accepted is a hard
      // MISMATCH; billing exactly what GRN-accepted is a MATCH when the
      // delivery is complete and a legitimate PARTIAL_MATCH line while
      // deliveries are still under way (more GRNs may come).
      const billedBeyondReceived = item.quantity > grnAccepted;
      const deliveryComplete = grnAccepted >= ordered;

      let lineStatus: 'MATCHED' | 'PARTIAL_MATCH' | 'MISMATCH';
      if (billedBeyondReceived || !priceOk || invoiceTooHigh) lineStatus = 'MISMATCH';
      else if (deliveryComplete && item.quantity === ordered) lineStatus = 'MATCHED';
      else lineStatus = 'PARTIAL_MATCH';

      return {
        description: item.description,
        invoiceQty: item.quantity, invoiceUnitPrice: Number(item.unitPrice),
        orderedQty: ordered, grnAcceptedQty: grnAccepted, poUnitPrice: poPrice,
        priceOk, invoiceTooHigh, billedBeyondReceived,
        status: lineStatus,
      };
    });

    // §23 verdict: any hard violation (billed > received, price ≠ PO,
    // invoice over PO line amount) → MISMATCH; otherwise PARTIAL_MATCH if
    // deliveries are still under way, MATCHED when every line is complete.
    const hasMismatch = lines.some((l) => l.status === 'MISMATCH');
    const hasPartial = lines.some((l) => l.status === 'PARTIAL_MATCH');
    const status = hasMismatch ? 'MISMATCH' : hasPartial ? 'PARTIAL_MATCH' : 'MATCHED';

    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { matchStatus: status, matchDetail: { lines } },
    });
  }

  async transition(id: string, action: 'submit' | 'approve' | 'reject' | 'post' | 'cancel' | 'redraft', actor: Actor) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException('Invoice not found');

    const next: Record<string, { to: string; stamp?: string } | undefined> = {
      submit: { to: 'SUBMITTED', stamp: 'submittedAt' },
      approve: { to: 'APPROVED', stamp: 'approvedAt' },
      reject: { to: 'REJECTED', stamp: 'rejectedAt' },
      post: { to: 'POSTED', stamp: 'postedAt' },
      cancel: { to: 'CANCELLED' },
      redraft: { to: 'DRAFT' },
    };
    const target = next[action];
    if (!target) throw new BadRequestException('Unknown action');
    if (!INVOICE_TRANSITIONS[inv.status]?.includes(target.to)) {
      throw new ConflictException(`Cannot ${action} an invoice in status ${inv.status}`);
    }

    // Control 3 (§35): GRN check at submission — invoice needs a PO with at least one GRN
    if (action === 'submit') {
      if (!inv.purchaseOrderId) {
        throw new ConflictException('Submit requires a linked PO (Control 3 — GRN check / hold)');
      }
      const grnCount = await this.prisma.goodsReceipt.count({ where: { purchaseOrderId: inv.purchaseOrderId } });
      if (grnCount === 0) {
        throw new ConflictException('No GRN on the linked PO — invoice held (Control 3). Record a GRN first');
      }
      // Control 4 (§35): invoice total must not exceed PO total
      if (inv.purchaseOrderId) {
        const po = await this.prisma.purchaseOrder.findUnique({
          where: { id: inv.purchaseOrderId },
          include: { items: true },
        });
        const poTotal = (po?.items ?? []).reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0);
        if (Number(inv.total) > poTotal + 0.01) {
          throw new ConflictException(`Invoice total ${inv.total} exceeds PO amount ${poTotal} (Control 4) — adjust the bill`);
        }
      }
      await this.recomputeMatch(id);
    }

    // §25 approval gate: only MATCHED / PARTIAL_MATCH invoices may be approved.
    // MISMATCH routes to review (Reject → resolve → redraft → resubmit).
    if (action === 'approve') {
      if (!['MATCHED', 'PARTIAL_MATCH'].includes(inv.matchStatus ?? '')) {
        throw new ConflictException(`Approval blocked — 3-way match is ${inv.matchStatus ?? 'NOT RUN'} (§25). Resolve the mismatch, then resubmit`);
      }
    }

    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { status: target.to, ...(target.stamp ? { [target.stamp]: new Date() } : {}) },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: `INVOICE_${action.toUpperCase()}`, module: 'PROCUREMENT', recordId: id,
      oldValue: { status: inv.status, match: inv.matchStatus },
      newValue: { status: target.to, match: updated.matchStatus },
    });
    return updated;
  }

  private normalizeItem(it: InvoiceItemInput, idx: number) {
    const description = (it.description ?? '').trim();
    if (!description) throw new BadRequestException(`Line ${idx + 1}: description is required`);
    const quantity = Math.floor(Number(it.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) throw new BadRequestException(`Line ${idx + 1}: quantity must be at least 1`);
    const unitPrice = Number(it.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new BadRequestException(`Line ${idx + 1}: unit price must be a positive number`);
    return {
      description,
      quantity,
      unit: it.unit?.trim() || undefined,
      unitPrice,
      accountId: it.accountId || undefined,
      assetId: it.assetId || undefined,
    };
  }
}
