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
      // GLG ERP §W2 — purchasing summary: real money + queue numbers (§33)
      summary: await this.purchasingSummary(),
    };
  }

  /** §W2 purchasing summary — this-month spend, open queues, payables outstandings. */
  private async purchasingSummary() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [monthAgg, openPos, pendingInvoiceCount, payAgg, overdueCount, prPendingCount] = await this.prisma.$transaction([
      // this-month purchase: real AP spend (APPROVED/POSTED invoices dated this month)
      this.prisma.invoice.aggregate({
        where: { status: { in: ACTIVE_INVOICE }, invoiceDate: { gte: monthStart } },
        _sum: { total: true },
      }),
      // outstanding PO value: every PO still in flight (not CLOSED/CANCELLED)
      this.prisma.purchaseOrder.findMany({
        where: { status: { notIn: ['CLOSED', 'CANCELLED'] } },
        include: { items: { select: { quantity: true, unitPrice: true } } },
      }),
      // pending invoices: vendor bills not yet approved/posted
      this.prisma.invoice.count({ where: { status: { in: ['DRAFT', 'SUBMITTED'] } } }),
      // payables: Σ balance of approved/posted invoices (rollup maintained by W1)
      this.prisma.invoice.aggregate({
        where: { status: { in: ACTIVE_INVOICE } },
        _sum: { total: true, paidAmount: true },
      }),
      this.prisma.invoice.count({
        where: { status: { in: ACTIVE_INVOICE }, dueDate: { lt: now } },
      }),
      this.prisma.requestDocument.count({ where: { docType: 'PURCHASE_REQUEST', status: 'PENDING_APPROVAL' } }),
    ]);
    const outstandingPoValue = openPos.reduce(
      (s, po) => s + po.items.reduce((si, i) => si + Number(i.unitPrice) * i.quantity, 0),
      0,
    );
    // POs still expecting goods → the receiving (GRN) queue
    const pendingGrnCount = openPos.filter((po) =>
      ['APPROVED', 'SENT_TO_VENDOR', 'PARTIALLY_RECEIVED'].includes(po.status),
    ).length;
    const invoiced = Number(payAgg._sum.total ?? 0);
    const paid = Number(payAgg._sum.paidAmount ?? 0);
    return {
      thisMonthPurchase: round2(Number(monthAgg._sum.total ?? 0)),
      prPendingCount,
      outstandingPoValue: round2(outstandingPoValue),
      pendingGrnCount,
      pendingInvoiceCount,
      pendingPayment: round2(invoiced - paid),
      overdueInvoiceCount: overdueCount,
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

  /** §34/W3: purchase by asset — acquisition cost (PO lines, migration-54
   *  provenance link) + later related spend (invoice items tagged to the asset). */
  async purchaseByAsset(from?: string, to?: string) {
    const items = await this.prisma.invoiceItem.findMany({
      where: { invoice: { status: { in: ACTIVE_INVOICE }, ...(this.period(from, to)) } },
      include: { asset: { select: { id: true, assetCode: true, name: true } } },
    });
    type Row = {
      assetId: string; assetCode: string | null; asset: string | null;
      poLineCount: number; purchaseCost: number;
      invoiceLineCount: number; invoiceCost: number; total: number;
    };
    const byAsset = new Map<string, Row>();
    const rowFor = (assetId: string, assetCode: string | null, name: string | null): Row => {
      let row = byAsset.get(assetId);
      if (!row) {
        row = { assetId, assetCode, asset: name, poLineCount: 0, purchaseCost: 0, invoiceLineCount: 0, invoiceCost: 0, total: 0 };
        byAsset.set(assetId, row);
      }
      return row;
    };
    for (const it of items) {
      if (!it.asset) continue;
      const row = rowFor(it.asset.id, it.asset.assetCode, it.asset.name);
      row.invoiceLineCount += 1;
      row.invoiceCost = round2(row.invoiceCost + Number(it.unitPrice) * it.quantity);
      row.total = round2(row.purchaseCost + row.invoiceCost);
    }
    // acquisition side: PO lines that registered the asset (§39 provenance)
    const poItems = await this.prisma.purchaseOrderItem.findMany({
      where: {
        assetId: { not: null },
        purchaseOrder: { orderDate: this.poPeriod(from, to) },
      },
      include: { asset: { select: { id: true, assetCode: true, name: true } } },
    });
    for (const it of poItems) {
      if (!it.asset || !it.assetId) continue;
      const row = rowFor(it.assetId, it.asset.assetCode, it.asset.name);
      row.poLineCount += 1;
      row.purchaseCost = round2(row.purchaseCost + Number(it.unitPrice) * it.quantity);
      row.total = round2(row.purchaseCost + row.invoiceCost);
    }
    return [...byAsset.values()].sort((a, b) => b.total - a.total);
  }

  /** §W5 vendor performance — derived from live documents (no manual rating):
   *  PO count/value, average delivery lateness (expected delivery vs GRN),
   *  reject rate from GRN lines. */
  async vendorPerformance(from?: string, to?: string) {
    const pos = await this.prisma.purchaseOrder.findMany({
      where: { orderDate: this.poPeriod(from, to) },
      include: {
        supplier: { select: { id: true, name: true } },
        items: { select: { quantity: true, unitPrice: true } },
        goodsReceipts: { select: { receivedAt: true, items: { select: { orderedQty: true, rejectedQty: true } } } },
      },
    });
    type Perf = {
      supplierId: string; supplier: string;
      poCount: number; poValue: number;
      grnCount: number; lateDaysTotal: number; lateCount: number;
      orderedQty: number; rejectedQty: number;
      avgDaysLate: number | null; rejectRatePercent: number;
    };
    const bySup = new Map<string, Perf>();
    for (const po of pos) {
      let row = bySup.get(po.supplier.id);
      if (!row) {
        row = { supplierId: po.supplier.id, supplier: po.supplier.name, poCount: 0, poValue: 0, grnCount: 0, lateDaysTotal: 0, lateCount: 0, orderedQty: 0, rejectedQty: 0, avgDaysLate: null, rejectRatePercent: 0 };
        bySup.set(po.supplier.id, row);
      }
      row.poCount += 1;
      row.poValue = round2(row.poValue + po.items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0));
      for (const grn of po.goodsReceipts) {
        row.grnCount += 1;
        // lateness only measurable when the PO promised a delivery date
        if (po.expectedDelivery) {
          const lateMs = grn.receivedAt.getTime() - po.expectedDelivery.getTime();
          row.lateDaysTotal += Math.max(0, Math.round(lateMs / 86400000));
          row.lateCount += 1;
        }
        for (const gi of grn.items) {
          row.orderedQty += gi.orderedQty;
          row.rejectedQty += gi.rejectedQty;
        }
      }
    }
    return [...bySup.values()]
      .map((r) => ({
        supplierId: r.supplierId, supplier: r.supplier,
        poCount: r.poCount, poValue: r.poValue, grnCount: r.grnCount,
        avgDaysLate: r.lateCount > 0 ? round2(r.lateDaysTotal / r.lateCount) : null,
        rejectRatePercent: r.orderedQty > 0 ? round2((r.rejectedQty / r.orderedQty) * 100) : 0,
      }))
      .sort((a, b) => b.poValue - a.poValue);
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

  /** orderDate period for PO-side reports (W3/W5). */
  private poPeriod(from?: string, to?: string): { gte?: Date; lt?: Date } {
    const gte = from && !Number.isNaN(new Date(from).getTime()) ? new Date(from) : undefined;
    const lt = to && !Number.isNaN(new Date(to).getTime()) ? new Date(new Date(to).getTime() + 24 * 3600 * 1000) : undefined;
    return gte || lt ? { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } : {};
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
