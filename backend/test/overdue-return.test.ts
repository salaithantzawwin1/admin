/**
 * Overdue-return guard — Step 1 (docs/OVERDUE_RETURN_GUARD_PLAN.md).
 *
 * Pins what the janitor now does with a ride that left the office and never came
 * back: hold it (assignment live, vehicle IN_USE, one audit) instead of
 * auto-completing it (CAR-202611-0039 was freed 15 minutes after its window
 * while the driver was still on the road). Also pins that the vehicle self-heal
 * counts that hold, and that the convoy branch still runs FIRST — a convoy
 * partner carries no tap of its own and must close with its group, not be held
 * for ever.
 *
 * Mock Prisma, REAL TripRemindersService. No DB, no HTTP.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/overdue-return.test.ts
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

const { TripRemindersService } = require('../src/cars/trip-reminders.service');
const { isOutOnRoad, outOnRoadWhere } = require('../src/cars/overdue.util');

const endedAgo = (mins: number) => new Date(Date.now() - mins * 60 * 1000);

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'a1', requestId: 'r1', vehicleId: 'v1', driverId: 'd1',
    releasedAt: null,
    driverNotedAt: endedAgo(200),
    driverArrivedAt: endedAgo(190), // Ready tapped — the car left the office
    driverBackAtOfficeAt: null,
    startOdoKm: null, startOdoAt: null, endOdoAt: null, estimatedReturnAt: null,
    vehicle: { vehicleNo: '9F1213' },
    driver: { name: 'Naing Naing Tun' },
    request: {
      docNumber: 'CAR-202611-0039', requesterId: 'u-req',
      carRequest: { endDate: endedAgo(180), sharedTripId: null },
    },
    ...over,
  };
}

/** One releaseExpired harness: sweep rows, convoy peers, other live holders. */
function sweep(rowOver: Record<string, unknown> = {}, opts: { peers?: any[]; holders?: any[] } = {}) {
  const ops: Array<[string, any]> = [];
  const audits: any[] = [];
  const vehicleRows: any[] = [];
  let sweepWhere: any = null;
  let vehicleQuery: any = null;
  const prisma: any = {
    carAssignment: {
      findMany: async ({ where }: any) => {
        if (where?.requestId?.not) return opts.peers ?? [];      // convoy peers
        if (where?.id?.not) return opts.holders ?? [];           // otherLiveHolders
        sweepWhere = where;
        return [row(rowOver)];
      },
      update: async (p: any) => { ops.push(['carAssignment.update', p.data]); return {}; },
    },
    vehicle: {
      update: async (p: any) => { ops.push(['vehicle.update', p.data]); return {}; },
      findMany: async (p: any) => { vehicleQuery = p; return vehicleRows; },
    },
    driver: {
      update: async (p: any) => { ops.push(['driver.update', p.data]); return {}; },
      findMany: async () => [],
    },
    carRequest: { update: async (p: any) => { ops.push(['carRequest.update', p.data]); return {}; } },
    requestDocument: { update: async (p: any) => { ops.push(['requestDocument.update', p.data]); return {}; } },
    auditLog: {
      create: async (p: any) => { ops.push(['auditLog.create', p.data]); audits.push(p.data); return {}; },
      // the 12 h throttle: report what this run already wrote for the request
      findFirst: async ({ where }: any) =>
        audits.find((l) => l.action === where.action && l.recordId === where.recordId) ?? null,
    },
    notification: { create: async (p: any) => { ops.push(['notification.create', p.data]); return {}; } },
    $transaction: async (list: any[]) => { for (const op of list) await op; },
  };
  const svc: any = new TripRemindersService(
    prisma,
    { notify: async () => ({}), notifyMany: async () => ({}) } as any,
    { sendRaw: async () => ({}), mirrorToUser: async () => ({}) } as any,
    { usersWithPermissions: async () => [] } as any,
  );
  return {
    svc, ops, audits, vehicleRows,
    sweepWhere: () => sweepWhere,
    vehicleQuery: () => vehicleQuery,
  };
}

const auditsOf = (t: any, action: string) =>
  t.ops.filter((o: any) => o[0] === 'auditLog.create' && o[1].action === action);
const writes = (t: any, model: string) => t.ops.filter((o: any) => o[0] === `${model}.update`);

async function main() {
  // ------------------------------------------------------------ 1) predicate
  await test('isOutOnRoad: a Ready tap alone is ride evidence', () => {
    assert.strictEqual(isOutOnRoad(row()), true);
  });

  await test('isOutOnRoad: a typed departure km alone is ride evidence', () => {
    assert.strictEqual(isOutOnRoad(row({ driverArrivedAt: null, driverNotedAt: null, startOdoKm: 341626 })), true);
  });

  await test('isOutOnRoad: a Back tap, a release or a return reading ends the hold', () => {
    assert.strictEqual(isOutOnRoad(row({ driverBackAtOfficeAt: new Date() })), false, 'Back tap closes the ride');
    assert.strictEqual(isOutOnRoad(row({ releasedAt: new Date() })), false, 'a released row is history');
    assert.strictEqual(isOutOnRoad(row({ endOdoAt: 341651 })), false, 'a return reading is proof of return');
  });

  await test('isOutOnRoad: a Noted-only row is not evidence the car left', () => {
    assert.strictEqual(isOutOnRoad(row({ driverArrivedAt: null })), false);
  });

  await test('outOnRoadWhere: one filter carries all three nulls and both evidence arms', () => {
    assert.strictEqual(outOnRoadWhere.releasedAt, null);
    assert.strictEqual(outOnRoadWhere.driverBackAtOfficeAt, null);
    assert.strictEqual(outOnRoadWhere.endOdoAt, null);
    assert.deepStrictEqual(outOnRoadWhere.OR, [
      { startOdoKm: { not: null } },
      { startOdoAt: { not: null } },
      { driverArrivedAt: { not: null } },
    ]);
  });

  // ------------------------------------------------- 2) janitor holds, no close
  await test('releaseExpired: ride out past its window is HELD, not auto-completed', async () => {
    const t = sweep();
    await t.svc.releaseExpired();
    assert.strictEqual(writes(t, 'carAssignment').length, 0, 'the assignment must stay live (no releasedAt write)');
    assert.strictEqual(writes(t, 'carRequest').length, 0, 'the request must not be re-queued or completed');
    assert.strictEqual(writes(t, 'requestDocument').length, 0, 'the base document must stay IN_PROGRESS');
    assert.strictEqual(writes(t, 'driver').length, 0, 'the driver is still on the road — do not free them');
    assert.ok(
      writes(t, 'vehicle').some((w: any) => w[1].status === 'IN_USE'),
      'the held car must be pinned IN_USE for the pickers and conflict checks',
    );
    assert.strictEqual(auditsOf(t, 'CAR_OVERDUE_RETURN_HELD').length, 1, 'the hold is audited once');
    assert.strictEqual(t.ops.filter((o: any) => o[0] === 'notification.create').length, 0,
      'no requester notice — the trip simply stays open');
  });

  await test('releaseExpired: the hold audit carries the ids and minutes over', async () => {
    const t = sweep();
    await t.svc.releaseExpired();
    const v = auditsOf(t, 'CAR_OVERDUE_RETURN_HELD')[0][1].newValue;
    assert.strictEqual(v.vehicleId, 'v1');
    assert.strictEqual(v.driverId, 'd1');
    assert.ok(v.minutesOver >= 178 && v.minutesOver <= 182, `minutesOver ~180 (got ${v.minutesOver})`);
    assert.strictEqual(v.auto, true);
  });

  await test('releaseExpired: a departure km without the Ready tap still holds the car', async () => {
    const t = sweep({ driverNotedAt: null, driverArrivedAt: null, startOdoKm: 341626 });
    await t.svc.releaseExpired();
    assert.strictEqual(auditsOf(t, 'CAR_OVERDUE_RETURN_HELD').length, 1);
    assert.strictEqual(writes(t, 'requestDocument').length, 0);
  });

  await test('releaseExpired: the hold audit is throttled to one per 12 h', async () => {
    const t = sweep();
    await t.svc.releaseExpired();
    await t.svc.releaseExpired(); // the next 30-minute tick sees the same row
    assert.strictEqual(auditsOf(t, 'CAR_OVERDUE_RETURN_HELD').length, 1, 'a 30-minute sweep must not repeat the audit');
  });

  // ------------------------------------------------ 3) the old paths still run
  await test('releaseExpired: Back tapped → COMPLETED (no hold, no notice)', async () => {
    const t = sweep({ driverBackAtOfficeAt: endedAgo(10), endOdoAt: 341651 });
    await t.svc.releaseExpired();
    assert.ok(writes(t, 'requestDocument').some((w: any) => w[1].status === 'COMPLETED'));
    assert.ok(writes(t, 'carAssignment').some((w: any) => w[1].releasedAt instanceof Date));
    assert.strictEqual(auditsOf(t, 'CAR_OVERDUE_RETURN_HELD').length, 0);
    assert.strictEqual(t.ops.filter((o: any) => o[0] === 'notification.create').length, 0,
      'the driver did tap — no "never tapped" notice');
  });

  await test('releaseExpired: no ride evidence → released to the pool as before', async () => {
    const t = sweep({ driverNotedAt: null, driverArrivedAt: null, startOdoKm: null });
    await t.svc.releaseExpired();
    assert.ok(writes(t, 'requestDocument').some((w: any) => w[1].status === 'APPROVED'));
    assert.ok(writes(t, 'carRequest').some((w: any) => w[1].vehicleId === null));
    assert.strictEqual(auditsOf(t, 'CAR_OVERDUE_RETURN_HELD').length, 0);
  });

  // ------------------------------------------------ 4) convoy ordering (Step 1.2)
  const sharedRow = (over: Record<string, unknown> = {}) => row({
    driverNotedAt: null,
    driverArrivedAt: null,
    ...over,
    request: {
      docNumber: 'CAR-202611-0039', requesterId: 'u-req',
      carRequest: { endDate: endedAgo(180), sharedTripId: 'group-1' },
    },
  });
  const peer = (over: Record<string, unknown> = {}) => ({
    releasedAt: null, driverBackAtOfficeAt: null, driverNotedAt: null, driverArrivedAt: null,
    request: { docNumber: 'CAR-202611-0040' },
    ...over,
  });

  await test('releaseExpired: a convoy partner with a live peer stays live (no hold on its own missing tap)', async () => {
    const t = sweep(sharedRow(), { peers: [peer({ releasedAt: null })] });
    await t.svc.releaseExpired();
    assert.strictEqual(auditsOf(t, 'CAR_OVERDUE_RETURN_HELD').length, 0,
      'the convoy branch must run before the hold — a partner never carries the Back stamp');
    assert.strictEqual(writes(t, 'requestDocument').length, 0, 'the member stays open with its group');
    assert.strictEqual(writes(t, 'carAssignment').length, 0);
  });

  await test('releaseExpired: a convoy member closes with its group once the group rode', async () => {
    const t = sweep(sharedRow({ driverArrivedAt: endedAgo(190) }), {
      peers: [peer({ releasedAt: endedAgo(5), driverNotedAt: endedAgo(200), driverArrivedAt: endedAgo(190) })],
    });
    await t.svc.releaseExpired();
    assert.ok(writes(t, 'requestDocument').some((w: any) => w[1].status === 'COMPLETED'));
    assert.strictEqual(auditsOf(t, 'CAR_OVERDUE_RETURN_HELD').length, 0);
  });

  // ------------------------------------ 5) self-heal must not free the held car
  await test('renormalizeVehicleStatuses: the query counts a held ride as live', async () => {
    const t = sweep();
    await t.svc.renormalizeVehicleStatuses();
    const q = t.vehicleQuery().select.assignments;
    assert.strictEqual(q.where.releasedAt, null);
    assert.strictEqual(q.where.driverBackAtOfficeAt, null);
    assert.strictEqual(q.where.endOdoAt, null);
    assert.deepStrictEqual(q.where.OR, [
      { startOdoKm: { not: null } },
      { startOdoAt: { not: null } },
      { driverArrivedAt: { not: null } },
      { trip: { status: 'STARTED' } },
    ]);
  });

  await test('renormalizeVehicleStatuses: a held IN_USE car stays IN_USE (no VEHICLE_AUTO_FREED)', async () => {
    const t = sweep();
    t.vehicleRows.push({ id: 'v1', vehicleNo: '9F1213', carRequests: [], assignments: [{ id: 'a1' }] });
    await t.svc.renormalizeVehicleStatuses();
    assert.strictEqual(writes(t, 'vehicle').length, 0, 'the held car must survive the 30-minute self-heal');
    assert.strictEqual(auditsOf(t, 'VEHICLE_AUTO_FREED').length, 0);
  });

  await test('renormalizeVehicleStatuses: a genuinely idle IN_USE car is still freed', async () => {
    const t = sweep();
    t.vehicleRows.push({ id: 'v2', vehicleNo: '2P2942', carRequests: [], assignments: [] });
    await t.svc.renormalizeVehicleStatuses();
    assert.ok(writes(t, 'vehicle').some((w: any) => w[1].status === 'AVAILABLE'), 'an orphaned flag is still repaired');
    assert.strictEqual(auditsOf(t, 'VEHICLE_AUTO_FREED').length, 1);
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
