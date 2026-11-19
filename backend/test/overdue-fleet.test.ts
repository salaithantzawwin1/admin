/**
 * Overdue-return guard — Step 3 (badges, conflict check, busy lists) and
 * Step 4 (assign/reassign/release guards, pickers).
 *
 * A ride that left the office and never came back (Step 1's hold) was invisible
 * to every reader that only looked at STARTED trips: the fleet badge said
 * AVAILABLE, checkAvailability() said "free" and the driver was offered for the
 * next trip. These tests pin the union, the hand-back buffer and the shared-trip
 * exemption.
 *
 * Mock Prisma, REAL CarsService / FleetService. No DB, no HTTP.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/overdue-fleet.test.ts
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
const { FleetService } = require('../src/fleet/fleet.service');
const { outOnRoadWhere } = require('../src/cars/overdue.util');

const minsAgo = (m: number) => new Date(Date.now() - m * 60000);

/** A held ride: the car left (Ready tap + departure km), no Back tap, window over. */
const heldRide = (over: Record<string, unknown> = {}) => ({
  vehicleId: 'v-held', driverId: 'd-held',
  releasedAt: null, driverBackAtOfficeAt: null, endOdoAt: null,
  startOdoKm: 341626, startOdoAt: minsAgo(240), driverArrivedAt: minsAgo(230),
  estimatedReturnAt: null, trip: null,
  request: { docNumber: 'CAR-202611-0039', carRequest: { endDate: minsAgo(180), sharedTripId: null } },
  ...over,
});

/** FleetService with the four queries listVehicles()/listDrivers()/busyDriverIds() make. */
function fleet(opts: { vehicles?: any[]; drivers?: any[]; rides?: any[] } = {}) {
  const rideQueries: any[] = [];
  const prisma: any = {
    vehicle: { findMany: async () => opts.vehicles ?? [] },
    driver: { findMany: async () => opts.drivers ?? [] },
    carRequest: { findMany: async () => [] },
    carAssignment: {
      findMany: async (p: any) => {
        rideQueries.push(p.where);
        return opts.rides ?? [];
      },
    },
    vehicleDocument: { findMany: async () => [] },
  };
  const svc: any = new FleetService(
    prisma, {} as any, {} as any, {} as any,
    { notify: async () => ({}) } as any,
    { usersWithPermissions: async () => [] } as any,
    {} as any,
  );
  return { svc, rideQueries };
}

/** CarsService with prisma shaped for requesterFleetOverview(). */
function overview(rides: any[]) {
  const prisma: any = {
    carAssignment: { findMany: async (p: any) => (p.where.driverBackAtOfficeAt ? [] : rides) },
    carRequest: { findMany: async () => [] },
    vehicle: { findMany: async () => [{ id: 'v-held', vehicleNo: '9F1213', brandModel: 'HiAce', status: 'IN_USE' }] },
    vehicleUnavailability: { findMany: async () => [] },
  };
  const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc };
}

/** CarsService with prisma shaped for checkAvailability()/overlaps(). */
function availability(heldRows: any[], own: any = null) {
  const prisma: any = {
    carAssignment: { findMany: async (p: any) => (p.where.OR ? heldRows : []) },
    carRequest: { findMany: async () => [], findUnique: async () => own },
    vehicleUnavailability: { findFirst: async () => null },
  };
  const timetable = { fleetBufferMinutes: async () => 30 };
  const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, timetable as any);
  return { svc };
}

async function main() {
  // ------------------------------------------------------- 1) fleet badges
  await test('listVehicles: a held ride reads IN_USE + overdueReturn', async () => {
    const t = fleet({
      vehicles: [
        { id: 'v-held', vehicleNo: '9F1213', status: 'IN_USE' },
        { id: 'v-idle', vehicleNo: '2P2942', status: 'AVAILABLE' },
      ],
      rides: [{ vehicleId: 'v-held', trip: null }],
    });
    const rows = await t.svc.listVehicles();
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    assert.strictEqual(byId['v-held'].status, 'IN_USE');
    assert.strictEqual(byId['v-held'].overdueReturn, true);
    assert.strictEqual(byId['v-idle'].status, 'AVAILABLE');
    assert.strictEqual(byId['v-idle'].overdueReturn, false);
    assert.ok(t.rideQueries[0].OR, 'the badge must union STARTED trips with the hold');
  });

  await test('listVehicles: a STARTED trip is IN_USE but not an overdue return', async () => {
    const t = fleet({
      vehicles: [{ id: 'v-started', vehicleNo: '9F1213', status: 'IN_USE' }],
      rides: [{ vehicleId: 'v-started', trip: { status: 'STARTED' } }],
    });
    const [row] = await t.svc.listVehicles();
    assert.strictEqual(row.status, 'IN_USE');
    assert.strictEqual(row.overdueReturn, false, 'the mileage close-out is a different stage');
  });

  await test('listDrivers: a driver on a held ride is ON_TRIP, not AVAILABLE', async () => {
    const t = fleet({
      drivers: [
        { id: 'd-held', name: 'Naing Naing Tun', status: 'ON_TRIP', licenseExpiry: null },
        { id: 'd-free', name: 'Aung Kyaw', status: 'ON_TRIP', licenseExpiry: null },
      ],
      rides: [{ driverId: 'd-held', estimatedReturnAt: null, trip: null }],
    });
    const rows = await t.svc.listDrivers();
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    assert.strictEqual(byId['d-held'].status, 'ON_TRIP');
    assert.strictEqual(byId['d-free'].status, 'AVAILABLE', 'a stale DB flag is still repaired');
  });

  await test('busyDriverIds: a held driver is busy for every window', async () => {
    const t = fleet({ rides: [{ driverId: 'd-held' }] });
    const ids = await t.svc.busyDriverIds(new Date(), new Date(Date.now() + 86400000));
    assert.deepStrictEqual(ids, ['d-held']);
  });

  await test('requesterFleetOverview: a held car stays IN_USE with the overdue flag', async () => {
    const t = overview([heldRide()]);
    const [row] = await t.svc.requesterFleetOverview();
    assert.strictEqual(row.status, 'IN_USE', 'every window on the row is past — the hold covers now');
    assert.strictEqual(row.overdueReturn, true);
  });

  // --------------------------------------------------- 2) conflict check
  const heldConflict = [{ requestId: 'r-held', request: { docNumber: 'CAR-202611-0039', carRequest: { sharedTripId: null } } }];

  await test('overlaps: a held car is not bookable inside the hand-back buffer', async () => {
    const t = availability(heldConflict);
    const now = Date.now();
    const r = await t.svc.checkAvailability(
      'v-held',
      new Date(now + 5 * 60000).toISOString(),
      new Date(now + 2 * 3600000).toISOString(),
    );
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.conflicts[0].request.docNumber, '🏁 Still out — return overdue');
    assert.strictEqual(r.conflicts[0].requestId, 'r-held');
    assert.ok(r.conflicts[0].startDate instanceof Date && r.conflicts[0].endDate > r.conflicts[0].startDate,
      'assign() and the picker read startDate/endDate off conflicts[0]');
  });

  await test('overlaps: tomorrow is still bookable while the car is out', async () => {
    const t = availability(heldConflict);
    const start = new Date(Date.now() + 24 * 3600000);
    const r = await t.svc.checkAvailability('v-held', start.toISOString(), new Date(start.getTime() + 3600000).toISOString());
    assert.strictEqual(r.available, true, 'the buffer guard must not block legitimate future work');
    assert.deepStrictEqual(r.conflicts, []);
  });

  await test('overlaps: a convoy may extend its own held ride', async () => {
    const t = availability(
      [{ requestId: 'r-peer', request: { docNumber: 'CAR-202611-0040', carRequest: { sharedTripId: 'group-1' } } }],
      { sharedTripId: 'group-1' },
    );
    const now = Date.now();
    const r = await t.svc.checkAvailability(
      'v-held',
      new Date(now + 5 * 60000).toISOString(),
      new Date(now + 3600000).toISOString(),
      'r-own',
    );
    assert.strictEqual(r.available, true, 'a hold inside the caller own group is not a foreign conflict');
  });

  // ------------------------------------------------------ 3) driver guard
  await test('driverClash: the held ride clashes whatever the new window is', async () => {
    const args: any[] = [];
    const prisma: any = {
      carRequest: {
        findFirst: async (p: any) => {
          args.push(p);
          return { startDate: minsAgo(240), endDate: minsAgo(180), sharedTripId: null, request: { docNumber: 'CAR-202611-0039' } };
        },
      },
    };
    const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    const start = new Date(Date.now() + 7 * 86400000);
    const hit = await svc.driverClash('d-held', { start, end: new Date(start.getTime() + 3600000) });
    assert.ok(hit, 'a driver still on the road cannot take next week either');
    const where = args[0].where;
    assert.ok(where.startDate.lt instanceof Date, 'the window net stays open-ended on the start side');
    assert.strictEqual(where.OR.length, 3);
    assert.deepStrictEqual(where.OR[2].assignment.OR, outOnRoadWhere.OR, 'the last arm is the hold, not another window');
  });

  // ------------------------------------------------- 4) assign / reassign guard
  const assignedRequest = (over: Record<string, unknown> = {}) => ({
    id: 'r1', docNumber: 'CAR-NEW', docType: 'CAR_REQUEST', status: 'APPROVED', requesterId: 'u1',
    carRequest: {
      id: 'cr1', requestId: 'r1', sharedTripId: null, assignment: null,
      startDate: new Date(Date.now() + 600000), endDate: new Date(Date.now() + 3600000),
    },
    ...over,
  });

  await test('assign(): a held vehicle is refused before anything is written', async () => {
    let wrote = false;
    const where: any[] = [];
    const prisma: any = {
      requestDocument: { findUnique: async () => assignedRequest() },
      vehicle: { findUnique: async () => ({ id: 'v-held', vehicleNo: '9F1213', brandModel: 'HiAce', status: 'IN_USE' }) },
      vehicleUnavailability: { findFirst: async () => null },
      carAssignment: { findMany: async (p: any) => { where.push(p.where); return [{ id: 'a-held' }]; } },
      $transaction: async () => { wrote = true; return null; },
    };
    const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    let msg = '';
    try { await svc.assign('r1', { vehicleId: 'v-held' }, { userId: 'u9', username: 'admin' }); } catch (e: any) { msg = e.message; }
    assert.ok(msg.includes('still out on an overdue trip'), `assign must refuse the held car, got: ${msg}`);
    assert.strictEqual(wrote, false, 'the hold is refused before the transaction');
    assert.strictEqual(where[0].vehicleId, 'v-held');
    assert.deepStrictEqual(where[0].OR, outOnRoadWhere.OR);
  });

  await test('assign(): the hold is re-checked inside the transaction', async () => {
    let upserted = false;
    const tx: any = {
      carAssignment: {
        findMany: async () => [{ id: 'a-held' }],
        upsert: async () => { upserted = true; return { id: 'a1' }; },
      },
      carRequest: { findMany: async () => [], update: async () => {} },
      requestDocument: { update: async () => {} },
      vehicle: { update: async () => {} },
      driver: { update: async () => {} },
    };
    const prisma: any = {
      requestDocument: { findUnique: async () => assignedRequest() },
      vehicle: { findUnique: async () => ({ id: 'v-held', vehicleNo: '9F1213', brandModel: 'HiAce', status: 'AVAILABLE' }) },
      vehicleUnavailability: { findFirst: async () => null },
      driverAbsence: { findFirst: async () => null },
      carRequest: { findFirst: async () => null },
      // the janitor holds the car AFTER the pre-check, before the insert
      carAssignment: { findMany: async () => [] },
      $transaction: async (fn: any) => fn(tx),
    };
    const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    let msg = '';
    try { await svc.assign('r1', { vehicleId: 'v-held' }, { userId: 'u9', username: 'admin' }); } catch (e: any) { msg = e.message; }
    assert.ok(msg.includes('still out on an overdue trip'), `the tx must refuse the raced hold, got: ${msg}`);
    assert.strictEqual(upserted, false);
  });

  const heldAssignment = (over: Record<string, unknown> = {}) => ({
    id: 'a1', requestId: 'r1', vehicleId: 'v-held', driverId: 'd-held', releasedAt: null,
    driverNotedAt: null, driverArrivedAt: minsAgo(230), driverBackAtOfficeAt: null,
    startOdoKm: 341626, startOdoAt: minsAgo(240), endOdoKm: null, endOdoAt: null,
    estimatedReturnAt: null, trip: null,
    vehicle: { vehicleNo: '9F1213' }, driver: { name: 'Naing Naing Tun' },
    ...over,
  });

  await test('reassign(): a held ride is refused — its evidence stays until the close', async () => {
    const prisma: any = {
      requestDocument: {
        findUnique: async () => ({
          id: 'r1', docNumber: 'CAR-202611-0039', docType: 'CAR_REQUEST', status: 'IN_PROGRESS', requesterId: 'u1',
          carRequest: {
            id: 'cr1', requestId: 'r1', sharedTripId: null,
            startDate: minsAgo(300), endDate: minsAgo(180),
            vehicle: { vehicleNo: '9F1213' }, assignment: heldAssignment(),
          },
        }),
      },
    };
    const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    let msg = '';
    try { await svc.reassign('r1', { vehicleId: 'v2' }, { userId: 'u9', username: 'admin' }); } catch (e: any) { msg = e.message; }
    assert.ok(msg.includes('return km'), `reassign must route to the manual close, got: ${msg}`);
  });

  await test('release(): a held ride is refused too (no APPROVED bounce, no wiped km)', async () => {
    let wrote = false;
    const prisma: any = {
      carAssignment: {
        findUnique: async () => ({
          ...heldAssignment(),
          request: { id: 'r1', status: 'IN_PROGRESS', carRequest: { startDate: minsAgo(300), endDate: minsAgo(180) } },
        }),
      },
      $transaction: async () => { wrote = true; },
    };
    const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    let msg = '';
    try { await svc.release('r1', { userId: 'u9', username: 'admin' }); } catch (e: any) { msg = e.message; }
    assert.ok(msg.includes('return km'), `release must route to the manual close, got: ${msg}`);
    assert.strictEqual(wrote, false);
  });

  // ------------------------------------------------------------------ summary
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error(failures.map((f) => `  ✗ ${f}`).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
