/**
 * Odometer (car kilo) tests — Ready / Back-at-office readings, trip usage and
 * the monthly per-vehicle total.
 *
 * Mock Prisma, REAL CarsService: the guards, the usage arithmetic and the
 * "stamp the stage through the driver-ack path" wiring are the logic under test.
 * No DB, no HTTP, no files written (the success case reuses a stored photo).
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/car-odometer.test.ts
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

const ACTOR = { userId: '11111111-1111-1111-1111-111111111111', username: 'admin' };
const ASSIGNMENT_ID = '22222222-2222-2222-2222-222222222222';
const REQUEST_ID = '33333333-3333-3333-3333-333333333333';
const VEHICLE_ID = '44444444-4444-4444-4444-444444444444';

function assignment(over: Record<string, unknown> = {}) {
  return {
    id: ASSIGNMENT_ID,
    requestId: REQUEST_ID,
    vehicleId: VEHICLE_ID,
    driverArrivedAt: null,
    driverBackAtOfficeAt: null,
    startOdoKm: null,
    startOdoPhoto: null,
    endOdoKm: null,
    endOdoPhoto: null,
    vehicle: { id: VEHICLE_ID, vehicleNo: 'YGN-1234', currentMileage: 0 },
    request: { id: REQUEST_ID, docNumber: 'CAR-202611-0001' },
    ...over,
  };
}

function build(opts: { row?: any; lastReturn?: any; usageRows?: any[] } = {}) {
  const updates: any[] = [];
  const audits: any[] = [];
  const ackCalls: any[] = [];
  const prisma: any = {
    carAssignment: {
      findUnique: async () => opts.row ?? assignment(),
      findFirst: async () => opts.lastReturn ?? null,
      update: async (args: any) => {
        updates.push(args);
        return { ...(opts.row ?? assignment()), ...args.data };
      },
      findMany: async () => opts.usageRows ?? [],
    },
  };
  const audit: any = { log: async (payload: any) => audits.push(payload) };
  const telegram: any = {
    manualAck: async (id: string, action: string) => {
      ackCalls.push({ id, action });
      return {};
    },
  };
  const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, audit, telegram, {} as any, { publish: () => undefined } as any);
  return { svc, updates, audits, ackCalls };
}

async function main() {
  await test('captureOdometer: a new reading without a photo is refused', async () => {
    const { svc } = build();
    await assert.rejects(
      () => svc.captureOdometer(ASSIGNMENT_ID, { stage: 'READY', km: 45210 }, undefined, ACTOR),
      /photo/i,
    );
  });

  await test('captureOdometer: a file that is not a real image is refused', async () => {
    const { svc } = build();
    await assert.rejects(
      () => svc.captureOdometer(ASSIGNMENT_ID, { stage: 'READY', km: 45210 }, { buffer: Buffer.from('not an image at all') }, ACTOR),
      /JPEG, PNG or WebP/,
    );
  });

  await test('captureOdometer: unknown stage and non-integer km are refused', async () => {
    const { svc } = build();
    await assert.rejects(() => svc.captureOdometer(ASSIGNMENT_ID, { stage: 'NOPE', km: 1 }, undefined, ACTOR), /stage/i);
    await assert.rejects(() => svc.captureOdometer(ASSIGNMENT_ID, { stage: 'READY', km: '12.5' }, undefined, ACTOR), /whole kilometres/i);
  });

  await test('captureOdometer: the return reading cannot be below the departure reading', async () => {
    const { svc } = build({ row: assignment({ startOdoKm: 45210, startOdoPhoto: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg' }) });
    await assert.rejects(
      () => svc.captureOdometer(ASSIGNMENT_ID, { stage: 'BACK', km: 45200 }, undefined, ACTOR),
      /cannot be less than the departure reading/,
    );
  });

  await test('captureOdometer: a departure reading below the last return of the car is refused', async () => {
    const { svc } = build({ lastReturn: { endOdoKm: 45268, endOdoAt: new Date('2026-11-01T10:00:00Z') } });
    await assert.rejects(
      () => svc.captureOdometer(ASSIGNMENT_ID, { stage: 'READY', km: 45200 }, undefined, ACTOR),
      /below the last recorded return/,
    );
  });

  await test('captureOdometer: saving BACK stamps the stage through the driver-ack path and reports usage', async () => {
    const { svc, updates, audits, ackCalls } = build({
      row: assignment({
        startOdoKm: 45210,
        startOdoPhoto: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg',
        // photo already on file for the return stage (e.g. only the number was wrong)
        endOdoPhoto: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg',
        driverArrivedAt: new Date('2026-11-02T08:00:00Z'),
      }),
      lastReturn: null,
    });
    const res = await svc.captureOdometer(ASSIGNMENT_ID, { stage: 'BACK', km: 45268 }, undefined, ACTOR);
    assert.strictEqual(res.usageKm, 58, 'usage = return - departure');
    assert.strictEqual(res.stamped, 'BACK', 'a missing Back-at-office tap is stamped by the same save');
    assert.deepStrictEqual(ackCalls, [{ id: ASSIGNMENT_ID, action: 'returned' }]);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].data.endOdoKm, 45268);
    assert.ok(audits.some((a: any) => a.action === 'CAR_ODOMETER_RECORDED' && a.newValue.km === 45268));
  });

  await test('captureOdometer: a reading added after the tap does not move the tap', async () => {
    const { svc, ackCalls } = build({
      row: assignment({
        startOdoKm: 45210,
        startOdoPhoto: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg',
        endOdoPhoto: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg',
        driverArrivedAt: new Date('2026-11-02T08:00:00Z'),
        driverBackAtOfficeAt: new Date('2026-11-02T16:00:00Z'),
      }),
    });
    const res = await svc.captureOdometer(ASSIGNMENT_ID, { stage: 'BACK', km: 45300 }, undefined, ACTOR);
    assert.strictEqual(res.stamped, null);
    assert.deepStrictEqual(ackCalls, [], 'the stage was already stamped — manualAck must not run again');
  });

  await test('vehicleUsage: sums completed trips per vehicle and flags a trip with no return reading', async () => {
    const rows = [
      {
        id: 'a1', vehicleId: 'v1', startOdoKm: 1000, endOdoKm: 1040,
        startOdoAt: new Date('2026-11-02T01:00:00Z'), endOdoAt: new Date('2026-11-02T09:00:00Z'),
        startOdoPhoto: 'p1.jpg', endOdoPhoto: null,
        driver: { name: 'U Aung' }, vehicle: { vehicleNo: 'YGN-1234', brandModel: 'Hilux' },
        request: { docNumber: 'CAR-202611-0001' }, carRequest: { destination: 'Mandalay', startDate: new Date('2026-11-02T01:00:00Z') },
      },
      {
        id: 'a2', vehicleId: 'v1', startOdoKm: 1040, endOdoKm: null,
        startOdoAt: new Date('2026-11-05T01:00:00Z'), endOdoAt: null,
        startOdoPhoto: null, endOdoPhoto: null,
        driver: { name: 'U Aung' }, vehicle: { vehicleNo: 'YGN-1234', brandModel: 'Hilux' },
        request: { docNumber: 'CAR-202611-0002' }, carRequest: { destination: 'Bago', startDate: new Date('2026-11-05T01:00:00Z') },
      },
      {
        id: 'a3', vehicleId: 'v2', startOdoKm: 500, endOdoKm: 560,
        startOdoAt: new Date('2026-11-03T01:00:00Z'), endOdoAt: new Date('2026-11-03T10:00:00Z'),
        startOdoPhoto: null, endOdoPhoto: 'p3.jpg',
        driver: { name: 'Daw Mya' }, vehicle: { vehicleNo: 'YGN-5678', brandModel: null },
        request: { docNumber: 'CAR-202611-0003' }, carRequest: { destination: 'Nay Pyi Taw', startDate: new Date('2026-11-03T01:00:00Z') },
      },
    ];
    const { svc } = build({ usageRows: rows });
    const res = await svc.vehicleUsage('2026-11');
    assert.strictEqual(res.month, '2026-11');
    assert.strictEqual(res.tripCount, 2, 'only trips with both readings count');
    assert.strictEqual(res.grandTotalKm, 100, '40 km + 60 km');
    assert.strictEqual(res.pendingCount, 1, 'the open trip is surfaced, not silently dropped');
    const v1 = res.vehicles.find((v: any) => v.vehicleId === 'v1');
    assert.strictEqual(v1.totalKm, 40);
    assert.strictEqual(v1.trips.length, 2);
    assert.strictEqual(v1.trips.filter((t: any) => !t.complete).length, 1);
    assert.deepStrictEqual(res.vehicles.map((v: any) => v.vehicleNo), ['YGN-1234', 'YGN-5678'], 'sorted by plate');
  });

  await test('vehicleUsage: a bad month is a 400, not an empty report', async () => {
    const { svc } = build({ usageRows: [] });
    await assert.rejects(() => svc.vehicleUsage('2026-13'), /2026-11/);
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
