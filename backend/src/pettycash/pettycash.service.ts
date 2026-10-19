import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { Actor } from '../org/org.service';

export const PETTY_CASH_TYPES = ['TOPUP', 'EXPENSE'] as const;
export type PettyCashType = (typeof PETTY_CASH_TYPES)[number];

@Injectable()
export class PettyCashService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
  ) {}

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

  /** Append one ledger row — TOPUP adds cash, EXPENSE removes it. */
  async create(data: {
    type: string; amount: number; date?: string; payee?: string; accountId?: string; description?: string;
  }, actor: Actor) {
    if (!PETTY_CASH_TYPES.includes(data.type as never)) throw new BadRequestException('Type must be TOPUP or EXPENSE');
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Amount must be a positive number');
    if (data.accountId) {
      const acc = await this.prisma.account.findUnique({ where: { id: data.accountId } });
      if (!acc) throw new BadRequestException('Unknown account');
    }
    const txn = await this.prisma.pettyCashTransaction.create({
      data: {
        code: await this.numbering.next('PC'),
        date: data.date ? new Date(data.date) : new Date(),
        type: data.type,
        amount,
        payee: data.payee?.trim() || undefined,
        accountId: data.accountId || undefined,
        description: data.description?.trim() || undefined,
        createdById: actor.userId,
      },
      include: { account: true },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: data.type === 'TOPUP' ? 'PETTY_CASH_TOPUP' : 'PETTY_CASH_EXPENSE',
      module: 'PETTY_CASH', recordId: txn.id,
      newValue: { code: txn.code, amount, payee: txn.payee ?? null, date: txn.date },
    });
    return txn;
  }

  /** Corrections: a monetary row is never edited — delete (audited, WARNING)
   *  and re-enter the corrected row keeps the audit chain honest. */
  async remove(id: string, actor: Actor) {
    const txn = await this.prisma.pettyCashTransaction.findUnique({ where: { id } });
    if (!txn) throw new NotFoundException('Petty cash record not found');
    await this.prisma.pettyCashTransaction.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'PETTY_CASH_DELETED', module: 'PETTY_CASH', recordId: id,
      oldValue: { code: txn.code, type: txn.type, amount: Number(txn.amount), date: txn.date },
      severity: 'WARNING',
    });
    return { success: true };
  }

  /** §41 petty-cash report CSV. */
  async csv(filters: { from?: string; to?: string }) {
    const { items, totals } = await this.list({ ...filters });
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['Code,Date,Type,Amount MMK,Payee,Account,Description,Recorded by'];
    for (const t of items) {
      lines.push([
        t.code, new Date(t.date).toISOString().slice(0, 10), t.type,
        Number(t.amount).toFixed(2), t.payee ?? '',
        t.account ? `${t.account.code ?? ''} ${t.account.name}` : '',
        t.description ?? '', t.createdBy?.fullName ?? t.createdBy?.username ?? '',
      ].map(esc).join(','));
    }
    lines.push('');
    lines.push(`Totals,TOPUP=${totals.topup.toFixed(2)},EXPENSE=${totals.expense.toFixed(2)},BALANCE=${totals.balance.toFixed(2)}`);
    return lines.join('\n');
  }
}
