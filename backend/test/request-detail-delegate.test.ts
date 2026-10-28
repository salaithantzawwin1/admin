/**
 * Request detail access — GET /requests/:id (workflow detail()).
 *
 * Why: detail() computed isApprover from the actor's OWN roles only, while
 * inbox() and approve() both resolve ACTIVE delegations. A delegate could see
 * the request in Pending Approvals and approve it, yet opening its detail page
 * threw 403 "No access" — Approvals.tsx navigates to that page right after a
 * car/meeting approve, so the delegate landed on an error screen, and opening
 * the request from their pending list failed the same way. Detail visibility
 * now mirrors approve(): own roles + roles of principals actively delegated to
 * me (same semantics as the inbox's SYSTEM_ADMIN-delegation branch).
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/request-detail-delegate.test.ts
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

const NOW = new Date();
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 60_000);
const EXPIRED_END = new Date(NOW.getTime() - 1000);

const CAR_WORKFLOW = { id: 'wf-car', module: 'CAR_REQUEST', active: true, minAmount: null, maxAmount: null, steps: [{ level: 1, roleName: 'ADMINISTRATION' }] };
const GENERIC_WORKFLOW = { id: 'wf-gen', module: 'GENERIC_REQUEST', active: true, minAmount: null, maxAmount: null, steps: [{ level: 1, roleName: 'DEPARTMENT_HEAD' }] };

const OWNER_REQUEST = {
  id: 'req-1',
  docNumber: 'CAR-202610-0001',
  docType: 'CAR_REQUEST',
  status: 'APPROVED',
  requesterId: 'u-owner',
  currentLevel: 1,
  totalLevels: 1,
};

interface Opts {
  request?: any;
  /** userId → role names (role.name rows) */
  roles?: Record<string, string[]>;
  /** delegation rows TO the actor (window filtering is honoured by the mock) */
  delegations?: { toUserId: string; fromUserId: string; startAt: Date; endAt: Date }[];
  workflows?: any[];
}

function makePrisma(opts: Opts) {
  const workflows = opts.workflows ?? [CAR_WORKFLOW, GENERIC_WORKFLOW];
  const prisma: any = {
    requestDocument: { findUnique: async () => opts.request ?? null },
    userRole: {
      findMany: async (a: any) => {
        // own roles: where.userId is a string; delegate roles: where.userId is { in: [...] }
        const ids: string[] = typeof a?.where?.userId === 'string' ? [a.where.userId] : (a?.where?.userId?.in ?? []);
        return ids.flatMap((id) => (opts.roles?.[id] ?? []).map((name: string) => ({ userId: id, role: { name } })));
      },
    },
    approvalDelegation: {
      findMany: async (a: any) =>
        (opts.delegations ?? [])
          .filter((d) => d.toUserId === a?.where?.toUserId)
          .filter((d) => d.startAt <= a.where.startAt.lte && d.endAt >= a.where.endAt.gte)
          .map((d) => ({ ...d, status: 'ACTIVE' })),
    },
    approvalWorkflow: {
      findMany: async (a: any) => workflows.filter((w) => w.module === a?.where?.module),
      findFirst: async (a: any) => workflows.find((w) => w.module === a?.where?.module) ?? null,
    },
    purchaseRequest: { findUnique: async () => null },
    approvalAction: { findMany: async () => [] },
    attachment: { findMany: async () => [] },
    approvalStep: { findFirst: async () => null },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  return prisma;
}

function makeService(prisma: any) {
  const { WorkflowService } = require('../src/workflow/workflow.service');
  const noop = async () => undefined;
  return new WorkflowService(prisma, {} as any, { notifyMany: noop, notify: noop } as any, { log: noop } as any);
}

async function detailFor(opts: Opts, actor = { userId: 'u-x', username: 'x' }) {
  const svc = makeService(makePrisma(opts));
  return svc.detail('req-1', actor);
}

async function main() {
  console.log('\n-- request detail: delegate visibility mirrors approve() --');

  await test('delegate of a step-role holder can open the detail', async () => {
    const d = await detailFor(
      {
        request: OWNER_REQUEST,
        roles: { 'u-delegate': ['DEPARTMENT_HEAD'], 'u-admin': ['ADMINISTRATION'] },
        delegations: [{ toUserId: 'u-delegate', fromUserId: 'u-admin', startAt: PAST, endAt: FUTURE }],
      },
      { userId: 'u-delegate', username: 'delegate' },
    );
    assert.strictEqual(d.isOwner, false, 'delegate is not the owner');
    assert.strictEqual(d.id, 'req-1', 'detail must resolve');
  });

  await test('delegate of SYSTEM_ADMIN opens a request at a step role they do NOT hold (inbox parity)', async () => {
    const d = await detailFor(
      {
        request: OWNER_REQUEST, // step role = ADMINISTRATION; actor holds neither it nor SYSTEM_ADMIN
        roles: { 'u-sys': ['SYSTEM_ADMIN'] },
        delegations: [{ toUserId: 'u-delegate', fromUserId: 'u-sys', startAt: PAST, endAt: FUTURE }],
      },
      { userId: 'u-delegate', username: 'delegate' },
    );
    assert.strictEqual(d.id, 'req-1');
  });

  await test('expired delegation does NOT open the detail', async () => {
    await assert.rejects(
      () =>
        detailFor(
          {
            request: OWNER_REQUEST,
            roles: { 'u-delegate': ['DEPARTMENT_HEAD'], 'u-admin': ['ADMINISTRATION'] },
            delegations: [{ toUserId: 'u-delegate', fromUserId: 'u-admin', startAt: PAST, endAt: EXPIRED_END }],
          },
          { userId: 'u-delegate', username: 'delegate' },
        ),
      /No access/,
    );
  });

  await test('delegate whose principal holds no step role is denied', async () => {
    await assert.rejects(
      () =>
        detailFor(
          {
            request: OWNER_REQUEST, // CAR workflow steps = ADMINISTRATION only; FINANCE is not among them
            roles: { 'u-delegate': ['EMPLOYEE'], 'u-finance': ['FINANCE'] },
            delegations: [{ toUserId: 'u-delegate', fromUserId: 'u-finance', startAt: PAST, endAt: FUTURE }],
          },
          { userId: 'u-delegate', username: 'delegate' },
        ),
      /No access/,
    );
  });

  await test('stranger without roles or delegation is denied', async () => {
    await assert.rejects(() => detailFor({ request: OWNER_REQUEST, roles: {} }), /No access/);
  });

  await test('owner can always open their own request', async () => {
    const d = await detailFor({ request: OWNER_REQUEST, roles: {} }, { userId: 'u-owner', username: 'owner' });
    assert.strictEqual(d.isOwner, true);
  });

  await test('direct step-role holder still opens it (unchanged behaviour)', async () => {
    const d = await detailFor(
      { request: OWNER_REQUEST, roles: { 'u-admin': ['ADMINISTRATION'] } },
      { userId: 'u-admin', username: 'admin' },
    );
    assert.strictEqual(d.id, 'req-1');
  });

  await test('missing request → NotFound (unchanged behaviour)', async () => {
    await assert.rejects(() => detailFor({ request: null, roles: { 'u-admin': ['ADMINISTRATION'] } }), /Request not found/);
  });

  console.log(`\n  ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
}

main();
