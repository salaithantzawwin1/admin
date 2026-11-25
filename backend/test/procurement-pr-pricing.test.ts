/**
 * PR pricing flow — requester asks Administration to estimate, procurement
 * fills the blanks and submits on the requester's behalf.
 *
 * Layers (same spy-prisma harness as procurement-pr.test.ts):
 *  1. DTO — a blank estimate is only allowed through askForPricing; an empty
 *     string is not a number and is rejected by the real DTO.
 *  2. create — askForPricing keeps the line price null and marks the doc.
 *  3. requestPricing — owner only, DRAFT only, needs an unpriced line, notifies
 *     buyers once (a second call inside 24 h sends nothing), audits.
 *  4. priceAndSubmit — every line needs a price, prices are saved, the
 *     description/total is rebuilt, the workflow is submitted on behalf of the
 *     requester, the requester is notified and the audit records the total.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/procurement-pr-pricing.test.ts
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

function validationMessages(plain: object): string[] {
  const { plainToInstance } = require('class-transformer');
  const { validateSync } = require('class-validator');
  const { PrItemDto } = require('../src/procurement/procurement.controller');
  const errors = validateSync(plainToInstance(PrItemDto, plain), { whitelist: true });
  return errors.flatMap((e: any) => (e.constraints ? Object.values(e.constraints) : [])) as string[];
}

const ACTOR = { userId: 'u-1', username: 'requester' };
const BUYER = { userId: 'u-9', username: 'procurement' };
const DOC_ID = 'req-1';

function pricingDoc(overrides: any = {}) {
  return {
    id: DOC_ID,
    docNumber: 'PR-202611-0007',
    docType: 'PURCHASE_REQUEST',
    title: 'Purchase: Mouse',
    requesterId: ACTOR.userId,
    status: 'DRAFT',
    purchaseRequest: {
      id: 'pr-1',
      justification: null,
      items: [
        { id: 'it-1', description: 'Wireless Mouse', quantity: 2, unit: 'pcs', estimatedUnitPrice: null },
        { id: 'it-2', description: 'Mouse Pad', quantity: 3, unit: 'pcs', estimatedUnitPrice: null },
      ],
    },
    ...overrides,
  };
}

/** Minimal mock Prisma; records writes so the tests can assert on them. */
function makePrisma(doc: any = pricingDoc(), recentNotification: any = null) {
  const calls: Record<string, any[]> = {
    requestCreate: [], prCreate: [], itemUpdate: [], docUpdate: [], audit: [], submits: [], notify: [], notifyMany: [],
  };
  const prisma: any = {
    employee: { findFirst: async () => ({ departmentId: 'dep-1' }) },
    account: { findFirst: async () => null },
    requestDocument: {
      create: async (a: any) => { calls.requestCreate.push(a.data); return { id: DOC_ID, ...a.data }; },
      findUnique: async () => doc,
      update: async (a: any) => { calls.docUpdate.push(a.data); return a.data; },
    },
    purchaseRequest: {
      create: async (a: any) => { calls.prCreate.push(a.data); return { id: 'pr-1', items: a.data.items?.create ?? [] }; },
    },
    purchaseRequestItem: {
      update: async (a: any) => { calls.itemUpdate.push(a); return a.data; },
    },
    notification: {
      findFirst: async () => recentNotification,
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
    __calls: calls,
  };
  return prisma;
}

function makeService(prisma: any, spy: Record<string, any> = {}) {
  const { ProcurementService } = require('../src/procurement/procurement.service');
  const audit = { log: async (e: any) => { prisma.__calls.audit.push(e); } };
  const permissions = { usersWithPermissions: async () => [BUYER, { userId: 'u-10' }] };
  const notifications = {
    notifyMany: async (users: any[], n: any) => { prisma.__calls.notifyMany.push({ users, n }); },
    notify: async (n: any) => { prisma.__calls.notify.push(n); },
  };
  const workflow = { submit: async (...args: any[]) => { prisma.__calls.submits.push(args); } };
  Object.assign(prisma.__calls, spy);
  return new ProcurementService(
    prisma,
    audit as any,
    { next: async (p: string) => `${p}-202611-0007` } as any,
    permissions as any,
    notifications as any,
    workflow as any,
  );
}

const UNPRICED = { description: 'Wireless Mouse', quantity: 2, unit: 'pcs' };

async function main() {
  // ========================= 1) DTO contract =========================
  console.log('\n-- CreatePurchaseRequestDto (blank price only via askForPricing) --');

  await test('blank estimate VALIDATES on a line', () => {
    assert.deepStrictEqual(validationMessages({ ...UNPRICED, estimatedUnitPrice: null }), []);
  });

  await test('empty-string estimate is not a number — REJECTED', () => {
    const msgs = validationMessages({ ...UNPRICED, estimatedUnitPrice: '' });
    assert.ok(msgs.some((m) => /estimatedUnitPrice must be a number/i.test(m)), `messages: ${msgs.join(' | ')}`);
  });

  // ========================= 2) create =========================
  console.log('\n-- create() --');

  await test('without askForPricing a missing estimate REJECTS', async () => {
    const prisma = makePrisma();
    await assert.rejects(() => makeService(prisma).create({ items: [UNPRICED] }, ACTOR), /estimated unit price is required/i);
    assert.strictEqual(prisma.__calls.requestCreate.length, 0, 'nothing may be written');
  });

  await test('askForPricing persists a null price and marks the doc as pending', async () => {
    const prisma = makePrisma();
    await makeService(prisma).create({ askForPricing: true, items: [UNPRICED] }, ACTOR);
    const item = prisma.__calls.prCreate[0].items.create[0];
    assert.strictEqual(item.estimatedUnitPrice, null);
    const desc = prisma.__calls.requestCreate[0].description as string;
    assert.ok(desc.includes('@ price pending'), `description: ${desc}`);
    assert.ok(desc.includes('(some prices pending)'), `description: ${desc}`);
  });

  await test('askForPricing still rejects a negative estimate', async () => {
    const prisma = makePrisma();
    await assert.rejects(
      () => makeService(prisma).create({ askForPricing: true, items: [{ ...UNPRICED, estimatedUnitPrice: -1 }] }, ACTOR),
      /must be a positive number/i,
    );
  });

  // ========================= 3) requestPricing =========================
  console.log('\n-- requestPricing() --');

  await test('rejects a non-owner', async () => {
    const prisma = makePrisma(pricingDoc({ requesterId: 'someone-else' }));
    await assert.rejects(() => makeService(prisma).requestPricing(DOC_ID, ACTOR), /Not your request/i);
    assert.strictEqual(prisma.__calls.notifyMany.length, 0);
  });

  await test('rejects a non-DRAFT PR', async () => {
    const prisma = makePrisma(pricingDoc({ status: 'PENDING_APPROVAL' }));
    await assert.rejects(() => makeService(prisma).requestPricing(DOC_ID, ACTOR), /only be set on a draft/i);
  });

  await test('rejects a PR where every line already has a price', async () => {
    const doc = pricingDoc();
    doc.purchaseRequest.items.forEach((i: any) => (i.estimatedUnitPrice = 1000));
    const prisma = makePrisma(doc);
    await assert.rejects(() => makeService(prisma).requestPricing(DOC_ID, ACTOR), /already has an estimated price/i);
  });

  await test('notifies buyers once and audits the request', async () => {
    const prisma = makePrisma();
    const res = await makeService(prisma).requestPricing(DOC_ID, ACTOR);
    assert.deepStrictEqual(res, { success: true, lines: 2, notified: 2 });
    const sent = prisma.__calls.notifyMany[0];
    assert.strictEqual(sent.users.length, 2);
    assert.strictEqual(sent.n.title, 'Pricing needed — PR-202611-0007');
    assert.strictEqual(sent.n.requestId, DOC_ID);
    assert.ok(/Wireless Mouse ×2, Mouse Pad ×3/.test(sent.n.body), sent.n.body);
    const audit = prisma.__calls.audit.at(-1);
    assert.strictEqual(audit.action, 'PURCHASE_REQUEST_PRICING_REQUESTED');
    assert.strictEqual(audit.newValue.lines, 2);
    assert.strictEqual(audit.newValue.notified, 2);
  });

  await test('a repeat click inside 24 h sends no second notification', async () => {
    const prisma = makePrisma(pricingDoc(), { id: 'n-1' });
    const res = await makeService(prisma).requestPricing(DOC_ID, ACTOR);
    assert.deepStrictEqual(res, { success: true, lines: 2, notified: 0, alreadyRequested: true });
    assert.strictEqual(prisma.__calls.notifyMany.length, 0);
    assert.strictEqual(prisma.__calls.audit.length, 0, 'repeat is not a new audit event');
  });

  // ========================= 4) priceAndSubmit =========================
  console.log('\n-- priceAndSubmit() --');

  await test('refuses to submit while a line has no price', async () => {
    const prisma = makePrisma();
    await assert.rejects(
      () => makeService(prisma).priceAndSubmit(DOC_ID, [{ itemId: 'it-1', estimatedUnitPrice: 5000 }], BUYER),
      /Set a price for every line: Mouse Pad/i,
    );
    assert.strictEqual(prisma.__calls.submits.length, 0, 'the chain must not start');
  });

  await test('saves all prices, rebuilds the total, submits on behalf and notifies the requester', async () => {
    const prisma = makePrisma();
    const res = await makeService(prisma).priceAndSubmit(
      DOC_ID,
      [{ itemId: 'it-1', estimatedUnitPrice: 5000 }, { itemId: 'it-2', estimatedUnitPrice: 2000 }],
      BUYER,
    );
    assert.deepStrictEqual(res, { success: true, total: 5000 * 2 + 2000 * 3 });

    const updates = prisma.__calls.itemUpdate;
    assert.deepStrictEqual(updates.map((u: any) => [u.where.id, u.data.estimatedUnitPrice]), [
      ['it-1', 5000], ['it-2', 2000],
    ]);
    const desc = prisma.__calls.docUpdate[0].description as string;
    assert.ok(desc.includes('Wireless Mouse ×2 pcs @ 5000'), desc);
    assert.ok(desc.includes('Estimated total: 16,000'), desc);
    assert.ok(!desc.includes('pending'), desc);

    assert.deepStrictEqual(prisma.__calls.submits[0].slice(0, 3), [DOC_ID, BUYER, { onBehalf: true }]);

    const note = prisma.__calls.notify[0];
    assert.strictEqual(note.userId, ACTOR.userId);
    assert.strictEqual(note.title, 'Priced — PR-202611-0007');
    assert.ok(note.body.includes('16,000'), note.body);

    const audit = prisma.__calls.audit.at(-1);
    assert.strictEqual(audit.action, 'PURCHASE_REQUEST_PRICED');
    assert.deepStrictEqual(audit.newValue, { docNumber: 'PR-202611-0007', estimatedTotal: 16000, items: 2 });
  });

  await test('keeps an already-set price when only the missing line is sent', async () => {
    const doc = pricingDoc();
    doc.purchaseRequest.items[0].estimatedUnitPrice = '4500';
    const prisma = makePrisma(doc);
    const res = await makeService(prisma).priceAndSubmit(DOC_ID, [{ itemId: 'it-2', estimatedUnitPrice: 2000 }], BUYER);
    assert.strictEqual(res.total, 4500 * 2 + 2000 * 3);
    assert.strictEqual(prisma.__calls.itemUpdate[0].data.estimatedUnitPrice, 4500);
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
