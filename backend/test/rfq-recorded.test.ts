/**
 * A1 — an RFQ is recorded, not approved.
 *
 * REAL ProcurementService.createRfq with a spy Prisma:
 *  - the document is written APPROVED with its level counters filled, so the
 *    workflow engine has nothing to pick up (no PENDING_APPROVAL, no inbox row,
 *    no badge count);
 *  - the approval trail still gets one SUBMIT entry naming the requester;
 *  - nothing calls requestDocument.update (the old submit path) and no
 *    notification is raised.
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
  const createdDocs: any[] = [];
  const createdActions: any[] = [];
  const auditLogs: any[] = [];
  let documentUpdates = 0;
  let notificationCount = 0;

  const prisma: any = {
    employee: { findFirst: async () => ({ departmentId: 'dept-chan-yin' }) },
    supplier: { count: async () => 0 },
    requestDocument: {
      create: async ({ data }: any) => {
        createdDocs.push(data);
        return { id: 'req-1', ...data };
      },
      update: async () => {
        documentUpdates++;
        return { id: 'req-1' };
      },
    },
    rfq: {
      create: async ({ data }: any) => {
        createdActions.push({ kind: 'rfq', ...data });
        return { id: 'rfq-1', ...data };
      },
    },
    approvalAction: {
      create: async ({ data }: any) => {
        createdActions.push(data);
        return data;
      },
    },
  };
  const audit = { log: async (e: any) => { auditLogs.push(e); } };
  const numbering = { next: async () => 'RFQ-202611-0001' };
  const notifications = { notify: async () => { notificationCount++; }, notifyMany: async () => { notificationCount++; } };

  return { prisma, audit, numbering, notifications, createdDocs, createdActions, auditLogs, documentUpdates: () => documentUpdates, notifications: () => notificationCount };
}

const { ProcurementService } = require('../src/procurement/procurement.service');

function makeSvc() {
  const env = makeEnv();
  const svc = new ProcurementService(env.prisma, env.audit, env.numbering, {} as never, env.notifications as never, {} as never);
  return { svc, env };
}

async function main() {
  console.log('\n== RFQ is recorded APPROVED, no approval step ==');

  await test('createRfq writes an APPROVED document (no PENDING_APPROVAL, no submit transition)', async () => {
    const { svc, env } = makeSvc();
    const created = await svc.createRfq({ title: 'Office chairs — 12' }, ACTOR);

    assert.strictEqual(env.createdDocs.length, 1);
    const doc = env.createdDocs[0];
    assert.strictEqual(doc.status, 'APPROVED');
    assert.strictEqual(doc.docType, 'RFQ');
    assert.strictEqual(doc.currentLevel, 1);
    assert.strictEqual(doc.totalLevels, 1);
    assert.ok(doc.submittedAt instanceof Date, 'submittedAt is stamped at creation');
    assert.strictEqual(doc.departmentId, 'dept-chan-yin');
    assert.strictEqual(created.status, 'APPROVED');

    assert.strictEqual(env.documentUpdates(), 0, 'no second workflow update (the old submit path)');
    assert.strictEqual(env.notifications(), 0, 'no approver notification');
  });

  await test('the approval trail still records who raised it, as one SUBMIT entry', async () => {
    const { svc, env } = makeSvc();
    await svc.createRfq({ title: 'Printer toner' }, ACTOR);

    const actions = env.createdActions.filter((a: any) => a.kind !== 'rfq');
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].action, 'SUBMIT');
    assert.strictEqual(actions[0].approverId, ACTOR.userId);
    assert.strictEqual(actions[0].previousStatus, 'DRAFT');
    assert.strictEqual(actions[0].newStatus, 'APPROVED');
    assert.strictEqual(actions[0].level, 0);
  });

  await test('RFQ_CREATED is still audited', async () => {
    const { svc, env } = makeSvc();
    await svc.createRfq({ title: 'Cleaning supplies' }, ACTOR);

    const audit = env.auditLogs.find((a: any) => a.action === 'RFQ_CREATED');
    assert.ok(audit, 'RFQ_CREATED audit row');
    assert.strictEqual(audit.newValue.docNumber, 'RFQ-202611-0001');
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
