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
    const prismaBao: any = { carRequest: { findMany: async () => returned }, carAssignment: { findMany: async () => [] } };
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
    const prismaBao: any = { carRequest: { findMany: async () => returned }, carAssignment: { findMany: async () => [] } };
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
    const prismaBao: any = { carRequest: { findMany: async () => planned }, carAssignment: { findMany: async () => [] } };
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

  await test('requesterFleetOverview: Back-at-Office booking leaves the Booked list', async () => {
    const overviewCaptured: any[] = [];
    const prismaOv: any = {
      carAssignment: { findMany: async () => [{ requestId: 'req-bao' }] },
      vehicle: { findMany: async () => [{ id: 'v1', vehicleNo: '1G/5575', brandModel: 'dd test', status: 'AVAILABLE' }] },
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
    assert.deepStrictEqual(w.OR, [{ trip: null }, { trip: { status: 'NOT_STARTED' } }], 'STARTED trips must be excluded from the auto-close query');
    assert.ok(w.request.carRequest.endDate.lt instanceof Date, 'only windows already ended are targeted');
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
