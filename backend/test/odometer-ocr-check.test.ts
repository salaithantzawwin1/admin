/**
 * The OCR cross-check line written by captureOdometer (shadow mode).
 *
 * The reader never records a reading; when a driver/Administration reading lands
 * the audit trail must say whether it matched the photo, so shadow mode can
 * measure accuracy before anyone sees a mismatch card.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/odometer-ocr-check.test.ts
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

const { CarsService } = require('../src/cars/cars.service');

const ASSIGN = 'aaaaaaaa-0000-4000-8000-000000000001';
const REQ = 'aaaaaaaa-0000-4000-8000-000000000002';
const VEH = 'aaaaaaaa-0000-4000-8000-000000000003';
const ACTOR = { userId: 'u-1', username: 'admin' };

function build(readKm: number | null) {
  const updates: any[] = [];
  const audits: any[] = [];
  const prisma: any = {
    carAssignment: {
      findUnique: async () => ({
        id: ASSIGN,
        requestId: REQ,
        vehicleId: VEH,
        startOdoKm: 341325,
        startOdoPhoto: 'start.jpg',
        endOdoPhoto: 'end.jpg',
        driverArrivedAt: new Date('2026-11-10T07:48:00Z'),
        driverBackAtOfficeAt: new Date('2026-11-10T08:58:00Z'),
        odoReadKm: readKm,
        vehicle: { id: VEH, vehicleNo: '9F1213', currentMileage: 341000 },
        request: { id: REQ, docNumber: 'CAR-202611-0023' },
        carRequest: { sharedTripId: null },
      }),
      findFirst: async () => null,
      update: async (args: any) => {
        updates.push(args);
        return {};
      },
      count: async () => 0,
    },
    vehicle: { update: async (args: any) => (updates.push(args), {}) },
  };
  const svc: any = new CarsService(
    prisma, {} as any, {} as any, {} as any,
    { log: async (e: any) => { audits.push(e); } },
    { manualAck: async () => ({}) },
    {} as any,
    { publish: () => undefined } as any,
  );
  return { svc, updates, audits };
}

async function main() {
  console.log('odometer OCR check (shadow)');

  await test('a matching photo marks the reading verified', async () => {
    const h = build(341363);
    await h.svc.captureOdometer(ASSIGN, { stage: 'BACK', km: 341363 }, undefined, ACTOR);
    const check = h.audits.find((a: any) => a.action === 'CAR_ODOMETER_OCR_CHECK');
    assert.ok(check, 'the check is in the audit trail');
    assert.strictEqual(check.newValue.matched, true);
    assert.strictEqual(check.newValue.readKm, 341363);
    assert.strictEqual(check.newValue.typedKm, 341363);
    assert.strictEqual(check.newValue.mode, 'shadow');
    const stamped = h.updates.find((u: any) => u.data && 'odoCheckedAt' in u.data);
    assert.ok(stamped && stamped.data.odoCheckedAt instanceof Date, 'odoCheckedAt marks it verified');
  });

  await test('a mismatch is recorded but never changes the recorded number', async () => {
    const h = build(341324);
    await h.svc.captureOdometer(ASSIGN, { stage: 'BACK', km: 341363 }, undefined, ACTOR);
    const check = h.audits.find((a: any) => a.action === 'CAR_ODOMETER_OCR_CHECK');
    assert.ok(check);
    assert.strictEqual(check.newValue.matched, false, 'photo says 341,324 — the slip is visible');
    const stamped = h.updates.find((u: any) => u.data && 'odoCheckedAt' in u.data);
    assert.ok(stamped && stamped.data.odoCheckedAt === null, 'not verified');
    const saved = h.updates.find((u: any) => u.data && 'endOdoKm' in u.data);
    assert.strictEqual(saved.data.endOdoKm, 341363, 'shadow mode never overrides the driver');
  });

  await test('no photo reading means no check line at all', async () => {
    const h = build(null);
    await h.svc.captureOdometer(ASSIGN, { stage: 'BACK', km: 341363 }, undefined, ACTOR);
    assert.ok(!h.audits.some((a: any) => a.action === 'CAR_ODOMETER_OCR_CHECK'));
    assert.ok(!h.updates.some((u: any) => u.data && 'odoCheckedAt' in u.data));
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
