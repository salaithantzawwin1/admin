/**
 * R7 (§9) — per-account monthly budget + PR-submit validation hook.
 *
 * REAL BudgetService with a spy Prisma:
 *  - set(): upsert semantics + validation (month 1..12, non-negative amount).
 *  - spendFor(): real-spend rollup from APPROVED/POSTED invoice lines only.
 *  - checkRequestSubmission(): estimated totals per account compared with the
 *    remaining monthly budget — exceeded accounts block the PR submission;
 *    unbudgeted accounts/months are NOT enforced by design (§9 first pass).
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/budget.test.ts
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

/** Spy quota store keyed by (account, year, month). */
function makePrisma(opts: { budgets?: Record<string, number>; invoiceLines?: { accountId: string; quantity: number; unitPrice: number; invoice: { status: string; invoiceDate: Date } }[] } = {}) {
  const invoices: any[] = [];
  const budgets = new Map(Object.entries(opts.budgets ?? {}));
  const prisma = {
    upserts: [] as { key: string; amount: number }[],
    account: {
      findUnique: async ({ where }: any) => (where.id === 'acc-1' ? { id: 'acc-1', name: 'Consumables' } : null),
    },
    monthlyBudget: {
      upsert: async ({ where, create }: any) => {
        const key = `${where.accountId_year_month.accountId}:${where.accountId_year_month.year}:${where.accountId_year_month.month}`;
        prisma.upserts.push({ key, amount: create.amount });
        if (budgets.has(key)) budgets.set(key, create.amount);
        else budgets.set(key, create.amount);
        return { id: `b-${key}`, amount: create.amount, accountId: where.accountId_year_month.accountId, year: where.accountId_year_month.year, month: where.accountId_year_month.month, account: { id: 'acc-1', name: 'Consumables' } };
      },
      findUnique: async ({ where }: any) => {
        const k = where.accountId_year_month;
        const key = `${k.accountId}:${k.year}:${k.month}`;
        if (!budgets.has(key)) return null;
        return { id: `b-${key}`, accountId: k.accountId, year: k.year, month: k.month, amount: budgets.get(key), account: { name: 'Consumables' } };
      },
      delete: async () => ({ ok: true }),
      findMany: async () => [],
      findFirst: async () => null,
    },
    invoiceItem: {
      findMany: async ({ where }: any) => {
        const from = where?.invoice?.invoiceDate?.gte?.getTime() ?? 0;
        const lt = where?.invoice?.invoiceDate?.lt?.getTime() ?? Infinity;
        const statuses = where?.invoice?.status?.in ?? ['APPROVED', 'POSTED'];
        return (opts.invoiceLines ?? []).filter(
          (l) => statuses.includes(l.invoice.status) && l.invoice.invoiceDate.getTime() >= from && l.invoice.invoiceDate.getTime() < lt,
        );
      },
    },
    purchaseRequest: {
      findUnique: async ({ where }: any) =>
        where.requestId === 'req-budget'
          ? {
              id: 'pr-1',
              items: [
                { accountId: 'acc-1', quantity: 10, estimatedUnitPrice: 5000 },
                { accountId: 'acc-1', quantity: 2, estimatedUnitPrice: 2500 },
                { accountId: null, quantity: 99, estimatedUnitPrice: 99999 }, // no account → not enforced
              ],
            }
          : null,
    },
  };
  return { prisma, invoices, budgets };
}

const { BudgetService } = require('../src/budget/budget.service');
const audit = { log: async () => undefined };

function makeSvc(opts: any) {
  const spy = makePrisma(opts);
  return { svc: new BudgetService(spy.prisma as any, audit as any), spy };
}

const YEAR = 2026;
const OCT = 10;

async function main() {
  console.log('\n== §9 budget validation hook ==');

  await test('suspended: PR over remaining monthly budget is blocked with account detail', async () => {
    const { svc } = makeSvc({
      budgets: { [`acc-1:${YEAR}:${OCT}`]: 50000 },
      invoiceLines: [
        { accountId: 'acc-1', quantity: 1, unitPrice: 20000, invoice: { status: 'POSTED', invoiceDate: new Date(Date.UTC(YEAR, 9, 2)) } },
        { accountId: 'acc-1', quantity: 1, unitPrice: 999, invoice: { status: 'DRAFT', invoiceDate: new Date(Date.UTC(YEAR, 9, 3)) } }, // not counted
      ],
    });
    const verdict = await svc.checkRequestSubmission('req-budget');
    assert.ok(verdict, 'exceeding PR must return a verdict');
    // estimated 10*5000 + 2*2500 = 55000; spent (POSTED only) = 20000 → remaining 30000
    assert.strictEqual(verdict.blocked.length, 1);
    assert.strictEqual(verdict.blocked[0].estimated, 55000);
    assert.strictEqual(verdict.blocked[0].alreadySpent, 20000);
    assert.strictEqual(verdict.blocked[0].remaining, 30000);
    assert.strictEqual(verdict.blocked[0].account, 'Consumables');
  });

  await test('pass: PR within remaining budget gets no verdict', async () => {
    const { svc } = makeSvc({
      budgets: { [`acc-1:${YEAR}:${OCT}`]: 100000 },
      invoiceLines: [{ accountId: 'acc-1', quantity: 1, unitPrice: 20000, invoice: { status: 'POSTED', invoiceDate: new Date(Date.UTC(YEAR, 9, 2)) } }],
    });
    const verdict = await svc.checkRequestSubmission('req-budget');
    assert.strictEqual(verdict, undefined);
  });

  await test('pass-by-design: account without a budget row is not enforced (§9 first pass)', async () => {
    const { svc } = makeSvc({ budgets: {}, invoiceLines: [] });
    const verdict = await svc.checkRequestSubmission('req-budget');
    assert.strictEqual(verdict, undefined);
  });

  await test('non-PR requests are a no-op for the hook', async () => {
    const { svc } = makeSvc({});
    const verdict = await svc.checkRequestSubmission('req-something-else');
    assert.strictEqual(verdict, undefined);
  });

  console.log('\n== budget CRUD ==');

  await test('set: month/month bounds validated', async () => {
    const { svc } = makeSvc({});
    await assert.rejects(() => svc.set({ accountId: 'acc-1', year: YEAR, month: 13, amount: 1 } as any), /Month must be 1..12/);
    await assert.rejects(() => svc.set({ accountId: 'acc-1', year: 1899, month: 1, amount: 1 } as any), /Year/);
    await assert.rejects(() => svc.set({ accountId: 'acc-1', year: YEAR, month: 1, amount: -5 } as any), /non-negative/);
    await assert.rejects(() => svc.set({ accountId: 'acc-x', year: YEAR, month: 1, amount: 1 } as any), /Account not found/);
  });

  await test('set: upserts into (account, year, month)', async () => {
    const { svc, spy } = makeSvc({});
    await svc.set({ accountId: 'acc-1', year: YEAR, month: OCT, amount: 12345 }, ACTOR);
    await svc.set({ accountId: 'acc-1', year: YEAR, month: OCT, amount: 77777 }, ACTOR);
    assert.strictEqual(spy.prisma.upserts.length, 2);
    assert.strictEqual(spy.prisma.upserts[1].amount, 77777);
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
