import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { BudgetService } from '../budget/budget.service';

const ACTIVE_INVOICE = ['APPROVED', 'POSTED'];

/** Per §23 principle: every number below is aggregated from real transaction rows. */
@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private budget: BudgetService,
  ) {}

  /** §33/§44: procurement dashboard tiles — document flow at a glance. */
  async dashboardTiles() {
    const [prByStatus, poByStatus, invoiceByStatus, invoiceByMatch] = await this.prisma.$transaction([
      this.prisma.requestDocument.groupBy({
        by: ['status'],
        where: { docType: 'PURCHASE_REQUEST' },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.purchaseOrder.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.invoice.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.invoice.groupBy({
        by: ['matchStatus'],
        where: { matchStatus: { in: ['MATCHED', 'PARTIAL_MATCH', 'MISMATCH', 'NO_MATCH'] } },
        _count: { _all: true },
        orderBy: { matchStatus: 'asc' },
      }),
    ]);
    const toMap = (rows: { status?: string | null; matchStatus?: string | null; _count: { _all: number } }[], key: 'status' | 'matchStatus') =>
      Object.fromEntries(rows.map((r) => [r[key] ?? 'NULL', r._count._all]));
    return {
      purchaseRequests: toMap(prByStatus as never, 'status'),
      purchaseOrders: toMap(poByStatus as never, 'status'),
      invoices: toMap(invoiceByStatus as never, 'status'),
      invoiceMatches: toMap(invoiceByMatch as never, 'matchStatus'),
    };
  }

  /** §34: vendor purchase report — real AP spend per supplier over a period. */
  async vendorPurchaseReport(from?: string, to?: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: { status: { in: ACTIVE_INVOICE }, ...(this.period(from, to)) },
      include: {
        supplier: { select: { id: true, name: true } },
        items: { select: { quantity: true, unitPrice: true } },
      },
    });
    const bySupplier = new Map<string, { supplierId: string; supplier: string; invoiceCount: number; subtotal: number; invoices: number }>();
    for (const inv of invoices) {
      const key = inv.supplier.id;
      const row = bySupplier.get(key) ?? { supplierId: key, supplier: inv.supplier.name, invoiceCount: 0, subtotal: 0, invoices: 0 };
      const lines = inv.items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0);
      row.invoiceCount += 1;
      row.invoices = row.invoiceCount;
      row.subtotal = round2(row.subtotal + lines + Number(inv.tax));
      bySupplier.set(key, row);
    }
    return [...bySupplier.values()].sort((a, b) => b.subtotal - a.subtotal);
  }

  /** §33/§34: purchase by account / asset — what the money was spent on. */
  async purchaseByAccount(from?: string, to?: string) {
    const items = await this.prisma.invoiceItem.findMany({
      where: { invoice: { status: { in: ACTIVE_INVOICE }, ...(this.period(from, to)) } },
      include: { account: { select: { id: true, code: true, name: true } } },
    });
    const byAccount = new Map<string, { accountId: string; accountCode: string | null; account: string; lineCount: number; total: number }>();
    for (const it of items) {
      if (!it.account) continue;
      const key = it.account.id;
      const row = byAccount.get(key) ?? { accountId: key, accountCode: it.account.code, account: it.account.name, lineCount: 0, total: 0 };
      row.lineCount += 1;
      row.total = round2(row.total + Number(it.unitPrice) * it.quantity);
      byAccount.set(key, row);
    }
    return [...byAccount.values()].sort((a, b) => b.total - a.total);
  }

  async purchaseByAsset(from?: string, to?: string) {
    const items = await this.prisma.invoiceItem.findMany({
      where: { invoice: { status: { in: ACTIVE_INVOICE }, ...(this.period(from, to)) } },
      include: { asset: { select: { id: true, assetCode: true, name: true } } },
    });
    const byAsset = new Map<string, { assetId: string; assetCode: string | null; asset: string | null; lineCount: number; total: number }>();
    for (const it of items) {
      if (!it.asset) continue;
      const key = it.asset.id;
      const row = byAsset.get(key) ?? { assetId: key, assetCode: it.asset.assetCode, asset: it.asset.name, lineCount: 0, total: 0 };
      row.lineCount += 1;
      row.total = round2(row.total + Number(it.unitPrice) * it.quantity);
      byAsset.set(key, row);
    }
    return [...byAsset.values()].sort((a, b) => b.total - a.total);
  }

  /** §9: budget vs actual for one month across all budgeted accounts. */
  async budgetVsActual(year: number, month: number) {
    const rows = await this.budget.list({ year, month });
    return rows.map((r) => ({
      accountId: r.accountId,
      account: r.account?.name ?? r.accountId,
      accountCode: r.account?.code,
      amount: r.amount,
      spent: r.spent,
      remaining: r.remaining,
      usedPercent: r.usedPercent,
    }));
  }

  private period(from?: string, to?: string) {
    const gte = from && !Number.isNaN(new Date(from).getTime()) ? new Date(from) : undefined;
    const lt = to && !Number.isNaN(new Date(to).getTime()) ? new Date(new Date(to).getTime() + 24 * 3600 * 1000) : undefined;
    return gte || lt ? { invoiceDate: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } } : {};
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
