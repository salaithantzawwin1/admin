/**
 * GLG Procurement ERP (2026-10-20) — reports batch:
 *  §W2 purchasingSummary (inside dashboardTiles): this-month purchase, open PO
 *     value, pending GRN/invoice queues, payables balance + overdue count.
 *  §W3 purchaseByAsset: PO-line acquisition cost (migration-54 provenance)
 *     merged with invoice-item related spend; totals reconcile.
 *  §W5 vendorPerformance: lateness vs promised delivery + GRN reject rate,
 *     derived from live documents (no manual rating).
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/reports-summary.test.ts
 */
const assert = require('assert');

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e: unknown) => {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    });
}

const DAY = 86400000;
const now = new Date();
const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const lastMonth = new Date(thisMonth.getTime() - 30 * DAY);

function makeEnv() {
  const invoices: any[] = [];
  const pos: any[] = [];
  const poItems: any[] = [];
  const invoiceItems: any[] = [];

  const prisma: any = {
    $transaction: async (ops: any[]) => Promise.all(ops),
    requestDocument: {
      count: async ({ where }: any) =>
        where?.docType === 'PURCHASE_REQUEST' && where?.status === 'PENDING_APPROVAL' ? 3 : 0,
      groupBy: async () => [{ status: 'APPROVED', _count: { _all: 2 } }],
    },
    purchaseOrder: {
      groupBy: async () => [{ status: 'SENT_TO_VENDOR', _count: { _all: 1 } }],
      findMany: async (args: any) => {
        let list = pos;
        if (args?.where?.status?.notIn) list = list.filter((p) => !args.where.status.notIn.includes(p.status));
        if (args?.where?.orderDate?.gte) list = list.filter((p) => p.orderDate >= args.where.orderDate.gte);
        if (args?.where?.orderDate?.lt) list = list.filter((p) => p.orderDate < args.where.orderDate.lt);
        return list;
      },
    },
    purchaseOrderItem: {
      findMany: async ({ where }: any) =>
        poItems.filter((it) => {
          if (where?.assetId?.not === null && it.assetId == null) return false;
          const w = where?.purchaseOrder?.orderDate ?? {};
          return (!w.gte || it.orderDate >= w.gte) && (!w.lt || it.orderDate < w.lt);
        }),
    },
    invoiceItem: {
      findMany: async () => invoiceItems,
    },
    invoice: {
      aggregate: async ({ where }: any) => {
        const rows = invoices.filter((i) => {
          if (where?.status?.in && !where.status.in.includes(i.status)) return false;
          if (where?.invoiceDate?.gte && i.invoiceDate < where.invoiceDate.gte) return false;
          if (where?.dueDate?.lt && (!i.dueDate || i.dueDate >= where.dueDate.lt)) return false;
          return true;
        });
        return {
          _sum: {
            total: rows.reduce((s, i) => s + i.total, 0) || null,
            paidAmount: rows.reduce((s, i) => s + i.paidAmount, 0) || null,
          },
        };
      },
      count: async ({ where }: any) =>
        invoices.filter((i) => {
          if (where?.status?.in && !where.status.in.includes(i.status)) return false;
          if (where?.dueDate?.lt && (!i.dueDate || i.dueDate >= where.dueDate.lt)) return false;
          return true;
        }).length,
      groupBy: async ({ where }: any) => {
        const rows = invoices.filter((i) => !where?.status?.in || where.status.in.includes(i.status));
        const counts = new Map<string, number>();
        for (const i of rows) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
        return [...counts.entries()].map(([status, n]) => ({ status, _count: { _all: n } }));
      },
    },
  };

  // helpers to seed rows in service shape
  const seedInvoice = (o: Partial<any> = {}) => {
    const row = {
      id: `inv-${invoices.length + 1}`, status: 'POSTED', total: 100000, paidAmount: 0,
      invoiceDate: thisMonth, dueDate: null as Date | null, ...o,
    };
    invoices.push(row);
    return row;
  };
  const seedPo = (o: Partial<any> = {}) => {
    const row = {
      id: `po-${pos.length + 1}`, status: 'SENT_TO_VENDOR', supplier: { id: 'sup-1', name: 'ABC' },
      orderDate: thisMonth, expectedDelivery: null as Date | null, items: [] as any[],
      goodsReceipts: [] as any[], ...o,
    };
    pos.push(row);
    return row;
  };

  return { prisma, invoices, pos, poItems, invoiceItems, seedInvoice, seedPo };
}

const { ReportsService } = require('../src/reports/reports.service');

function makeSvc() {
  const env = makeEnv();
  const svc = new ReportsService(env.prisma, { list: async () => [] });
  return { svc, env };
}

async function main() {
  console.log('\n== §W2 purchasing summary (dashboardTiles) ==');

  await test('summary: this-month purchase counts only APPROVED/POSTED invoices this month', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice({ status: 'POSTED', total: 500000, invoiceDate: thisMonth });
    env.seedInvoice({ status: 'APPROVED', total: 300000, invoiceDate: thisMonth });
    env.seedInvoice({ status: 'POSTED', total: 999000, invoiceDate: lastMonth }); // excluded
    env.seedInvoice({ status: 'DRAFT', total: 42000, invoiceDate: thisMonth }); // excluded
    const tiles = await svc.dashboardTiles();
    assert.strictEqual(tiles.summary.thisMonthPurchase, 800000);
  });

  await test('summary: outstanding PO value + pending GRN queue from open POs only', async () => {
    const { svc, env } = makeSvc();
    const open = env.seedPo({ status: 'SENT_TO_VENDOR', items: [{ quantity: 2, unitPrice: 150000 }] });
    env.seedPo({ status: 'PARTIALLY_RECEIVED', items: [{ quantity: 1, unitPrice: 40000 }] });
    env.seedPo({ status: 'CLOSED', items: [{ quantity: 9, unitPrice: 999999 }] }); // excluded
    env.seedPo({ status: 'CANCELLED', items: [{ quantity: 1, unitPrice: 1 }] }); // excluded
    const tiles = await svc.dashboardTiles();
    assert.strictEqual(tiles.summary.outstandingPoValue, 2 * 150000 + 40000);
    assert.strictEqual(tiles.summary.pendingGrnCount, 2, 'open POs awaiting full delivery');
    assert.ok(open, 'seed sanity');
  });

  await test('summary: payables balance = Σ total − Σ paid; overdue counts due-dated APPROVED/POSTED', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice({ status: 'POSTED', total: 100000, paidAmount: 40000, dueDate: new Date(now.getTime() - 3 * DAY) });
    env.seedInvoice({ status: 'APPROVED', total: 60000, paidAmount: 60000, dueDate: new Date(now.getTime() + 5 * DAY) });
    env.seedInvoice({ status: 'DRAFT', total: 50000, paidAmount: 0, dueDate: new Date(now.getTime() - 9 * DAY) }); // not payable
    const tiles = await svc.dashboardTiles();
    assert.strictEqual(tiles.summary.pendingPayment, 100000 - 40000 + 60000 - 60000);
    assert.strictEqual(tiles.summary.overdueInvoiceCount, 1, 'only the posted overdue one');
    assert.strictEqual(tiles.summary.pendingInvoiceCount, 1, 'DRAFT counts as pending bill');
  });

  console.log('\n== §W3 purchase by asset ==');

  await test('merges PO-line acquisition cost with invoice-item related spend', async () => {
    const { svc, env } = makeSvc();
    // acquisition: PO line that registered the asset (migration-54 provenance)
    env.poItems.push({ assetId: 'ast-1', quantity: 1, unitPrice: 5000000, orderDate: thisMonth, asset: { id: 'ast-1', assetCode: 'AST-001', name: 'Server' } });
    // related: invoice line later tagged to the same asset (e.g. warranty service)
    env.invoiceItems.push({ asset: { id: 'ast-1', assetCode: 'AST-001', name: 'Server' }, quantity: 1, unitPrice: 150000 });
    const rows = await svc.purchaseByAsset();
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    assert.strictEqual(r.purchaseCost, 5000000);
    assert.strictEqual(r.invoiceCost, 150000);
    assert.strictEqual(r.total, 5150000, 'total reconciles = purchase + related');
    assert.strictEqual(r.poLineCount, 1);
    assert.strictEqual(r.invoiceLineCount, 1);
  });

  await test('rows sorted by total desc; period filter respected on PO side', async () => {
    const { svc, env } = makeSvc();
    env.poItems.push({ assetId: 'ast-a', quantity: 1, unitPrice: 100, orderDate: thisMonth, asset: { id: 'ast-a', assetCode: 'A', name: 'A' } });
    env.poItems.push({ assetId: 'ast-b', quantity: 1, unitPrice: 900, orderDate: thisMonth, asset: { id: 'ast-b', assetCode: 'B', name: 'B' } });
    env.poItems.push({ assetId: 'ast-old', quantity: 1, unitPrice: 99999, orderDate: lastMonth, asset: { id: 'ast-old', assetCode: 'OLD', name: 'OLD' } });
    const fromStr = thisMonth.toISOString();
    const rows = await svc.purchaseByAsset(fromStr, undefined);
    assert.deepStrictEqual(rows.map((r: any) => r.assetId), ['ast-b', 'ast-a'], 'sorted desc, last-month excluded');
  });

  console.log('\n== §W5 vendor performance ==');

  await test('lateness = avg max(0, received − promised); reject rate from GRN lines', async () => {
    const { svc, env } = makeSvc();
    const promised = new Date(now.getTime() - 10 * DAY);
    env.seedPo({
      supplier: { id: 'sup-1', name: 'ABC' }, expectedDelivery: promised,
      items: [{ quantity: 10, unitPrice: 1000 }],
      goodsReceipts: [
        { receivedAt: new Date(promised.getTime() + 2 * DAY), items: [{ orderedQty: 10, rejectedQty: 2 }] },
        { receivedAt: promised, items: [{ orderedQty: 0, rejectedQty: 0 }] }, // on time
      ],
    });
    // early delivery must NOT produce negative days
    env.seedPo({
      supplier: { id: 'sup-1', name: 'ABC' }, expectedDelivery: promised,
      items: [{ quantity: 1, unitPrice: 500 }],
      goodsReceipts: [{ receivedAt: new Date(promised.getTime() - 5 * DAY), items: [{ orderedQty: 5, rejectedQty: 0 }] }],
    });
    // no promise date → avgDaysLate null
    env.seedPo({
      supplier: { id: 'sup-2', name: 'XYZ' }, expectedDelivery: null,
      items: [{ quantity: 1, unitPrice: 10 }], goodsReceipts: [],
    });
    const rows = await svc.vendorPerformance();
    const abc = rows.find((r: any) => r.supplierId === 'sup-1');
    const xyz = rows.find((r: any) => r.supplierId === 'sup-2');
    assert.strictEqual(abc.poCount, 2);
    assert.strictEqual(abc.poValue, 10 * 1000 + 500);
    assert.strictEqual(abc.grnCount, 3, '2 GRNs on the first PO + 1 on the early-delivery PO');
    assert.strictEqual(abc.avgDaysLate, 0.67, 'early/on-time deliveries count as 0 — round2(2/3)');
    assert.strictEqual(abc.rejectRatePercent, Math.round((2 / 15) * 10000) / 100, '2 rejected of 15 ordered');
    assert.strictEqual(xyz.avgDaysLate, null, 'no promise date → not measurable');
    assert.strictEqual(xyz.rejectRatePercent, 0);
    assert.strictEqual(rows[0].supplierId, 'sup-1', 'sorted by PO value desc');
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
