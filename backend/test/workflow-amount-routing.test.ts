/**
 * Phase 2 (R3) — amount-based approval routing (Procurement design §8).
 *
 * Contract: WorkflowService.submit() must resolve the approval workflow by the
 * PR's estimated total — the active ApprovalWorkflow whose amount band
 * [minAmount, maxAmount] (inclusive, optional bounds) contains the total —
 * falling back to the module's unbounded default workflow, then to the
 * GENERIC_REQUEST fallback. Non-amount doc types (cars, meetings, …) keep the
 * old by-docType routing and must never look up an amount at all.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/workflow-amount-routing.test.ts
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

const ACTOR = { userId: 'u-1', username: 'requester' };

/** The four PURCHASE_REQUEST bands seeded by seed.js (design §8 examples). */
const PR_BAND_WORKFLOWS = [
  { id: 'wf-band-1', module: 'PURCHASE_REQUEST', active: true, minAmount: null, maxAmount: 500000, steps: [{ level: 1, roleName: 'DEPARTMENT_HEAD' }] },
  { id: 'wf-band-2', module: 'PURCHASE_REQUEST', active: true, minAmount: 500001, maxAmount: 2000000, steps: [{ level: 1, roleName: 'DEPARTMENT_HEAD' }, { level: 2, roleName: 'ADMINISTRATION' }] },
  { id: 'wf-band-3', module: 'PURCHASE_REQUEST', active: true, minAmount: 2000001, maxAmount: 10000000, steps: [{ level: 1, roleName: 'DEPARTMENT_HEAD' }, { level: 2, roleName: 'ADMINISTRATION' }, { level: 3, roleName: 'FINANCE' }] },
  { id: 'wf-band-4', module: 'PURCHASE_REQUEST', active: true, minAmount: 10000001, maxAmount: null, steps: [{ level: 1, roleName: 'DEPARTMENT_HEAD' }, { level: 2, roleName: 'ADMINISTRATION' }, { level: 3, roleName: 'FINANCE' }, { level: 4, roleName: 'MANAGEMENT' }] },
];

const CAR_DEFAULT_WORKFLOW = { id: 'wf-car', module: 'CAR_REQUEST', active: true, minAmount: null, maxAmount: null, steps: [{ level: 1, roleName: 'ADMINISTRATION' }] };

const PR_DEFAULT_WORKFLOW = { id: 'wf-pr-default', module: 'PURCHASE_REQUEST', active: true, minAmount: null, maxAmount: null, steps: [{ level: 1, roleName: 'DEPARTMENT_HEAD' }, { level: 2, roleName: 'MANAGEMENT' }] };

function makePrisma(opts: { docType: string; items?: any[]; workflows?: any[]; prRow?: any }) {
  const calls: any = { docUpdates: [], actions: [], prLookups: 0 };
  const prisma: any = {
    requestDocument: {
      findUnique: async () => ({ id: 'req-1', docType: opts.docType, status: 'DRAFT', requesterId: ACTOR.userId, docNumber: 'PR-202610-0001', title: 'Test', currentLevel: 0, totalLevels: 0 }),
      update: async (a: any) => {
        calls.docUpdates.push(a.data);
        return a.data;
      },
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      count: async () => 0,
    },
    purchaseRequest: {
      findUnique: async () => {
        calls.prLookups++;
        if (opts.prRow !== undefined) return opts.prRow;
        return opts.items ? { id: 'pr-1', items: opts.items } : null;
      },
    },
    approvalWorkflow: {
      findMany: async () => opts.workflows ?? PR_BAND_WORKFLOWS,
      findFirst: async () => null,
    },
    approvalStep: { findFirstOrThrow: async () => ({ level: 1, roleName: 'DEPARTMENT_HEAD' }) },
    approvalAction: {
      create: async (a: any) => {
        calls.actions.push(a.data);
        return a.data;
      },
    },
    userRole: { findMany: async () => [] },
    approvalDelegation: { findMany: async () => [] },
    $transaction: async (ops: any[]) => Promise.all(ops.map((op: any) => (typeof op === 'function' ? op(prisma) : op))),
    __calls: calls,
  };
  return prisma;
}

function makeService(prisma: any) {
  const { WorkflowService } = require('../src/workflow/workflow.service');
  const noop = async () => undefined;
  return new WorkflowService(
    prisma,
    {} as any, // numbering (unused on submit)
    { notifyMany: noop, notify: noop } as any,
    { log: noop } as any,
  );
}

function item(unitPrice: number, quantity: number) {
  return { estimatedUnitPrice: unitPrice, quantity };
}

async function submitAndGetUpdate(opts: { docType: string; items?: any[]; workflows?: any[]; prRow?: any }) {
  const prisma = makePrisma(opts);
  const svc = makeService(prisma);
  await svc.submit('req-1', ACTOR);
  assert.strictEqual(prisma.__calls.docUpdates.length, 1, 'request document must be updated once');
  return prisma.__calls.docUpdates[0];
}

async function main() {
  console.log('\n-- amount-based workflow routing (Procurement design §8) --');

  await test('PR at 400,000 routes to the ≤500K band (1 level, L1 DEPARTMENT_HEAD)', async () => {
    const update = await submitAndGetUpdate({ docType: 'PURCHASE_REQUEST', items: [item(8000, 50)] });
    assert.strictEqual(update.totalLevels, 1);
    assert.strictEqual(update.currentLevel, 1);
  });

  await test('PR at exactly 500,000 stays in the ≤500K band (inclusive maxAmount)', async () => {
    const update = await submitAndGetUpdate({ docType: 'PURCHASE_REQUEST', items: [item(5000, 100)] });
    assert.strictEqual(update.totalLevels, 1);
  });

  await test('PR at 500,001 moves to the 500,001–2M band (2 levels)', async () => {
    const update = await submitAndGetUpdate({ docType: 'PURCHASE_REQUEST', items: [item(50001, 10)] });
    assert.strictEqual(update.totalLevels, 2);
  });

  await test('multi-item PR totals are summed before band matching (5M → 3-level band)', async () => {
    const update = await submitAndGetUpdate({ docType: 'PURCHASE_REQUEST', items: [item(1000000, 4), item(500000, 2)] });
    assert.strictEqual(update.totalLevels, 3);
  });

  await test('PR above 10,000,000 routes to the 4-level band', async () => {
    const update = await submitAndGetUpdate({ docType: 'PURCHASE_REQUEST', items: [item(5000000, 3)] });
    assert.strictEqual(update.totalLevels, 4);
    assert.strictEqual(update.currentLevel, 1);
  });

  await test('non-amount doc type (CAR_REQUEST) routes to the unbounded default and never looks up an amount', async () => {
    const update = await submitAndGetUpdate({ docType: 'CAR_REQUEST', workflows: [CAR_DEFAULT_WORKFLOW], items: [item(999, 1)] });
    assert.strictEqual(update.totalLevels, 1);
    const prisma = makePrisma({ docType: 'CAR_REQUEST', workflows: [CAR_DEFAULT_WORKFLOW], items: [item(999, 1)] });
    const svc = makeService(prisma);
    await svc.submit('req-1', ACTOR);
    assert.strictEqual(prisma.__calls.prLookups, 0, 'amountFor must short-circuit for non-amount doc types');
  });

  await test('PR without a purchaseRequest row falls back to the unbounded default workflow', async () => {
    const update = await submitAndGetUpdate({ docType: 'PURCHASE_REQUEST', workflows: [PR_DEFAULT_WORKFLOW, ...PR_BAND_WORKFLOWS], prRow: null });
    assert.strictEqual(update.totalLevels, 2, 'unbounded default workflow should win when no amount is known');
  });

  await test('no band matches and no default → GENERIC_REQUEST fallback is not silently broken (throws config error)', async () => {
    const prisma = makePrisma({ docType: 'PURCHASE_REQUEST', workflows: [], items: [item(1000, 1)] });
    const svc = makeService(prisma);
    await assert.rejects(() => svc.submit('req-1', ACTOR), /No active workflow configured/);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
