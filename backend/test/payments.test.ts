/**
 * GLG Procurement ERP W1 (2026-10-20) — vendor payments (design §26, Plan §9).
 *
 * REAL PaymentsService with a spy Prisma:
 *  - record: PY-… numbering, PAYMENT_RECORDED audit, rollup sync
 *    (UNPAID → PARTIALLY_PAID → PAID), over-payment rejected, lifecycle gate
 *    (only APPROVED/POSTED accept money), validation.
 *  - remove: audited WARNING deletion + rollup resync (no edit of money rows).
 *  - payables: balance > 0 only, overdue-first ordering, totals.
 *  - list: status filter validated.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/payments.test.ts
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

const ACTOR = { userId: 'u-1', username: 'finance1' };

function makeEnv() {
  const invoices = new Map<string, any>();
  const payments = new Map<string, any>();
  const audits: any[] = [];
  let seq = 0;

  // in-memory invoice factory: status + total drive every guard
  function seedInvoice(id: string, opts: { status?: string; total?: number; dueDate?: Date } = {}) {
    invoices.set(id, {
      id,
      invoiceNumber: `INV-202610-${id}`,
      status: opts.status ?? 'APPROVED',
      total: opts.total ?? 100000,
      paidAmount: 0,
      paymentStatus: 'UNPAID',
      dueDate: opts.dueDate ?? null,
      invoiceDate: new Date('2026-10-01'),
      supplierId: 'sup-1',
      supplierInvoiceNumber: `BILL-${id}`,
      supplier: { id: 'sup-1', name: 'ABC Trading' },
      purchaseOrder: { poNumber: 'PO-202610-0001' },
    });
    return invoices.get(id);
  }

  async function syncRollup(tx: any, invoiceId: string) {
    const rows = [...tx._payments.values()].filter((p: any) => p.invoiceId === invoiceId);
    const paid = rows.reduce((s: number, p: any) => s + Number(p.amount), 0);
    const inv = tx._invoices.get(invoiceId);
    inv.paidAmount = paid;
    inv.paymentStatus = paid <= 0 ? 'UNPAID' : paid >= Number(inv.total) - 0.01 ? 'PAID' : 'PARTIALLY_PAID';
    return inv;
  }

  const store = {
    _invoices: invoices,
    _payments: payments,
    payment: {
      create: async ({ data }: any) => {
        const row = { id: `pay-${++seq}`, createdAt: new Date(), ...data };
        payments.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: any) => {
        const row = payments.get(where.id) ?? null;
        return row ? { ...row, invoice: invoices.get(row.invoiceId) } : null;
      },
      findMany: async ({ where }: any) => {
        let list = [...payments.values()];
        if (where?.invoiceId) list = list.filter((p) => p.invoiceId === where.invoiceId);
        if (where?.date?.gte) list = list.filter((p) => p.date >= where.date.gte);
        if (where?.date?.lte) list = list.filter((p) => p.date <= where.date.lte);
        if (where?.invoice?.supplierId) list = list.filter((p) => invoices.get(p.invoiceId)?.supplierId === where.invoice.supplierId);
        if (where?.invoice?.paymentStatus) list = list.filter((p) => invoices.get(p.invoiceId)?.paymentStatus === where.invoice.paymentStatus);
        return list.map((p) => ({ ...p, invoice: invoices.get(p.invoiceId), createdBy: { username: 'finance1', fullName: 'Finance One' } }));
      },
      count: async ({ where }: any) => (await store.payment.findMany({ where })).length,
      delete: async ({ where }: any) => {
        const row = payments.get(where.id);
        payments.delete(where.id);
        return row;
      },
      aggregate: async ({ where }: any) => {
        const rows = [...payments.values()].filter((p) => p.invoiceId === where.invoiceId);
        return { _sum: { amount: rows.reduce((s, p) => s + Number(p.amount), 0) || null } };
      },
    },
    invoice: {
      findUnique: async ({ where }: any) => invoices.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const inv = invoices.get(where.id);
        if (!inv) throw new Error('Invoice not found');
        return inv;
      },
      findMany: async ({ where }: any) => {
        let list = [...invoices.values()];
        if (where?.status?.in) list = list.filter((i) => where.status.in.includes(i.status));
        if (where?.supplierId) list = list.filter((i) => i.supplierId === where.supplierId);
        return list;
      },
      update: async ({ where, data }: any) => {
        const inv = invoices.get(where.id);
        Object.assign(inv, data);
        return inv;
      },
    },
    // supports both interactive (fn) and batch (Promise[]) transaction forms
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn(store) : Promise.all(fn)),
  };

  const audit = { log: async (e: any) => { audits.push(e); } };
  const numbering = { next: async (prefix: string) => `${prefix}-202610-${String(9000 + ++seq).slice(1)}` };
  return { prisma: store, audit, numbering, invoices, payments, audits, seedInvoice };
}

const { PaymentsService } = require('../src/procurement/payments.service');

function makeSvc() {
  const env = makeEnv();
  const svc = new PaymentsService(env.prisma, env.numbering, env.audit);
  return { svc, env };
}

async function main() {
  console.log('\n== record (§26 lifecycle + rollup) ==');

  await test('payment gets PY-… number, defaults date, audits PAYMENT_RECORDED, rollup → PARTIALLY_PAID', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('inv-1', { total: 100000 });
    const row = await svc.record({ invoiceId: 'inv-1', amount: 40000, method: 'BANK_TRANSFER', reference: 'TXN-77' }, ACTOR);
    assert.ok(row.paymentNumber.startsWith('PY-'), `paymentNumber, got ${row.paymentNumber}`);
    assert.ok(row.date instanceof Date);
    assert.strictEqual(env.audits[0].action, 'PAYMENT_RECORDED');
    assert.strictEqual(env.audits[0].module, 'PROCUREMENT');
    assert.strictEqual(Number(env.audits[0].newValue.amount), 40000);
    const inv = env.invoices.get('inv-1');
    assert.strictEqual(Number(inv.paidAmount), 40000);
    assert.strictEqual(inv.paymentStatus, 'PARTIALLY_PAID');
  });

  await test('paying the rest flips the invoice to PAID', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('inv-1', { total: 100000 });
    await svc.record({ invoiceId: 'inv-1', amount: 60000, method: 'CASH' }, ACTOR);
    await svc.record({ invoiceId: 'inv-1', amount: 40000, method: 'CASH' }, ACTOR);
    const inv = env.invoices.get('inv-1');
    assert.strictEqual(Number(inv.paidAmount), 100000);
    assert.strictEqual(inv.paymentStatus, 'PAID');
  });

  await test('over-payment rejected: amount > remaining balance → 400', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('inv-1', { total: 100000 });
    await svc.record({ invoiceId: 'inv-1', amount: 80000, method: 'CASH' }, ACTOR);
    await assert.rejects(
      () => svc.record({ invoiceId: 'inv-1', amount: 20001, method: 'CASH' }, ACTOR),
      /exceeds the outstanding balance/,
    );
    await svc.record({ invoiceId: 'inv-1', amount: 20000, method: 'CASH' }, ACTOR); // exact rest is fine
  });

  await test('lifecycle gate: DRAFT/SUBMITTED/REJECTED/CANCELLED invoice → 409', async () => {
    const { svc, env } = makeSvc();
    for (const status of ['DRAFT', 'SUBMITTED', 'REJECTED', 'CANCELLED']) {
      env.seedInvoice(`inv-${status}`, { status });
      await assert.rejects(
        () => svc.record({ invoiceId: `inv-${status}`, amount: 10, method: 'CASH' }, ACTOR),
        /payments are recorded on APPROVED\/POSTED/,
      );
    }
    env.seedInvoice('inv-posted', { status: 'POSTED' });
    const row = await svc.record({ invoiceId: 'inv-posted', amount: 10, method: 'CASH' }, ACTOR);
    assert.ok(row.paymentNumber.startsWith('PY-'));
  });

  await test('validation: bad method / non-positive amount / unknown invoice → 400/404', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('inv-1');
    await assert.rejects(() => svc.record({ invoiceId: 'inv-1', amount: 10, method: 'BITCOIN' }, ACTOR), /BANK_TRANSFER/);
    await assert.rejects(() => svc.record({ invoiceId: 'inv-1', amount: 0, method: 'CASH' }, ACTOR), /positive/);
    await assert.rejects(() => svc.record({ invoiceId: 'inv-1', amount: -5, method: 'CASH' }, ACTOR), /positive/);
    await assert.rejects(() => svc.record({ invoiceId: 'nope', amount: 10, method: 'CASH' }, ACTOR), /not found/);
  });

  console.log('\n== delete (append-only money rows) ==');

  await test('remove deletes the row, audits WARNING, resyncs rollup back to UNPAID', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('inv-1', { total: 50000 });
    const pay = await svc.record({ invoiceId: 'inv-1', amount: 50000, method: 'CHEQUE', reference: 'CHQ-9' }, ACTOR);
    const res = await svc.remove(pay.id, ACTOR);
    assert.strictEqual(res.success, true);
    assert.strictEqual(env.payments.size, 0);
    const inv = env.invoices.get('inv-1');
    assert.strictEqual(Number(inv.paidAmount), 0);
    assert.strictEqual(inv.paymentStatus, 'UNPAID');
    const a = env.audits.at(-1);
    assert.strictEqual(a.action, 'PAYMENT_DELETED');
    assert.strictEqual(a.severity, 'WARNING');
    assert.strictEqual(a.oldValue.paymentNumber, pay.paymentNumber);
    await assert.rejects(() => svc.remove('missing', ACTOR), /not found/);
  });

  await test('delete one of two payments resyncs to PARTIALLY_PAID', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('inv-1', { total: 100000 });
    const p1 = await svc.record({ invoiceId: 'inv-1', amount: 50000, method: 'CASH' }, ACTOR);
    await svc.record({ invoiceId: 'inv-1', amount: 50000, method: 'CASH' }, ACTOR);
    assert.strictEqual(env.invoices.get('inv-1').paymentStatus, 'PAID');
    await svc.remove(p1.id, ACTOR);
    const inv = env.invoices.get('inv-1');
    assert.strictEqual(Number(inv.paidAmount), 50000);
    assert.strictEqual(inv.paymentStatus, 'PARTIALLY_PAID');
  });

  console.log('\n== payables (outstanding) ==');

  await test('lists only balance > 0; totals + overdue-first ordering', async () => {
    const { svc, env } = makeSvc();
    // a: fully paid → excluded; b: overdue partial; c: unpaid no due date; d: unpaid overdue
    env.seedInvoice('inv-a', { total: 10000 });
    await svc.record({ invoiceId: 'inv-a', amount: 10000, method: 'CASH' }, ACTOR);
    env.seedInvoice('inv-b', { total: 20000, dueDate: new Date(Date.now() - 5 * 86400000) });
    await svc.record({ invoiceId: 'inv-b', amount: 5000, method: 'CASH' }, ACTOR);
    env.seedInvoice('inv-c', { total: 30000 });
    env.seedInvoice('inv-d', { total: 40000, dueDate: new Date(Date.now() - 2 * 86400000) });

    const res = await svc.payables({});
    assert.strictEqual(res.count, 3);
    const ids = res.items.map((i: any) => i.id);
    assert.deepStrictEqual(ids, ['inv-b', 'inv-d', 'inv-c'], `overdue-first order, got ${ids}`);
    assert.ok(res.items.every((i: any) => i.balance > 0));
    const b = res.items.find((i: any) => i.id === 'inv-b');
    assert.strictEqual(b.daysOverdue, 5);
    assert.strictEqual(Number(res.totals.balance), 20000 - 5000 + 30000 + 40000);
  });

  console.log('\n== list ==');

  await test('register filter by invoice paymentStatus; invalid filter → 400', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('inv-1', { total: 10000 });
    await svc.record({ invoiceId: 'inv-1', amount: 10000, method: 'CASH' }, ACTOR);
    const paid = await svc.list({ page: 1, pageSize: 20, status: 'PAID' });
    assert.strictEqual(paid.total, 1);
    assert.strictEqual(paid.items[0].invoice.paymentStatus, 'PAID');
    await assert.rejects(() => svc.list({ page: 1, pageSize: 20, status: 'BOGUS' }), /Unknown payment status/);
  });

  console.log('\n== csv export ==');

  await test('header + escaped rows + totals line', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('inv-1', { total: 50000 });
    await svc.record({ invoiceId: 'inv-1', amount: 50000, method: 'CASH', reference: 'REF, with "comma"', note: 'Line one' }, ACTOR);
    const csv = await svc.csv({});
    const lines = csv.split('\n');
    assert.ok(lines[0].startsWith('Payment code,Date,Invoice,Supplier,Amount MMK'), `header, got: ${lines[0]}`);
    assert.ok(csv.includes('"REF, with ""comma"""'), 'comma+quote escaping');
    assert.ok(csv.includes('Line one'));
    assert.ok(csv.includes('AMOUNT=50000.00'), `totals line, got: ${lines.at(-1)}`);
  });

  await test('csv respects the from/to filter', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('inv-1', { total: 20000 });
    await svc.record({ invoiceId: 'inv-1', amount: 10000, method: 'CASH', date: '2026-01-05' }, ACTOR);
    await svc.record({ invoiceId: 'inv-1', amount: 10000, method: 'CASH', date: '2026-10-05' }, ACTOR);
    const csv = await svc.csv({ from: '2026-10-01', to: '2026-10-31' });
    assert.ok(csv.includes('2026-10-05'), 'october row included');
    assert.ok(!csv.includes('2026-01-05'), 'january row filtered out');
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
