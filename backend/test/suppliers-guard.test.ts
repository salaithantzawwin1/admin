/**
 * Gap analysis §66 soft-delete policy — the supplier delete guard.
 *
 * REAL SuppliersService.remove with a spy Prisma:
 *  - PO / invoice / quotation / RFQ / draft / contact-log / stock references
 *    all refuse hard delete with the named counts ("set it inactive instead").
 *  - a truly unused supplier deletes + audits WARNING.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/suppliers-guard.test.ts
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

const ACTOR = { userId: 'u-1', username: 'admin1' };

function makeEnv(refs: Partial<Record<string, number>>) {
  const audits: any[] = [];
  let deleted = false;
  const count = (key: string) => async () => refs[key] ?? 0;
  const prisma: any = {
    supplier: {
      findUnique: async () => ({ id: 'sup-1', name: 'Acme Traders' }),
      delete: async () => {
        deleted = true;
        return { id: 'sup-1' };
      },
    },
    stockTransaction: { count: count('stockTransaction') },
    purchaseOrder: { count: count('purchaseOrder') },
    invoice: { count: count('invoice') },
    quotation: { count: count('quotation') },
    rfqVendor: { count: count('rfqVendor') },
    supplierPurchaseDraft: { count: count('supplierPurchaseDraft') },
    supplierContactLog: { count: count('supplierContactLog') },
  };
  const audit = { log: async (e: any) => { audits.push(e); } };
  return { prisma, audit, audits, wasDeleted: () => deleted };
}

const { SuppliersService } = require('../src/suppliers/suppliers.service');

function makeSvc(refs: Partial<Record<string, number>>) {
  const env = makeEnv(refs);
  // numbering + procurement are constructor deps the delete path never touches
  const svc = new SuppliersService(env.prisma, env.audit, {} as never, {} as never);
  return { svc, env };
}

async function main() {
  console.log('\n== §66 supplier delete guard ==');

  await test('PO history refuses hard delete and names the count + inactive path', async () => {
    const { svc, env } = makeSvc({ purchaseOrder: 3 });
    await assert.rejects(
      () => svc.remove('sup-1', ACTOR),
      (e: Error) => /3 PO\(s\)/.test(e.message) && /inactive/.test(e.message),
    );
    assert.strictEqual(env.wasDeleted(), false);
    assert.strictEqual(env.audits.length, 0);
  });

  await test('invoice + quotation + RFQ + draft + contact-log references all block', async () => {
    const { svc, env } = makeSvc({ invoice: 1, quotation: 2, rfqVendor: 4, supplierPurchaseDraft: 1, supplierContactLog: 5 });
    await assert.rejects(
      () => svc.remove('sup-1', ACTOR),
      (e: Error) =>
        /1 invoice\(s\)/.test(e.message) &&
        /2 quotation\(s\)/.test(e.message) &&
        /4 RFQ invite\(s\)/.test(e.message) &&
        /1 purchase draft\(s\)/.test(e.message) &&
        /5 contact log\(s\)/.test(e.message),
    );
    assert.strictEqual(env.wasDeleted(), false);
  });

  await test('stock transactions block too (legacy guard kept)', async () => {
    const { svc } = makeSvc({ stockTransaction: 7 });
    await assert.rejects(() => svc.remove('sup-1', ACTOR), /7 stock transaction\(s\)/);
  });

  await test('unused supplier deletes + WARNING audit', async () => {
    const { svc, env } = makeSvc({});
    const res = await svc.remove('sup-1', ACTOR);
    assert.strictEqual(res.success, true);
    assert.strictEqual(env.wasDeleted(), true);
    assert.strictEqual(env.audits[0].action, 'SUPPLIER_DELETED');
    assert.strictEqual(env.audits[0].severity, 'WARNING');
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
