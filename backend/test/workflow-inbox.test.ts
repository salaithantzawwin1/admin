/**
 * Approvals inbox contract — the Pending Approvals queue (GET /requests/inbox).
 *
 * Why: the inbox only matched `step.roleName ∈ my roles`, but workflow steps
 * never name SYSTEM_ADMIN as a step role — while approve() and
 * approverUserIds() both grant SYSTEM_ADMIN a superuser bypass. Result: an
 * admin could act on every request via detail page / Telegram yet their
 * Pending Approvals list was always empty. The inbox must list exactly what
 * the actor can act on:
 *   1. SYSTEM_ADMIN (own role, or received via active delegation) → every
 *      pending request at a level that exists in its workflow (any doc type,
 *      any level — docType branch and amount-routed branch alike);
 *   2. otherwise → only steps whose role matches my roles / delegated-in roles
 *      (no cross-workflow level leakage);
 *   3. always → the actor's OWN requests are excluded: approve() rejects them
 *      ("You cannot act on your own request"), so they are not actionable.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/workflow-inbox.test.ts
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

const ACTOR = { userId: 'u-admin', username: 'sysadmin' };

const CAR_WORKFLOW = { id: 'wf-car', module: 'CAR_REQUEST', active: true, minAmount: null, maxAmount: null, steps: [{ level: 1, roleName: 'ADMINISTRATION' }] };
const GENERIC_WORKFLOW = { id: 'wf-gen', module: 'GENERIC_REQUEST', active: true, minAmount: null, maxAmount: null, steps: [{ level: 1, roleName: 'DEPARTMENT_HEAD' }] };
// amount-routed (Procurement §8): L1 DEPARTMENT_HEAD band for a small PR
const PR_BAND = { id: 'wf-pr', module: 'PURCHASE_REQUEST', active: true, minAmount: null, maxAmount: 500000, steps: [{ level: 1, roleName: 'DEPARTMENT_HEAD' }] };

interface PrismaOpts {
  /** userId → role names (role.name rows) */
  roles?: Record<string, string[]>;
  /** ACTIVE delegations TO the actor */
  delegations?: { fromUserId: string }[];
  /** distinct pending docTypes returned by the first findMany */
  pendingDocTypes?: string[];
  workflows?: any[];
  /** rows for the amount-routed pending query (second findMany, no distinct) */
  amountPending?: { id: string; docType: string; currentLevel: number }[];
  prRow?: any;
}

function makePrisma(opts: PrismaOpts) {
  const calls: { finalWhere?: any } = {};
  const roles = opts.roles ?? {};
  const prisma: any = {
    userRole: {
      findMany: async (a: any) =>
        (roles[a?.where?.userId] ?? []).map((name: string) => ({ userId: a.where.userId, role: { name } })),
    },
    approvalDelegation: {
      findMany: async () => (opts.delegations ?? []).map((d) => ({ ...d, status: 'ACTIVE', startAt: new Date(0), endAt: new Date(8.64e15) })),
    },
    approvalWorkflow: {
      findMany: async (a: any) => (opts.workflows ?? [CAR_WORKFLOW, GENERIC_WORKFLOW]).filter((w) => w.module === a?.where?.module),
      findFirst: async () => null,
    },
    purchaseRequest: {
      findUnique: async () => opts.prRow ?? null,
    },
    requestDocument: {
      findMany: async (a: any) => {
        if (a?.distinct) return (opts.pendingDocTypes ?? []).map((docType) => ({ docType }));
        // amount-routed pending query: select {id, docType, currentLevel}, no include
        if (a?.select?.currentLevel !== undefined) return opts.amountPending ?? [];
        // only the paged list query carries the requester/department include
        if (a?.include) calls.finalWhere = a?.where;
        return [];
      },
      count: async () => 0,
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
    __calls: calls,
  };
  return prisma;
}

function makeService(prisma: any) {
  const { WorkflowService } = require('../src/workflow/workflow.service');
  const noop = async () => undefined;
  return new WorkflowService(prisma, {} as any, { notifyMany: noop, notify: noop } as any, { log: noop } as any);
}

async function inboxWhere(opts: PrismaOpts, actor = ACTOR) {
  const prisma = makePrisma(opts);
  const svc = makeService(prisma);
  await svc.inbox(actor, 1, 20);
  return prisma.__calls.finalWhere;
}

function orClauses(where: any): any[] {
  assert.ok(where, 'inbox must issue the final findMany');
  assert.strictEqual(where.status, 'PENDING_APPROVAL');
  return (where.OR ?? []) as any[];
}

async function main() {
  console.log('\n-- approvals inbox: SYSTEM_ADMIN bypass + own-request exclusion --');

  await test('SYSTEM_ADMIN sees pending requests at levels whose step role they do NOT hold', async () => {
    const where = await inboxWhere({
      roles: { 'u-admin': ['SYSTEM_ADMIN'] }, // no ADMINISTRATION, no DEPARTMENT_HEAD
      pendingDocTypes: ['CAR_REQUEST', 'GENERIC_REQUEST'],
      workflows: [CAR_WORKFLOW, GENERIC_WORKFLOW],
    });
    const or = orClauses(where);
    assert.ok(
      or.some((c) => c.docType === 'CAR_REQUEST' && c.currentLevel === 1),
      'admin must see the CAR request queued at L1 ADMINISTRATION',
    );
    assert.ok(
      or.some((c) => c.docType === 'GENERIC_REQUEST' && c.currentLevel === 1),
      'admin must see the generic request queued at L1 DEPARTMENT_HEAD',
    );
  });

  await test('own requests are never in the inbox (approve() rejects them — separation of duties)', async () => {
    const where = await inboxWhere({
      roles: { 'u-admin': ['SYSTEM_ADMIN'] },
      pendingDocTypes: ['CAR_REQUEST'],
      workflows: [CAR_WORKFLOW],
    });
    assert.ok(where.requesterId, 'where must filter by requester');
    assert.strictEqual(where.requesterId.not, ACTOR.userId, 'the actor must be excluded as requester');
  });

  await test('non-admin role still only matches its own steps (no cross-workflow leakage)', async () => {
    const where = await inboxWhere(
      {
        roles: { 'u-head': ['DEPARTMENT_HEAD', 'EMPLOYEE'] },
        pendingDocTypes: ['CAR_REQUEST', 'GENERIC_REQUEST'],
        workflows: [CAR_WORKFLOW, GENERIC_WORKFLOW],
      },
      { userId: 'u-head', username: 'head1' },
    );
    const or = orClauses(where);
    assert.ok(
      or.some((c) => c.docType === 'GENERIC_REQUEST' && c.currentLevel === 1),
      'DEPARTMENT_HEAD must see the generic request at L1',
    );
    assert.ok(
      !or.some((c) => c.docType === 'CAR_REQUEST'),
      'DEPARTMENT_HEAD must NOT see CAR requests queued at L1 ADMINISTRATION',
    );
    assert.strictEqual(where.requesterId.not, 'u-head');
  });

  await test('delegation FROM a SYSTEM_ADMIN grants the bypass to the delegate', async () => {
    const where = await inboxWhere({
      roles: { 'u-admin': ['EMPLOYEE'], 'u-super': ['SYSTEM_ADMIN'] }, // my own roles match nothing
      delegations: [{ fromUserId: 'u-super' }],
      pendingDocTypes: ['CAR_REQUEST'],
      workflows: [CAR_WORKFLOW],
    });
    const or = orClauses(where);
    assert.ok(
      or.some((c) => c.docType === 'CAR_REQUEST' && c.currentLevel === 1),
      'delegate of an admin must see every pending request',
    );
  });

  await test('SYSTEM_ADMIN also covers amount-routed doc types (per-request branch)', async () => {
    const where = await inboxWhere({
      roles: { 'u-admin': ['SYSTEM_ADMIN'] },
      pendingDocTypes: ['PURCHASE_REQUEST'], // skipped by the docType loop (amount-routed)
      workflows: [PR_BAND],
      amountPending: [{ id: 'pr-1', docType: 'PURCHASE_REQUEST', currentLevel: 1 }],
      prRow: { id: 'pr-1', items: [{ estimatedUnitPrice: 100, quantity: 1 }] },
    });
    const or = orClauses(where);
    assert.ok(
      or.some((c) => c.id === 'pr-1'),
      'admin must see amount-routed pending requests resolved per request',
    );
  });

  await test('no pending work to match → empty inbox is forced (id in [])', async () => {
    const where = await inboxWhere({
      roles: { 'u-admin': ['EMPLOYEE'] },
      pendingDocTypes: [],
      workflows: [],
    });
    const or = orClauses(where);
    assert.strictEqual(or.length, 0);
    assert.deepStrictEqual(where.id, { in: [] });
    assert.strictEqual(where.requesterId.not, ACTOR.userId, 'requester exclusion applies on the empty branch too');
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
