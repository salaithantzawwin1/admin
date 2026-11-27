import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { Actor } from '../org/org.service';
import { csvCell } from '../util/csv';
import { PAYMENT_TOLERANCE, syncInvoiceRollup } from '../procurement/payment-rollup';

export const PETTY_CASH_TYPES = ['TOPUP', 'EXPENSE'] as const;
export type PettyCashType = (typeof PETTY_CASH_TYPES)[number];

/** A cancelled or rejected bill is closed to money (v2 BR-3). */
const CLOSED_INVOICE_STATUSES = ['CANCELLED', 'REJECTED'];

/**
 * Petty-cash ledger (spec §23).
 *
 * v2 P1-1 adds the link that makes the float ledger tell the truth about
 * invoices: an EXPENSE may name the bill it settled, and that link creates the
 * invoice's payment row in the same transaction (BR-13 — a petty-cash payment
 * has no other origin). A TOPUP is not a payment and can never be linked.
 *
 * Balance stays advisory (v2 D-5): it is computed from the rows and never
 * blocks a save, because top-ups are not always recorded.
 */
@Injectable()
export class PettyCashService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
  ) { }

  /** Ledger listing + totals. Balance is computed sum[TOPUP] − sum[EXPENSE]
   *  (spec §23 — transactions are the source of truth; no balance column). */
  async list(filters: { from?: string; to?: string; type?: string }) {
    const where: any = {};
    if (filters.type) {
      if (!PETTY_CASH_TYPES.includes(filters.type as never)) throw new BadRequestException('Unknown petty cash type');
      where.type = filters.type;
    }
    if (filters.from || filters.to) {
      where.date = {};
      if (filters.from) where.date.gte = new Date(filters.from);
      if (filters.to) where.date.lte = new Date(`${filters.to}T23:59:59.999Z`);
    }
    const items = await this.prisma.pettyCashTransaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      include: {
        account: { select: { id: true, code: true, name: true } },
        createdBy: { select: { username: true, fullName: true } },
        // v2 P1-1: what the cash settled, when it settled anything
        invoice: { select: { id: true, invoiceNumber: true } },
        payment: { select: { id: true, paymentNumber: true, invoiceId: true } },
      },
    });
    let topup = 0;
    let expense = 0;
    for (const t of items) {
      if (t.type === 'TOPUP' as never) topup += Number(t.amount);
      else expense += Number(t.amount);
    }
    return { items, totals: { topup, expense, balance: topup - expense }, count: items.length };
  }

  /**
   * The invoice a link may be made against, with its outstanding balance.
   * Refuses closed bills and settled bills — the two cases where money must
   * not move (v2 BR-3/BR-4).
   */
  private async assertLinkable(invoiceId: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true, invoiceNumber: true, status: true, supplierId: true,
        total: true, paidAmount: true,
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (CLOSED_INVOICE_STATUSES.includes(inv.status)) {
      throw new ConflictException(
        `Invoice ${inv.invoiceNumber} is ${inv.status} — a cancelled or rejected bill cannot take a payment`,
      );
    }
    const remaining = Number(inv.total) - Number(inv.paidAmount);
    if (remaining <= PAYMENT_TOLERANCE) {
      throw new ConflictException(`Invoice ${inv.invoiceNumber} is already settled — nothing is outstanding`);
    }
    return { inv, remaining };
  }

  /**
   * Append one ledger row — TOPUP adds cash, EXPENSE removes it.
   *
   * With `invoiceId` (EXPENSE only) the row also records the payment: one
   * transaction writes the expense, the payment and the invoice rollup, so a
   * half-linked state cannot exist.
   */
  async create(data: {
    type: string; amount: number; date?: string; payee?: string; accountId?: string; description?: string;
    invoiceId?: string;
  }, actor: Actor) {
    if (!PETTY_CASH_TYPES.includes(data.type as never)) throw new BadRequestException('Type must be TOPUP or EXPENSE');
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Amount must be a positive number');
    if (data.accountId) {
      const acc = await this.prisma.account.findUnique({ where: { id: data.accountId } });
      if (!acc) throw new BadRequestException('Unknown account');
    }
    // a bad date used to reach Prisma as an Invalid Date and come back as a 500;
    // it is a client input error, so answer 400 with a usable message
    const date = data.date ? new Date(data.date) : new Date();
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date');

    // v2 BR-2: a top-up is cash received, never a payment — it cannot be linked
    if (data.invoiceId && data.type !== 'EXPENSE') {
      throw new BadRequestException('Only an expense can be linked to an invoice — a top-up is not a payment');
    }
    let link: { invoiceId: string; supplierId: string; invoiceNumber: string } | null = null;
    if (data.invoiceId) {
      const { inv, remaining } = await this.assertLinkable(data.invoiceId);
      if (amount > remaining + PAYMENT_TOLERANCE) {
        throw new BadRequestException(
          `Expense ${amount.toLocaleString()} exceeds the outstanding balance ${remaining.toLocaleString()} on ${inv.invoiceNumber} — over-payment rejected. Record a separate expense for each instalment.`,
        );
      }
      link = { invoiceId: inv.id, supplierId: inv.supplierId, invoiceNumber: inv.invoiceNumber };
    }

    // numbers are allocated outside the transaction: a rollback leaves a gap in
    // the sequence, never a reused document number
    const code = await this.numbering.next('PC');
    const paymentNumber = link ? await this.numbering.next('PY') : null;

    const txn = await this.prisma.$transaction(async (tx) => {
      const row = await tx.pettyCashTransaction.create({
        data: {
          code,
          date,
          type: data.type,
          amount,
          payee: data.payee?.trim() || undefined,
          accountId: data.accountId || undefined,
          description: data.description?.trim() || undefined,
          invoiceId: link?.invoiceId,
          supplierId: link?.supplierId,
          createdById: actor.userId,
        },
        include: { account: true, invoice: { select: { id: true, invoiceNumber: true } } },
      });
      if (link && paymentNumber) {
        const payment = await tx.payment.create({
          data: {
            paymentNumber,
            invoiceId: link.invoiceId,
            date,
            amount,
            method: 'CASH',
            fundingSource: 'PETTY_CASH',
            reference: code,
            note: row.payee ? `Petty cash ${code} — paid to ${row.payee}` : `Petty cash ${code}`,
            pettyCashTransactionId: row.id,
            createdById: actor.userId,
          },
        });
        await syncInvoiceRollup(tx, link.invoiceId);
        return { row, payment };
      }
      return { row, payment: null };
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: data.type === 'TOPUP' ? 'PETTY_CASH_TOPUP' : 'PETTY_CASH_EXPENSE',
      module: 'PETTY_CASH', recordId: txn.row.id,
      newValue: {
        code: txn.row.code, amount, payee: txn.row.payee ?? null, date: txn.row.date,
        invoiceNumber: link?.invoiceNumber ?? null,
        paymentNumber: txn.payment?.paymentNumber ?? null,
      },
    });

    return txn.row;
  }

  /** Expenses that plausibly settled this invoice and are not linked yet. */
  async linkable(invoiceId: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, invoiceNumber: true, supplierId: true, supplier: { select: { name: true } } },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    const items = await this.prisma.pettyCashTransaction.findMany({
      where: {
        type: 'EXPENSE',
        invoiceId: null,
        payment: null,
        OR: [
          { supplierId: inv.supplierId },
          // the shop is often typed into `payee` and never picked as a supplier
          { payee: { contains: inv.supplier.name, mode: 'insensitive' } },
        ],
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: { id: true, code: true, date: true, amount: true, payee: true, description: true },
    });
    return { invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber }, items };
  }

  /**
   * Link an expense that already exists (cash spent before the bill was
   * entered) — creates the payment and rolls the invoice up in one transaction.
   */
  async linkInvoice(expenseId: string, invoiceId: string, actor: Actor) {
    const expense = await this.prisma.pettyCashTransaction.findUnique({
      where: { id: expenseId },
      include: {
        payment: { select: { paymentNumber: true } },
        invoice: { select: { invoiceNumber: true } },
      },
    });
    if (!expense) throw new NotFoundException('Petty cash record not found');
    if (expense.type !== 'EXPENSE') {
      throw new BadRequestException('Only a petty-cash expense can settle an invoice — a top-up is not a payment');
    }
    if (expense.payment || expense.invoiceId) {
      throw new ConflictException(
        `Petty cash ${expense.code} is already linked to ${expense.invoice?.invoiceNumber ?? 'an invoice'}`,
      );
    }
    const { inv, remaining } = await this.assertLinkable(invoiceId);
    const amount = Number(expense.amount);
    if (amount > remaining + PAYMENT_TOLERANCE) {
      throw new BadRequestException(
        `Petty cash ${expense.code} is ${amount.toLocaleString()} but only ${remaining.toLocaleString()} is outstanding on ${inv.invoiceNumber} — over-payment rejected`,
      );
    }

    const paymentNumber = await this.numbering.next('PY');
    await this.prisma.$transaction(async (tx) => {
      await tx.pettyCashTransaction.update({
        where: { id: expense.id },
        data: { invoiceId: inv.id, supplierId: expense.supplierId ?? inv.supplierId },
      });
      await tx.payment.create({
        data: {
          paymentNumber,
          invoiceId: inv.id,
          date: expense.date,
          amount,
          method: 'CASH',
          fundingSource: 'PETTY_CASH',
          reference: expense.code,
          note: expense.payee ? `Petty cash ${expense.code} — paid to ${expense.payee}` : `Petty cash ${expense.code}`,
          pettyCashTransactionId: expense.id,
          createdById: actor.userId,
        },
      });
      await syncInvoiceRollup(tx, inv.id);
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'PETTY_CASH_LINKED_TO_INVOICE', module: 'PROCUREMENT', recordId: expense.id,
      newValue: {
        code: expense.code, paymentNumber, invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber, amount,
      },
    });
    return { success: true, paymentNumber, invoiceNumber: inv.invoiceNumber, amount };
  }

  /** Corrections: a monetary row is never edited — delete (audited, WARNING)
   *  and re-enter the corrected row keeps the audit chain honest.
   *
   *  A linked expense owns its payment (BR-9): deleting it deletes the payment
   *  and restores the invoice rollup, all in one transaction. */
  async remove(id: string, actor: Actor) {
    const txn = await this.prisma.pettyCashTransaction.findUnique({
      where: { id },
      include: {
        payment: { select: { id: true, paymentNumber: true, invoiceId: true, amount: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
      },
    });
    if (!txn) throw new NotFoundException('Petty cash record not found');
    // (v2 P2 adds: refuse when the invoice is RECORDED — the voucher froze it.)
    const payment = txn.payment;
    await this.prisma.$transaction(async (tx) => {
      if (payment) {
        await tx.payment.delete({ where: { id: payment.id } });
        await syncInvoiceRollup(tx, payment.invoiceId);
      }
      await tx.pettyCashTransaction.delete({ where: { id } });
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'PETTY_CASH_DELETED', module: 'PETTY_CASH', recordId: id,
      oldValue: {
        code: txn.code, type: txn.type, amount: Number(txn.amount), date: txn.date,
        invoiceNumber: txn.invoice?.invoiceNumber ?? null,
        paymentNumber: payment?.paymentNumber ?? null,
      },
      severity: 'WARNING',
    });
    if (payment) {
      await this.audit.log({
        userId: actor.userId, username: actor.username,
        action: 'PAYMENT_DELETED', module: 'PROCUREMENT', recordId: payment.id,
        oldValue: {
          paymentNumber: payment.paymentNumber, amount: Number(payment.amount),
          invoiceNumber: txn.invoice?.invoiceNumber ?? null, via: `petty cash ${txn.code}`,
        },
        severity: 'WARNING',
      });
    }
    return { success: true, paymentRemoved: payment?.paymentNumber ?? null };
  }

  /** §41 petty-cash report CSV. */
  async csv(filters: { from?: string; to?: string }) {
    const { items, totals } = await this.list({ ...filters });
    const esc = (v: unknown) => {
      return csvCell(v);
    };
    const lines = ['Code,Date,Type,Amount MMK,Payee,Account,Description,Invoice,Payment,Recorded by'];
    for (const t of items) {
      lines.push([
        t.code, new Date(t.date).toISOString().slice(0, 10), t.type,
        Number(t.amount).toFixed(2), t.payee ?? '',
        t.account ? `${t.account.code ?? ''} ${t.account.name}` : '',
        t.description ?? '', t.invoice?.invoiceNumber ?? '', t.payment?.paymentNumber ?? '',
        t.createdBy?.fullName ?? t.createdBy?.username ?? '',
      ].map(esc).join(','));
    }
    lines.push('');
    lines.push(`Totals,TOPUP=${totals.topup.toFixed(2)},EXPENSE=${totals.expense.toFixed(2)},BALANCE=${totals.balance.toFixed(2)}`);
    return lines.join('\n');
  }
}
