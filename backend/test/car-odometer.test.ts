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
const { TripRemindersService } = require('../src/cars/trip-reminders.service');

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

function build(opts: { row?: any; lastReturn?: any; usageRows?: any[]; fuelRows?: any[] } = {}) {
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
    carExpense: { findMany: async () => opts.fuelRows ?? [] },
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


  await test('captureOdometer: a shared ride copies the reading to the partner booking', async () => {
    const updated: any[] = [];
    const prisma: any = {
      carAssignment: {
        findUnique: async () => assignment({ carRequest: { sharedTripId: 'g1' }, endOdoPhoto: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg' }),
        findFirst: async () => null,
        update: async (args: any) => { updated.push(args); return {}; },
        findMany: async (args: any) => (args?.where?.carRequest ? [{ id: 'sibling-1', requestId: 'req-2' }] : []),
        count: async () => 1,
      },
    };
    const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, { log: async () => undefined }, { manualAck: async () => ({}) }, {} as any, { publish: () => undefined });
    await svc.captureOdometer(ASSIGNMENT_ID, { stage: 'BACK', km: 45268 }, undefined, ACTOR);
    assert.strictEqual(updated.length, 2, 'the own row and the partner booking');
    assert.deepStrictEqual(updated[1].where, { id: 'sibling-1' });
    assert.strictEqual(updated[1].data.endOdoKm, 45268, 'one physical drive, one reading');
  });

  await test('vehicleUsage: a shared ride is counted once, not once per booking', async () => {
    const row = (id: string, doc: string) => ({
      id, vehicleId: 'v1', startOdoKm: 1000, endOdoKm: 1040,
      startOdoAt: new Date('2026-11-02T01:00:00Z'), endOdoAt: new Date('2026-11-02T09:00:00Z'),
      startOdoPhoto: 'p1.jpg', endOdoPhoto: 'p2.jpg',
      driver: { name: 'U Aung' }, vehicle: { vehicleNo: 'YGN-1234', brandModel: 'Hilux' },
      request: { docNumber: doc }, carRequest: { destination: 'Bago', startDate: new Date('2026-11-02T01:00:00Z'), sharedTripId: 'g1' },
    });
    const { svc } = build({ usageRows: [row('a1', 'CAR-1'), row('a2', 'CAR-2')] });
    const res = await svc.vehicleUsage('2026-11');
    assert.strictEqual(res.grandTotalKm, 40, 'the distance is counted once');
    assert.strictEqual(res.tripCount, 1);
    const v = res.vehicles[0];
    assert.strictEqual(v.trips.length, 2, 'both bookings are still listed');
    assert.strictEqual(v.trips.filter((t: any) => t.sharedDuplicate).length, 1);
    assert.strictEqual(v.trips.filter((t: any) => t.shared).length, 2);
    assert.strictEqual(res.pendingCount, 0, 'the partner booking must not look pending');
  });

  await test('vehicleUsageCsv: escapes commas and quotes, marks pending, subtotals + total', async () => {
    const { svc } = build({
      usageRows: [
        {
          id: 'a1', vehicleId: 'v1', startOdoKm: 1000, endOdoKm: 1040,
          startOdoAt: new Date('2026-11-02T01:00:00Z'), endOdoAt: new Date('2026-11-02T09:00:00Z'),
          startOdoPhoto: null, endOdoPhoto: null,
          driver: { name: 'U Aung' }, vehicle: { vehicleNo: 'YGN-1234', brandModel: 'Hilux' },
          request: { docNumber: 'CAR-1' }, carRequest: { destination: 'Bago, "East"', startDate: new Date('2026-11-01T18:00:00Z') },
        },
        {
          id: 'a2', vehicleId: 'v1', startOdoKm: 1040, endOdoKm: null,
          startOdoAt: new Date('2026-11-05T01:00:00Z'), endOdoAt: null,
          startOdoPhoto: null, endOdoPhoto: null,
          driver: { name: 'U Aung' }, vehicle: { vehicleNo: 'YGN-1234', brandModel: 'Hilux' },
          request: { docNumber: 'CAR-2' }, carRequest: { destination: 'Mandalay', startDate: new Date('2026-11-05T01:00:00Z') },
        },
      ],
    });
    const out = await svc.vehicleUsageCsv('2026-11');
    assert.strictEqual(out.filename, 'vehicle-usage-2026-11.csv');
    assert.ok(out.csv.startsWith('﻿'), 'Excel needs the UTF-8 BOM');
    assert.ok(out.csv.includes('"Bago, ""East"""'), 'commas and quotes are escaped');
    assert.ok(out.csv.includes('PENDING'), 'a trip without a return reading stays visible');
    assert.ok(out.csv.includes('SUBTOTAL') && out.csv.includes('ALL VEHICLES'));
    assert.ok(out.csv.includes(',40,'), 'the complete trip carries its distance');
  });

  await test('odometerMissingNudge: one nudge per assignment, with what is missing', async () => {
    const rows = [
      { id: 'a1', startOdoKm: null, endOdoKm: null, driver: { name: 'U Aung' }, vehicle: { vehicleNo: 'YGN-1234' }, request: { id: 'r1', docNumber: 'CAR-202611-0001' } },
    ];
    const notified: any[] = [];
    const updates: any[] = [];
    const audits: any[] = [];
    const prisma: any = {
      carAssignment: {
        findMany: async () => rows,
        findUnique: async () => null,
        findFirst: async () => null,
        update: async (a: any) => { updates.push(a); return {}; },
        count: async () => 1,
      },
      auditLog: { create: async (a: any) => { audits.push(a); return {}; } },
    };
    const notifications: any = { notifyMany: async (ids: string[], data: any) => notified.push({ ids, data }) };
    const permissions: any = { usersWithPermissions: async () => ['admin-1', 'admin-2'] };
    const svc: any = new TripRemindersService(prisma, notifications, {} as any, permissions);
    await svc.odometerMissingNudge();
    assert.strictEqual(notified.length, 1, 'one message per assignment');
    assert.deepStrictEqual(notified[0].ids, ['admin-1', 'admin-2']);
    assert.ok(/departure/.test(notified[0].data.body) && /return/.test(notified[0].data.body));
    assert.strictEqual(notified[0].data.link, '/requests/r1');
    assert.ok(updates[0].data.odoNudgeAt instanceof Date, 'the nudge is stamped so it repeats at most daily');
    assert.strictEqual(audits[0].data.action, 'CAR_ODOMETER_NUDGE');
  });


  await test('vehicleUsage: fuel for the month is summed per vehicle and priced per km', async () => {
    const { svc } = build({
      usageRows: [
        {
          id: 'a1', vehicleId: 'v1', startOdoKm: 1000, endOdoKm: 1100,
          startOdoAt: new Date('2026-11-02T01:00:00Z'), endOdoAt: new Date('2026-11-02T09:00:00Z'),
          startOdoPhoto: null, endOdoPhoto: null,
          driver: { name: 'U Aung' }, vehicle: { vehicleNo: 'YGN-1234', brandModel: 'Hilux' },
          request: { docNumber: 'CAR-1' }, carRequest: { destination: 'Bago', startDate: new Date('2026-11-02T01:00:00Z') },
        },
      ],
      fuelRows: [
        { vehicleId: 'v1', amount: '90000' },
        { vehicleId: 'v1', amount: 50000 },
      ],
    });
    const res = await svc.vehicleUsage('2026-11');
    assert.strictEqual(res.vehicles[0].fuelCost, 140000);
    assert.strictEqual(res.vehicles[0].fuelCostPerKm, 1400, '140,000 MMK over 100 km');
    assert.strictEqual(res.grandTotalFuel, 140000);
    const csv = await svc.vehicleUsageCsv('2026-11');
    assert.ok(csv.csv.includes('Fuel cost (MMK)') && csv.csv.includes('1400'));
  });

  await test('shiftHandoverDigest: today\'s distance is reported per vehicle (shared ride once)', async () => {
    const odo = (plate: string, a: number, b: number, group: string | null) => ({
      startOdoKm: a, endOdoKm: b,
      vehicle: { vehicleNo: plate },
      carRequest: { sharedTripId: group },
    });
    const prisma: any = {
      carAssignment: { findMany: async (args: any) => (args?.where?.endOdoAt ? [odo('YGN-1234', 1000, 1040, null), odo('YGN-1234', 2000, 2020, 'g1'), odo('YGN-1234', 2000, 2020, 'g1')] : []) },
      carRequest: { findMany: async () => [] },
      vehicleUnavailability: { findMany: async () => [] },
      user: { findMany: async () => [{ telegramChatId: '777' }] },
    };
    const sent: string[] = [];
    const telegram: any = { sendRaw: async (_chat: string, text: string) => { sent.push(text); } };
    const svc: any = new TripRemindersService(prisma, { notifyMany: async () => undefined } as any, telegram, { usersWithPermissions: async () => ['a1'] } as any);
    await svc.shiftHandoverDigest();
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].includes("Today's distance"), 'the digest carries the day\'s distance');
    assert.ok(sent[0].includes('60 km'), '40 + 20 shared counted once');
    assert.ok(sent[0].includes('YGN-1234'));
  });


  await test('vehicleUsageTrend: six months of distance per vehicle, fuel per km, and the flag', async () => {
    const row = (id: string, plate: string, kmStart: number, kmEnd: number, at: string) => ({
      vehicleId: id, startOdoKm: kmStart, endOdoKm: kmEnd, endOdoAt: new Date(at),
      vehicle: { vehicleNo: plate, brandModel: null }, carRequest: { sharedTripId: null },
    });
    const { svc } = build({
      usageRows: [
        row('v1', 'YGN-1234', 1000, 1100, '2026-10-12T03:00:00Z'),
        row('v1', 'YGN-1234', 1100, 1200, '2026-11-03T03:00:00Z'),
        row('v2', 'YGN-5678', 500, 600, '2026-11-04T03:00:00Z'),
      ],
      fuelRows: [
        { vehicleId: 'v1', amount: 400000, expenseDate: new Date('2026-11-05T03:00:00Z') },
        { vehicleId: 'v2', amount: 30000, expenseDate: new Date('2026-11-06T03:00:00Z') },
      ],
    });
    const res = await svc.vehicleUsageTrend('2026-11', 6);
    assert.deepStrictEqual(res.months, ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    const v1 = res.vehicles.find((v: any) => v.vehicleId === 'v1');
    assert.strictEqual(v1.series.length, 6);
    assert.strictEqual(v1.series[4].totalKm, 100, 'October distance');
    assert.strictEqual(v1.series[5].totalKm, 100, 'November distance');
    assert.strictEqual(v1.series[5].fuelPerKm, 4000, '400,000 MMK over 100 km');
    assert.strictEqual(v1.totalKm, 200);
    assert.strictEqual(v1.flagged, true, '4,000 vs fleet 1,433 MMK/km');
    const v2 = res.vehicles.find((v: any) => v.vehicleId === 'v2');
    assert.strictEqual(v2.flagged, false);
    assert.strictEqual(Math.round(res.fleetFuelPerKm), 1433, '430,000 MMK over 300 km');
    assert.strictEqual(res.vehicles[0].vehicleNo, 'YGN-1234', 'sorted by plate');
  });

  await test('weeklyUsageDigest: weekly km + fuel per vehicle, flags the expensive one', async () => {
    const prisma: any = {
      carAssignment: {
        findMany: async () => [
          { startOdoKm: 1000, endOdoKm: 1100, vehicle: { id: 'v1', vehicleNo: 'YGN-1234' }, carRequest: { sharedTripId: null } },
          { startOdoKm: 500, endOdoKm: 600, vehicle: { id: 'v2', vehicleNo: 'YGN-5678' }, carRequest: { sharedTripId: null } },
        ],
      },
      carExpense: {
        findMany: async () => [
          { vehicleId: 'v1', amount: 400000 },
          { vehicleId: 'v2', amount: 30000 },
        ],
      },
      user: { findMany: async () => [{ telegramChatId: '777' }] },
      carRequest: { findMany: async () => [] },
      vehicleUnavailability: { findMany: async () => [] },
    };
    const sent: string[] = [];
    const telegram: any = { sendRaw: async (_c: string, text: string) => { sent.push(text); } };
    const svc: any = new TripRemindersService(prisma, { notifyMany: async () => undefined } as any, telegram, { usersWithPermissions: async () => ['a1'] } as any);
    await svc.weeklyUsageDigest();
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].includes('Weekly fleet usage'));
    assert.ok(sent[0].includes('200 km'), '100 + 100 km driven');
    assert.ok(sent[0].includes('YGN-1234') && sent[0].includes('YGN-5678'));
    assert.ok(sent[0].includes('⚠️ high'), 'the 4,000 MMK/km vehicle is flagged');
    assert.strictEqual((sent[0].match(/⚠️ high/g) ?? []).length, 1, 'only the outlier is flagged');
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
