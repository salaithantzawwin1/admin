import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CHEQUE', 'OTHER'] as const;

/** §26 — only approved/posted invoices accept money (the design's flow:
 *  Approved Invoice → Payment Request → Finance Payment). */
const PAYABLE_STATUSES = ['APPROVED', 'POSTED'];

/** Rounding window for balance arithmetic (MMK has no minor unit). */
const TOLERANCE = 0.01;

/**
 * GLG Procurement ERP W1 — vendor payments (design §26, Plan §9).
 *
 * Controls implemented here:
 *  • Payment only against APPROVED/POSTED invoices (§26 lifecycle).
 *  • Over-payment guard: amount ≤ invoice.total − Σ payments (a second
 *    DB-level CHECK on payments.amount > 0 backstops the positive check).
 *  • Invoice rollup (paidAmount + paymentStatus) is recomputed inside the
 *    same interactive transaction as every payment write — no drift, no
 *    hand-edited status.
 *  • Payments are append-only: a wrong row is deleted (audited, WARNING)
 *    and re-entered — never edited (petty-cash ledger convention).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private numbering: NumberingService,
    private audit: AuditService,
  ) {}

  /** Payment register — filterable by range/supplier/invoice paymentStatus. */
  async list(params: {
    page: number; pageSize: number;
    from?: string; to?: string; supplierId?: string; status?: string;
  }) {
    const where: any = {};
    if (params.supplierId) where.invoice = { supplierId: params.supplierId };
    if (params.status) {
      if (!['UNPAID', 'PARTIALLY_PAID', 'PAID'].includes(params.status)) {
        throw new BadRequestException('Unknown payment status filter');
      }
      // filter the register by the invoice's rollup status
      where.invoice = { ...(where.invoice ?? {}), paymentStatus: params.status };
    }
    if (params.from || params.to) {
      where.date = {};
      if (params.from) where.date.gte = new Date(params.from);
      if (params.to) where.date.lte = new Date(`${params.to}T23:59:59.999Z`);
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          invoice: {
            select: {
              id: true, invoiceNumber: true, total: true, paidAmount: true,
              paymentStatus: true, dueDate: true,
              supplier: { select: { id: true, name: true } },
              purchaseOrder: { select: { poNumber: true } },
            },
          },
          createdBy: { select: { username: true, fullName: true } },
        },
      }),
    ]);
    return { items: rows, total, page: params.page, pageSize: params.pageSize };
  }

  async byId(id: string) {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        invoice: { select: { id: true, invoiceNumber: true, total: true, paidAmount: true, paymentStatus: true, supplier: { select: { name: true } } } },
        createdBy: { select: { username: true, fullName: true } },
      },
    });
    if (!row) throw new NotFoundException('Payment not found');
    return row;
  }

  /** Invoices the UI can offer for "record payment": APPROVED/POSTED with a
   *  remaining balance — the payables shortlist itself. */
  async payables(params: { from?: string; to?: string; supplierId?: string }) {
    const where: any = { status: { in: PAYABLE_STATUSES } };
    if (params.supplierId) where.supplierId = params.supplierId;
    if (params.from || params.to) {
      where.invoiceDate = {};
      if (params.from) where.invoiceDate.gte = new Date(params.from);
      if (params.to) where.invoiceDate.lte = new Date(`${params.to}T23:59:59.999Z`);
    }
    const rows = await this.prisma.invoice.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        purchaseOrder: { select: { poNumber: true } },
      },
    });
    const today = new Date();
    const items = rows
      .map((inv) => {
        const total = Number(inv.total);
        const paid = Number(inv.paidAmount);
        const balance = total - paid;
        const daysOverdue = inv.dueDate && balance > TOLERANCE
          ? Math.max(0, Math.floor((today.getTime() - inv.dueDate.getTime()) / 86400000))
          : 0;
        return {
          id: inv.id, invoiceNumber: inv.invoiceNumber, supplierInvoiceNumber: inv.supplierInvoiceNumber,
          supplier: inv.supplier, purchaseOrder: inv.purchaseOrder, status: inv.status,
          invoiceDate: inv.invoiceDate, dueDate: inv.dueDate,
          total, paid, balance, paymentStatus: inv.paymentStatus, daysOverdue,
        };
      })
      .filter((r) => r.balance > TOLERANCE)
      .sort((a, b) => {
        // overdue first, then by due date (no due date last), then oldest invoice
        if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
        const ad = a.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bd = b.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (ad !== bd) return ad - bd;
        return a.invoiceDate.getTime() - b.invoiceDate.getTime();
      });
    const totals = items.reduce(
      (s, r) => ({ total: s.total + r.total, paid: s.paid + r.paid, balance: s.balance + r.balance }),
      { total: 0, paid: 0, balance: 0 },
    );
    return { items, totals, count: items.length };
  }

  /** Record one payment against an invoice; recomputes the rollup in-tx. */
  async record(data: {
    invoiceId: string; amount: number; date?: string; method: string; reference?: string; note?: string;
  }, actor: Actor) {
    const method = (data.method ?? '').toUpperCase();
    if (!PAYMENT_METHODS.includes(method as never)) {
      throw new BadRequestException(`Method must be one of ${PAYMENT_METHODS.join(' / ')}`);
    }
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive number');
    }
    const inv = await this.prisma.invoice.findUnique({ where: { id: data.invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (!PAYABLE_STATUSES.includes(inv.status)) {
      throw new ConflictException(
        `Invoice ${inv.invoiceNumber} is ${inv.status} — payments are recorded on APPROVED/POSTED invoices only (§26)`,
      );
    }
    const remaining = Number(inv.total) - Number(inv.paidAmount);
    if (amount > remaining + TOLERANCE) {
      throw new BadRequestException(
        `Payment ${amount.toLocaleString()} exceeds the outstanding balance ${remaining.toLocaleString()} — over-payment rejected`,
      );
    }

    // allocate the number outside the tx (a rolled-back tx leaves a gap, never a reuse)
    const paymentNumber = await this.numbering.next('PY');
    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          paymentNumber,
          invoiceId: inv.id,
          date: data.date ? new Date(data.date) : new Date(),
          amount,
          method,
          reference: data.reference?.trim() || undefined,
          note: data.note?.trim() || undefined,
          createdById: actor.userId,
        },
      });
      await this.syncRollup(tx, inv.id);
      return p;
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'PAYMENT_RECORDED', module: 'PROCUREMENT', recordId: payment.id,
      newValue: {
        paymentNumber, invoiceNumber: inv.invoiceNumber, amount, method,
        reference: payment.reference ?? null, date: payment.date,
      },
    });
    return payment;
  }

  /** Delete a payment (audited WARNING) and resync the invoice rollup. */
  async remove(id: string, actor: Actor) {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: { invoice: { select: { invoiceNumber: true } } },
    });
    if (!row) throw new NotFoundException('Payment not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.delete({ where: { id } });
      await this.syncRollup(tx, row.invoiceId);
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'PAYMENT_DELETED', module: 'PROCUREMENT', recordId: id,
      oldValue: {
        paymentNumber: row.paymentNumber, amount: Number(row.amount),
        method: row.method, invoiceNumber: row.invoice.invoiceNumber, date: row.date,
      },
      severity: 'WARNING',
    });
    return { success: true };
  }

  /** Recompute paidAmount + paymentStatus from the ledger (single source of truth). */
  private async syncRollup(tx: any, invoiceId: string) {
    const agg = await tx.payment.aggregate({ where: { invoiceId }, _sum: { amount: true } });
    const paid = Number(agg._sum.amount ?? 0);
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { total: true } });
    const total = Number(inv.total);
    const paymentStatus = paid <= 0 ? 'UNPAID' : paid >= total - TOLERANCE ? 'PAID' : 'PARTIALLY_PAID';
    return tx.invoice.update({ where: { id: invoiceId }, data: { paidAmount: paid, paymentStatus } });
  }

  /** §41-style CSV export of the register (respects from/to filters). */
  async csv(filters: { from?: string; to?: string }) {
    const { items } = await this.list({ page: 1, pageSize: 100000, from: filters.from, to: filters.to });
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['Payment code,Date,Invoice,Supplier,Amount MMK,Method,Reference,Note,Recorded by'];
    let total = 0;
    for (const p of items) {
      total += Number(p.amount);
      lines.push([
        p.paymentNumber, new Date(p.date).toISOString().slice(0, 10),
        p.invoice.invoiceNumber, p.invoice.supplier.name,
        Number(p.amount).toFixed(2), p.method,
        p.reference ?? '', p.note ?? '',
        p.createdBy?.fullName ?? p.createdBy?.username ?? '',
      ].map(esc).join(','));
    }
    lines.push('');
    lines.push(`Totals,COUNT=${items.length},AMOUNT=${total.toFixed(2)}`);
    return lines.join('\n');
  }
}
