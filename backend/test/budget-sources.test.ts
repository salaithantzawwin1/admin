/**
 * §9/§17 — the budget's "spent" must cover every way money leaves the office.
 *
 * Before this, only supplier invoices counted, so cash bought from the float and
 * stock paid for directly were invisible: a month could look 40% used while the
 * petty cash box was empty.
 *
 * REAL BudgetService with a spy Prisma:
 *  - invoice lines (APPROVED/POSTED) still count, as before;
 *  - petty cash EXPENSE rows for the account/month now count;
 *  - stock PURCHASE rows count when they carry an account — except the ones
 *    marked pettyCashId, because that expense already counted them;
 *  - the breakdown adds up to the total, so a spend figure can be explained;
 *  - the request-submission guard sees the same (larger) spend.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/budget-sources.test.ts
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

const ACTOR = { userId: 'u-9', username: 'admin1' };
const YEAR = 2026;
const MONTH = 11;

function makeEnv(opts: {
  invoiceSpend?: number;
  pettyCash?: number[];
  stock?: { quantity: number; unitPrice: number | null; pettyCashId: string | null }[];
} = {}) {
  const calls: string[] = [];
  const prisma: any = {
    calls,
    invoiceItem: {
      findMany: async () => {
        calls.push('invoice');
        const total = opts.invoiceSpend ?? 0;
        return total ? [{ quantity: 1, unitPrice: total }] : [];
      },
    },
    pettyCashTransaction: {
      findMany: async ({ where }: any) => {
        calls.push('pettyCash');
        assert.strictEqual(where.type, 'EXPENSE', 'only money going out counts');
        return (opts.pettyCash ?? []).map((amount) => ({ amount }));
      },
    },
    stockTransaction: {
      findMany: async ({ where }: any) => {
        calls.push('stock');
        assert.strictEqual(where.pettyCashId, null, 'float-paid purchases are excluded');
        return opts.stock ?? [];
      },
    },
  };
  const { BudgetService } = require('../src/budget/budget.service');
  const audit = { log: async () => ({}) };
  return { prisma, svc: new BudgetService(prisma, audit as any) };
}

(async () => {
  console.log('\n== budget spend sources (§9/§17) ==');

  await test('invoice spend still counts, exactly as before', async () => {
    const env = makeEnv({ invoiceSpend: 120000 });
    assert.strictEqual(await env.svc.spendFor('acc-1', YEAR, MONTH), 120000);
  });

  await test('petty cash expenses count for the account and month', async () => {
    const env = makeEnv({ pettyCash: [15000, 2500.5] });
    assert.strictEqual(await env.svc.spendFor('acc-1', YEAR, MONTH), 17500.5);
  });

  await test('stock bought against the account counts; float-paid stock does not', async () => {
    const env = makeEnv({
      stock: [
        { quantity: 5, unitPrice: 20000, pettyCashId: null },
        { quantity: 2, unitPrice: 20000, pettyCashId: null },
      ],
    });
    // 5×20,000 + 2×20,000 — and the query itself excluded pettyCashId rows
    assert.strictEqual(await env.svc.spendFor('acc-1', YEAR, MONTH), 140000);
  });

  await test('a purchase with no recorded price adds usage but no invented money', async () => {
    const env = makeEnv({ stock: [{ quantity: 3, unitPrice: null, pettyCashId: null }] });
    assert.strictEqual(await env.svc.spendFor('acc-1', YEAR, MONTH), 0);
  });

  await test('the breakdown adds up to the total, so the figure can be explained', async () => {
    const env = makeEnv({
      invoiceSpend: 100000,
      pettyCash: [30000],
      stock: [{ quantity: 2, unitPrice: 5000, pettyCashId: null }],
    });
    const b = await env.svc.spendBreakdown('acc-1', YEAR, MONTH);
    assert.deepStrictEqual(b, {
      invoice: 100000,
      pettyCash: 30000,
      stock: 10000,
      total: 140000,
    });
  });

  await test('checkTotals blocks on the full spend, including float and stock', async () => {
    const env = makeEnv({ invoiceSpend: 0, pettyCash: [9000], stock: [{ quantity: 1, unitPrice: 1000, pettyCashId: null }] });
    env.prisma.monthlyBudget = {
      findUnique: async () => ({ id: 'b-1', amount: 10000, account: { name: 'Consumables' } }),
    };
    const verdict = await env.svc.checkTotals(new Map([['acc-1', 500]]));
    assert.ok(verdict, 'over budget is blocked');
    assert.strictEqual(verdict.blocked[0].alreadySpent, 10000);
    assert.strictEqual(verdict.blocked[0].remaining, 0);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.error(f));
    process.exit(1);
  }
})();
