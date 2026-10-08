/**
 * Purchase Request (procurement P1) — contract between the web form, the
 * Supplier PO-draft bridge and ProcurementService.
 *
 * Layers covered (same spy-prisma harness as fleet-vehicle-creation.test.ts):
 *  1. DTO validation contract — plainToInstance()/validateSync() exactly like
 *     Nest's global ValidationPipe — runs the REAL CreatePurchaseRequestDto.
 *  2. Service behaviour — REAL ProcurementService with a mock Prisma:
 *     - create: title fallback to first item, items persisted with
 *       unit/price/account/asset mapping, estimated total in the description,
 *       audit logged, docType PURCHASE_REQUEST with a PR- doc number;
 *     - create rejections: empty items, zero/negative quantity, bad price;
 *     - createFromSupplierDraft: draft lines (item code/name/unit/unitPrice)
 *       map 1:1 onto PR items — the P1 replacement for the old
 *       "lines flattened into description text" bridge;
 *     - update: only DRAFT + owner; items replaced wholesale.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/procurement-pr.test.ts
 */
const assert = require('assert');

// ------------------------------------------------------------------ harness
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

function plainPayloadOf(plain: object) {
  const { plainToInstance } = require('class-transformer');
  const { validateSync } = require('class-validator');
  const { CreatePurchaseRequestDto } = require('../src/procurement/procurement.controller');
  const dto = plainToInstance(CreatePurchaseRequestDto, plain);
  const errors = validateSync(dto, { whitelist: true });
  return { dto, errors };
}

function validationMessages(plain: object): string[] {
  const { errors } = plainPayloadOf(plain);
  return errors.flatMap((e: any) => (e.constraints ? Object.values(e.constraints) : [])) as string[];
}

const ACTOR = { userId: 'u-1', username: 'tester' };

/** Minimal mock Prisma that records calls and returns deterministic data. */
function makePrisma(overrides: any = {}) {
  const calls: Record<string, any[]> = { requestCreate: [], prCreate: [], prUpdate: [], itemDelete: [], docUpdate: [] };
  const prisma: any = {
    employee: { findFirst: async () => ({ departmentId: 'dep-1' }) },
    account: { findFirst: async () => null, findUnique: async () => null, create: async (a: any) => a.data, update: async (a: any) => a.data },
    accountCategory: { upsert: async (a: any) => ({ id: 'cat-1', name: a.where.name }) },
    requestDocument: {
      create: async (a: any) => {
        calls.requestCreate.push(a.data);
        return { id: 'req-1', ...a.data, docNumber: a.data.docNumber };
      },
      findUnique: async (a: any) =>
        overrides.request ?? { id: a.where.id, docType: 'PURCHASE_REQUEST', requesterId: ACTOR.userId, status: 'DRAFT' },
      update: async (a: any) => {
        calls.docUpdate.push(a.data);
        return a.data;
      },
    },
    purchaseRequest: {
      create: async (a: any) => {
        calls.prCreate.push(a.data);
        return { id: 'pr-1', requestId: 'req-1', items: a.data.items?.create ?? [] };
      },
      findUnique: async (a: any) => overrides.pr ?? { id: 'pr-1', requestId: a.where.requestId ?? a.where.id },
      update: async (a: any) => {
        calls.prUpdate.push(a.data);
        return a.data;
      },
    },
    purchaseRequestItem: {
      deleteMany: async (a: any) => {
        calls.itemDelete.push(a.where);
        return { count: 0 };
      },
      count: async () => 3,
    },
    $transaction: async (ops: any[]) => Promise.all(ops.map((op: any) => (typeof op === 'function' ? op(prisma) : op))),
    __calls: calls,
  };
  return prisma;
}

function makeService(prisma: any) {
  const { ProcurementService } = require('../src/procurement/procurement.service');
  const noop = async () => undefined;
  return new ProcurementService(
    prisma,
    { log: noop } as any, // audit
    { next: async (p: string) => `${p}-202610-0001` } as any, // numbering
    {} as any, // workflow (unused on create path)
  );
}

const GOOD_ITEM = { description: 'A4 Paper', quantity: 10, unit: 'ream', estimatedUnitPrice: 8000 };

async function main() {
  // ========================= 1) DTO validation contract =========================
  console.log('\n-- CreatePurchaseRequestDto validation contract (as the web form submits) --');

  await test('valid form payload VALIDATES', () => {
    const { errors } = plainPayloadOf({
      priority: 'URGENT', requiredDate: '2026-10-15', budgetCode: 'B-2026',
      justification: 'Toner replacement',
      items: [GOOD_ITEM, { description: 'Stapler', quantity: 2 }],
    });
    assert.deepStrictEqual(
      errors.flatMap((e: any) => (e.constraints ? Object.values(e.constraints) : [])),
      [],
    );
  });

  await test('empty items array REJECTED — a PR without lines makes no sense', () => {
    const msgs = validationMessages({ items: [] });
    assert.ok(msgs.length > 0, 'expected array validation to fail for empty items');
  });

  await test('bad priority value REJECTED', () => {
    const msgs = validationMessages({ priority: 'WHENEVER', items: [GOOD_ITEM] });
    assert.ok(msgs.some((m) => /priority/i.test(m)), `unexpected messages: ${msgs.join(' | ')}`);
  });

  // ========================= 2) Service: create =========================
  console.log('\n-- ProcurementService.create (mock prisma) --');

  await test('create persists items 1:1 and falls back to first item as title', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    const doc = await svc.create(
      { items: [GOOD_ITEM, { description: 'Stapler', quantity: 2 }] },
      ACTOR,
    );
    const reqData = prisma.__calls.requestCreate[0];
    assert.strictEqual(reqData.docType, 'PURCHASE_REQUEST');
    assert.strictEqual(reqData.docNumber, 'PR-202610-0001');
    assert.ok(reqData.title.startsWith('Purchase: A4 Paper'), `title fallback: ${reqData.title}`);
    assert.strictEqual(reqData.departmentId, 'dep-1');
    const items = prisma.__calls.prCreate[0].items.create;
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].description, 'A4 Paper');
    assert.strictEqual(items[0].quantity, 10);
    assert.strictEqual(Number(items[0].estimatedUnitPrice), 8000);
    assert.strictEqual(items[1].unit, undefined);
    assert.ok(prisma.__calls.prCreate[0].items.create.every((i: any) => i.accountId === undefined));
    assert.ok(doc.purchaseRequest.items.length === 2);
  });

  await test('create rejects an empty item list', async () => {
    const svc = makeService(makePrisma());
    await assert.rejects(() => svc.create({ items: [] }, ACTOR), /At least one item/i);
  });

  await test('create rejects quantity < 1 and NaN price', async () => {
    const svc = makeService(makePrisma());
    await assert.rejects(
      () => svc.create({ items: [{ description: 'X', quantity: 0 }] }, ACTOR),
      /quantity must be at least 1/i,
    );
    await assert.rejects(
      () => svc.create({ items: [{ description: 'X', quantity: 2, estimatedUnitPrice: -5 }] }, ACTOR),
      /invalid estimated unit price/i,
    );
  });

  await test('create writes the estimated total into the request description', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.create({ items: [GOOD_ITEM] }, ACTOR);
    const desc = prisma.__calls.requestCreate[0].description as string;
    assert.ok(desc.includes('A4 Paper ×10 ream @ 8000'), `description: ${desc}`);
    assert.ok(desc.includes('Estimated total: 80,000'), `total line: ${desc}`);
  });

  // ========================= 3) Service: supplier draft bridge =========================
  console.log('\n-- createFromSupplierDraft (PO draft → PR) --');

  await test('draft lines map 1:1 onto PR items (P1 bridge replaces the text flattening)', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    const doc = await svc.createFromSupplierDraft(
      {
        supplier: { name: 'ABC Technology' },
        lines: [
          { item: { code: 'ITM-0001', name: 'A4 Paper', unit: 'ream' }, quantity: 4, unitPrice: '150000' },
          { item: { code: 'ITM-0002', name: 'Ball Pen', unit: 'pcs' }, quantity: 10, unitPrice: null },
        ],
        note: 'urgent restock',
      },
      ACTOR,
    );
    const items = prisma.__calls.prCreate[0].items.create;
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].description, 'A4 Paper (ITM-0001)');
    assert.strictEqual(items[0].quantity, 4);
    assert.strictEqual(Number(items[0].estimatedUnitPrice), 150000);
    assert.strictEqual(items[1].estimatedUnitPrice, undefined);
    const reqData = prisma.__calls.requestCreate[0];
    assert.ok(reqData.title.includes('ABC Technology'), `title: ${reqData.title}`);
    assert.ok((reqData.description as string).includes('Vendor PO draft'), `justification: ${reqData.description}`);
    assert.strictEqual(doc.id, 'req-1');
  });

  // ========================= 4) Service: update guard =========================
  console.log('\n-- ProcurementService.update (draft guard) --');

  await test('update rejects a non-owner', async () => {
    const prisma = makePrisma();
    prisma.requestDocument.findUnique = async () => ({ id: 'req-1', docType: 'PURCHASE_REQUEST', requesterId: 'someone-else', status: 'DRAFT' });
    const svc = makeService(prisma);
    await assert.rejects(() => svc.update('req-1', { items: [GOOD_ITEM] }, ACTOR), /Not your request/i);
  });

  await test('update rejects a submitted (non-DRAFT) request', async () => {
    const prisma = makePrisma();
    prisma.requestDocument.findUnique = async () => ({ id: 'req-1', docType: 'PURCHASE_REQUEST', requesterId: ACTOR.userId, status: 'PENDING_APPROVAL' });
    const svc = makeService(prisma);
    await assert.rejects(() => svc.update('req-1', { items: [GOOD_ITEM] }, ACTOR), /Only DRAFT/i);
  });

  await test('update replaces items wholesale on an owned DRAFT', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.update('req-1', { items: [GOOD_ITEM] }, ACTOR);
    assert.strictEqual(prisma.__calls.itemDelete.length, 1);
    assert.strictEqual(prisma.__calls.prUpdate.length, 1);
    assert.strictEqual(prisma.__calls.prUpdate[0].items.create.length, 1);
    assert.strictEqual(prisma.__calls.docUpdate.length, 1);
  });

  // ------------------------------------------------------------------ report
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
