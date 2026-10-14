import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';

export interface SetBudgetInput {
  accountId: string;
  year: number;
  month: number;
  amount: number;
  note?: string;
}

/**
 * R7 (§9) — per-account monthly budget as an integration point.
 *
 *  • Budgets are amounts per Account + month (§9 alignment; MMK has no minor
 *    unit, Decimal(12,2) is the org-wide convention).
 *  • Usage is measured from REAL data: InvoiceItem lines of APPROVED/POSTED
 *    invoices attributed to the account (transactions are the source of truth,
 *    spec §23 — no denormalized totals).
 *  • checkRequestSubmission() is the validation hook the PR submit path calls:
 *    a PR whose estimated total for an account exceeds that account's monthly
 *    remaining amount is held (only accounts WITH a budget are enforced —
 *    unbudgeted accounts stay unconstrained until Finance sets them up).
 */
@Injectable()
export class BudgetService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** Upsert one (account, year, month) budget row. */
  async set(data: SetBudgetInput, actor: Actor) {
    if (!Number.isInteger(data.year) || data.year < 2000 || data.year > 2100) {
      throw new BadRequestException('Year must be a valid calendar year');
    }
    if (!Number.isInteger(data.month) || data.month < 1 || data.month > 12) {
      throw new BadRequestException('Month must be 1..12');
    }
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException('Budget amount must be a non-negative number');

    const account = await this.prisma.account.findUnique({ where: { id: data.accountId } });
    if (!account) throw new BadRequestException('Account not found');

    const row = await this.prisma.monthlyBudget.upsert({
      where: { accountId_year_month: { accountId: data.accountId, year: data.year, month: data.month } },
      create: { accountId: data.accountId, year: data.year, month: data.month, amount, note: data.note?.trim() || undefined, createdById: actor.userId },
      update: { amount, note: data.note?.trim() || undefined },
      include: { account: { select: { id: true, code: true, name: true } } },
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'BUDGET_SET', module: 'PROCUREMENT', recordId: row.id,
      oldValue: { account: account.name, year: data.year, month: data.month },
      newValue: { account: account.name, year: data.year, month: data.month, amount },
    });
    return row;
  }

  async remove(id: string, actor: Actor) {
    const row = await this.prisma.monthlyBudget.findUnique({ where: { id }, include: { account: true } });
    if (!row) throw new NotFoundException('Budget not found');
    await this.prisma.monthlyBudget.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'BUDGET_REMOVED', module: 'PROCUREMENT', recordId: id,
      oldValue: { account: row.account?.name, year: row.year, month: row.month, amount: row.amount },
    });
    return { ok: true };
  }

  /** Lists budgets with REAL usage attached (spend from APPROVED/POSTED invoices). */
  async list(params: { year: number; month?: number; accountId?: string }) {
    const where = {
      year: params.year,
      ...(params.month ? { month: params.month } : {}),
      ...(params.accountId ? { accountId: params.accountId } : {}),
    };
    const rows = await this.prisma.monthlyBudget.findMany({
      where,
      orderBy: [{ year: 'desc' }, { month: 'asc' }],
      include: { account: { select: { id: true, code: true, name: true, categoryId: true } } },
    });
    return Promise.all(rows.map(async (row) => ({ ...row, ...await this.usageFor(row.accountId, row.year, row.month, Number(row.amount)) })));
  }

  /**
   * CSV export of the budget table — same Excel-friendly shape as the
   * inventory spending/ledger CSVs (UTF-8 BOM + CRLF). `q` narrows by account
   * name/code so the download matches the table's filter.
   */
  async csv(params: { year: number; month?: number; q?: string }) {
    const rows = await this.list(params);
    const q = (params.q ?? '').trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) =>
          (r.account?.name ?? '').toLowerCase().includes(q) ||
          (r.account?.code ?? '').toLowerCase().includes(q),
        )
      : rows;
    const head = ['Account', 'Code', 'Year', 'Month', 'Budget (Ks)', 'Spent (Ks)', 'Remaining (Ks)', 'Used %', 'Note'];
    const lines = [
      head,
      ...filtered.map((r) => [
        r.account?.name ?? '',
        r.account?.code ?? '',
        String(r.year),
        String(r.month),
        String(r.amount),
        String(r.spent),
        String(r.remaining),
        String(r.usedPercent),
        r.note ?? '',
      ]),
    ];
    const content = '\ufeff' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
    const stamp = `${params.year}-${params.month ? String(params.month).padStart(2, '0') : 'all'}`;
    return { filename: `budgets-${stamp}.csv`, content };
  }

  /** Budget vs actual for a month — every report/table surfaces this shape. */
  async usageFor(accountId: string, year: number, month: number, budgetAmount: number) {
    const spend = await this.spendFor(accountId, year, month);
    return {
      amount: Number(budgetAmount),
      spent: spend,
      remaining: Number(budgetAmount) - spend,
      usedPercent: Number(budgetAmount) > 0 ? Math.round((spend / Number(budgetAmount)) * 1000) / 10 : 0,
    };
  }

  /** Real spend data source: APPROVED/POSTED invoice lines for the account in that month. */
  async spendFor(accountId: string, year: number, month: number) {
    const lines = await this.prisma.invoiceItem.findMany({
      where: {
        accountId,
        invoice: {
          status: { in: ['APPROVED', 'POSTED'] },
          invoiceDate: { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) },
        },
      },
      select: { quantity: true, unitPrice: true },
    });
    return round2(lines.reduce((s, l) => s + Number(l.unitPrice) * l.quantity, 0));
  }

  /**
   * §9 validation hook — called from the PR submit path (WorkflowService.submit).
   * PR estimated totals per account are compared with that account's remaining
   * monthly budget; exceeding any account blocks the submission with a clear
   * message naming the accounts (resolve via budget adjustment or next month).
   */
  async checkRequestSubmission(requestId: string) {
    const pr = await this.prisma.purchaseRequest.findUnique({
      where: { requestId },
      include: { items: { select: { accountId: true, quantity: true, estimatedUnitPrice: true } } },
    });
    if (!pr) return; // not a purchase request — the hook is a no-op for other docTypes

    const perAccount = new Map<string, number>();
    for (const item of pr.items) {
      if (!item.accountId) continue; // unbudgeted line: §9 first pass only enforces lines with an account
      const est = Number(item.estimatedUnitPrice ?? 0) * item.quantity;
      perAccount.set(item.accountId, (perAccount.get(item.accountId) ?? 0) + est);
    }
    return this.checkTotals(perAccount);
  }

  /**
   * §9 core — per-account estimated totals vs the current month's remaining
   * budget. Shared by the PR-submit hook (pre-approval) and PO creation
   * (the purchasing stage now owns Account — design §17/§39), so both
   * enforcement points return the identical structured verdict.
   */
  async checkTotals(perAccount: Map<string, number>) {
    if (perAccount.size === 0) return;

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    const blocked: { account: string; estimated: number; budget: number; alreadySpent: number; remaining: number }[] = [];
    for (const [accountId, estimated] of perAccount) {
      const budget = await this.prisma.monthlyBudget.findUnique({
        where: { accountId_year_month: { accountId, year, month } },
        include: { account: { select: { name: true } } },
      });
      if (!budget) continue; // no budget for this account/month → not enforced
      const spent = await this.spendFor(accountId, year, month);
      const remaining = Number(budget.amount) - spent;
      if (estimated > remaining) {
        blocked.push({ account: budget.account?.name ?? accountId, estimated: round2(estimated), budget: Number(budget.amount), alreadySpent: spent, remaining: round2(remaining) });
      }
    }
    return blocked.length ? { blocked, year, month } : undefined;
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Excel-friendly CSV cell — quotes separators/quotes/newlines per RFC 4180. */
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
