/**
 * Unit tests for the Car Request module fixes (critical + medium).
 *
 * Pure-logic tests run the REAL overlap / window-conflict rules; service-level
 * tests drive the REAL CarsService / TripRemindersService / TelegramCarActionsService
 * with a mock Prisma — the same spy-style harness as test/telegram-assign-e2e.ts.
 * No DB, no HTTP.
 *
 * Written in CommonJS-style TS (require + async main) so Node's module detection
 * never mistakes it for ESM under ts-node.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/cars-fixes.test.ts
 */
const assert = require('assert');

// ------------------------------------------------------------------ helpers
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

async function main() {
  // ------------------------------------------------------------------ 1) overlap rule (pure logic mirror of the SQL)
  const overlaps = (aS: Date, aE: Date, bS: Date, bE: Date) => aS < bE && aE > bS;

  await test('overlap rule: same-day windows intersect', () => {
    const d = (h: number) => new Date(Date.UTC(2026, 8, 24, h));
    assert.ok(overlaps(d(9), d(17), d(10), d(12)), 'inner window must overlap');
  });

  await test('overlap rule: touching endpoints do NOT overlap (end-exclusive)', () => {
    const d = (h: number) => new Date(Date.UTC(2026, 8, 24, h));
    assert.ok(!overlaps(d(9), d(12), d(12), d(15)), 'a.end == b.start must be free');
  });

  await test('overlap rule: rejected/cancelled bookings never counted', () => {
    // mirrored in SQL by request.status filter — terminal statuses excluded from ACTIVE set
    const ACTIVE = ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'];
    for (const s of ['REJECTED', 'CANCELLED', 'COMPLETED', 'DRAFT'] as const) {
      assert.ok(!ACTIVE.includes(s), `${s} must not block the calendar`);
    }
  });

  // ------------------------------------------------- 2) CarsService — window conflicts / overlaps / expenses
  const { CarsService } = require('../src/cars/cars.service');
  const captured: any[] = [];
  const seededConflicts = [
    { startDate: new Date('2026-09-24T09:00Z'), endDate: new Date('2026-09-24T12:00Z'), destination: 'Taunggyi', request: { docNumber: 'CAR-202609-0001' } },
  ];
  const prisma: any = {
    carRequest: {
      findMany: async (args: any) => {
        captured.push(args);
        return seededConflicts;
      },
      // overlaps() looks up the caller's own shared-trip group (null unless mocked)
      findUnique: async () => null,
    },
    carAssignment: { findMany: async () => [] },
    vehicleUnavailability: { findFirst: async () => null, findMany: async () => [] },
  };
  const svc: any = new CarsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);

  await test('checkWindowConflicts filters on request.status (mirror-safe), incl. SUBMITTED', async () => {
    await svc.checkWindowConflicts('2026-09-24T08:00Z', '2026-09-24T10:00Z');
    const where = captured[0].where;
    assert.ok(where.request, 'must filter via the base request relation');
    assert.deepStrictEqual(where.request.status.in, ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS']);
    assert.strictEqual(where.status, undefined, 'must NOT filter on the mirrored CarRequest.status');
  });

  await test('checkWindowConflicts rejects invalid/empty windows', async () => {
    let threw = '';
    try { await svc.checkWindowConflicts('2026-09-24T10:00Z', '2026-09-24T10:00Z'); } catch (e: any) { threw = e.message; }
    assert.strictEqual(threw, 'Invalid window');
  });

  await test('checkWindowConflicts returns doc numbers for the warning UI', async () => {
    const r = await svc.checkWindowConflicts('2026-09-24T08:00Z', '2026-09-24T10:00Z');
    assert.strictEqual(r.conflicts[0].request.docNumber, 'CAR-202609-0001');
  });

  await test('checkWindowConflicts: Back-at-Office clash is trimmed to the actual return time', async () => {
    // planned 10:45→11:45, driver returned 11:00 → effective clash window 10:45→11:00
    const returned: any[] = [
      {
        startDate: new Date('2026-09-24T10:45Z'), endDate: new Date('2026-09-24T11:45Z'), destination: 'Office run',
        assignment: { driverBackAtOfficeAt: new Date('2026-09-24T11:00Z') },
        request: { docNumber: 'CAR-202609-0006' },
      },
    ];
    const prismaBao: any = { carRequest: { findMany: async () => returned }, carAssignment: { findMany: async () => [] }, vehicleUnavailability: { findMany: async () => [] } };
    const svcBao: any = new CarsService(prismaBao, {} as any, {} as any, {} as any, {} as any, {} as any);
    // new request 11:10→12:10: overlaps the PLANNED end (11:45) but NOT the actual absence (ends 11:00)
    const r = await svcBao.checkWindowConflicts('2026-09-24T11:10Z', '2026-09-24T12:10Z');
    assert.strictEqual(r.conflicts.length, 0, 'clash fully inside the early-return gap must NOT warn');
  });

  await test('checkWindowConflicts: partial overlap before the return time still warns', async () => {
    const returned: any[] = [
      {
        startDate: new Date('2026-09-24T10:45Z'), endDate: new Date('2026-09-24T11:45Z'), destination: 'Office run',
        assignment: { driverBackAtOfficeAt: new Date('2026-09-24T11:00Z') },
        request: { docNumber: 'CAR-202609-0006' },
      },
    ];
    const prismaBao: any = { carRequest: { findMany: async () => returned }, carAssignment: { findMany: async () => [] }, vehicleUnavailability: { findMany: async () => [] } };
    const svcBao: any = new CarsService(prismaBao, {} as any, {} as any, {} as any, {} as any, {} as any);
    // new request 10:50→11:20: genuinely collides with the car until 11:00
    const r = await svcBao.checkWindowConflicts('2026-09-24T10:50Z', '2026-09-24T11:20Z');
    assert.strictEqual(r.conflicts.length, 1, 'genuine overlap before the return must still warn');
    assert.strictEqual(new Date(r.conflicts[0].endDate).toISOString(), '2026-09-24T11:00:00.000Z', 'warning shows the ACTUAL return time, not the planned end');
    assert.strictEqual(r.conflicts[0].assignment, undefined, 'internal assignment field must not leak to the UI payload');
  });

  await test('checkWindowConflicts: no Back-at-Office → planned window unchanged', async () => {
    const planned: any[] = [
      {
        startDate: new Date('2026-09-24T10:45Z'), endDate: new Date('2026-09-24T11:45Z'), destination: 'Office run',
        assignment: { driverBackAtOfficeAt: null },
        request: { docNumber: 'CAR-202609-0007' },
      },
    ];
    const prismaBao: any = { carRequest: { findMany: async () => planned }, carAssignment: { findMany: async () => [] }, vehicleUnavailability: { findMany: async () => [] } };
    const svcBao: any = new CarsService(prismaBao, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svcBao.checkWindowConflicts('2026-09-24T11:10Z', '2026-09-24T12:10Z');
    assert.strictEqual(r.conflicts.length, 1, 'without a return tap the planned end still blocks');
    assert.strictEqual(new Date(r.conflicts[0].endDate).toISOString(), '2026-09-24T11:45:00.000Z');
  });

  await test('overlaps(): excludeRequestId targets requestId (not CarRequest.id)', async () => {
    await svc.overlaps('veh1', new Date('2026-09-24T08:00Z'), new Date('2026-09-24T10:00Z'), 'req-42');
    const w = captured[captured.length - 1].where;
    assert.strictEqual(w.requestId.not, 'req-42', 'own booking must be excluded by requestId');
    assert.strictEqual(w.id, undefined, 'old buggy id-filter must be gone');
    assert.ok(w.request.status.in.includes('APPROVED'));
  });

  await test('overlaps(): Back-at-Office assignments exempt from blocking', async () => {
    const prismaBao: any = {
      carRequest: { findMany: async (args: any) => { captured.push(args); return []; } },
      carAssignment: { findMany: async () => [{ requestId: 'req-bao' }] },
      vehicleUnavailability: { findFirst: async () => null },
    };
    const svcBao: any = new CarsService(prismaBao, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svcBao.overlaps('veh1', new Date('2026-09-24T08:00Z'), new Date('2026-09-24T10:00Z'));
    assert.strictEqual(captured[captured.length - 1].where.requestId.notIn[0], 'req-bao');
    assert.strictEqual(r.available, true);
  });

  await test('overlaps(): shared-trip group members do not block each other', async () => {
    const GROUP = 'group-1';
    const prismaShared: any = {
      // DB row: the caller's shared-trip peer — the ONLY overlapping booking
      carRequest: {
        findMany: async () => [
          { requestId: 'req-peer', sharedTripId: GROUP, startDate: new Date(), endDate: new Date(), request: { docNumber: 'CAR-1' } },
        ],
        findUnique: async () => ({ sharedTripId: GROUP }),
      },
      carAssignment: { findMany: async () => [] },
      vehicleUnavailability: { findFirst: async () => null, findMany: async () => [] },
    };
    const svcShared: any = new CarsService(prismaShared, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svcShared.overlaps('veh1', new Date('2026-09-24T08:00Z'), new Date('2026-09-24T10:00Z'), 'req-mine');
    assert.strictEqual(r.available, true, 'only the same-group peer overlapped → available');
    assert.strictEqual(r.conflicts.length, 0);
  });

  await test('overlaps(): other bookings still block a shared-trip member', async () => {
    const prismaShared: any = {
      carRequest: {
        findMany: async () => [
          { requestId: 'req-stranger', sharedTripId: null, startDate: new Date(), endDate: new Date(), request: { docNumber: 'CAR-2' } },
        ],
        findUnique: async () => ({ sharedTripId: 'group-1' }),
      },
      carAssignment: { findMany: async () => [] },
      vehicleUnavailability: { findFirst: async () => null, findMany: async () => [] },
    };
    const svcShared: any = new CarsService(prismaShared, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svcShared.overlaps('veh1', new Date('2026-09-24T08:00Z'), new Date('2026-09-24T10:00Z'), 'req-mine');
    assert.strictEqual(r.available, false, 'a foreign booking still conflicts');
    assert.strictEqual(r.conflicts[0].request.docNumber, 'CAR-2');
  });

  await test('assign(): share=true without a driver is refused', async () => {
    const prismaAssign: any = {
      requestDocument: {
        findUnique: async () => ({
          id: 'r1', docType: 'CAR_REQUEST', status: 'APPROVED', requesterId: 'u1',
          carRequest: { id: 'cr1', requestId: 'r1', startDate: new Date(), endDate: new Date(), assignment: null },
        }),
      },
    };
    const svcAssign: any = new CarsService(prismaAssign, {} as any, {} as any, {} as any, {} as any, {} as any);
    let msg = '';
    try { await svcAssign.assign('r1', { vehicleId: 'v1', share: true }, { userId: 'u9', username: 'admin' }); } catch (e: any) { msg = e.message; }
    assert.strictEqual(msg, 'Shared trips need a driver — pick the driver of the trip you are joining');
  });

  await test('assign(): requester notification includes the driver name', async () => {
    const captured: any[] = [];
    const notifications = { notify: async (p: any) => { captured.push(p); } };
    const audit = { log: async () => {} };
    const telegram = { sendAssignment: async () => {}, repaintDriverCards: async () => {} };
    const tx = {
      carAssignment: { upsert: async () => ({ id: 'a1' }), findMany: async () => [] },
      carRequest: { update: async () => {}, findMany: async () => [] },
      requestDocument: { update: async () => {} },
      vehicle: { update: async () => {} },
      driver: { update: async () => {} },
    };
    const prismaDrv: any = {
      requestDocument: {
        findUnique: async () => ({
          id: 'r1', docNumber: 'r1', docType: 'CAR_REQUEST', status: 'APPROVED', requesterId: 'u1',
          carRequest: { id: 'cr1', requestId: 'r1', startDate: new Date(), endDate: new Date(), assignment: null },
        }),
      },
      vehicle: { findUnique: async () => ({ id: 'v1', vehicleNo: '2P2942', brandModel: ' Hyundai Grand Starex / 2011 (2497CC)', status: 'AVAILABLE' }) },
      vehicleUnavailability: { findFirst: async () => null },
      driverAbsence: { findFirst: async () => null },
      driver: { findUnique: async () => ({ name: 'Kyaw Thiha Maw' }), update: async () => {} },
      $transaction: async (fn: any) => fn(tx),
    };
    const svcDrv: any = new CarsService(prismaDrv, {} as any, {} as any, notifications, audit, telegram);
    await svcDrv.assign('r1', { vehicleId: 'v1', driverId: 'd1' }, { userId: 'u9', username: 'admin' });
    const bell = captured.find((n) => n.type === 'CAR_ASSIGNED' && n.title === 'Vehicle assigned to r1');
    assert.ok(bell, 'requester CAR_ASSIGNED notification must be sent');
    assert.ok(bell.body.includes('2P2942'), `body must still name the vehicle, got: ${bell.body}`);
    assert.ok(bell.body.includes('Driver Kyaw Thiha Maw'), `body must name the driver, got: ${bell.body}`);
    assert.ok(bell.body.includes('has been assigned for your trip'), 'body must keep the assigned-for-your-trip wording');
  });

  await test('assign(): requester notification without driver stays vehicle-only', async () => {
    const captured: any[] = [];
    const notifications = { notify: async (p: any) => { captured.push(p); } };
    const audit = { log: async () => {} };
    const telegram = { sendAssignment: async () => {}, repaintDriverCards: async () => {} };
    const tx = {
      carAssignment: { upsert: async () => ({ id: 'a1' }), findMany: async () => [] },
      carRequest: { update: async () => {}, findMany: async () => [] },
      requestDocument: { update: async () => {} },
      vehicle: { update: async () => {} },
      driver: { update: async () => {} },
    };
    const prismaNoDrv: any = {
      requestDocument: {
        findUnique: async () => ({
          id: 'r1', docNumber: 'r1', docType: 'CAR_REQUEST', status: 'APPROVED', requesterId: 'u1',
          carRequest: { id: 'cr1', requestId: 'r1', startDate: new Date(), endDate: new Date(), assignment: null },
        }),
      },
      vehicle: { findUnique: async () => ({ id: 'v1', vehicleNo: '2P2942', brandModel: ' Hyundai Grand Starex / 2011 (2497CC)', status: 'AVAILABLE' }) },
      vehicleUnavailability: { findFirst: async () => null },
      $transaction: async (fn: any) => fn(tx),
    };
    const svcNoDrv: any = new CarsService(prismaNoDrv, {} as any, {} as any, notifications, audit, telegram);
    await svcNoDrv.assign('r1', { vehicleId: 'v1' }, { userId: 'u9', username: 'admin' });
    const bell = captured.find((n) => n.type === 'CAR_ASSIGNED' && n.title === 'Vehicle assigned to r1');
    assert.ok(bell, 'requester CAR_ASSIGNED notification must be sent');
    assert.ok(!bell.body.includes('Driver'), `no driver line expected without driverId, got: ${bell.body}`);
    assert.ok(bell.body.includes('has been assigned for your trip.'), `vehicle-only wording expected, got: ${bell.body}`);
  });

  await test('requesterFleetOverview: Back-at-Office booking leaves the Booked list', async () => {
    const overviewCaptured: any[] = [];
    const prismaOv: any = {
      carAssignment: {
        findMany: async (args: any) => {
          // shape-aware: the overview's started-trips probe selects vehicleId +
          // carRequest.endDate; the Back-at-Office exemption probe selects requestId
          const sel = JSON.stringify(args.select || {});
          return sel.includes('carRequest') ? [] : [{ requestId: 'req-bao' }];
        },
      },
      vehicle: { findMany: async () => [{ id: 'v1', vehicleNo: '1G/5575', brandModel: 'dd test', status: 'AVAILABLE' }] },
      vehicleUnavailability: { findMany: async () => [] },
      carRequest: {
        findMany: async (args: any) => {
          overviewCaptured.push(args);
          // emulate the DB: honour the notIn (Back-at-Office exemption) filter
          const notIn: string[] = args.where?.requestId?.notIn ?? [];
          const rows = [
            { requestId: 'req-bao', vehicleId: 'v1', startDate: new Date(), endDate: new Date(), request: { docNumber: 'CAR-202609-0004' } },
            { requestId: 'req-live', vehicleId: 'v1', startDate: new Date(), endDate: new Date(), request: { docNumber: 'CAR-202609-0005' } },
          ];
          return rows.filter((r) => !notIn.includes(r.requestId));
        },
      },
    };
    const svcOv: any = new CarsService(prismaOv, {} as any, {} as any, {} as any, {} as any, {} as any);
    const out = await svcOv.requesterFleetOverview();
    assert.ok(overviewCaptured[0].where.requestId.notIn.includes('req-bao'), 'Back-at-Office booking must be excluded from Booked windows');
    assert.strictEqual(out[0].bookings.length, 1, 'only the live booking remains on the card');
    assert.strictEqual(out[0].bookings[0].docNumber, 'CAR-202609-0005');
  });

  await test('requesterFleetOverview: future booking shows BOOKED (not IN_USE), active shows IN_USE', async () => {
    const now = new Date();
    const in2h = new Date(now.getTime() + 2 * 3600 * 1000);
    const in4h = new Date(now.getTime() + 4 * 3600 * 1000);
    const ago1h = new Date(now.getTime() - 1 * 3600 * 1000);
    const in2h2 = new Date(now.getTime() + 2 * 3600 * 1000);
    const prismaBadge: any = {
      carAssignment: { findMany: async () => [] },
      vehicleUnavailability: { findMany: async () => [] },
      vehicle: {
        findMany: async () => [
          { id: 'v-future', vehicleNo: 'FUT/001', brandModel: 'future trip', status: 'IN_USE' },
          { id: 'v-active', vehicleNo: 'ACT/002', brandModel: 'on the road', status: 'IN_USE' },
          { id: 'v-maint', vehicleNo: 'MNT/003', brandModel: 'workshop', status: 'UNDER_MAINTENANCE' },
          { id: 'v-idle', vehicleNo: 'IDL/004', brandModel: 'free pool', status: 'AVAILABLE' },
        ],
      },
      carRequest: {
        findMany: async () => [
          // committed for LATER today — car is physically free NOW (the user's bug)
          { requestId: 'r-fut', vehicleId: 'v-future', startDate: in2h, endDate: in4h, request: { docNumber: 'CAR-202610-0003' } },
          // window covering now → genuinely on the road
          { requestId: 'r-act', vehicleId: 'v-active', startDate: ago1h, endDate: in2h2, request: { docNumber: 'CAR-202610-0007' } },
        ],
      },
    };
    const svcBadge: any = new CarsService(prismaBadge, {} as any, {} as any, {} as any, {} as any, {} as any);
    const out = await svcBadge.requesterFleetOverview();
    const byId = Object.fromEntries(out.map((v: any) => [v.id, v]));
    assert.strictEqual(byId['v-future'].status, 'BOOKED', 'future-only booking → BOOKED (committed, not rolling)');
    assert.strictEqual(byId['v-future'].bookings.length, 1, 'the booked window is still listed');
    assert.strictEqual(byId['v-active'].status, 'IN_USE', 'a booking whose window covers now → IN_USE');
    assert.strictEqual(byId['v-maint'].status, 'UNDER_MAINTENANCE', 'physical workshop state kept verbatim');
    assert.strictEqual(byId['v-idle'].status, 'AVAILABLE', 'plain pool car stays AVAILABLE');
  });

  // ------------------------------------------ 3) expense access control
  const expenseRows = [{ id: 'e1' }];
  const prismaExp: any = {
    requestDocument: {
      findUnique: async ({ where: { id } }: any) =>
        id === 'req-mine' ? { requesterId: 'u-owner' } : id === 'req-other' ? { requesterId: 'u-someone' } : null,
    },
    carAssignment: { findUnique: async () => ({ trip: { id: 't1' } }) },
    carExpense: { findMany: async () => expenseRows, create: async () => ({}) },
  };
  const permsExp: any = { userHas: async (userId: string, code: string) => code === 'cars.assign' && userId === 'u-admin' };
  const svcExp: any = new CarsService(prismaExp, permsExp, {} as any, {} as any, {} as any, {} as any);

  await test('listExpenses: Administration (cars.assign) can read any trip expenses', async () => {
    const rows = await svcExp.listExpenses('req-other', { userId: 'u-admin', username: 'admin' });
    assert.strictEqual(rows, expenseRows);
  });

  await test('listExpenses: the requester reads their OWN trip expenses', async () => {
    const rows = await svcExp.listExpenses('req-mine', { userId: 'u-owner', username: 'owner' });
    assert.strictEqual(rows, expenseRows);
  });

  const statusOf = (e: any) => e.status ?? e.getStatus?.() ?? 0;

  await test('listExpenses: unrelated user is forbidden (403)', async () => {
    let code = 0;
    try { await svcExp.listExpenses('req-mine', { userId: 'u-stranger', username: 'x' }); } catch (e: any) { code = statusOf(e); }
    assert.strictEqual(code, 403);
  });

  await test('listExpenses: unknown request → 404', async () => {
    let code = 0;
    try { await svcExp.listExpenses('req-ghost', { userId: 'u-admin', username: 'admin' }); } catch (e: any) { code = statusOf(e); }
    assert.strictEqual(code, 404);
  });

  await test('addExpense: requester cannot add expenses to someone else’s trip', async () => {
    let code = 0;
    try { await svcExp.addExpense('req-other', { type: 'FUEL', amount: 1000 }, { userId: 'u-owner', username: 'owner' }); } catch (e: any) { code = statusOf(e); }
    assert.strictEqual(code, 403);
  });

  // ------------------------------------------------- 4) TripRemindersService escalation filters
  const { TripRemindersService } = require('../src/cars/trip-reminders.service');
  const cronCaptured: any[] = [];
  const prismaCron: any = {
    carAssignment: {
      findMany: async (args: any) => { cronCaptured.push(args); return []; },
    },
    notification: { findFirst: async () => null, findMany: async () => [] },
    carRequest: { findMany: async (args: any) => { cronCaptured.push(args); return []; } },
    auditLog: { create: async () => ({}), findFirst: async () => null },
  };
  const svcCron: any = new TripRemindersService(
    prismaCron,
    { notify: async () => ({}), notifyMany: async () => ({}) } as any,
    { sendRaw: async () => ({}) } as any,
    { usersWithPermissions: async () => [] } as any,
  );

  await test('runOnce (reminder): uses base request status APPROVED/IN_PROGRESS (mirror-safe)', async () => {
    await svcCron.runOnce();
    const where = cronCaptured[0].where; // first capture = runOnce carRequest query
    assert.ok(where.request, 'must filter via the base request relation');
    assert.deepStrictEqual([...where.request.status.in], ['APPROVED', 'IN_PROGRESS']);
  });

  await test('escalateUnacknowledged: skips drivers who already tapped Noted', async () => {
    await svcCron.escalateUnacknowledged();
    const where = cronCaptured[cronCaptured.length - 1].where;
    assert.strictEqual(where.driverNotedAt, null, 'Noted-acknowledged assignments must be filtered out');
    assert.strictEqual(where.trip, null);
  });

  // ------------------------------------------------- 5) workflow status-mirror plumbing
  const { WorkflowService } = require('../src/workflow/workflow.service');
  const txWrites: { requestId: string; data: { status?: string } }[] = [];
  const tx: any = { carRequest: { update: async ({ where, data }: any) => { txWrites.push({ requestId: where.requestId, data }); } } };
  const prismaWf: any = {
    requestDocument: { findFirst: async () => ({ docType: 'CAR_REQUEST' }) },
  };
  const svcWf: any = new WorkflowService(prismaWf, {} as any, {} as any, {} as any);

  await test('registerStatusMirror fires inside a transaction', async () => {
    let called = 0;
    svcWf.registerStatusMirror('CAR_REQUEST', async (requestId: string, status: string, client: any) => {
      called++;
      await client.carRequest.update({ where: { requestId }, data: { status } });
    });
    await svcWf.mirrorStatus('CAR_REQUEST', 'req-1', 'APPROVED', tx);
    assert.strictEqual(called, 1);
    assert.deepStrictEqual(txWrites[0], { requestId: 'req-1', data: { status: 'APPROVED' } });
  });

  await test('mirror failure never blocks the workflow transition', async () => {
    svcWf.registerStatusMirror('CAR_REQUEST', async () => { throw new Error('boom'); });
    await svcWf.mirrorStatus('CAR_REQUEST', 'req-2', 'REJECTED', tx); // must not throw
  });

  await test('docTypes without a mirror are a no-op', async () => {
    await svcWf.mirrorStatus('GENERIC_REQUEST', 'req-3', 'PENDING_APPROVAL', tx); // must not throw
  });

  // ------------------------------------------------- 6) Telegram assign surface — mirror-safe busy query
  const { TelegramCarActionsService } = require('../src/cars/telegram-car-actions.service');
  const tgCaptured: any[] = [];
  const CR = { startDate: new Date('2026-09-24T08:00Z'), endDate: new Date('2026-09-24T17:00Z'), destination: 'Naypyitaw' };
  const prismaTg: any = {
    requestDocument: { findUnique: async () => ({ id: 'req-1', docNumber: 'CAR-1', requester: { fullName: 'A B' }, carRequest: CR }) },
    carRequest: { findMany: async (args: any) => { tgCaptured.push(args); return []; } },
    vehicle: { findMany: async () => [{ id: 'v1', vehicleNo: 'YC-1', brandModel: 'Hiace' }] },
    driver: { findMany: async (args: any) => { tgCaptured.push(args); return []; } },
    driverAbsence: { findMany: async () => [] },
    vehicleUnavailability: { findMany: async () => [] },
  };
  const svcTg: any = new TelegramCarActionsService(
    prismaTg,
    {} as any,
    {} as any,
    {} as any,
    { sendRaw: async () => ({}), answer: async () => ({}), editCallbackMessage: async () => ({}), peekCallbackMessage: () => undefined } as any,
    {} as any,
  );

  await test('offerAssignVehicle busy list filters on request.status IN_PROGRESS (mirror-safe)', async () => {
    await svcTg.offerAssignVehicle('req-1', 'chat-1');
    // busy query args shape: { where: { ..., request: { status }, select:... }, select: { vehicleId: true } }
    const vehicleBusy = tgCaptured.find((c) => c.select?.vehicleId && c.where?.request);
    assert.ok(vehicleBusy, 'vehicle busy query must run');
    assert.strictEqual(vehicleBusy.where.request.status, 'IN_PROGRESS');
  });

  // ------------------------------------------------- 7) releaseExpired auto-close rules (729dc02)
  const mkReleasePrisma = (rows: any[]) => {
    const ops: Array<[string, any]> = [];
    let capturedWhere: any = null;
    const prisma: any = {
      carAssignment: {
        findMany: async ({ where }: any) => { capturedWhere = where; return rows; },
        update: async (p: any) => { ops.push(['carAssignment.update', p.data]); return {}; },
      },
      vehicle: { update: async (p: any) => { ops.push(['vehicle.update', p.data]); return {}; } },
      driver: { update: async (p: any) => { ops.push(['driver.update', p.data]); return {}; }, findMany: async () => [] },
      carRequest: { update: async (p: any) => { ops.push(['carRequest.update', p.data]); return {}; } },
      requestDocument: { update: async (p: any) => { ops.push(['requestDocument.update', p.data]); return {}; } },
      auditLog: { create: async (p: any) => { ops.push(['auditLog.create', p.data]); return {}; } },
      notification: { create: async (p: any) => { ops.push(['notification.create', p.data]); return {}; } },
      $transaction: async (list: any[]) => { for (const op of list) await op; },
    };
    return { prisma, ops, where: () => capturedWhere };
  };
  const mkRow = (over: Record<string, unknown> = {}) => ({
    id: 'a1', requestId: 'r1', vehicleId: 'v1', driverId: 'd1', releasedAt: null,
    driverNotedAt: new Date(), driverArrivedAt: null, driverBackAtOfficeAt: null,
    vehicle: { vehicleNo: 'V-1' },
    request: { docNumber: 'CAR-202609-0999', requesterId: 'u1', carRequest: { endDate: new Date(Date.now() - 3600 * 1000) } },
    ...over,
  });
  const mkRelSvc = (prisma: any) =>
    new TripRemindersService(
      prisma,
      { notify: async () => ({}), notifyMany: async () => ({}) } as any,
      { sendRaw: async () => ({}), mirrorToUser: async () => ({}) } as any,
      { usersWithPermissions: async () => [] } as any,
    );

  await test('releaseExpired: acknowledged expired trip → COMPLETED + audit + requester notice + driver freed', async () => {
    const t = mkReleasePrisma([mkRow()]);
    await mkRelSvc(t.prisma).releaseExpired();
    assert.ok(t.ops.some((o) => o[0] === 'requestDocument.update' && o[1].status === 'COMPLETED'), 'base document must be COMPLETED');
    assert.ok(t.ops.some((o) => o[0] === 'carRequest.update' && o[1].status === 'COMPLETED'), 'CarRequest mirror must be COMPLETED');
    assert.ok(!t.ops.some((o) => o[0] === 'carRequest.update' && o[1].vehicleId === null), 'must NOT clear the vehicle link (the ride happened)');
    assert.ok(t.ops.some((o) => o[0] === 'driver.update' && o[1].status === 'AVAILABLE'), 'driver must be freed');
    assert.ok(t.ops.some((o) => o[0] === 'auditLog.create' && o[1].action === 'REQUEST_AUTO_COMPLETED'), 'REQUEST_AUTO_COMPLETED audit must be written');
    assert.ok(t.ops.some((o) => o[0] === 'notification.create' && o[1].type === 'TRIP_COMPLETED'), 'requester must receive the completion notice');
  });

  await test('releaseExpired: unacknowledged expired trip → back to APPROVED, vehicle link cleared, driver freed', async () => {
    const t = mkReleasePrisma([mkRow({ driverNotedAt: null })]);
    await mkRelSvc(t.prisma).releaseExpired();
    assert.ok(t.ops.some((o) => o[0] === 'requestDocument.update' && o[1].status === 'APPROVED'), 'base document must return to APPROVED');
    assert.ok(t.ops.some((o) => o[0] === 'carRequest.update' && o[1].vehicleId === null && o[1].driverId === null && o[1].status === 'APPROVED'), 'vehicle/driver links must be cleared on the CarRequest row');
    assert.ok(t.ops.some((o) => o[0] === 'driver.update' && o[1].status === 'AVAILABLE'), 'driver must be freed');
    assert.ok(!t.ops.some((o) => o[0] === 'auditLog.create' && o[1].action === 'REQUEST_AUTO_COMPLETED'), 'no completion audit for a ride that never happened');
  });

  await test('releaseExpired: query only targets trips never started (STARTED untouched)', async () => {
    const t = mkReleasePrisma([]);
    await mkRelSvc(t.prisma).releaseExpired();
    const w = t.where();
    assert.deepStrictEqual(w.AND[1].OR, [{ trip: null }, { trip: { status: 'NOT_STARTED' } }], 'STARTED trips must be excluded from the auto-close query');
    // window-ended + no ETA, OR an expired ETA — either way the car is overdue
    assert.ok(Array.isArray(w.AND) && w.AND.length === 2, 'window/ETA conditions ride in an AND branch');
    const overdue = w.AND[0].OR;
    assert.ok(overdue.some((o: any) => o.request?.carRequest?.endDate?.lt instanceof Date && o.estimatedReturnAt === null), 'ended window without ETA is targeted');
    assert.ok(overdue.some((o: any) => o.estimatedReturnAt?.lt instanceof Date), 'an expired ETA is targeted');
  });

  // ------------------------------------------------- 8) expireStaleRequests + picker guards
  await test('expireStaleRequests: unassigned APPROVED/PENDING past window → CANCELLED + audit + notice; live assignment skipped', async () => {
    const rows = [
      { id: 'r-old-unassigned', docNumber: 'CAR-202609-0100', status: 'APPROVED', requesterId: 'u1' },
      { id: 'r-old-pending', docNumber: 'CAR-202609-0101', status: 'PENDING_APPROVAL', requesterId: 'u2' },
      { id: 'r-live', docNumber: 'CAR-202609-0102', status: 'APPROVED', requesterId: 'u3' }, // has a live assignment → skipped
    ];
    const ops: Array<[string, any]> = [];
    const prismaExp: any = {
      requestDocument: {
        findMany: async () => rows,
        update: async (p: any) => { ops.push(['requestDocument.update', p]); return {}; },
      },
      carRequest: { update: async (p: any) => { ops.push(['carRequest.update', p]); return {}; } },
      carAssignment: { findFirst: async ({ where }: any) => (where.requestId === 'r-live' ? { id: 'a-live' } : null) },
      auditLog: { create: async (p: any) => { ops.push(['auditLog.create', p.data]); return {}; } },
      notification: { create: async (p: any) => { ops.push(['notification.create', p.data]); return {}; } },
      $transaction: async (list: any[]) => { for (const op of list) await op; },
    };
    const svcExp: any = new TripRemindersService(
      prismaExp,
      { notify: async () => ({}), notifyMany: async () => ({}) } as any,
      { sendRaw: async () => ({}), mirrorToUser: async () => ({}) } as any,
      { usersWithPermissions: async () => [] } as any,
    );
    await svcExp.expireStaleRequests();
    const cancelledDocs = ops.filter((o) => o[0] === 'requestDocument.update' && o[1].data.status === 'CANCELLED').map((o) => o[1].where.id);
    assert.deepStrictEqual(cancelledDocs.sort(), ['r-old-pending', 'r-old-unassigned'], 'unassigned past-window docs must be CANCELLED; the live-assigned one must NOT');
    assert.ok(ops.some((o) => o[0] === 'auditLog.create' && o[1].action === 'REQUEST_AUTO_EXPIRED'), 'REQUEST_AUTO_EXPIRED audit must be written');
    assert.strictEqual(ops.filter((o) => o[0] === 'notification.create').length, 2, 'each expired requester gets a bell notice');
  });

  await test('renormalizeVehicleStatuses: stale IN_USE vehicle → AVAILABLE + audit; live claims untouched', async () => {
    const ops: Array<[string, any]> = [];
    const prismaRenorm: any = {
      vehicle: {
        findMany: async () => [
          // artifact: released Oct 2, AVAILABLE flip lost → BOOKED with no bookings
          { id: 'v-stale', vehicleNo: '2P2942', carRequests: [], assignments: [] },
          // genuinely on the road: booking window still covers now
          { id: 'v-road', vehicleNo: '5P8390', carRequests: [{ startDate: new Date(Date.now() - 3600e3), endDate: new Date(Date.now() + 3600e3) }], assignments: [] },
          // STARTED trip past its window (running late) — keeps the flag
          { id: 'v-late', vehicleNo: '9F1213', carRequests: [{ startDate: new Date(Date.now() - 7200e3), endDate: new Date(Date.now() - 3600e3) }], assignments: [{ id: 'a1' }] },
        ],
        update: async (p: any) => { ops.push(['vehicle.update', p]); return {}; },
      },
      auditLog: { create: async (p: any) => { ops.push(['auditLog.create', p.data]); return {}; } },
    };
    const svcRenorm: any = new TripRemindersService(
      prismaRenorm,
      { notify: async () => ({}), notifyMany: async () => ({}) } as any,
      { sendRaw: async () => ({}), mirrorToUser: async () => ({}) } as any,
      { usersWithPermissions: async () => [] } as any,
    );
    await (svcRenorm as any).renormalizeVehicleStatuses();
    const freed = ops.filter((o) => o[0] === 'vehicle.update' && o[1].data.status === 'AVAILABLE').map((o) => o[1].where.id);
    assert.deepStrictEqual(freed, ['v-stale'], 'only the claim-less stale flag must be freed');
    assert.ok(ops.some((o) => o[0] === 'auditLog.create' && o[1].action === 'VEHICLE_AUTO_FREED' && o[1].recordId === 'v-stale'), 'VEHICLE_AUTO_FREED audit must be written for the stale vehicle');
  });

  await test('endingSoonNudge: window ending within 15min → driver Telegram nudge + requester bell, idempotent', async () => {
    const raws: string[] = [];
    const notifs: any[] = [];
    const in10min = new Date(Date.now() + 10 * 60e3);
    const prismaNudge: any = {
      carAssignment: {
        findMany: async () => [
          {
            releasedAt: null, driverBackAtOfficeAt: null, trip: null,
            driver: { id: 'd1', name: 'Kyaw Thiha Maw', telegramChatId: 'chat-1' },
            vehicle: { vehicleNo: '2P2942' },
            request: { id: 'r-end', docNumber: 'CAR-202610-0099', requesterId: 'u-req', requester: { fullName: 'Rider One' } },
          },
        ],
      },
      carRequest: { findUnique: async () => ({ endDate: in10min }) },
      notification: {
        findFirst: async ({ where }: any) => (where.requestId === 'r-end' ? (notifs.length ? { id: 'n1' } : null) : null),
        create: async (p: any) => { notifs.push(p.data); return {}; },
      },
      driver: { findUnique: async () => null },
      auditLog: { create: async () => {} },
    };
    const svcNudge: any = new TripRemindersService(
      prismaNudge,
      { notify: async () => ({}), notifyMany: async () => ({}) } as any,
      { sendRaw: async (_chat: string, text: string) => { raws.push(text); }, mirrorToUser: async () => ({}) } as any,
      { usersWithPermissions: async () => [] } as any,
    );
    await svcNudge.endingSoonNudge();
    assert.strictEqual(raws.length, 1, 'driver must get exactly one Telegram nudge');
    assert.ok(raws[0].includes('Ending soon') && raws[0].includes('နောက်ကျ'), 'nudge must name the window end and the ⏰ Late button');
    assert.ok(notifs.some((n) => n.type === 'WINDOW_ENDING' && n.userId === 'u-req'), 'requester must get the ending-soon bell');
    // second run: idempotent — no duplicate nudge/bell
    await svcNudge.endingSoonNudge();
    assert.strictEqual(raws.length, 1, 'no duplicate Telegram nudge on the next tick');
    assert.strictEqual(notifs.length, 1, 'no duplicate bell on the next tick');
  });

  await test('releaseExpired auto-close notifies Administration immediately', async () => {
    const adminNotifs: any[] = [];
    const endPast = new Date(Date.now() - 3600e3);
    const prismaAuto: any = {
      carAssignment: {
        findMany: async () => [
          {
            id: 'a-end', requestId: 'r-auto', vehicleId: 'v1', driverId: 'd1',
            driverNotedAt: new Date(), driverArrivedAt: null, driverBackAtOfficeAt: null,
            vehicle: { vehicleNo: '2P2942' },
            driver: { name: 'Kyaw Thiha Maw' },
            request: { docNumber: 'CAR-202610-0098', requesterId: 'u-req', carRequest: { endDate: endPast } },
            trip: null,
          },
        ],
        update: async () => ({}),
      },
      $transaction: async (list: any[]) => { for (const op of list) await op; },
      vehicle: { update: async () => ({}) },
      driver: { update: async () => ({}) },
      carRequest: { update: async () => ({}) },
      requestDocument: { update: async () => ({}) },
      auditLog: { create: async () => {} },
      notification: { create: async (p: any) => ({ userId: p.data.userId, title: p.data.title }) },
    };
    const svcAuto: any = new TripRemindersService(
      prismaAuto,
      {
        notify: async () => ({}),
        notifyMany: async (ids: string[], n: any) => { for (const id of ids) adminNotifs.push({ ...n, userId: id }); },
      } as any,
      { sendRaw: async () => ({}), mirrorToUser: async () => ({}) } as any,
      { usersWithPermissions: async () => ['admin-1', 'admin-2'] } as any,
    );
    await svcAuto.releaseExpired();
    assert.strictEqual(adminNotifs.length, 2, 'both cars.assign holders must be notified');
    const n = adminNotifs[0];
    assert.ok(n.title.includes('🤖 Auto-closed') && n.title.includes('CAR-202610-0098'), 'title must flag the auto-close and the doc number');
    assert.ok(n.body.includes('Kyaw Thiha Maw') && n.body.includes('Back at Office'), 'body must name the driver and the missed tap');
  });

  await test('shiftHandoverDigest: sends on-road/ETA/blocked sections to cars.assign Telegram chats', async () => {
    const now = new Date();
    const sent: string[] = [];
    const prismaDigest: any = {
      carAssignment: {
        findMany: async () => [
          {
            releasedAt: null, driverBackAtOfficeAt: null,
            estimatedReturnAt: new Date(now.getTime() + 60 * 60000),
            vehicle: { vehicleNo: 'V-1' }, driver: { name: 'Kyaw' },
            request: { docNumber: 'CAR-D1', carRequest: { endDate: new Date(now.getTime() - 30 * 60000) } },
          },
        ],
      },
      carRequest: {
        findMany: async () => [
          {
            startDate: new Date(now.getTime() + 3 * 3600 * 1000),
            vehicle: { vehicleNo: 'V-2' }, driver: { name: 'Ko Ko' },
            request: { docNumber: 'CAR-D2' },
          },
        ],
      },
      vehicleUnavailability: {
        findMany: async () => [
          { vehicle: { vehicleNo: 'V-9' }, endsAt: new Date(now.getTime() + 4 * 3600 * 1000), reason: 'Service' },
        ],
      },
      user: { findMany: async () => [{ telegramChatId: '999' }] },
    };
    const svcDigest: any = new TripRemindersService(
      prismaDigest,
      { notify: async () => ({}), notifyMany: async () => ({}) } as any,
      { sendRaw: async (chatId: string, text: string) => { sent.push(`${chatId}|${text}`); return {}; }, mirrorToUser: async () => ({}) } as any,
      { usersWithPermissions: async () => ['u-admin'] } as any,
    );
    await svcDigest.shiftHandoverDigest();
    assert.strictEqual(sent.length, 1, 'exactly one digest goes to the one linked admin chat');
    const [chat, text] = sent[0].split('|');
    assert.strictEqual(chat, '999', 'sent to the linked Telegram chat');
    assert.ok(text.includes('Shift handover'), 'digest header present');
    assert.ok(text.includes('CAR-D1'), 'on-road trip listed');
    assert.ok(text.includes('ETA'), 'driver ETA surfaced');
    assert.ok(text.includes('CAR-D2'), 'upcoming trip listed');
    assert.ok(text.includes('V-9') && text.includes('Service'), 'blocked vehicle listed');
  });

  await test('shiftHandoverDigest: nothing live → no message sent', async () => {
    let called = false;
    const prismaQuiet: any = {
      carAssignment: { findMany: async () => [] },
      carRequest: { findMany: async () => [] },
      vehicleUnavailability: { findMany: async () => [] },
      user: { findMany: async () => { called = true; return []; } },
    };
    const svcQuiet: any = new TripRemindersService(
      prismaQuiet,
      { notify: async () => ({}), notifyMany: async () => ({}) } as any,
      { sendRaw: async () => ({}), mirrorToUser: async () => ({}) } as any,
      { usersWithPermissions: async () => [] } as any,
    );
    await svcQuiet.shiftHandoverDigest();
    assert.strictEqual(called, false, 'an empty shift must not even look up admin chats');
  });

  await test('listApprovedUnassigned: hides requests whose window ended >24h ago', async () => {
    const captured: any[] = [];
    const prismaQ: any = { requestDocument: { findMany: async (args: any) => { captured.push(args); return []; } } };
    const svcQ: any = new CarsService(prismaQ, {} as any, {} as any, {} as any, {} as any, {} as any);
    await svcQ.listApprovedUnassigned();
    const gt = captured[0].where.carRequest.endDate.gt as Date;
    assert.ok(gt instanceof Date && Math.abs(Date.now() - gt.getTime() - 24 * 3600 * 1000) < 60_000, 'queue filter must exclude windows ended >24h ago');
  });

  // ------------------------------------------------- 8) ⏰ ETA / effective-end (feature: driver Delay)
  // NOTE: the service now takes 8 constructor args (…, timetable, events) — the
  // overview resolves the buffer through them; mocks pass undefined and the
  // private bufferMinutes() helper falls back to the 30-minute default.

  await test('overlaps(): a ⏰ ETA past the planned end keeps the booking blocking', async () => {
    // planned 09:00→12:00, driver reported ETA 14:00 → a 12:30 booking must clash
    const lateBookings: any[] = [
      {
        requestId: 'req-late', sharedTripId: null,
        startDate: new Date('2026-09-24T09:00Z'), endDate: new Date('2026-09-24T12:00Z'),
        assignment: { estimatedReturnAt: new Date('2026-09-24T14:00Z') },
        request: { docNumber: 'CAR-LATE' },
      },
    ];
    const prismaLate: any = {
      carRequest: { findMany: async () => lateBookings, findUnique: async () => null },
      carAssignment: { findMany: async () => [] },
      vehicleUnavailability: { findFirst: async () => null },
    };
    const svcLate: any = new CarsService(prismaLate, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svcLate.overlaps('veh1', new Date('2026-09-24T12:30Z'), new Date('2026-09-24T13:30Z'));
    assert.strictEqual(r.available, false, 'the ETA stretches the booking to 14:00 — a 12:30 window must clash');
    assert.strictEqual(r.conflicts[0].request.docNumber, 'CAR-LATE');
  });

  await test('overlaps(): SQL net widens to catch planned-end-passed bookings with a live ETA', async () => {
    const capturedOv: any[] = [];
    const prismaWide: any = {
      carRequest: { findMany: async (args: any) => { capturedOv.push(args); return []; }, findUnique: async () => null },
      carAssignment: { findMany: async () => [] },
      vehicleUnavailability: { findFirst: async () => null },
    };
    const svcWide: any = new CarsService(prismaWide, {} as any, {} as any, {} as any, {} as any, {} as any);
    await svcWide.overlaps('veh1', new Date('2026-09-24T12:30Z'), new Date('2026-09-24T13:30Z'));
    const or = capturedOv[0].where.OR;
    assert.ok(or.some((o: any) => o.endDate?.gt instanceof Date), 'planned-end branch present');
    assert.ok(or.some((o: any) => o.assignment?.estimatedReturnAt?.gt instanceof Date), 'ETA branch present — a booking whose planned end passed but ETA is live is still fetched');
  });

  await test('setEstimatedReturn: quick minutes → stores ETA, notifies Administration + requester', async () => {
    const ops: Array<[string, any]> = [];
    const plannedEnd = new Date(Date.now() + 3600 * 1000);
    const prismaEta: any = {
      carAssignment: {
        findUnique: async () => ({
          id: 'a1', requestId: 'r1', releasedAt: null, estimatedReturnAt: null,
          vehicle: { vehicleNo: 'V-1', brandModel: 'Probox' }, driver: { name: 'Kyaw' },
          request: { docNumber: 'CAR-ETA', requesterId: 'u-req', status: 'IN_PROGRESS' },
          carRequest: { endDate: plannedEnd },
        }),
        update: async (p: any) => { ops.push(['ca.update', p.data]); return { estimatedReturnAt: p.data.estimatedReturnAt }; },
      },
    };
    const notifications = { notifyMany: async (ids: string[], data: any) => { ops.push(['notifyMany', { ids, type: data.type, title: data.title }]); return {}; } };
    const audit = { log: async () => ({}) };
    const permissions = { usersWithPermissions: async () => ['u-admin1', 'u-admin2'] };
    const telegram = { mirrorToUser: async () => ({}), sendAssignment: async () => ({}) };
    const events = { publish: () => undefined };
    const svcEta: any = new CarsService(prismaEta, permissions, {} as any, notifications, audit, telegram, {} as any, events);
    const res = await svcEta.setEstimatedReturn('r1', { minutes: 30 });
    assert.ok(res.success, 'the ETA report succeeds');
    const eta = ops.find((o) => o[0] === 'ca.update')![1].estimatedReturnAt as Date;
    assert.ok(eta.getTime() > Date.now() + 25 * 60_000 && eta.getTime() <= Date.now() + 31 * 60_000, 'quick +30m stores now+30min');
    const notice = ops.find((o) => o[0] === 'notifyMany')![1];
    assert.deepStrictEqual(notice.ids.sort(), ['u-admin1', 'u-admin2', 'u-req'], 'Administration (cars.assign) AND the requester are notified');
    assert.ok(notice.title.includes('⏰'), 'the notice carries the delay marker');
  });

  await test('setEstimatedReturn: rejects past ETAs and assignments without an active row', async () => {
    const prismaNo: any = { carAssignment: { findUnique: async () => null } };
    const svcNo: any = new CarsService(prismaNo, {} as any, {} as any, {} as any, {} as any, {} as any);
    let msg = '';
    try { await svcNo.setEstimatedReturn('r1', { minutes: 30 }); } catch (e: any) { msg = e.message; }
    assert.strictEqual(msg, 'No active assignment for this request');

    const prismaPast: any = {
      carAssignment: {
        findUnique: async () => ({
          id: 'a1', requestId: 'r1', releasedAt: null, estimatedReturnAt: null,
          vehicle: { vehicleNo: 'V-1', brandModel: 'Probox' }, driver: { name: 'Kyaw' },
          request: { docNumber: 'CAR-ETA', requesterId: 'u-req', status: 'IN_PROGRESS' },
          carRequest: { endDate: new Date(Date.now() + 3600 * 1000) },
        }),
        update: async () => ({}),
      },
    };
    const svcPast: any = new CarsService(prismaPast, {} as any, {} as any, {} as any, {} as any, {} as any);
    msg = '';
    try { await svcPast.setEstimatedReturn('r1', { eta: new Date(Date.now() - 60_000).toISOString() }); } catch (e: any) { msg = e.message; }
    assert.strictEqual(msg, 'ETA must be in the future', 'a real extension always reaches forward');
  });

  await test('checkWindowConflicts: a ⏰ ETA past the planned end warns the new window', async () => {
    const late: any[] = [
      {
        startDate: new Date('2026-09-24T09:00Z'), endDate: new Date('2026-09-24T12:00Z'), destination: 'Taunggyi',
        assignment: { driverBackAtOfficeAt: null, estimatedReturnAt: new Date('2026-09-24T14:00Z') },
        request: { docNumber: 'CAR-LATE' },
      },
    ];
    const prismaLate: any = {
      carRequest: { findMany: async () => late },
      carAssignment: { findMany: async () => [] },
      vehicleUnavailability: { findMany: async () => [] },
    };
    const svcLate: any = new CarsService(prismaLate, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svcLate.checkWindowConflicts('2026-09-24T12:30Z', '2026-09-24T13:30Z');
    assert.strictEqual(r.conflicts.length, 1, 'planned end passed, but the live ETA still holds the car');
    assert.strictEqual(new Date(r.conflicts[0].endDate).toISOString(), '2026-09-24T14:00:00.000Z', 'the warning shows the ETA, not the planned end');
    assert.strictEqual(r.bufferMinutes, 30, 'default hand-back buffer (30 min) is exposed');
  });

  await test('requesterFleetOverview: bookings carry likelyFreeFrom (end + default 30 min buffer)', async () => {
    const start = new Date('2026-09-24T09:00Z');
    const end = new Date('2026-09-24T12:00Z');
    const prismaBuf: any = {
      carAssignment: { findMany: async () => [] },
      vehicle: { findMany: async () => [{ id: 'v1', vehicleNo: 'V-1', brandModel: 'Probox', status: 'AVAILABLE' }] },
      vehicleUnavailability: { findMany: async () => [] },
      carRequest: {
        findMany: async () => [
          { requestId: 'r1', vehicleId: 'v1', startDate: start, endDate: end, assignment: { estimatedReturnAt: null }, request: { docNumber: 'CAR-BUF' } },
        ],
      },
    };
    const svcBuf: any = new CarsService(prismaBuf, {} as any, {} as any, {} as any, {} as any, {} as any);
    const out = await svcBuf.requesterFleetOverview();
    const b = out[0].bookings[0];
    assert.strictEqual(new Date(b.likelyFreeFrom).toISOString(), '2026-09-24T12:30:00.000Z', 'likely free = end + 30 min default buffer');
    assert.strictEqual(b.estimatedReturnAt, null, 'no ETA reported yet');
  });

  await test('requesterFleetOverview: a ⏰ ETA stretches the booking and likelyFreeFrom follows', async () => {
    const start = new Date('2026-09-24T09:00Z');
    const end = new Date('2026-09-24T12:00Z');
    const eta = new Date('2026-09-24T14:00Z');
    const prismaEta: any = {
      carAssignment: { findMany: async () => [] },
      vehicle: { findMany: async () => [{ id: 'v1', vehicleNo: 'V-1', brandModel: 'Probox', status: 'AVAILABLE' }] },
      vehicleUnavailability: { findMany: async () => [] },
      carRequest: {
        findMany: async () => [
          { requestId: 'r1', vehicleId: 'v1', startDate: start, endDate: end, assignment: { estimatedReturnAt: eta }, request: { docNumber: 'CAR-ETA2' } },
        ],
      },
    };
    const svcEta: any = new CarsService(prismaEta, {} as any, {} as any, {} as any, {} as any, {} as any);
    const out = await svcEta.requesterFleetOverview();
    const b = out[0].bookings[0];
    assert.strictEqual(new Date(b.likelyFreeFrom).toISOString(), '2026-09-24T14:30:00.000Z', 'likely free = ETA + 30 min, NOT the planned end');
    assert.strictEqual(new Date(b.estimatedReturnAt).toISOString(), '2026-09-24T14:00:00.000Z', 'the ETA is surfaced for the ⏰ badge');
  });

  await test('requesterFleetOverview: an Administration block covering now shows UNDER_MAINTENANCE + a 🛠 window on the card', async () => {
    const now = new Date();
    const prismaBlock: any = {
      carAssignment: { findMany: async () => [] },
      vehicle: { findMany: async () => [{ id: 'v1', vehicleNo: 'V-9', brandModel: 'Hiace', status: 'AVAILABLE' }] },
      vehicleUnavailability: {
        findMany: async () => [
          { vehicleId: 'v1', startsAt: new Date(now.getTime() - 3600 * 1000), endsAt: new Date(now.getTime() + 3600 * 1000), reason: 'Service' },
        ],
      },
      carRequest: { findMany: async () => [] },
    };
    const svcBlock: any = new CarsService(prismaBlock, {} as any, {} as any, {} as any, {} as any, {} as any);
    const out = await svcBlock.requesterFleetOverview();
    assert.strictEqual(out[0].status, 'UNDER_MAINTENANCE', 'a block covering now reads as the workshop state');
    assert.strictEqual(out[0].bookings[0].docNumber, '🛠 Service', 'the blocked window is listed on the card');
  });

  await test('overlaps(): an Administration block refuses the vehicle for the window', async () => {
    const prismaBlk: any = {
      carRequest: { findMany: async () => { throw new Error('must not reach the booking query'); } },
      carAssignment: { findMany: async () => [] },
      vehicleUnavailability: {
        findFirst: async () => ({ startsAt: new Date('2026-09-24T00:00Z'), endsAt: new Date('2026-09-25T00:00Z'), reason: 'Inspection' }),
      },
    };
    const svcBlk: any = new CarsService(prismaBlk, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svcBlk.overlaps('veh1', new Date('2026-09-24T08:00Z'), new Date('2026-09-24T10:00Z'));
    assert.strictEqual(r.available, false, 'a blocked car is blocked for everyone');
    assert.ok(r.conflicts[0].request.docNumber.includes('🛠'), 'the refusal names the block, not a booking');
  });

  await test('handover(): on-road trips carry plannedEnd/ETA/overdue, blocked vehicles listed', async () => {
    const now = new Date();
    const pastEnd = new Date(now.getTime() - 30 * 60000);
    const etaSoon = new Date(now.getTime() + 45 * 60000);
    const prismaH: any = {
      carAssignment: {
        findMany: async () => [
          {
            // delayed but covered: planned end passed, driver reported a future ETA
            releasedAt: null, driverBackAtOfficeAt: null, estimatedReturnAt: etaSoon,
            vehicle: { vehicleNo: 'V-1', brandModel: 'Probox' }, driver: { name: 'Kyaw' },
            trip: { status: 'STARTED' },
            request: { id: 'r1', docNumber: 'CAR-H1', carRequest: { endDate: pastEnd, destination: 'Taunggyi' } },
          },
          {
            // overdue: planned end passed, NO ETA — nothing accounts for the car
            releasedAt: null, driverBackAtOfficeAt: null, estimatedReturnAt: null,
            vehicle: { vehicleNo: 'V-3', brandModel: 'Vitz' }, driver: { name: 'Mg Mg' },
            trip: { status: 'NOT_STARTED' },
            request: { id: 'r3', docNumber: 'CAR-H3', carRequest: { endDate: pastEnd, destination: 'Office' } },
          },
        ],
      },
      carRequest: {
        findMany: async () => [
          {
            requestId: 'r2', startDate: new Date(now.getTime() + 3 * 3600 * 1000), endDate: new Date(now.getTime() + 5 * 3600 * 1000),
            destination: 'Pyay', vehicle: { vehicleNo: 'V-2' }, driver: { name: 'Ko Ko' },
            assignment: null, request: { id: 'r2', docNumber: 'CAR-H2', status: 'APPROVED' },
          },
        ],
      },
      vehicleUnavailability: {
        findMany: async () => [
          { vehicle: { vehicleNo: 'V-9', brandModel: 'Hiace' }, startsAt: pastEnd, endsAt: new Date(now.getTime() + 3 * 3600 * 1000), reason: 'Service' },
        ],
      },
    };
    const svcH: any = new CarsService(prismaH, {} as any, {} as any, {} as any, {} as any, {} as any);
    const h = await svcH.handover();
    assert.strictEqual(h.onRoad.length, 2, 'both live assignments are on the road');
    const h1 = h.onRoad.find((t: any) => t.docNumber === 'CAR-H1');
    const h3 = h.onRoad.find((t: any) => t.docNumber === 'CAR-H3');
    assert.strictEqual(new Date(h1.plannedEnd).getTime(), pastEnd.getTime(), 'plannedEnd surfaced');
    assert.strictEqual(new Date(h1.estimatedReturnAt).getTime(), etaSoon.getTime(), 'ETA surfaced');
    assert.strictEqual(h1.overdue, false, 'a future ETA still covers the car — not overdue yet');
    assert.strictEqual(h3.overdue, true, 'planned end passed with no ETA → overdue');
    assert.strictEqual(h.delayedCount, 1, 'ETA later than planned end counts as delayed');
    assert.strictEqual(h.today.length, 1, 'today\'s remaining trips listed');
    assert.strictEqual(h.today[0].docNumber, 'CAR-H2');
    assert.strictEqual(h.blocked.length, 1, 'active vehicle blocks listed');
    assert.strictEqual(h.blocked[0].reason, 'Service');
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
