/**
 * Phase 3 — issuing stock to a fixed asset (§14/§24).
 *
 * REAL InventoryService with a spy Prisma:
 *  - issueToAsset: ISSUE row with assetId + purpose ASSET_USE, balance decremented,
 *    CONSUMABLE row in the asset cost ledger at the item's last price.
 *  - no known price → usage recorded, no invented money.
 *  - a maintenance job stamps purpose MAINTENANCE and the MRC number.
 *  - insufficient stock / unknown asset / bad quantity are refused before any write.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/inventory-asset-issue.test.ts
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

const ACTOR = { userId: 'u-1', username: 'storekeeper' };

function makeEnv(opts: { balance?: number; unitPrice?: string | null } = {}) {
  const items = new Map<string, any>([
    ['it-1', {
      id: 'it-1', code: 'ITM-0001', name: 'Toner cartridge', unit: 'pcs',
      balance: opts.balance ?? 10,
      lastUnitPrice: opts.unitPrice === undefined ? '20000' : opts.unitPrice,
    }],
  ]);
  const assets = new Map<string, any>([
    ['a-1', { id: 'a-1', assetCode: 'AST-PRI-2611-0003', name: 'Konica Printer' }],
  ]);
  const records = new Map<string, any>([
    ['mr-1', { id: 'mr-1', code: 'MRC-2611-0002', assetId: 'a-1' }],
  ]);
  const stockTxns: any[] = [];
  const costs: any[] = [];
  const audits: any[] = [];
  let tseq = 0;

  const inventoryItem = {
    findUnique: async ({ where }: any) => {
      const row = items.get(where.id);
      return row ? { ...row } : null;
    },
    update: async ({ where, data }: any) => {
      const row = items.get(where.id);
      Object.assign(row, data);
      return { ...row };
    },
  };

  const stockTransaction = {
    create: async ({ data }: any) => {
      const row = { id: `tx-${++tseq}`, createdAt: new Date(), ...data };
      stockTxns.push(row);
      return { ...row };
    },
  };

  const tx = { $queryRaw: null as any, inventoryItem, stockTransaction };
  // the service reads the locked row through a tagged template
  tx.$queryRaw = async (_strings: TemplateStringsArray, ...values: any[]) => {
    const row = items.get(values[0]);
    return row ? [{ id: row.id, balance: row.balance }] : [];
  };

  const prisma: any = {
    inventoryItem,
    stockTransaction,
    asset: { findUnique: async ({ where }: any) => assets.get(where.id) ?? null },
    maintenanceRecord: { findUnique: async ({ where }: any) => records.get(where.id) ?? null },
    assetCost: {
      create: async ({ data }: any) => {
        const row = { id: `ac-${costs.length + 1}`, createdAt: new Date(), ...data };
        costs.push(row);
        return row;
      },
    },
    $transaction: async (fn: any) => fn(tx),
  };

  const audit = { log: async (e: any) => { audits.push(e); } };
  return { prisma, audit, items, assets, stockTxns, costs, audits };
}

const { InventoryService } = require('../src/inventory/inventory.service');

function makeSvc(opts?: { balance?: number; unitPrice?: string | null }) {
  const env = makeEnv(opts);
  // suppliers / workflow / numbering are not touched by issueToAsset
  // ctor: prisma, numbering, notifications, audit, workflow, permissions
  const svc = new InventoryService(env.prisma, {} as any, {} as any, env.audit, {} as any, {} as any);
  return { svc, env };
}

async function main() {
  console.log('\n== issue stock to an asset (§14/§24) ==');

  await test('the issue hits the stock ledger and the asset cost ledger', async () => {
    const { svc, env } = makeSvc();
    const res = await svc.issueToAsset({ itemId: 'it-1', assetId: 'a-1', quantity: 2, note: 'Toner swap' }, ACTOR);

    assert.strictEqual(env.items.get('it-1').balance, 8, 'two units leave the store');
    assert.strictEqual(env.stockTxns.length, 1);
    assert.strictEqual(env.stockTxns[0].type, 'ISSUE');
    assert.strictEqual(env.stockTxns[0].quantity, -2);
    assert.strictEqual(env.stockTxns[0].balanceAfter, 8);
    assert.strictEqual(env.stockTxns[0].assetId, 'a-1');
    assert.strictEqual(env.stockTxns[0].purpose, 'ASSET_USE');
    assert.strictEqual(env.stockTxns[0].reference, 'Toner swap');

    assert.strictEqual(env.costs.length, 1);
    assert.strictEqual(env.costs[0].kind, 'CONSUMABLE');
    assert.strictEqual(Number(env.costs[0].amount), 40000, '2 × 20,000');
    assert.strictEqual(env.costs[0].quantity, 2);
    assert.strictEqual(env.costs[0].sourceType, 'STOCK_ISSUE');
    assert.strictEqual(env.costs[0].sourceId, 'tx-1');
    assert.strictEqual(env.audits.at(-1).action, 'INVENTORY_ISSUED_TO_ASSET');
    assert.strictEqual(res.unitPrice, 20000);
  });

  await test('an item without a price still records the usage, with no invented money', async () => {
    const { svc, env } = makeSvc({ unitPrice: null });
    await svc.issueToAsset({ itemId: 'it-1', assetId: 'a-1', quantity: 1 }, ACTOR);
    assert.strictEqual(env.stockTxns.length, 1);
    assert.strictEqual(env.costs.length, 0);
  });

  await test('a part used by a maintenance job carries the MRC number and purpose', async () => {
    const { svc, env } = makeSvc();
    await svc.issueToAsset({ itemId: 'it-1', assetId: 'a-1', quantity: 1, maintenanceRecordId: 'mr-1' }, ACTOR);
    assert.strictEqual(env.stockTxns[0].purpose, 'MAINTENANCE');
    assert.match(env.stockTxns[0].reference, /^MRC-2611-0002 — /);
  });

  await test('insufficient stock, an unknown asset or a bad quantity writes nothing', async () => {
    const { svc, env } = makeSvc({ balance: 1 });
    await assert.rejects(
      () => svc.issueToAsset({ itemId: 'it-1', assetId: 'a-1', quantity: 5 }, ACTOR),
      /Insufficient stock/,
    );
    await assert.rejects(
      () => svc.issueToAsset({ itemId: 'it-1', assetId: 'nope', quantity: 1 }, ACTOR),
      /Unknown asset/,
    );
    await assert.rejects(
      () => svc.issueToAsset({ itemId: 'it-1', assetId: 'a-1', quantity: 0 }, ACTOR),
      /positive whole number/,
    );
    assert.strictEqual(env.stockTxns.length, 0);
    assert.strictEqual(env.costs.length, 0);
    assert.strictEqual(env.items.get('it-1').balance, 1);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

void main();
