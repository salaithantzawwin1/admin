/**
 * Procurement visibility contract — supplier drill-down + approved PRs.
 *
 *  1. GET /suppliers/:id/history and /:id/contact-logs accept suppliers.read
 *     OR procurement.manage (the PO / bill screens drill into a supplier for a
 *     manager whose role has no suppliers.read).
 *  2. ProcurementService.list: procurement.read sees every PR; procurement.manage
 *     without it sees its own + every APPROVED PR; everyone else own-only.
 *  3. ProcurementService.byRequest mirrors that: an APPROVED PR not owned by the
 *     manager opens, a DRAFT one stays Forbidden.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/procurement-visibility.test.ts
 */
const assert = require('assert');
const { ForbiddenException } = require('@nestjs/common');

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

const { PERMISSIONS_KEY } = require('../src/auth/permissions.guard');
const { PERMISSIONS } = require('../src/auth/permissions');
const { SuppliersController } = require('../src/suppliers/suppliers.controller');
const { ProcurementService } = require('../src/procurement/procurement.service');

const ACTOR = { userId: 'u-1', username: 'admin1' };

function guardSets(handler: Function): string[][] {
  const meta = Reflect.getMetadata(PERMISSIONS_KEY, handler);
  return (meta ?? []).map((entry: unknown) => (Array.isArray(entry) ? entry : [entry]));
}

function accepts(sets: string[][], perm: string): boolean {
  return sets.some((set) => set.includes(perm));
}

/** Spy prisma: records the `where` handed to count/findMany for /requests. */
function makeListPrisma(rows: any[] = []) {
  const whereSeen: any[] = [];
  const prisma: any = {
    requestDocument: {
      count: async (args: any) => {
        whereSeen.push(args.where);
        return rows.length;
      },
      findMany: async () => rows,
      findUnique: async () => null,
    },
    purchaseRequest: { findUnique: async () => null },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return { prisma, whereSeen };
}

function makeSvc(prisma: any, workflow: any = { canView: async () => false }) {
  return new ProcurementService(prisma, { log: async () => {} } as never, {} as never, {} as never, {} as never, workflow as never);
}

async function main() {
  console.log('\n== supplier drill-down guards ==');

  await test('GET /suppliers/:id/history accepts suppliers.read or procurement.manage', () => {
    const sets = guardSets(SuppliersController.prototype.history);
    assert.ok(accepts(sets, PERMISSIONS.SUPPLIERS_READ), `missing suppliers.read: ${JSON.stringify(sets)}`);
    assert.ok(accepts(sets, PERMISSIONS.PROCUREMENT_MANAGE), `missing procurement.manage: ${JSON.stringify(sets)}`);
  });

  await test('GET /suppliers/:id/contact-logs accepts suppliers.read or procurement.manage', () => {
    const sets = guardSets(SuppliersController.prototype.contactLogs);
    assert.ok(accepts(sets, PERMISSIONS.SUPPLIERS_READ), `missing suppliers.read: ${JSON.stringify(sets)}`);
    assert.ok(accepts(sets, PERMISSIONS.PROCUREMENT_MANAGE), `missing procurement.manage: ${JSON.stringify(sets)}`);
  });

  await test('contact-log WRITE stays manage-only (no suppliers.read shortcut)', () => {
    const sets = guardSets(SuppliersController.prototype.createContactLog);
    assert.ok(!accepts(sets, PERMISSIONS.SUPPLIERS_READ), `write must not accept suppliers.read: ${JSON.stringify(sets)}`);
  });

  console.log('\n== /procurement/requests visibility ==');

  await test('procurement.read sees every PR (no requester filter)', async () => {
    const { prisma, whereSeen } = makeListPrisma();
    const svc = makeSvc(prisma);
    await svc.list({ page: 1, pageSize: 50, canReadAll: true, seeApprovedAll: true, actor: ACTOR });
    const where = whereSeen[0];
    assert.strictEqual(where.requesterId, undefined);
    assert.strictEqual(where.OR, undefined);
  });

  await test('manage-only sees own + every APPROVED PR', async () => {
    const { prisma, whereSeen } = makeListPrisma();
    const svc = makeSvc(prisma);
    await svc.list({ page: 1, pageSize: 50, canReadAll: false, seeApprovedAll: true, actor: ACTOR });
    const where = whereSeen[0];
    assert.deepStrictEqual(where.OR, [{ requesterId: 'u-1' }, { status: 'APPROVED' }]);
    assert.strictEqual(where.requesterId, undefined);
  });

  await test('a plain requester still sees own rows only', async () => {
    const { prisma, whereSeen } = makeListPrisma();
    const svc = makeSvc(prisma);
    await svc.list({ page: 1, pageSize: 50, canReadAll: false, actor: ACTOR });
    const where = whereSeen[0];
    assert.strictEqual(where.requesterId, 'u-1');
    assert.strictEqual(where.OR, undefined);
  });

  console.log('\n== PR detail mirrors the list ==');

  function detailPrisma(status: string) {
    return {
      requestDocument: {
        findUnique: async () => ({
          id: 'pr-1',
          docType: 'PURCHASE_REQUEST',
          status,
          requesterId: 'someone-else',
          requester: { id: 'someone-else', fullName: 'Other' },
          department: null,
        }),
      },
      purchaseRequest: { findUnique: async () => null },
    };
  }

  await test('manage-only opens an APPROVED PR it does not own', async () => {
    const svc = makeSvc(detailPrisma('APPROVED'));
    const res: any = await svc.byRequest('pr-1', { ...ACTOR, canReadAll: false, seeApprovedAll: true });
    assert.strictEqual(res.status, 'APPROVED');
  });

  await test('manage-only is still Forbidden on someone else\'s DRAFT', async () => {
    const svc = makeSvc(detailPrisma('DRAFT'));
    await assert.rejects(
      () => svc.byRequest('pr-1', { ...ACTOR, canReadAll: false, seeApprovedAll: true }),
      (e: Error) => e instanceof ForbiddenException,
    );
  });

  await test('procurement.read still opens any PR', async () => {
    const svc = makeSvc(detailPrisma('DRAFT'));
    const res: any = await svc.byRequest('pr-1', { ...ACTOR, canReadAll: true });
    assert.strictEqual(res.status, 'DRAFT');
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
