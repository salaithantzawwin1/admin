/**
 * Procurement Phase 4 (design §22–25, R6) — Invoice + three-way match contract.
 *
 * REAL InvoicesService with a spy Prisma:
 *  - Control 5 (§35): duplicate vendor bill (supplier + paper invoice number)
 *    rejected at create.
 *  - Control 3 (§35): submit requires a linked PO with at least one GRN;
 *    held otherwise.
 *  - Control 4 (§35): invoice total > PO total blocks approval-submit.
 *  - §23 three-way match: PO ordered qty + price vs GRN accepted qty vs
 *    invoice billed qty/price → MATCHED / PARTIAL_MATCH / MISMATCH / NO_MATCH.
 *  - §25 approval gate: only MATCHED / PARTIAL_MATCH invoices approve;
 *    MISMATCH routes to review (reject → resolve → redraft → resubmit).
 *  - Lifecycle: DRAFT→SUBMITTED→APPROVED→POSTED (+ REJECTED→DRAFT redraft).
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/invoices.test.ts
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

/** Minimal invoice shape returned by the spy create. */
function makeInvoiceRow(overrides: any = {}) {
  return {
    id: 'inv-1',
    invoiceNumber: 'INV-202610-0001',
    supplierInvoiceNumber: 'V-BILL-100',
    supplierId: 'sup-1',
    status: 'DRAFT',
    invoiceDate: new Date(),
    dueDate: null,
    purchaseOrderId: 'po-1',
    goodsReceiptId: null,
    subtotal: 500000,
    tax: 0,
    total: 500000,
    note: null,
    matchStatus: null,
    matchDetail: null,
    createdById: ACTOR.userId,
    ...overrides,
  };
}

/** Spy prisma recursing into the createWithStatus / transition paths. */
function makePrisma(opts: any = {}) {
  const state = {
    created: [] as any[],
    invoices: opts.invoices ?? ([] as any[]),
    suppliers: opts.suppliers ?? [{ id: 'sup-1', name: 'Yangon Office Supplies', isActive: true }],
    po: opts.po ?? null,
    grnCount: opts.grnCount ?? 0,
    updates: [] as any[],
  };

  const prisma: any = {
    supplier: { findUnique: async ({ where: { id } }: any) => state.suppliers.find((s: any) => s.id === id) ?? null },
    invoice: {
      findFirst: async ({ where }: any) => state.invoices.find((i: any) => i.supplierId === where.supplierId && i.supplierInvoiceNumber === where.supplierInvoiceNumber) ?? null,
      create: async (a: any) => {
        const row = makeInvoiceRow({ ...a.data, id: `inv-${state.created.length + 1}` });
        // created items are nested — flatten for state assertions
        row.items = a.data.items?.create ?? [];
        state.created.push(row);
        state.invoices.push(row);
        return row;
      },
      findUnique: async ({ where: { id } }: any) => state.invoices.find((i: any) => i.id === id) ?? null,
      count: async () => state.invoices.length,
      update: async (a: any) => {
        const row = state.invoices.find((i: any) => i.id === a.where.id);
        Object.assign(row, a.data);
        state.updates.push({ id: a.where.id, data: a.data });
        return row;
      },
    },
    purchaseOrder: {
      findUnique: async () => state.po,
    },
    goodsReceipt: {
      findUnique: async () => null,
      count: async () => state.grnCount,
    },
    auditLog: { create: async () => ({}), log: async () => ({}) },
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn)),
    __state: state,
  };
  // recomputeMatch calls findUnique with include on purchaseOrder — return po with items/goodsReceipts
  const baseFindUnique = prisma.invoice.findUnique;
  prisma.invoice.findUnique = async (args: any) => {
    const row = state.invoices.find((i: any) => i.id === args.where.id);
    if (!row) return null;
    if (args.include?.purchaseOrder) {
      return {
        ...row,
        purchaseOrder: row.purchaseOrderId && state.po ? { items: state.po.items ?? [], goodsReceipts: state.po.goodsReceipts ?? [] } : null,
        items: row.items ?? [],
      };
    }
    return row;
  };
  return prisma;
}

function makeService(prisma: any) {
  const { InvoicesService } = require('../src/procurement/invoices.service');
  return new InvoicesService(
    prisma,
    { next: async (p: string) => `${p}-202610-0001` } as any,
    { log: async () => ({}) } as any,
  );
}

const VALID_INVOICE = {
  supplierId: 'sup-1',
  supplierInvoiceNumber: 'V-BILL-100',
  invoiceDate: '2026-10-12',
  purchaseOrderId: 'po-1',
  items: [
    { description: 'A4 Paper', quantity: 10, unit: 'ream', unitPrice: 50000 },
  ],
};

const PO_FIXTURE = makePo();

/** PO with one line (10 @ 50,000) and one GRN accepting all 10. */
function makePo(overrides: any = {}) {
  return {
    id: 'po-1',
    poNumber: 'PO-202610-0001',
    supplierId: 'sup-1',
    status: 'FULLY_RECEIVED',
    items: [
      { id: 'po-item-1', description: 'A4 Paper', quantity: 10, unit: 'ream', unitPrice: 50000 },
    ],
    goodsReceipts: [
      { id: 'grn-1', grnNumber: 'GRN-202610-0001', items: [{ poItemId: 'po-item-1', acceptedQty: 10, rejectedQty: 0 }] },
    ],
    ...overrides,
  };
}

// ------------------------------------------------------------------ tests

(async () => {
  console.log('\n== invoices creation ==\n');

  await test('create: invoice persisted as DRAFT with numbering, items, subtotal, Control 5 unique-key data', async () => {
    const prisma = makePrisma({ po: PO_FIXTURE });
    const svc = makeService(prisma);
    const inv = await svc.create(VALID_INVOICE, ACTOR);
    assert.equal(inv.status, 'DRAFT');
    assert.match(inv.invoiceNumber, /^INV-/);
    assert.equal(inv.subtotal, 500000);
    assert.equal(inv.total, 500000);
    assert.equal(inv.supplierInvoiceNumber, 'V-BILL-100');
    assert.equal(prisma.__state.created[0].items.length, 1);
  });

  await test('Control 5: duplicate supplier + paper invoice number rejected', async () => {
    const prisma = makePrisma({ po: PO_FIXTURE, invoices: [makeInvoiceRow({ supplierId: 'sup-1', supplierInvoiceNumber: 'V-BILL-100', status: 'POSTED' })] });
    const svc = makeService(prisma);
    await assert.rejects(
      () => svc.create(VALID_INVOICE, ACTOR),
      (e: any) => /already has INV-/.test(e.message),
    );
  });

  await test('create: empty items and inactive supplier rejected', async () => {
    const prisma = makePrisma({ po: PO_FIXTURE });
    const svc = makeService(prisma);
    await assert.rejects(() => svc.create({ ...VALID_INVOICE, items: [] }, ACTOR), (e: any) => /At least one invoice line/.test(e.message));
    await assert.rejects(
      () => svc.create({ ...VALID_INVOICE, supplierId: 'sup-dead' }, ACTOR),
      (e: any) => {
        prisma.__state.suppliers = [{ id: 'sup-dead', name: 'Dead Supplier', isActive: false }];
        return /valid, active supplier/.test(e.message);
      },
    );
  });

  console.log('\n== three-way match (§23) ==\n');

  await test('MATCHED: invoice qty == GRN accepted == PO ordered, unit price equal', async () => {
    const prisma = makePrisma({ po: makePo(), grnCount: 1 });
    const svc = makeService(prisma);
    const inv = await svc.create(VALID_INVOICE, ACTOR);
    const matched = await svc.recomputeMatch(inv.id);
    assert.equal(matched.matchStatus, 'MATCHED');
    assert.equal(matched.matchDetail.lines[0].status, 'MATCHED');
  });

  await test('MISMATCH: invoice bills more than GRN-accepted (phantom delivery)', async () => {
    const po = makePo({ goodsReceipts: [{ id: 'grn-1', items: [{ poItemId: 'po-item-1', acceptedQty: 10, rejectedQty: 0 }] }] });
    const prisma = makePrisma({ po, grnCount: 1 });
    const svc = makeService(prisma);
    const inv = await svc.create({ ...VALID_INVOICE, items: [{ description: 'A4 Paper', quantity: 12, unit: 'ream', unitPrice: 50000 }] }, ACTOR);
    const matched = await svc.recomputeMatch(inv.id);
    assert.equal(matched.matchStatus, 'MISMATCH');
    assert.equal(matched.matchDetail.lines[0].billedBeyondReceived, true);
  });

  await test('under-billed invoice (7 of 10 received) is PARTIAL_MATCH, not MISMATCH', async () => {
    const prisma = makePrisma({ po: makePo(), grnCount: 1 });
    const svc = makeService(prisma);
    const inv = await svc.create({ ...VALID_INVOICE, items: [{ description: 'A4 Paper', quantity: 7, unit: 'ream', unitPrice: 50000 }] }, ACTOR);
    const matched = await svc.recomputeMatch(inv.id);
    assert.equal(matched.matchStatus, 'PARTIAL_MATCH');
  });

  await test('MISMATCH: invoice unit price ≠ PO price', async () => {
    const prisma = makePrisma({ po: makePo(), grnCount: 1 });
    const svc = makeService(prisma);
    const inv = await svc.create({ ...VALID_INVOICE, items: [{ description: 'A4 Paper', quantity: 10, unit: 'ream', unitPrice: 55000 }] }, ACTOR);
    const matched = await svc.recomputeMatch(inv.id);
    assert.equal(matched.matchStatus, 'MISMATCH');
    assert.equal(matched.matchDetail.lines[0].priceOk, false);
  });

  await test('PARTIAL_MATCH: GRN accepted < ordered, invoice billed the received amount', async () => {
    const po = makePo({
      goodsReceipts: [{ id: 'grn-1', items: [{ poItemId: 'po-item-1', acceptedQty: 4, rejectedQty: 0 }] }],
    });
    const prisma = makePrisma({ po, grnCount: 1 });
    const svc = makeService(prisma);
    const inv = await svc.create({ ...VALID_INVOICE, items: [{ description: 'A4 Paper', quantity: 4, unit: 'ream', unitPrice: 50000 }] }, ACTOR);
    const matched = await svc.recomputeMatch(inv.id);
    assert.equal(matched.matchStatus, 'PARTIAL_MATCH');
  });

  await test('NO_MATCH: no PO reference — service/direct bill passes through unmatched', async () => {
    const prisma = makePrisma({ po: PO_FIXTURE });
    const svc = makeService(prisma);
    const inv = await svc.create({ ...VALID_INVOICE, purchaseOrderId: undefined, supplierInvoiceNumber: 'V-BILL-200' }, ACTOR);
    const matched = await svc.recomputeMatch(inv.id);
    assert.equal(matched.matchStatus, 'NO_MATCH');
  });

  console.log('\n== lifecycle + controls ==\n');

  await test('Controls 3+4: submit passes on a PO with GRN and within PO amount', async () => {
    const prisma = makePrisma({ po: makePo(), grnCount: 1 });
    const svc = makeService(prisma);
    const inv = await svc.create(VALID_INVOICE, ACTOR);
    const submitted = await svc.transition(inv.id, 'submit', ACTOR);
    assert.equal(submitted.status, 'SUBMITTED');
    // submit recomputes the match — MATCHED for this data
    assert.equal(submitted.matchStatus, 'MATCHED');
  });

  await test('Control 3: submit without GRN on the linked PO is held', async () => {
    const prisma = makePrisma({ po: makePo(), grnCount: 0 });
    const svc = makeService(prisma);
    const inv = await svc.create(VALID_INVOICE, ACTOR);
    await assert.rejects(
      () => svc.transition(inv.id, 'submit', ACTOR),
      (e: any) => /No GRN on the linked PO/.test(e.message),
    );
  });

  await test('Control 4: invoice above PO total held at submit', async () => {
    const prisma = makePrisma({ po: makePo({ items: [{ id: 'i1', description: 'A4 Paper', quantity: 10, unitPrice: 40000 }] }), grnCount: 1 });
    const svc = makeService(prisma);
    const inv = await svc.create({ ...VALID_INVOICE, items: [{ description: 'A4 Paper', quantity: 10, unit: 'ream', unitPrice: 50000 }] }, ACTOR);
    assert.equal(inv.total, 500000);
    await assert.rejects(
      () => svc.transition(inv.id, 'submit', ACTOR),
      (e: any) => /exceeds PO amount/.test(e.message),
    );
  });

  await test('§25 gate: SUBMITTED + MISMATCH invoice cannot be approved', async () => {
    const prisma = makePrisma({ po: makePo(), grnCount: 1, invoices: [makeInvoiceRow({ status: 'SUBMITTED', matchStatus: 'MISMATCH', matchDetail: { lines: [] }, purchaseOrderId: 'po-1' })] });
    const svc = makeService(prisma);
    await assert.rejects(
      () => svc.transition('inv-1', 'approve', ACTOR),
      (e: any) => /match is MISMATCH/.test(e.message),
    );
  });

  await test('§25 gate: SUBMITTED + MATCHED invoice approves; POSTED only from APPROVED', async () => {
    const prisma = makePrisma({ invoices: [makeInvoiceRow({ status: 'SUBMITTED', matchStatus: 'MATCHED' })] });
    const svc = makeService(prisma);
    const approved = await svc.transition('inv-1', 'approve', ACTOR);
    assert.equal(approved.status, 'APPROVED');
    await assert.rejects(() => svc.transition('inv-1', 'submit', ACTOR), () => true); // APPROVED has no submit
    const posted = await svc.transition('inv-1', 'post', ACTOR);
    assert.equal(posted.status, 'POSTED');
  });

  await test('reject → redraft cycle: REJECTED returns to DRAFT for revision', async () => {
    const prisma = makePrisma({ invoices: [makeInvoiceRow({ status: 'SUBMITTED', matchStatus: 'MISMATCH' })] });
    const svc = makeService(prisma);
    const rejected = await svc.transition('inv-1', 'reject', ACTOR);
    assert.equal(rejected.status, 'REJECTED');
    const redrafted = await svc.transition('inv-1', 'redraft', ACTOR);
    assert.equal(redrafted.status, 'DRAFT');
  });

  await test('illegal transition: POSTED is terminal', async () => {
    const prisma = makePrisma({ invoices: [makeInvoiceRow({ status: 'POSTED' })] });
    const svc = makeService(prisma);
    await assert.rejects(
      () => svc.transition('inv-1', 'cancel', ACTOR),
      (e: any) => /Cannot cancel an invoice in status POSTED/.test(e.message),
    );
  });

  // summarize
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    failures.forEach((f) => console.error('  failed:', f));
    process.exit(1);
  }
  process.exit(0);
})();
