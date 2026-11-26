/**
 * Quotations recorded by mistake can be corrected or removed while the RFQ is
 * still OPEN and no §14 vendor decision has been recorded.
 *
 * REAL ProcurementService.updateQuotation / deleteQuotation with a spy Prisma:
 *  - the header + lines are replaced (PATCH) and QUOTATION_UPDATED is audited;
 *  - a delete removes the row and audits QUOTATION_DELETED;
 *  - a CLOSED RFQ refuses both (the round is over);
 *  - a recorded decision refuses both (the quote is the evidence behind it);
 *  - a quotation belonging to another RFQ is not found.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/rfq-quotation-edit.test.ts
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

const QUOTE = {
  id: 'q-1',
  rfqId: 'qr-1',
  supplierId: 'sup-1',
  quoteNumber: 'Q-OLD',
  quoteDate: new Date('2026-11-20T00:00:00Z'),
  dueDate: null,
  validUntil: null,
  paymentTerms: '30 Days',
  taxIncluded: true,
  note: null,
  items: [{ id: 'qi-1', description: 'Mouse pad', quantity: 20, unitPrice: 3500 }],
  supplier: { id: 'sup-1', name: 'Unique Myanmar' },
};

const INPUT = {
  supplierId: 'sup-1',
  quoteNumber: 'Q-FIXED',
  paymentTerms: 'COD',
  items: [{ description: 'Mouse pad', quantity: 25, unitPrice: 3400 }],
};

function makeSvc(opts: { status?: string; decision?: boolean; quoteRfqId?: string } = {}) {
  const audits: any[] = [];
  const updates: any[] = [];
  const deletes: any[] = [];
  const updates_count: any[] = [];
  const rfq = {
    id: 'qr-1',
    docNumber: 'RFQ-202611-0014',
    title: 'Mouse pads',
    status: opts.status ?? 'OPEN',
  };
  const prisma: any = {
    quotationRequest: { findUnique: async () => rfq },
    quotationComparison: {
      findUnique: async () => (opts.decision ? { id: 'cmp-1' } : null),
    },
    supplier: { findUnique: async () => ({ id: 'sup-1', name: 'Unique Myanmar', isActive: true }) },
    rfqVendor: { findFirst: async () => ({ id: 'rv-1' }) },
    quotation: {
      findFirst: async () => null,
      findUnique: async () => ({ ...QUOTE, rfqId: opts.quoteRfqId ?? QUOTE.rfqId }),
      update: async ({ data }: any) => {
        updates.push(data);
        if (data.items?.deleteMany) updates_count.push(data.items.deleteMany);
        return {
          ...QUOTE,
          quoteNumber: data.quoteNumber,
          supplier: QUOTE.supplier,
          items: data.items.create.map((i: any, idx: number) => ({ id: `new-${idx}`, ...i })),
        };
      },
      delete: async ({ where }: any) => {
        deletes.push(where.id);
        return QUOTE;
      },
    },
  };
  const audit = { log: async (e: any) => { audits.push(e); } };
  const notifications = { notify: async () => undefined, notifyMany: async () => undefined };
  const { ProcurementService } = require('../src/procurement/procurement.service');
  const svc = new ProcurementService(prisma, audit, { next: async () => 'X' }, {} as never, notifications as never, {} as never);
  return { svc, audits, updates, deletes, updateCount: () => updates_count.length };
}

async function main() {
  console.log('\n== RFQ quotation edit / delete ==');

  await test('update replaces the header and lines, then audits QUOTATION_UPDATED', async () => {
    const { svc, audits, updates, updateCount } = makeSvc();
    const updated = await svc.updateQuotation('qr-1', 'q-1', INPUT, ACTOR);

    assert.strictEqual(updates.length, 1);
    const data = updates[0];
    assert.strictEqual(data.quoteNumber, 'Q-FIXED');
    assert.strictEqual(data.paymentTerms, 'COD');
    assert.strictEqual(data.items.create.length, 1);
    assert.strictEqual(data.items.create[0].quantity, 25);
    assert.strictEqual(data.items.create[0].unitPrice, 3400);
    assert.strictEqual(data.items.create[0].createdById, ACTOR.userId);
    assert.strictEqual(updateCount(), 1, 'old lines are cleared before the new ones are written');
    assert.strictEqual(updated.quoteNumber, 'Q-FIXED');

    const audit = audits.find((a: any) => a.action === 'QUOTATION_UPDATED');
    assert.ok(audit, 'QUOTATION_UPDATED audit row');
    assert.strictEqual(audit.recordId, 'q-1');
    assert.strictEqual(audit.oldValue.quoteNumber, 'Q-OLD');
    assert.strictEqual(audit.newValue.quoteNumber, 'Q-FIXED');
  });

  await test('delete removes the quotation and audits QUOTATION_DELETED', async () => {
    const { svc, audits, deletes } = makeSvc();
    const res = await svc.deleteQuotation('qr-1', 'q-1', ACTOR);

    assert.deepStrictEqual(deletes, ['q-1']);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.quoteNumber, 'Q-OLD');
    const audit = audits.find((a: any) => a.action === 'QUOTATION_DELETED');
    assert.ok(audit, 'QUOTATION_DELETED audit row');
    assert.strictEqual(audit.recordId, 'q-1');
    assert.strictEqual(audit.severity, 'WARNING');
    assert.strictEqual(audit.oldValue.supplier, 'Unique Myanmar');
  });

  await test('a CLOSED RFQ refuses both edit and delete', async () => {
    const edit = makeSvc({ status: 'CLOSED' });
    await assert.rejects(() => edit.svc.updateQuotation('qr-1', 'q-1', INPUT, ACTOR), /can no longer change/);
    assert.strictEqual(edit.updates.length, 0);

    const del = makeSvc({ status: 'CLOSED' });
    await assert.rejects(() => del.svc.deleteQuotation('qr-1', 'q-1', ACTOR), /can no longer change/);
    assert.strictEqual(del.deletes.length, 0);
  });

  await test('a recorded vendor decision freezes the quotations', async () => {
    const edit = makeSvc({ decision: true });
    await assert.rejects(() => edit.svc.updateQuotation('qr-1', 'q-1', INPUT, ACTOR), /recorded vendor decision/);
    assert.strictEqual(edit.updates.length, 0);

    const del = makeSvc({ decision: true });
    await assert.rejects(() => del.svc.deleteQuotation('qr-1', 'q-1', ACTOR), /recorded vendor decision/);
    assert.strictEqual(del.deletes.length, 0);
  });

  await test('a quotation from another RFQ is not found', async () => {
    const { svc } = makeSvc({ quoteRfqId: 'qr-other' });
    await assert.rejects(() => svc.deleteQuotation('qr-1', 'q-1', ACTOR), /Quotation not found on this RFQ/);
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
