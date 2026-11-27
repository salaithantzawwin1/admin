import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';
import { csvCell } from '../util/csv';
import { maskSupplierIdentity, maskSupplierName } from './ap-visibility';
import { PAYMENT_TOLERANCE, syncInvoiceRollup } from './payment-rollup';

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CHEQUE', 'OTHER'] as const;

/** v2 BR-7/D-3 — every new payment must say where the money came from.
 *  `PETTY_CASH` is deliberately absent: that payment exists only as the product
 *  of a linked expense (D-2), so the API refuses the label itself. */
export const FUNDING_SOURCES = ['COMPANY_CASH', 'COMPANY_BANK'] as const;
const PETTY_CASH_SOURCE = 'PETTY_CASH';

/** v2 BR-3/D-11 — a cancelled or rejected bill is the only state closed to
 *  money. The shop is often paid before approval, so APPROVED/POSTED is no
 *  longer a gate. */
const CLOSED_INVOICE_STATUSES = ['CANCELLED', 'REJECTED'];

/** Rounding window for balance arithmetic (MMK has no minor unit). */
const TOLERANCE = PAYMENT_TOLERANCE;

/**
 * GLG Procurement ERP W1 — vendor payments (design §26, Plan §9).
 *
 * Controls implemented here:
 *  • Payment against any invoice that is not CANCELLED/REJECTED (v2 BR-3/D-11).
 *  • fundingSource is mandatory and `PETTY_CASH` is refused (v2 BR-7/BR-13) —
 *    that source has exactly one writer, the petty-cash expense link.
 *  • An identical payment (same invoice, amount and day) asks for confirmation
 *    instead of being accepted or refused silently (v2 BR-15).
 *  • Deletion needs a reason, which lands in the audit entry (v2 BR-14).
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

  /**
   * Payment register — filterable by range/supplier/invoice paymentStatus.
   * `maskSupplier` hides the supplier identity (see ap-visibility.ts).
   */
  async list(params: {
    page: number; pageSize: number;
    from?: string; to?: string; supplierId?: string; status?: string;
  }, maskSupplier = false) {
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
          payer: { select: { username: true, fullName: true } },
        },
      }),
    ]);
    if (maskSupplier) rows.forEach((row) => maskSupplierName(row.invoice));
    return { items: rows, total, page: params.page, pageSize: params.pageSize };
  }

  async byId(id: string, maskSupplier = false) {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        invoice: { select: { id: true, invoiceNumber: true, total: true, paidAmount: true, paymentStatus: true, supplier: { select: { name: true } } } },
        createdBy: { select: { username: true, fullName: true } },
        payer: { select: { username: true, fullName: true } },
      },
    });
    if (!row) throw new NotFoundException('Payment not found');
    if (maskSupplier) maskSupplierName(row.invoice);
    return row;
  }

  /** Invoices the UI can offer for "record payment": anything still owing and
   *  not cancelled/rejected (v2 BR-3) — the payables shortlist itself. */
  async payables(params: { from?: string; to?: string; supplierId?: string }, maskSupplier = false) {
    const where: any = { status: { notIn: CLOSED_INVOICE_STATUSES } };
    if (params.supplierId) where.supplierId = params.supplierId;
    // `from`/`to` filter the payment register only. Outstanding money is not a
    // range question: a bill dated last month that is still unpaid must stay on
    // the list (and in the outstanding total) whatever period is shown above,
    // otherwise the page hides the very invoices the office still owes.
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
      });
    const outstanding = items
      .filter((r) => r.balance > TOLERANCE)
      .sort((a, b) => {
        // overdue first, then by due date (no due date last), then oldest invoice
        if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
        const ad = a.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bd = b.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (ad !== bd) return ad - bd;
        return a.invoiceDate.getTime() - b.invoiceDate.getTime();
      });
    if (maskSupplier) outstanding.forEach(maskSupplierIdentity);
    const totals = outstanding.reduce(
      (s, r) => ({ total: s.total + r.total, paid: s.paid + r.paid, balance: s.balance + r.balance }),
      { total: 0, paid: 0, balance: 0 },
    );
    return { items: outstanding, totals, count: outstanding.length };
  }

  /**
   * Record one company cash/bank payment against an invoice; recomputes the
   * rollup in-tx. `confirmDuplicate` is how the UI re-sends an entry the user
   * has explicitly confirmed as a second, separate payment (v2 BR-15).
   */
  async record(data: {
    invoiceId: string; amount: number; date?: string; method: string;
    fundingSource?: string; reference?: string; note?: string;
    payerUserId?: string; payerName?: string; confirmDuplicate?: boolean;
  }, actor: Actor) {
    const method = (data.method ?? '').toUpperCase();
    if (!PAYMENT_METHODS.includes(method as never)) {
      throw new BadRequestException(`Method must be one of ${PAYMENT_METHODS.join(' / ')}`);
    }
    const source = (data.fundingSource ?? '').toUpperCase();
    // v2 BR-7: no payment without a funding source. Nothing is guessed — real
    // cash and a bank transfer are different accounts in the GL.
    if (!source) {
      throw new BadRequestException(
        'fundingSource is required — COMPANY_CASH or COMPANY_BANK (a petty-cash payment is created by linking its expense)',
      );
    }
    // v2 D-2/BR-13: one write path per funding source. A petty-cash payment is
    // only ever produced by the expense link, so the label itself is refused here.
    if (source === PETTY_CASH_SOURCE) {
      throw new BadRequestException({
        code: 'USE_PETTY_CASH_LINK',
        message: 'A petty-cash payment is created by linking the expense that paid the shop — record it on Petty Cash or with "Link petty-cash expense", not here',
      });
    }
    if (!FUNDING_SOURCES.includes(source as never)) {
      throw new BadRequestException(`fundingSource must be one of ${FUNDING_SOURCES.join(' / ')}`);
    }
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive number');
    }
    const date = data.date ? new Date(data.date) : new Date();
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date');
    if (data.payerUserId) {
      const payer = await this.prisma.user.findUnique({ where: { id: data.payerUserId } });
      if (!payer) throw new BadRequestException('Unknown payer — pick an existing user or type the name instead');
    }
    const inv = await this.prisma.invoice.findUnique({ where: { id: data.invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    // v2 BR-3/D-11: money may arrive before approval — only a cancelled or
    // rejected bill is closed (the shop is often paid before the paperwork).
    if (CLOSED_INVOICE_STATUSES.includes(inv.status)) {
      throw new ConflictException(
        `Invoice ${inv.invoiceNumber} is ${inv.status} — a cancelled or rejected bill cannot take a payment`,
      );
    }
    const remaining = Number(inv.total) - Number(inv.paidAmount);
    if (amount > remaining + TOLERANCE) {
      throw new BadRequestException(
        `Payment ${amount.toLocaleString()} exceeds the outstanding balance ${remaining.toLocaleString()} — over-payment rejected`,
      );
    }

    // v2 BR-15: the same invoice, amount and day twice is a typo until the user
    // says otherwise — ask once; never accept silently, never block outright.
    if (!data.confirmDuplicate) {
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
      const twin = await this.prisma.payment.findFirst({
        where: { invoiceId: inv.id, amount, date: { gte: dayStart, lte: dayEnd } },
      });
      if (twin) {
        throw new ConflictException({
          code: 'DUPLICATE_PAYMENT',
          message: `Payment ${twin.paymentNumber} already records ${amount.toLocaleString()} MMK for ${inv.invoiceNumber} on this date — confirm only if this is a second, separate payment`,
          duplicate: { paymentNumber: twin.paymentNumber, amount },
        });
      }
    }

    // allocate the number outside the tx (a rolled-back tx leaves a gap, never a reuse)
    const paymentNumber = await this.numbering.next('PY');
    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          paymentNumber,
          invoiceId: inv.id,
          date,
          amount,
          method,
          fundingSource: source,
          payerUserId: data.payerUserId || undefined,
          payerName: data.payerName?.trim() || undefined,
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
        paymentNumber, invoiceNumber: inv.invoiceNumber, amount, method, fundingSource: source,
        payerName: payment.payerName ?? null, payerUserId: payment.payerUserId ?? null,
        reference: payment.reference ?? null, date: payment.date,
      },
    });
    return payment;
  }

  /** Delete a payment (audited WARNING, reason required) and resync the rollup. */
  async remove(id: string, actor: Actor, reason?: string) {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: { invoice: { select: { invoiceNumber: true } } },
    });
    if (!row) throw new NotFoundException('Payment not found');
    // v2 BR-13: a petty-cash payment is the product of its expense. Deleting it
    // here would orphan the expense and hide the cash that actually left the
    // float, so the correction belongs on the petty-cash screen.
    if (row.fundingSource === PETTY_CASH_SOURCE) {
      throw new ConflictException(
        `Payment ${row.paymentNumber} was created by a petty-cash expense — delete that expense instead (Petty Cash screen)`,
      );
    }
    // BR-14/D-9: the audit trail must say why money left the ledger, not only who
    // removed it — so the reason is a required field, not a note.
    const why = (reason ?? '').trim();
    if (!why) {
      throw new BadRequestException('A reason is required to delete a payment — it is kept in the audit log');
    }
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
        fundingSource: row.fundingSource ?? null,
      },
      newValue: { reason: why },
      severity: 'WARNING',
    });
    return { success: true };
  }

  /** Recompute paidAmount + paymentStatus from the ledger (single source of truth).
   *  Shared with the petty-cash ledger so both write paths agree (v2 BR-1). */
  private async syncRollup(tx: any, invoiceId: string) {
    return syncInvoiceRollup(tx, invoiceId);
  }

  /** §41-style CSV export of the register (respects from/to filters). */
  async csv(filters: { from?: string; to?: string }, maskSupplier = false) {
    const { items } = await this.list(
      { page: 1, pageSize: 100000, from: filters.from, to: filters.to },
      maskSupplier,
    );
    const esc = (v: unknown) => {
      return csvCell(v);
    };
    const lines = ['Payment code,Date,Invoice,Supplier,Amount MMK,Funding source,Method,Paid by,Reference,Note,Recorded by'];
    let total = 0;
    for (const p of items) {
      total += Number(p.amount);
      lines.push([
        p.paymentNumber, new Date(p.date).toISOString().slice(0, 10),
        p.invoice.invoiceNumber, p.invoice.supplier.name,
        Number(p.amount).toFixed(2), p.fundingSource ?? '', p.method,
        p.payerName ?? p.payer?.fullName ?? p.payer?.username ?? '',
        p.reference ?? '', p.note ?? '',
        p.createdBy?.fullName ?? p.createdBy?.username ?? '',
      ].map(esc).join(','));
    }
    lines.push('');
    lines.push(`Totals,COUNT=${items.length},AMOUNT=${total.toFixed(2)}`);
    return lines.join('\n');
  }
}
