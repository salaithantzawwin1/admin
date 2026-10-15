/**
 * Account master-data CRUD (Settings → Accounts tab).
 *
 * REAL ProcurementService with a spy Prisma:
 *  - createAccount(): unique-code + category validation, defaults, audit entry.
 *  - updateAccount(): partial update, code clear ('') / keep (undefined).
 *  - deleteAccount(): hard delete only when unreferenced; otherwise 409 with
 *    "deactivate instead" (audit-integrity rule shared with user deletion).
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/accounts.test.ts
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

/** Spy Prisma: accounts in a Map, categories seeded, usage counts injectable. */
function makePrisma() {
  const accounts = new Map<string, any>([
    ['acc-1', { id: 'acc-1', code: 'ACC-OS-001', name: 'Office Supplies', categoryId: null, active: true, category: null }],
    ['acc-used', { id: 'acc-used', code: 'ACC-USED', name: 'Used Account', categoryId: null, active: true, category: null }],
  ]);
  const categories = new Map<string, any>([['cat-1', { id: 'cat-1', name: 'Expense' }]]);
  const counts = new Map<string, any>([
    ['acc-used', { prItems: 0, poItems: 3, invoiceItems: 0, monthlyBudgets: 0 }],
  ]);
  const spy = {
    created: [] as any[],
    updates: [] as { where: any; data: any }[],
    deleted: [] as string[],
    prisma: {
      account: {
        findUnique: async ({ where, include }: any) => {
          const row = where.id
            ? accounts.get(where.id) ?? null
            : [...accounts.values()].find((a) => a.code === where.code) ?? null;
          if (row && include?._count) return { ...row, _count: counts.get(row.id) ?? { prItems: 0, poItems: 0, invoiceItems: 0, monthlyBudgets: 0 } };
          return row;
        },
        create: async ({ data }: any) => {
          const row: any = { id: `acc-new-${spy.created.length + 1}`, category: data.categoryId ? categories.get(data.categoryId) ?? null : null, ...data };
          spy.created.push(row);
          accounts.set(row.id, row);
          return row;
        },
        update: async ({ where, data }: any) => {
          const prev = accounts.get(where.id);
          if (!prev) throw new Error('Record not found');
          const row = {
            ...prev,
            ...data,
            category: data.categoryId !== undefined ? (data.categoryId ? categories.get(data.categoryId) ?? null : null) : prev.category,
          };
          spy.updates.push({ where, data });
          accounts.set(where.id, row);
          return row;
        },
        delete: async ({ where }: any) => {
          spy.deleted.push(where.id);
          accounts.delete(where.id);
          return { id: where.id };
        },
      },
      accountCategory: {
        findUnique: async ({ where }: any) => (where.id ? categories.get(where.id) ?? null : null),
        findMany: async () => [...categories.values()],
      },
    },
  };
  return { spy, accounts, categories };
}

const { ProcurementService } = require('../src/procurement/procurement.service');

function makeSvc() {
  const { spy, accounts, categories } = makePrisma();
  const auditEntries: any[] = [];
  const audit = { log: async (e: any) => { auditEntries.push(e); } };
  // numbering is unused by the account methods
  const svc = new ProcurementService(spy.prisma, audit, {} as any);
  return { svc, spy, auditEntries, accounts, categories };
}

async function main() {
  await test('create: trims name, blank code → null, defaults active=true, audits', async () => {
    const { svc, spy, auditEntries } = makeSvc();
    const row = await svc.createAccount({ code: '   ', name: '  Travel  ' }, ACTOR);
    assert.strictEqual(row.code, null);
    assert.strictEqual(row.name, 'Travel');
    assert.strictEqual(row.active, true);
    assert.strictEqual(auditEntries.length, 1);
    assert.strictEqual(auditEntries[0].action, 'ACCOUNT_CREATED');
    assert.strictEqual(spy.created.length, 1);
  });

  await test('create: duplicate code → 409', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.createAccount({ code: 'ACC-OS-001', name: 'Copycat' }, ACTOR), /already exists/);
  });

  await test('create: unknown category → 400', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.createAccount({ name: 'X', categoryId: 'nope' }, ACTOR), /Unknown account category/);
  });

  await test('update: partial (name only) keeps the code untouched', async () => {
    const { svc, accounts, auditEntries } = makeSvc();
    const row = await svc.updateAccount('acc-1', { name: 'Office Supplies & Stationery' }, ACTOR);
    assert.strictEqual(row.name, 'Office Supplies & Stationery');
    assert.strictEqual(accounts.get('acc-1').code, 'ACC-OS-001');
    assert.strictEqual(auditEntries[0].action, 'ACCOUNT_UPDATED');
    assert.strictEqual(auditEntries[0].oldValue.name, 'Office Supplies');
  });

  await test('update: code "" clears the code', async () => {
    const { svc, accounts } = makeSvc();
    const row = await svc.updateAccount('acc-1', { code: '' }, ACTOR);
    assert.strictEqual(row.code, null);
    assert.strictEqual(accounts.get('acc-1').code, null);
  });

  await test('update: setting a taken code → 409', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.updateAccount('acc-1', { code: 'ACC-USED' }, ACTOR), /already exists/);
  });

  await test('update: missing account → 404', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.updateAccount('nope', { name: 'X' }, ACTOR), /Account not found/);
  });

  await test('update: active=false (deactivate) persists + audits', async () => {
    const { svc, accounts, auditEntries } = makeSvc();
    const row = await svc.updateAccount('acc-1', { active: false }, ACTOR);
    assert.strictEqual(row.active, false);
    assert.strictEqual(accounts.get('acc-1').active, false);
    assert.strictEqual(auditEntries[0].newValue.active, false);
  });

  await test('delete: unreferenced account is removed + audited', async () => {
    const { svc, spy, auditEntries } = makeSvc();
    const res = await svc.deleteAccount('acc-1', ACTOR);
    assert.deepStrictEqual(res, { id: 'acc-1', deleted: true });
    assert.deepStrictEqual(spy.deleted, ['acc-1']);
    assert.strictEqual(auditEntries[0].action, 'ACCOUNT_DELETED');
  });

  await test('delete: referenced account → 409 "deactivate instead", nothing deleted', async () => {
    const { svc, spy } = makeSvc();
    await assert.rejects(() => svc.deleteAccount('acc-used', ACTOR), /PO line.*deactivate it instead/);
    assert.deepStrictEqual(spy.deleted, []);
  });

  await test('delete: missing account → 404', async () => {
    const { svc } = makeSvc();
    await assert.rejects(() => svc.deleteAccount('nope', ACTOR), /Account not found/);
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
