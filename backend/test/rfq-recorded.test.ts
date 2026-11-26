/**
 * A2 — a quotation request is a record, not a workflow document.
 *
 * REAL ProcurementService.createRfq / byRfq with a spy Prisma:
 *  - the RFQ- number, title, requester and department go into
 *    quotation_requests with status OPEN;
 *  - nothing is written to request_documents or approval_actions, so the record
 *    can never appear in an approval inbox, the badge or My Requests;
 *  - the audit row points at the quotation request id;
 *  - another user cannot read someone else's quotation request.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/rfq-recorded.test.ts
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

const ACTOR = { userId: 'u-1', username: 'cy1' };

function makeEnv() {
  const created: any[] = [];
  const audits: any[] = [];
  let workflowDocs = 0;
  let approvalActions = 0;

  const row = {
    id: 'qr-1',
    docNumber: 'RFQ-202611-0014',
    title: 'Office chairs',
    description: null,
    status: 'OPEN',
    requestedById: ACTOR.userId,
    departmentId: 'dept-1',
    rfqVendors: [],
    quotations: [],
    comparison: null,
    requestedBy: { id: ACTOR.userId, fullName: 'Cy One' },
    department: null,
    purchaseRequest: null,
  };

  const prisma: any = {
    employee: { findFirst: async () => ({ departmentId: 'dept-1' }) },
    supplier: { count: async () => 0 },
    quotationRequest: {
      create: async ({ data }: any) => {
        created.push(data);
        return { id: 'qr-1', ...data };
      },
      findUnique: async ({ where }: any) => (where.id === 'qr-1' ? row : null),
    },
    requestDocument: {
      create: async () => {
        workflowDocs++;
        throw new Error('a quotation request must not create a workflow document');
      },
    },
    approvalAction: {
      create: async () => {
        approvalActions++;
        throw new Error('a quotation request must not write approval actions');
      },
    },
  };
  const audit = { log: async (e: any) => { audits.push(e); } };
  const numbering = { next: async () => 'RFQ-202611-0001' };

  return { prisma, audit, numbering, audits, created, workflowDocs: () => workflowDocs, approvalActions: () => approvalActions };
}

const { ProcurementService } = require('../src/procurement/procurement.service');

function makeSvc() {
  const env = makeEnv();
  const notifications = { notify: async () => undefined, notifyMany: async () => undefined };
  const svc = new ProcurementService(env.prisma, env.audit, env.numbering, {} as never, notifications as never, {} as never);
  return { svc, env };
}

async function main() {
  console.log('\n== RFQ is a quotation request record ==');

  await test('createRfq writes quotation_requests with the RFQ- number and OPEN status', async () => {
    const { svc, env } = makeSvc();
    const created = await svc.createRfq({ title: 'Office chairs — 12' }, ACTOR);

    assert.strictEqual(env.created.length, 1);
    const row = env.created[0];
    assert.strictEqual(row.docNumber, 'RFQ-202611-0001');
    assert.strictEqual(row.status, 'OPEN');
    assert.strictEqual(row.title, 'Office chairs — 12');
    assert.strictEqual(row.requestedById, ACTOR.userId);
    assert.strictEqual(row.departmentId, 'dept-1');
    assert.strictEqual(created.id, 'qr-1');
    assert.strictEqual(created.docNumber, 'RFQ-202611-0001');
  });

  await test('no workflow document and no approval action is written', async () => {
    const { svc, env } = makeSvc();
    await svc.createRfq({ title: 'Printer toner' }, ACTOR);

    assert.strictEqual(env.workflowDocs(), 0, 'request_documents must stay untouched');
    assert.strictEqual(env.approvalActions(), 0, 'no approval trail — there is no approval step');
  });

  await test('RFQ_CREATED is audited against the quotation request id', async () => {
    const { svc, env } = makeSvc();
    await svc.createRfq({ title: 'Cleaning supplies' }, ACTOR);

    const audit = env.audits.find((a: any) => a.action === 'RFQ_CREATED');
    assert.ok(audit, 'RFQ_CREATED audit row');
    assert.strictEqual(audit.recordId, 'qr-1');
    assert.strictEqual(audit.newValue.docNumber, 'RFQ-202611-0001');
  });

  await test('byRfq hides another user’s quotation request', async () => {
    const { svc } = makeSvc();
    await assert.rejects(
      () => svc.byRfq('qr-1', { userId: 'u-2', username: 'someone-else' }),
      /Not your RFQ/,
    );
    const own = await svc.byRfq('qr-1', ACTOR);
    assert.strictEqual(own.docNumber, 'RFQ-202611-0014');
    assert.strictEqual(own.status, 'OPEN');
    assert.strictEqual(own.rfq.id, 'qr-1', 'the screens still read the nested rfq shape');
    assert.strictEqual(own.requester.fullName, 'Cy One');
  });

  console.log(`\n${passed}/${passed + failures.length} passed`);
  if (failures.length) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
