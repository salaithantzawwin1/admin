/**
 * v2 P1-1/P1-2 follow-up — petty-cash ↔ invoice link, supplier guard, picker.
 *
 * REAL PettyCashService with a spy Prisma:
 *  - linkInvoice: refuses an expense paid to a different supplier (the payment
 *    row would otherwise state something untrue), accepts a matching payee or a
 *    matching supplierId, writes the payment + rolls the invoice up.
 *  - openBills: the server-side *Invoice paid* picker — open, unpaid bills only,
 *    and no 100-row page cap (the old screen-side picker read page 1).
 *  - remove: a linked expense takes its payment with it, both audited, reason kept.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/petty-cash-link.test.ts
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

const ACTOR = { userId: 'u-1', username: 'admin1' };

function makeEnv() {
  const invoices = new Map<string, any>();
  const expenses = new Map<string, any>();
  const payments = new Map<string, any>();
  const audits: any[] = [];
  let seq = 0;

  const suppliers: Record<string, { id: string; name: string }> = {
    'sup-1': { id: 'sup-1', name: 'ABC Trading' },
    'sup-2': { id: 'sup-2', name: 'Stationery Shop' },
  };

  function seedInvoice(id: string, opts: { status?: string; total?: number; paid?: number; supplierId?: string; date?: string } = {}) {
    const supplierId = opts.supplierId ?? 'sup-1';
    const inv = {
      id,
      invoiceNumber: `INV-202611-${id}`,
      status: opts.status ?? 'POSTED',
      total: opts.total ?? 500000,
      paidAmount: opts.paid ?? 0,
      paymentStatus: opts.paid ? 'PARTIALLY_PAID' : 'UNPAID',
      invoiceDate: new Date(opts.date ?? '2026-11-10'),
      supplierId,
      supplier: suppliers[supplierId],
    };
    invoices.set(id, inv);
    return inv;
  }

  function seedExpense(id: string, opts: { payee?: string; supplierId?: string; amount?: number } = {}) {
    const row = {
      id,
      code: `PC-202611-${id}`,
      type: 'EXPENSE',
      amount: opts.amount ?? 100000,
      date: new Date('2026-11-12'),
      payee: opts.payee ?? null,
      supplierId: opts.supplierId ?? null,
      invoiceId: null,
      description: 'paid at the counter',
    };
    expenses.set(id, row);
    return row;
  }

  async function syncRollup(tx: any, invoiceId: string) {
    const rows = [...tx._payments.values()].filter((p: any) => p.invoiceId === invoiceId);
    const paid = rows.reduce((s: number, p: any) => s + Number(p.amount), 0);
    const inv = tx._invoices.get(invoiceId);
    inv.paidAmount = paid;
    inv.paymentStatus = paid <= 0 ? 'UNPAID' : paid >= Number(inv.total) - 0.01 ? 'PAID' : 'PARTIALLY_PAID';
    return inv;
  }

  const store: any = {
    _payments: payments,
    _invoices: invoices,
    invoice: {
      findUnique: async ({ where }: any) => invoices.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const inv = invoices.get(where.id);
        if (!inv) throw new Error('Invoice not found');
        return inv;
      },
      findMany: async ({ where, take }: any) => {
        let list = [...invoices.values()];
        if (where?.status?.notIn) list = list.filter((i) => !where.status.notIn.includes(i.status));
        if (where?.supplierId) list = list.filter((i) => i.supplierId === where.supplierId);
        list.sort((a, b) => b.invoiceDate.getTime() - a.invoiceDate.getTime() || b.invoiceNumber.localeCompare(a.invoiceNumber));
        return list.slice(0, take ?? 100000);
      },
      update: async ({ where, data }: any) => {
        const inv = invoices.get(where.id);
        Object.assign(inv, data);
        return inv;
      },
    },
    pettyCashTransaction: {
      findUnique: async ({ where }: any) => {
        const row = expenses.get(where.id);
        if (!row) return null;
        return {
          ...row,
          payment: row.invoiceId ? [...payments.values()].find((p) => p.pettyCashTransactionId === row.id) ?? null : null,
          invoice: row.invoiceId ? invoices.get(row.invoiceId) ?? null : null,
        };
      },
      update: async ({ where, data }: any) => {
        const row = expenses.get(where.id);
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: any) => {
        const row = expenses.get(where.id);
        expenses.delete(where.id);
        return row;
      },
    },
    payment: {
      create: async ({ data }: any) => {
        const row = { id: `pay-${++seq}`, createdAt: new Date(), ...data };
        payments.set(row.id, row);
        return row;
      },
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
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn(store) : Promise.all(fn)),
  };

  const audit = { log: async (e: any) => { audits.push(e); } };
  const numbering = { next: async (prefix: string) => `${prefix}-202611-${String(7000 + ++seq).slice(1)}` };
  return { prisma: store, audit, numbering, invoices, expenses, payments, audits, seedInvoice, seedExpense };
}

const { PettyCashService } = require('../src/pettycash/pettycash.service');

function makeSvc() {
  const env = makeEnv();
  const svc = new PettyCashService(env.prisma, env.audit, env.numbering);
  return { svc, env };
}

async function main() {
  console.log('\n== linkInvoice — the payee must be the bill\'s supplier ==');

  await test('an expense paid to another shop is refused (400, nothing written)', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('16', { supplierId: 'sup-1', total: 500000 });
    env.seedExpense('1', { payee: 'Stationery Shop', supplierId: 'sup-2', amount: 25000 });
    await assert.rejects(
      () => svc.linkInvoice('1', '16', ACTOR),
      /paid to Stationery Shop, but INV-202611-16 is from ABC Trading/,
    );
    assert.strictEqual(env.payments.size, 0, 'a refused link writes no payment');
    assert.strictEqual(env.expenses.get('1').invoiceId, null, 'and leaves the expense unlinked');
  });

  await test('a free-text payee matching the supplier name links (case/space insensitive)', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('16', { supplierId: 'sup-1', total: 500000 });
    env.seedExpense('1', { payee: '  abc trading ', amount: 25000 });
    const res = await svc.linkInvoice('1', '16', ACTOR);
    assert.strictEqual(res.success, true);
    const pay = [...env.payments.values()][0];
    assert.strictEqual(pay.fundingSource, 'PETTY_CASH');
    assert.strictEqual(Number(env.invoices.get('16').paidAmount), 25000);
    assert.strictEqual(env.invoices.get('16').paymentStatus, 'PARTIALLY_PAID');
    assert.strictEqual(env.audits.at(-1).action, 'PETTY_CASH_LINKED_TO_INVOICE');
  });

  await test('a stored supplierId wins over the free-text payee', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('16', { supplierId: 'sup-1', total: 500000 });
    // payee text is a person's name, but the row is tagged to the right supplier
    env.seedExpense('1', { payee: 'Ko Aung (driver)', supplierId: 'sup-1', amount: 1000 });
    await svc.linkInvoice('1', '16', ACTOR);
    assert.strictEqual(env.payments.size, 1);
  });

  await test('an expense with no payee and no supplier cannot be matched', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('16', { supplierId: 'sup-1' });
    env.seedExpense('1', { payee: null, amount: 1000 });
    await assert.rejects(() => svc.linkInvoice('1', '16', ACTOR), /paid to \(no payee\)/);
  });

  console.log('\n== openBills — the invoice picker ==');

  await test('offers every open, unpaid bill (no 100-row page cap)', async () => {
    const { svc, env } = makeSvc();
    for (let i = 1; i <= 120; i++) env.seedInvoice(`n${i}`, { total: 1000 });
    const res = await svc.openBills({});
    assert.strictEqual(res.items.length, 120, 'the 101st+ bill must still be offered');
    assert.ok(res.items.every((b: any) => b.balance === 1000));
  });

  await test('drops cancelled, rejected and settled bills; balance is total − paid', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('ok', { total: 5000, paid: 2000 });
    env.seedInvoice('cancelled', { status: 'CANCELLED' });
    env.seedInvoice('rejected', { status: 'REJECTED' });
    env.seedInvoice('settled', { total: 5000, paid: 5000 });
    const res = await svc.openBills({});
    assert.deepStrictEqual(res.items.map((b: any) => b.id), ['ok']);
    assert.strictEqual(res.items[0].balance, 3000);
    assert.strictEqual(res.items[0].supplier.name, 'ABC Trading');
  });

  console.log('\n== remove — a linked expense takes its payment ==');

  await test('deleting the linked expense removes the payment, re-rolls, audits both with the reason', async () => {
    const { svc, env } = makeSvc();
    env.seedInvoice('16', { supplierId: 'sup-1', total: 500000 });
    env.seedExpense('1', { payee: 'ABC Trading', amount: 500000 });
    await svc.linkInvoice('1', '16', ACTOR);
    assert.strictEqual(env.invoices.get('16').paymentStatus, 'PAID');

    const res = await svc.remove('1', ACTOR, 'wrong bill — this was the March delivery');
    assert.strictEqual(res.paymentRemoved.startsWith('PY-'), true);
    assert.strictEqual(env.payments.size, 0);
    assert.strictEqual(env.invoices.get('16').paymentStatus, 'UNPAID');
    const deleted = env.audits.filter((a) => a.action === 'PETTY_CASH_DELETED' || a.action === 'PAYMENT_DELETED');
    assert.strictEqual(deleted.length, 2, 'both rows are audited');
    assert.ok(deleted.every((a) => a.newValue.reason === 'wrong bill — this was the March delivery'));
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
