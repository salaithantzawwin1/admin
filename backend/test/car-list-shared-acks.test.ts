/**
 * Car Requests list — shared-trip ACK lane.
 *
 * A shared ride is ONE car, ONE driver and ONE set of taps (sharedTripId group).
 * A member row can carry an assignment of its own with no taps, or none at all,
 * while the driver already tapped ✓ Noted / 🚦 Ready / 🏁 Back at office on the
 * partner row. The list used to draw "⏳ Noted" for that member, so the trip read
 * as unacknowledged in Car Requests even though the detail panel was correct.
 *
 * Contract: GET /requests?docType=CAR_REQUEST attaches `carRequest.sharedRide`
 * (the group's taps, same shape as the detail panel) whenever this row has no
 * taps of its own — and never overrides a row that has them.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/car-list-shared-acks.test.ts
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

const ACTOR = { userId: 'u-admin', username: 'sysadmin' };
const GROUP = '11111111-1111-4111-8111-111111111111';

function makeService(rows: any[], groupMembers: any[]) {
  const prisma: any = {
    requestDocument: {
      findMany: async () => rows,
      count: async () => rows.length,
    },
    carRequest: {
      findMany: async (a: any) => {
        const ids = a?.where?.sharedTripId?.in ?? [];
        return groupMembers.filter((m) => ids.includes(m.sharedTripId));
      },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  const { WorkflowService } = require('../src/workflow/workflow.service');
  const noop = async () => undefined;
  return new WorkflowService(prisma, {} as any, { notifyMany: noop, notify: noop } as any, { log: noop } as any);
}

async function list(rows: any[], groupMembers: any[]) {
  const svc: any = makeService(rows, groupMembers);
  const res = await svc.list({ page: 1, pageSize: 20, docType: 'CAR_REQUEST', mine: true }, ACTOR);
  return res.items as any[];
}

async function main() {
  console.log('\n-- Car Requests list: shared-trip ack lane --');

  await test('a shared member with NO own taps shows the group taps (CAR-202610-0081 / 0084 regression)', async () => {
    const noted = new Date('2026-10-30T04:00:00Z');
    const ready = new Date('2026-10-30T04:20:00Z');
    const rows = [
      {
        id: 'r-84', docNumber: 'CAR-202610-0084', status: 'IN_PROGRESS',
        carRequest: {
          vehicleId: 'v1', driver: { name: 'Lay Win' }, sharedTripId: GROUP,
          assignment: { driverNotedAt: null, driverArrivedAt: null, driverBackAtOfficeAt: null, estimatedReturnAt: null },
        },
      },
      {
        id: 'r-81', docNumber: 'CAR-202610-0081', status: 'IN_PROGRESS',
        carRequest: {
          vehicleId: 'v1', driver: { name: 'Lay Win' }, sharedTripId: GROUP,
          assignment: { driverNotedAt: noted, driverArrivedAt: ready, driverBackAtOfficeAt: null, estimatedReturnAt: null },
        },
      },
    ];
    const items = await list(rows, [
      { sharedTripId: GROUP, request: { docNumber: 'CAR-202610-0081' }, assignment: { driverNotedAt: noted, driverArrivedAt: ready, driverBackAtOfficeAt: null } },
      { sharedTripId: GROUP, request: { docNumber: 'CAR-202610-0084' }, assignment: { driverNotedAt: null, driverArrivedAt: null, driverBackAtOfficeAt: null } },
    ]);
    const member = items.find((i) => i.docNumber === 'CAR-202610-0084')!;
    assert.ok(member.carRequest.sharedRide, 'the shared member must carry the group taps');
    assert.strictEqual(member.carRequest.sharedRide.notedAt, noted);
    assert.strictEqual(member.carRequest.sharedRide.arrivedAt, ready);
    assert.strictEqual(member.carRequest.sharedRide.docNumber, 'CAR-202610-0081', 'the lane names the row the taps came from');
    assert.strictEqual(member.carRequest.sharedTripId, GROUP, 'the list keeps the group id so the client can label the ride');
  });

  await test('own taps always win — no sharedRide is attached (and never overrides)', async () => {
    const ownNoted = new Date('2026-10-30T05:00:00Z');
    const rows = [
      {
        id: 'r-81', docNumber: 'CAR-202610-0081', status: 'IN_PROGRESS',
        carRequest: {
          vehicleId: 'v1', sharedTripId: GROUP,
          assignment: { driverNotedAt: ownNoted, driverArrivedAt: null, driverBackAtOfficeAt: null, estimatedReturnAt: null },
        },
      },
    ];
    const items = await list(rows, [
      { sharedTripId: GROUP, request: { docNumber: 'CAR-202610-0081' }, assignment: { driverNotedAt: new Date('2026-10-30T09:00:00Z'), driverArrivedAt: null, driverBackAtOfficeAt: null } },
    ]);
    assert.strictEqual(items[0].carRequest.sharedRide, undefined, 'own row keeps its own taps');
  });

  await test('a solo (unshared) row is untouched — no group lookup, no sharedRide', async () => {
    const rows = [
      {
        id: 'r-90', docNumber: 'CAR-202610-0090', status: 'IN_PROGRESS',
        carRequest: { vehicleId: 'v2', sharedTripId: null, assignment: { driverNotedAt: null, driverArrivedAt: null, driverBackAtOfficeAt: null, estimatedReturnAt: null } },
      },
    ];
    const items = await list(rows, []);
    assert.strictEqual(items[0].carRequest.sharedRide, undefined);
  });

  await test('a shared group where NOBODY has tapped yet stays pending (no phantom ✓)', async () => {
    const rows = [
      {
        id: 'r-95', docNumber: 'CAR-202610-0095', status: 'IN_PROGRESS',
        carRequest: { vehicleId: 'v3', sharedTripId: GROUP, assignment: { driverNotedAt: null, driverArrivedAt: null, driverBackAtOfficeAt: null, estimatedReturnAt: null } },
      },
    ];
    const items = await list(rows, [
      { sharedTripId: GROUP, request: { docNumber: 'CAR-202610-0095' }, assignment: { driverNotedAt: null, driverArrivedAt: null, driverBackAtOfficeAt: null } },
    ]);
    assert.strictEqual(items[0].carRequest.sharedRide, undefined, 'an untouched group must still read as waiting');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
