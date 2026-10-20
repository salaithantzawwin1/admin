/**
 * GLG Procurement ERP W4 (2026-10-20) — purchase-type classification (§36):
 * normalizePurchaseType defaults to NORMAL, rejects unknown types, requires a
 * written reason for EMERGENCY/DIRECT, and never stores a reason for
 * NORMAL/PETTY_CASH (that classification is display-only — money movement
 * lives in the petty-cash ledger).
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/purchase-types.test.ts
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

const { normalizePurchaseType, PURCHASE_TYPES } = require('../src/procurement/purchase-types');

/** normalizePurchaseType throws SYNCHRONOUSLY (BadRequestException) — use assert.throws, not assert.rejects. */

async function main() {
  console.log('\n== §W4 purchase types ==');

  await test('defaults to NORMAL when type is absent/empty', async () => {
    assert.deepStrictEqual(normalizePurchaseType(undefined, undefined), { purchaseType: 'NORMAL', purchaseReason: undefined });
    assert.deepStrictEqual(normalizePurchaseType('', 'ignored'), { purchaseType: 'NORMAL', purchaseReason: undefined });
    assert.deepStrictEqual(normalizePurchaseType(null, null), { purchaseType: 'NORMAL', purchaseReason: undefined });
  });

  await test('case/whitespace normalized; valid pass-through', async () => {
    assert.strictEqual(normalizePurchaseType('emergency', 'generator down').purchaseType, 'EMERGENCY');
    assert.strictEqual(normalizePurchaseType('  DIRECT  ', ' sole source ').purchaseType, 'DIRECT');
    assert.strictEqual(normalizePurchaseType('PETTY_CASH', null).purchaseType, 'PETTY_CASH');
  });

  await test('EMERGENCY/DIRECT require a written reason (§36 exception path)', async () => {
    assert.throws(() => normalizePurchaseType('EMERGENCY', undefined), /reason is required/i);
    assert.throws(() => normalizePurchaseType('EMERGENCY', '   '), /reason is required/i);
    assert.throws(() => normalizePurchaseType('DIRECT', null), /reason is required/i);
    const ok = normalizePurchaseType('EMERGENCY', '  UPS failed — server room heat  ');
    assert.strictEqual(ok.purchaseReason, 'UPS failed — server room heat', 'reason trimmed');
  });

  await test('NORMAL/PETTY_CASH never store a reason', async () => {
    assert.strictEqual(normalizePurchaseType('NORMAL', 'accidental text').purchaseReason, undefined);
    assert.strictEqual(normalizePurchaseType('PETTY_CASH', 'accidental text').purchaseReason, undefined);
  });

  await test('unknown type → 400 listing the allowed set', async () => {
    assert.throws(() => normalizePurchaseType('CRYPTO', null), /NORMAL \/ EMERGENCY \/ DIRECT \/ PETTY_CASH/);
    assert.deepStrictEqual([...PURCHASE_TYPES], ['NORMAL', 'EMERGENCY', 'DIRECT', 'PETTY_CASH']);
  });

  const summary = failures.length ? `\nFAILED (${failures.length}): ${failures.join(' | ')}` : `\n${passed} passed, 0 failed`;
  console.log(summary);
  process.exitCode = failures.length ? 1 : 0;
}

main();
