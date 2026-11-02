/**
 * §"Administration Spend" — one entry for money that leaves the office.
 *
 * REAL SpendingService with a spy Prisma, so the rules are exercised rather than
 * described:
 *  - one submission writes the petty cash EXPENSE, the asset cost row and the
 *    service log together (the gap this form exists to close);
 *  - a service log on its own carries no cost, because the money is already on
 *    the asset — the ledger must not count it twice;
 *  - stock taken from the store is usage, not payment: an amount alongside it is
 *    refused, and the CONSUMABLE row uses the item's last purchase price;
 *  - an unknown asset or an empty entry fails before anything is written.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/spending.test.ts
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
  const assets = new Map<string, any>([
    ['a-1', { id: 'a-1', assetCode: 'AST-PRI-2611-0001', name: 'Printer — 2nd floor' }],
  ]);
  const accounts = new Map<string, any>([['acc-1', { id: 'acc-1', name: 'Office supplies' }]]);
  const vendors = new Map<string, any>([['v-1', { id: 'v-1', name: 'Smart Print Co' }]]);
  const items = new Map<string, any>([
    ['i-1', { id: 'i-1', code: 'ITM-0007', name: 'Toner 85A', unit: 'pcs', balance: 5, lastUnitPrice: 20000 }],
    ['i-2', { id: 'i-2', code: 'ITM-0008', name: 'Cleaning kit', unit: 'set', balance: 2, lastUnitPrice: null }],
  ]);
  const pettyCash: any[] = [];
  const costs: any[] = [];
  const records: any[] = [];
  const stockTx: any[] = [];
  const audits: any[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;

  const prisma: any = {
    asset: { findUnique: async ({ where }: any) => assets.get(where.id) ?? null },
    account: { findUnique: async ({ where }: any) => accounts.get(where.id) ?? null },
    supplier: { findUnique: async ({ where }: any) => vendors.get(where.id) ?? null },
    pettyCashTransaction: {
      create: async ({ data }: any) => {
        const row = { id: nextId('pc'), ...data };
        pettyCash.push(row);
        return row;
      },
    },
    assetCost: {
      create: async ({ data }: any) => {
        const row = { id: nextId('cost'), ...data };
        costs.push(row);
        return row;
      },
    },
    maintenanceRecord: {
      create: async ({ data }: any) => {
        const row = { id: nextId('mr'), ...data };
        records.push(row);
        return row;
      },
    },
    inventoryItem: {
      update: async ({ where, data }: any) => {
        const item = items.get(where.id);
        Object.assign(item, data);
        return item;
      },
    },
    stockTransaction: {
      create: async ({ data }: any) => {
        const row = { id: nextId('tx'), ...data };
        stockTx.push(row);
        return row;
      },
    },
    // the service opens ONE transaction; the spy runs the callback inline
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(prisma),
    // FOR UPDATE ... the spy answers with the requested item
    $queryRaw: async (_strings: any, ...values: any[]) => {
      const item = items.get(values[0]);
      return item ? [{ ...item }] : [];
    },
  };

  const numbering: any = {
    next: async (prefix: string, when?: Date, digits: 2 | 4 = 4) => {
      const y = (when ?? new Date()).getUTCFullYear();
      const m = String((when ?? new Date()).getUTCMonth() + 1).padStart(2, '0');
      const stamp = digits === 2 ? `${String(y).slice(-2)}${m}` : `${y}${m}`;
      return `${prefix}-${stamp}-0001`;
    },
  };
  const audit: any = { log: async (entry: any) => { audits.push(entry); } };

  return { prisma, numbering, audit, items, pettyCash, costs, records, stockTx, audits };
}

function svc(env: ReturnType<typeof makeEnv>) {
  // ctor: prisma, audit, numbering
  return new SpendingService(env.prisma, env.audit, env.numbering);
}

const SpendingService = require('../src/spending/spending.service').SpendingService;

(async () => {
  console.log('\n== administration spend: one entry (§"paid but not recorded") ==');

  await test('petty cash + asset cost + service log are written by one submission', async () => {
    const env = makeEnv();
    const out = await svc(env).create({
      date: '2026-11-02',
      description: 'Toner drum replacement',
      amount: 45000,
      payee: 'Smart Print Co',
      accountId: 'acc-1',
      supplierId: 'v-1',
      paidFrom: 'PETTY_CASH',
      assetId: 'a-1',
      costKind: 'SERVICE',
      maintenance: {
        type: 'CORRECTIVE',
        problem: 'Print quality degraded',
        workDone: 'Replaced drum unit',
        nextDueDate: '2026-12-02',
      },
    }, ACTOR);

    assert.strictEqual(env.pettyCash.length, 1, 'one petty cash expense');
    assert.ok(String(env.pettyCash[0].code).startsWith('PC-'), 'PC number');
    assert.strictEqual(env.pettyCash[0].type, 'EXPENSE');
    assert.strictEqual(Number(env.pettyCash[0].amount), 45000);

    assert.strictEqual(env.costs.length, 1, 'one asset cost row');
    assert.strictEqual(env.costs[0].kind, 'SERVICE');
    assert.strictEqual(Number(env.costs[0].amount), 45000);
    assert.strictEqual(env.costs[0].sourceType, 'PETTY_CASH');
    assert.strictEqual(env.costs[0].sourceId, env.pettyCash[0].id, 'ledger points at the payment');

    assert.strictEqual(env.records.length, 1, 'one service record');
    assert.ok(String(env.records[0].code).startsWith('MRC-'), 'MRC number');
    assert.strictEqual(env.records[0].assetId, 'a-1');
    assert.strictEqual(Number(env.records[0].costParts), 0, 'the money is on the asset, not repeated');
    assert.strictEqual(Number(env.records[0].costLabor), 0);
    assert.strictEqual(env.records[0].nextDueDate.toISOString().slice(0, 10), '2026-12-02');

    assert.strictEqual(env.audits.length, 1, 'one audit entry');
    assert.strictEqual(env.audits[0].action, 'SPEND_ENTRY_CREATED');
    assert.strictEqual(out.total, 45000);
  });

  await test('money with no asset still reaches the petty cash ledger', async () => {
    const env = makeEnv();
    await svc(env).create({ amount: 12000, description: 'Water for the pantry', paidFrom: 'PETTY_CASH' }, ACTOR);
    assert.strictEqual(env.pettyCash.length, 1);
    assert.strictEqual(env.costs.length, 0, 'no asset → nothing to attribute');
  });

  await test('stock from the store records usage at the last purchase price, no money', async () => {
    const env = makeEnv();
    await svc(env).create({
      date: '2026-11-02',
      assetId: 'a-1',
      description: 'Toner swap',
      stockLines: [{ itemId: 'i-1', quantity: 2 }],
    }, ACTOR);

    assert.strictEqual(env.pettyCash.length, 0, 'no cash left the office');
    assert.strictEqual(env.items.get('i-1').balance, 3, 'balance drops by the quantity used');
    assert.strictEqual(env.stockTx.length, 1);
    assert.strictEqual(env.stockTx[0].type, 'ISSUE');
    assert.strictEqual(env.stockTx[0].quantity, -2);
    assert.strictEqual(env.stockTx[0].purpose, 'ASSET_USE');
    assert.strictEqual(env.stockTx[0].assetId, 'a-1');
    assert.strictEqual(env.costs.length, 1, 'one CONSUMABLE row');
    assert.strictEqual(env.costs[0].kind, 'CONSUMABLE');
    assert.strictEqual(Number(env.costs[0].amount), 40000, '2 × 20,000');
    assert.strictEqual(env.costs[0].sourceType, 'STOCK_ISSUE');
  });

  await test('an item with no purchase price is logged as usage, with no invented money', async () => {
    const env = makeEnv();
    await svc(env).create({ assetId: 'a-1', stockLines: [{ itemId: 'i-2', quantity: 1 }] }, ACTOR);
    assert.strictEqual(env.stockTx.length, 1, 'the usage is recorded');
    assert.strictEqual(env.costs.length, 0, 'and no kyat are invented');
  });

  await test('an amount alongside stock is refused as double counting', async () => {
    const env = makeEnv();
    let msg = '';
    await svc(env).create({ amount: 40000, assetId: 'a-1', stockLines: [{ itemId: 'i-1', quantity: 2 }] }, ACTOR)
      .then(() => { throw new Error('should have been refused'); })
      .catch((e: any) => { msg = e.message; });
    assert.ok(/without an amount/i.test(msg), `message explains it: ${msg}`);
    assert.strictEqual(env.pettyCash.length + env.costs.length + env.stockTx.length, 0, 'nothing written');
  });

  await test('an empty entry and an unknown asset are refused before anything is written', async () => {
    const env = makeEnv();
    await svc(env).create({}, ACTOR).then(
      () => { throw new Error('empty entry allowed'); },
      () => undefined,
    );
    await svc(env).create({ amount: 1000, assetId: 'nope' }, ACTOR).then(
      () => { throw new Error('unknown asset allowed'); },
      (e: any) => assert.ok(/Unknown asset/.test(e.message)),
    );
    assert.strictEqual(env.pettyCash.length + env.costs.length, 0);
  });

  await test('insufficient stock stops the entry instead of driving the balance negative', async () => {
    const env = makeEnv();
    await svc(env).create({ assetId: 'a-1', stockLines: [{ itemId: 'i-1', quantity: 9 }] }, ACTOR).then(
      () => { throw new Error('over-issue allowed'); },
      (e: any) => assert.ok(/Insufficient stock/.test(e.message), e.message),
    );
    assert.strictEqual(env.items.get('i-1').balance, 5, 'balance untouched');
    assert.strictEqual(env.stockTx.length, 0);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.error(f));
    process.exit(1);
  }
})();
