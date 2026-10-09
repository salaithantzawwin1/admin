/**
 * Procurement Phase 3 (design §15–20, R5) — Purchase Order + GRN contract.
 *
 * REAL PurchaseOrdersService with a spy Prisma + REAL inventory engine path:
 *  - Control 1 (§35): creating a PO from a PR whose document is not APPROVED
 *    must throw (no approval, no PO); APPROVED PR passes.
 *  - §16 status machine: illegal transitions throw; close only when fully
 *    received.
 *  - GRN receiving: accepted+rejected must equal received; over-receiving
 *    across multiple GRNs throws (partial delivery §19 up to ordered qty);
 *    accepted consumable lines post PURCHASE stock IN via the inventory
 *    engine (balance incremented, ledger entry written with GRN/PO reference);
 *    asset/service lines (no itemId) post nothing.
 *  - PO status auto-advances PARTIALLY_RECEIVED → FULLY_RECEIVED.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/purchase-orders.test.ts
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

const ACTOR = { userId: 'u-1', username: 'purchaser' };

/** Spy prisma covering the PO + GRN paths (including the raw row lock the engine uses). */
function makePrisma(opts: any = {}) {
  const state = {
    po: opts.po ?? null,
    poItems: opts.poItems ?? [],
    priorGrnAccepted: opts.priorGrnAccepted ?? [], // groupBy rows
    stockTx: [] as any[],
    balances: opts.balances ?? ({} as Record<string, number>),
    prismaOps: [] as any[],
    grnCreated: null as any,
  };
  const prisma: any = {
    supplier: { findUnique: async () => (opts.supplier ?? { id: 'sup-1', name: 'Yangon Office Supplies', isActive: true }) },
    purchaseRequest: {
      findUnique: async () => opts.pr ?? null,
    },
    purchaseOrder: {
      findUnique: async () => (state.po ? { ...state.po, items: state.poItems } : null),
      create: async (a: any) => {
        state.prismaOps.push(['po.create', a.data]);
        return { id: 'po-1', poNumber: a.data.poNumber, status: a.data.status ?? 'DRAFT', ...a.data };
      },
      update: async (a: any) => {
        state.prismaOps.push(['po.update', a.data]);
        state.po = { ...state.po, ...a.data };
        return state.po;
      },
    },
    purchaseOrderItem: {
      findMany: async () => state.poItems,
      aggregate: async () => ({ _sum: { quantity: state.poItems.reduce((s: number, i: any) => s + i.quantity, 0) } }),
    },
    goodsReceiptItem: {
      // live accumulation: prior GRNs (pre-seeded) + whatever this test's GRN create writes
      groupBy: async () => {
        const acc = new Map<string, number>(state.priorGrnAccepted.map((r: any) => [r.poItemId, r._sum.acceptedQty ?? 0]));
        for (const gi of state.grnItems ?? []) acc.set(gi.poItemId, (acc.get(gi.poItemId) ?? 0) + gi.acceptedQty);
        return [...acc.entries()].map(([poItemId, acceptedQty]) => ({ poItemId, _sum: { acceptedQty } }));
      },
      aggregate: async () => ({
        _sum: {
          acceptedQty: [...state.priorGrnAccepted.map((r: any) => r._sum.acceptedQty ?? 0), ...(state.grnItems ?? []).map((g: any) => g.acceptedQty)].reduce((s: number, q: number) => s + q, 0),
        },
      }),
    },
    goodsReceipt: {
      create: async (a: any) => {
        state.grnCreated = { id: 'grn-1', grnNumber: a.data.grnNumber, ...a.data };
        state.grnItems = (state.grnItems ?? []).concat(a.data.items?.create ?? []);
        return { id: 'grn-1', grnNumber: a.data.grnNumber, ...a.data, items: a.data.items?.create ?? [] };
      },
    },
    stockTransaction: {
      create: async (a: any) => {
        state.stockTx.push(a.data);
        return a.data;
      },
    },
    inventoryItem: {
      update: async (a: any) => {
        // the engine sets balance: newBalance (absolute), lastUnitPrice alongside
        if (a.data.balance && typeof a.data.balance === 'object' && 'increment' in a.data.balance) {
          state.balances[a.where.id] = (state.balances[a.where.id] ?? 0) + a.data.balance.increment;
        } else if (typeof a.data.balance === 'number') {
          state.balances[a.where.id] = a.data.balance;
        }
        state.prismaOps.push(['item.update', a.data]);
        return a.data;
      },
    },
    auditLog: { create: async () => ({}), log: async () => ({}) },
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn)),
    $queryRaw: async (strings: any, ...params: any[]) => {
      // the engine's FOR UPDATE row lock — the query interpolates the itemId.
      // Prisma sql`` object: { strings: [...], values: [...] } in arg 0;
      // plain tagged template: values as trailing args.
      const vals: any[] = strings && Array.isArray(strings.values) ? strings.values : params;
      const id = (Array.isArray(vals) ? vals : [vals]).find((p) => typeof p === 'string') as string;
      return [{ id, balance: state.balances[id] ?? 0 }];
    },
    __state: state,
  };
  return prisma;
}

function makeService(prisma: any) {
  const { PurchaseOrdersService } = require('../src/procurement/purchase-orders.service');
  const { InventoryService } = require('../src/inventory/inventory.service');
  // Real inventory engine over the spy prisma (applyTransaction path)
  const inventory = new InventoryService(prisma, { log: async () => ({}) } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return new PurchaseOrdersService(
    prisma,
    { log: async () => ({}) } as any,
    { next: async (p: string) => `${p}-202610-0001` } as any,
    inventory,
  );
}

async function main() {
  console.log('\n-- Purchase Order + GRN (Procurement Phase 3, design §15–20) --');

  await test('Control 1: PO from a PENDING_APPROVAL PR throws — no approval, no PO', async () => {
    const prisma = makePrisma({ pr: { id: 'pr-1', request: { status: 'PENDING_APPROVAL', docNumber: 'PR-202610-0001' } } });
    const svc = makeService(prisma);
    await assert.rejects(
      () => svc.create({ purchaseRequestId: 'req-1', supplierId: 'sup-1', items: [{ description: 'A4 paper', quantity: 10, unitPrice: 8000 }] }, ACTOR),
      /no approval, no PO/i,
    );
  });

  await test('Control 1: PO from an APPROVED PR is created as DRAFT with PO- number', async () => {
    const prisma = makePrisma({ pr: { id: 'pr-1', request: { status: 'APPROVED', docNumber: 'PR-202610-0001' } } });
    const svc = makeService(prisma);
    const po = await svc.create({ purchaseRequestId: 'req-1', supplierId: 'sup-1', items: [{ description: 'A4 paper', quantity: 10, unitPrice: 8000 }] }, ACTOR);
    assert.strictEqual(po.status, 'DRAFT');
    assert.ok(po.poNumber.startsWith('PO-'), 'PO number must use the PO- prefix');
  });

  await test('§16 machine: cannot receive against a DRAFT PO (Control 2), GRN needs SENT_TO_VENDOR', async () => {
    const prisma = makePrisma({
      po: { id: 'po-1', poNumber: 'PO-202610-0001', status: 'DRAFT', supplierId: 'sup-1' },
      poItems: [{ id: 'poi-1', description: 'A4 paper', quantity: 100, unitPrice: 8000, inventoryItemId: 'itm-1' }],
    });
    const svc = makeService(prisma);
    await assert.rejects(
      () => svc.createGrn('po-1', { items: [{ poItemId: 'poi-1', receivedQty: 40, acceptedQty: 40 }] }, ACTOR),
      /sent to the vendor/i,
    );
  });

  await test('GRN line math: accepted + rejected must equal received', async () => {
    const prisma = makePrisma({
      po: { id: 'po-1', poNumber: 'PO-202610-0001', status: 'SENT_TO_VENDOR', supplierId: 'sup-1' },
      poItems: [{ id: 'poi-1', description: 'A4 paper', quantity: 100, unitPrice: 8000, inventoryItemId: 'itm-1' }],
    });
    const svc = makeService(prisma);
    await assert.rejects(
      () => svc.createGrn('po-1', { items: [{ poItemId: 'poi-1', receivedQty: 40, acceptedQty: 38, rejectedQty: 1 }] }, ACTOR),
      /must equal received/i,
    );
  });

  await test('partial delivery §19: first GRN of 40 posts stock IN, PO → PARTIALLY_RECEIVED', async () => {
    const prisma = makePrisma({
      po: { id: 'po-1', poNumber: 'PO-202610-0001', status: 'SENT_TO_VENDOR', supplierId: 'sup-1' },
      poItems: [{ id: 'poi-1', description: 'A4 paper', quantity: 100, unitPrice: 8000, inventoryItemId: 'itm-1' }],
      balances: { 'itm-1': 12 },
    });
    const svc = makeService(prisma);
    const res = await svc.createGrn('po-1', { items: [{ poItemId: 'poi-1', receivedQty: 42, acceptedQty: 40, rejectedQty: 2, condition: 'wet damage' }] }, ACTOR);
    assert.strictEqual(res.poStatus, 'PARTIALLY_RECEIVED');
    assert.strictEqual(prisma.__state.balances['itm-1'], 52, 'inventory engine must add accepted qty (12 → 52)');
    const tx = prisma.__state.stockTx[0];
    assert.ok(tx, 'a StockTransaction ledger entry must be written');
    assert.strictEqual(tx.quantity, 40);
    assert.strictEqual(tx.type, 'PURCHASE');
    assert.strictEqual(tx.balanceAfter, 52, 'ledger balanceAfter must reflect the real balance');
    assert.ok(String(tx.reference).includes('GRN-202610-0001') && String(tx.reference).includes('PO-202610-0001'), 'ledger reference must carry GRN + PO numbers');
    assert.strictEqual(Number(tx.unitPrice), 8000, 'ledger must carry the PO unit price for spending reports');
  });

  await test('over-receiving guard: 40 accepted + GRN of 70 more against ordered 100 throws', async () => {
    const prisma = makePrisma({
      po: { id: 'po-1', poNumber: 'PO-202610-0001', status: 'PARTIALLY_RECEIVED', supplierId: 'sup-1' },
      poItems: [{ id: 'poi-1', description: 'A4 paper', quantity: 100, unitPrice: 8000, inventoryItemId: 'itm-1' }],
      priorGrnAccepted: [{ poItemId: 'poi-1', _sum: { acceptedQty: 40 } }],
    });
    const svc = makeService(prisma);
    await assert.rejects(
      () => svc.createGrn('po-1', { items: [{ poItemId: 'poi-1', receivedQty: 70, acceptedQty: 70 }] }, ACTOR),
      /exceed the ordered quantity/i,
    );
  });

  await test('full delivery: second GRN of the remaining 60 → FULLY_RECEIVED, balance updated', async () => {
    const prisma = makePrisma({
      po: { id: 'po-1', poNumber: 'PO-202610-0001', status: 'PARTIALLY_RECEIVED', supplierId: 'sup-1' },
      poItems: [{ id: 'poi-1', description: 'A4 paper', quantity: 100, unitPrice: 8000, inventoryItemId: 'itm-1' }],
      priorGrnAccepted: [{ poItemId: 'poi-1', _sum: { acceptedQty: 40 } }],
      balances: { 'itm-1': 52 },
    });
    const svc = makeService(prisma);
    const res = await svc.createGrn('po-1', { items: [{ poItemId: 'poi-1', receivedQty: 60, acceptedQty: 60 }] }, ACTOR);
    assert.strictEqual(res.poStatus, 'FULLY_RECEIVED');
    assert.strictEqual(prisma.__state.balances['itm-1'], 112);
  });

  await test('asset/service line (no inventoryItemId) posts NO stock but still records the GRN', async () => {
    const prisma = makePrisma({
      po: { id: 'po-1', poNumber: 'PO-202610-0001', status: 'SENT_TO_VENDOR', supplierId: 'sup-1' },
      poItems: [{ id: 'poi-1', description: 'Aircon maintenance service', quantity: 1, unitPrice: 250000, inventoryItemId: null }],
    });
    const svc = makeService(prisma);
    const res = await svc.createGrn('po-1', { items: [{ poItemId: 'poi-1', receivedQty: 1, acceptedQty: 1 }] }, ACTOR);
    assert.strictEqual(res.poStatus, 'FULLY_RECEIVED');
    assert.strictEqual(prisma.__state.stockTx.length, 0, 'no ledger entry for a service line');
  });

  await test('§16 machine: a FULLY_RECEIVED PO whose aggregate is somehow short cannot close (defense in depth)', async () => {
    const prisma = makePrisma({
      po: { id: 'po-1', poNumber: 'PO-202610-0001', status: 'FULLY_RECEIVED', supplierId: 'sup-1' },
      poItems: [{ id: 'poi-1', description: 'A4 paper', quantity: 100, unitPrice: 8000, inventoryItemId: 'itm-1' }],
      priorGrnAccepted: [{ poItemId: 'poi-1', _sum: { acceptedQty: 40 } }], // data anomaly
    });
    const svc = makeService(prisma);
    await assert.rejects(() => svc.transition('po-1', 'close', ACTOR), /before every line is fully received/i);
  });

  await test('§16 machine: a FULLY_RECEIVED PO with complete receipts CAN close', async () => {
    const prisma = makePrisma({
      po: { id: 'po-1', poNumber: 'PO-202610-0001', status: 'FULLY_RECEIVED', supplierId: 'sup-1' },
      poItems: [{ id: 'poi-1', description: 'A4 paper', quantity: 100, unitPrice: 8000, inventoryItemId: 'itm-1' }],
      priorGrnAccepted: [{ poItemId: 'poi-1', _sum: { acceptedQty: 100 } }],
    });
    const svc = makeService(prisma);
    const closed = await svc.transition('po-1', 'close', ACTOR);
    assert.strictEqual(closed.status, 'CLOSED');
    assert.ok(closed.closedAt instanceof Date, 'closedAt stamped');
  });

  await test('§16 machine: DRAFT → APPROVED ok, then SENT_TO_VENDOR; illegal DRAFT → SENT_TO_VENDOR throws', async () => {
    const prisma = makePrisma({ po: { id: 'po-1', poNumber: 'PO-202610-0001', status: 'DRAFT', supplierId: 'sup-1' } });
    const svc = makeService(prisma);
    await assert.rejects(() => svc.transition('po-1', 'send', ACTOR), /Cannot send a PO in status DRAFT/);
    const approved = await svc.transition('po-1', 'approve', ACTOR);
    assert.strictEqual(approved.status, 'APPROVED');
    const sent = await svc.transition('po-1', 'send', ACTOR);
    assert.strictEqual(sent.status, 'SENT_TO_VENDOR');
    assert.ok(sent.sentToVendorAt instanceof Date, 'sentToVendorAt stamped');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
