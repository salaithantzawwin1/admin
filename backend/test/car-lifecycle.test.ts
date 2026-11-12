/**
 * Car request lifecycle guards (approval → assign → release / shift / back-at-office).
 *
 * These pin the four gaps a deep pass over "request → approved" found:
 *   1. final approval never told Administration a car is waiting → the trip sat in
 *      the assign queue until the "start time passed" nudge hours later;
 *   2. release() re-opened a COMPLETED request (status written back to APPROVED)
 *      and handed a car to the pool while a shared/next booking still held it;
 *   3. Shift time only checked the VEHICLE, so it could slide a trip into another
 *      trip the same driver already holds;
 *   4. the driver's "Back at Office" on a stale card freed a car that had already
 *      been re-assigned to someone else.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/car-lifecycle.test.ts
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
const GROUP = '22222222-2222-4222-8222-222222222222';

const { CarsService } = require('../src/cars/cars.service');
const { TelegramService } = require('../src/telegram/telegram.service');
const { TripRemindersService } = require('../src/cars/trip-reminders.service');

function cars(prisma: any, extra: { permissions?: any; notifications?: any; telegram?: any; audit?: any; events?: any } = {}) {
  return new CarsService(
    prisma,
    extra.permissions ?? ({} as any),
    {} as any,
    extra.notifications ?? ({} as any),
    extra.audit ?? ({ log: async () => undefined } as any),
    extra.telegram ?? ({} as any),
    {} as any,
    extra.events ?? ({ publish: () => 0 } as any),
  );
}

async function main() {
  // ------------------------------------------------ 1) approval → dispatcher hand-off
  await test('approval notifies cars.assign holders (minus the requester) that a car is needed', async () => {
    const notes: any[] = [];
    const mirrored: any[] = [];
    const svc: any = cars(
      { requestDocument: { findUnique: async () => ({
        docNumber: 'CAR-202611-0100', requesterId: 'u-req',
        carRequest: {
          destination: 'Mandalay', pickupLocation: 'Head Office',
          startDate: new Date('2026-11-03T02:30:00Z'), endDate: new Date('2026-11-03T10:30:00Z'),
          passengers: 4, vehicleTypeRequired: 'SUV',
        },
      }) } },
      {
        permissions: { usersWithPermissions: async () => ['u-admin', 'u-other', 'u-req'] },
        notifications: { notifyMany: async (ids: string[], p: any) => notes.push({ ids, p }) },
        telegram: { mirrorToUser: async (id: string, title: string) => mirrored.push({ id, title }) },
      },
    );
    await svc.notifyReadyToAssign('req-1');
    assert.strictEqual(notes.length, 1, 'one bell fan-out');
    assert.deepStrictEqual(notes[0].ids, ['u-admin', 'u-other'], 'the requester is not told to assign their own car');
    assert.strictEqual(notes[0].p.link, '/car-requests');
    assert.ok(notes[0].p.title.includes('CAR-202611-0100'), 'names the document');
    assert.ok(notes[0].p.body.includes('Mandalay') && notes[0].p.body.includes('SUV'), 'carries what the dispatcher needs');
    assert.strictEqual(mirrored.length, 2, 'each dispatcher also gets the Telegram mirror');
  });

  await test('approval hand-off is silent for a non-car document', async () => {
    const notes: any[] = [];
    const svc: any = cars(
      { requestDocument: { findUnique: async () => ({ docNumber: 'GEN-1', requesterId: 'u-req', carRequest: null }) } },
      { permissions: { usersWithPermissions: async () => ['u-admin'] }, notifications: { notifyMany: async (ids: string[], p: any) => notes.push(p) } },
    );
    await svc.notifyReadyToAssign('req-1');
    assert.strictEqual(notes.length, 0);
  });

  // ------------------------------------------------ 2) release() guards
  function releasePrisma(over: {
    requestStatus?: string;
    releasedAt?: Date | null;
    trip?: any;
    othersOnVehicle?: number;
    othersForDriver?: number;
  } = {}) {
    const calls: any[] = [];
    const tx: any = {
      carAssignment: { update: async (a: any) => calls.push({ table: 'carAssignment', ...a }) },
      carRequest: {
        update: async (a: any) => calls.push({ table: 'carRequest', ...a }),
        count: async (a: any) => (a.where.vehicleId ? over.othersOnVehicle ?? 0 : over.othersForDriver ?? 0),
      },
      requestDocument: { update: async (a: any) => calls.push({ table: 'requestDocument', ...a }) },
      vehicle: { update: async (a: any) => calls.push({ table: 'vehicle', ...a }) },
      driver: { update: async (a: any) => calls.push({ table: 'driver', ...a }) },
    };
    const prisma: any = {
      carAssignment: {
        findUnique: async () => ({
          id: 'a1', requestId: 'r1', vehicleId: 'v1', driverId: 'd1', releasedAt: over.releasedAt ?? null,
          trip: over.trip ?? null,
          request: { status: over.requestStatus ?? 'IN_PROGRESS' },
        }),
      },
      $transaction: async (fn: any) => fn(tx),
    };
    return { prisma, calls };
  }

  await test('release() refuses to re-open a COMPLETED request', async () => {
    const { prisma } = releasePrisma({ requestStatus: 'COMPLETED' });
    let msg = '';
    try { await cars(prisma).release('r1', ACTOR); } catch (e: any) { msg = e.message; }
    assert.ok(/Cannot release from status COMPLETED/.test(msg), `expected a status guard, got "${msg}"`);
  });

  await test('release() refuses a second release of the same assignment', async () => {
    const { prisma } = releasePrisma({ releasedAt: new Date() });
    let msg = '';
    try { await cars(prisma).release('r1', ACTOR); } catch (e: any) { msg = e.message; }
    assert.ok(/already released/.test(msg), `expected an already-released guard, got "${msg}"`);
  });

  await test('release() keeps the car IN_USE while another live booking still rides it (shared convoy)', async () => {
    const { prisma, calls } = releasePrisma({ othersOnVehicle: 1, othersForDriver: 1 });
    await cars(prisma).release('r1', ACTOR);
    assert.ok(!calls.some((c) => c.table === 'vehicle'), 'the car must not be flipped to AVAILABLE');
    assert.ok(!calls.some((c) => c.table === 'driver'), 'the driver must stay ON_TRIP');
    assert.ok(calls.some((c) => c.table === 'requestDocument' && c.data.status === 'APPROVED'), 'the request itself is still re-queued');
  });

  await test('release() frees the car and driver when nothing else holds them', async () => {
    const { prisma, calls } = releasePrisma({ othersOnVehicle: 0, othersForDriver: 0 });
    await cars(prisma).release('r1', ACTOR);
    assert.ok(calls.some((c) => c.table === 'vehicle' && c.data.status === 'AVAILABLE'));
    assert.ok(calls.some((c) => c.table === 'driver' && c.data.status === 'AVAILABLE'));
  });

  // ------------------------------------------------ 3) shift re-checks the driver
  function shiftPrisma(clash: any) {
    const calls: any[] = [];
    const prisma: any = {
      requestDocument: {
        findUnique: async () => ({
          id: 'r1', docType: 'CAR_REQUEST', status: 'IN_PROGRESS', requesterId: 'u-req', docNumber: 'CAR-202611-0200',
          carRequest: { vehicleId: null, driverId: 'd1', sharedTripId: null, startDate: new Date('2026-11-04T02:00:00Z'), endDate: new Date('2026-11-04T04:00:00Z') },
        }),
      },
      carAssignment: { findUnique: async () => ({ trip: null }) },
      carRequest: {
        findFirst: async () => clash,
        update: async (a: any) => calls.push(a),
      },
      notifications: { notify: async () => undefined },
    };
    return { prisma, calls };
  }

  await test('Shift time refuses a window that overlaps another trip of the same driver', async () => {
    const { prisma, calls } = shiftPrisma({
      startDate: new Date('2026-11-04T03:00:00Z'), endDate: new Date('2026-11-04T05:00:00Z'),
      sharedTripId: null, request: { docNumber: 'CAR-202611-0201' }, assignment: { estimatedReturnAt: null },
    });
    let msg = '';
    try { await cars(prisma).adminShiftTime('r1', { startDate: '2026-11-04T03:30:00Z' }, ACTOR); } catch (e: any) { msg = e.message; }
    assert.ok(/already on CAR-202611-0201/.test(msg), `expected a driver-clash refusal, got "${msg}"`);
    assert.strictEqual(calls.length, 0, 'the window must not move');
  });

  await test('Shift time: a convoy member of the same group is not a driver clash', async () => {
    const { prisma, calls } = shiftPrisma({
      startDate: new Date('2026-11-04T03:00:00Z'), endDate: new Date('2026-11-04T05:00:00Z'),
      sharedTripId: GROUP, request: { docNumber: 'CAR-202611-0202' }, assignment: { estimatedReturnAt: null },
    });
    (prisma.requestDocument.findUnique as any) = async () => ({
      id: 'r1', docType: 'CAR_REQUEST', status: 'IN_PROGRESS', requesterId: 'u-req', docNumber: 'CAR-202611-0200',
      carRequest: { vehicleId: null, driverId: 'd1', sharedTripId: GROUP, startDate: new Date('2026-11-04T02:00:00Z'), endDate: new Date('2026-11-04T04:00:00Z') },
    });
    await cars(prisma, {
      notifications: { notify: async () => undefined },
      telegram: { notifyDriverOfTimeChange: async () => undefined },
    }).adminShiftTime('r1', { startDate: '2026-11-04T03:30:00Z' }, ACTOR);
    assert.strictEqual(calls.length, 1, 'the same shared ride may move as a unit');
  });

  // ------------------------------------------------ 4) Back at Office frees only a car nobody else holds
  function telegramSvc(others: any[]) {
    const updates: any[] = [];
    const prisma: any = {
      carAssignment: {
        findUnique: async () => ({ vehicleId: 'v1', driverId: 'd1', estimatedReturnAt: null, carRequest: { sharedTripId: null } }),
        findMany: async () => others,
        update: async (a: any) => updates.push({ table: 'carAssignment', ...a }),
      },
      vehicle: { update: async (a: any) => updates.push({ table: 'vehicle', ...a }) },
      driver: { update: async (a: any) => updates.push({ table: 'driver', ...a }) },
    };
    const svc: any = new TelegramService(prisma, { log: async () => undefined }, {}, { publish: () => 0 });
    return { svc, updates };
  }

  await test('Back at Office does not free a car that another live trip still uses', async () => {
    const { svc, updates } = telegramSvc([{ vehicleId: 'v1', driverId: null, carRequest: { sharedTripId: null } }]);
    await svc.freeVehicle('a1');
    assert.ok(!updates.some((u) => u.table === 'vehicle'), 'the re-assigned car must stay IN_USE');
  });

  await test('Back at Office still frees a solo trip', async () => {
    const { svc, updates } = telegramSvc([]);
    await svc.freeVehicle('a1');
    assert.ok(updates.some((u) => u.table === 'vehicle' && u.data.status === 'AVAILABLE'));
    assert.ok(updates.some((u) => u.table === 'driver' && u.data.status === 'AVAILABLE'));
  });

  // ------------------------------------------------ 5) expired-trip janitor
  function janitor(over: { holders?: any[]; row?: any } = {}) {
    const writes: any[] = [];
    const notices: any[] = [];
    const sweepArgs: any[] = [];
    const row = over.row ?? {
      id: 'a1', requestId: 'r1', vehicleId: 'v1', driverId: 'd1',
      driverBackAtOfficeAt: null, driverNotedAt: null, driverArrivedAt: null, estimatedReturnAt: null,
      vehicle: { vehicleNo: 'YGN-1' }, driver: { name: 'U Aung' },
      request: {
        docNumber: 'CAR-1', requesterId: 'u-req',
        carRequest: { endDate: new Date('2026-11-01T00:00:00Z'), sharedTripId: null },
      },
    };
    const op = (table: string) => (a: any) => ({ __w: table, ...a });
    const prisma: any = {
      carAssignment: {
        // `id: { not: … }` is the holder query; the sweep query has no id filter
        findMany: async (args: any) => {
          sweepArgs.push(args);
          return args?.where?.id ? over.holders ?? [] : [row];
        },
        update: op('carAssignment'),
      },
      vehicle: { findMany: async () => [], update: op('vehicle') },
      driver: { findMany: async () => [], update: op('driver') },
      carRequest: { update: op('carRequest') },
      requestDocument: { update: op('requestDocument') },
      notification: { create: async (a: any) => writes.push({ __w: 'notification', ...a }) },
      auditLog: { create: async (a: any) => writes.push({ __w: 'audit', ...a }) },
      $transaction: async (ops: any[]) => writes.push(...ops),
    };
    const svc: any = new TripRemindersService(
      prisma,
      { notifyMany: async (ids: string[], n: any) => notices.push({ ids, ...n }), notify: async () => undefined },
      { mirrorToUser: async () => undefined },
      { usersWithPermissions: async () => ['u-admin'] },
    );
    return { svc, writes, notices, sweepArgs };
  }

  await test('janitor keeps the car IN_USE when the next trip already took it', async () => {
    const { svc, writes } = janitor({ holders: [{ vehicleId: 'v1', driverId: null, request: { carRequest: { sharedTripId: null } } }] });
    await svc.releaseExpired();
    assert.ok(!writes.some((w) => w.__w === 'vehicle'), 'the re-assigned car must stay IN_USE');
    assert.ok(writes.some((w) => w.__w === 'driver' && w.data.status === 'AVAILABLE'), 'the free driver still returns to the pool');
    assert.ok(writes.some((w) => w.__w === 'carRequest' && w.data.status === 'APPROVED'), 'the request is still re-queued for a new car');
  });

  await test('janitor frees the car and driver when nothing else holds them', async () => {
    const { svc, writes } = janitor({ holders: [] });
    await svc.releaseExpired();
    assert.ok(writes.some((w) => w.__w === 'vehicle' && w.data.status === 'AVAILABLE'));
    assert.ok(writes.some((w) => w.__w === 'driver' && w.data.status === 'AVAILABLE'));
  });

  await test('janitor auto-close keeps a car IN_USE when another live trip holds it', async () => {
    const { svc, writes } = janitor({
      holders: [{ vehicleId: 'v1', driverId: null, request: { carRequest: { sharedTripId: null } } }],
      row: {
        id: 'a1', requestId: 'r1', vehicleId: 'v1', driverId: 'd1',
        driverBackAtOfficeAt: null, driverNotedAt: new Date(), driverArrivedAt: null, estimatedReturnAt: null,
        vehicle: { vehicleNo: 'YGN-1' }, driver: { name: 'U Aung' },
        request: {
          docNumber: 'CAR-1', requesterId: 'u-req',
          carRequest: { endDate: new Date('2026-11-01T00:00:00Z'), sharedTripId: null },
        },
      },
    });
    await svc.releaseExpired();
    assert.ok(!writes.some((w) => w.__w === 'vehicle'), 'a completed ride must not free a car still on the road');
    assert.ok(writes.some((w) => w.__w === 'requestDocument' && w.data.status === 'COMPLETED'), 'the ride itself still closes');
  });

  await test('janitor waits out a late-return buffer before releasing a trip', async () => {
    const { svc, sweepArgs } = janitor({ holders: [] });
    await svc.releaseExpired();
    const cutoff = sweepArgs[0]?.where?.AND?.[0]?.OR?.[0]?.request?.carRequest?.endDate?.lt as Date;
    assert.ok(cutoff instanceof Date, 'the sweep must bound the window by a grace cutoff');
    const minutes = (Date.now() - cutoff.getTime()) / 60000;
    assert.ok(minutes > 5, `a driver tapping a few minutes late must still land on a live booking (grace ${minutes.toFixed(1)} min)`);
  });

  // ------------------------------------------------ 6) CAR-202611-0005
  await test('janitor tells Administration a car was released, not that none was picked', async () => {
    const { svc, notices } = janitor({ holders: [] });
    await svc.releaseExpired();
    assert.ok(
      notices.some((n) => n.ids.includes('u-admin')),
      'Administration must learn the assigned car was released at window end',
    );
  });

  function returnedAfterRelease(over: { status?: string; docStatus?: string; taps?: any; endDate?: Date | null } = {}) {
    const writes: any[] = [];
    const taps = over.taps ?? { releasedAt: new Date('2026-11-02T04:00:00Z'), driverBackAtOfficeAt: new Date('2026-11-02T04:10:00Z') };
    const tx: any = {
      requestDocument: {
        findUnique: async () => ({
          status: over.status ?? 'APPROVED',
          docNumber: 'CAR-202611-0005',
          requesterId: 'u-req',
          // the booking window: null = no schedule on record (old behaviour)
          carRequest: { endDate: over.endDate ?? null },
          carAssignment: { vehicleId: 'v1', driverId: 'd1', trip: null, ...taps },
        }),
        update: async (a: any) => writes.push({ __w: 'requestDocument', ...a }),
      },
      carRequest: { update: async (a: any) => writes.push({ __w: 'carRequest', ...a }) },
    };
    const prisma: any = {
      $transaction: async (cb: any) => cb(tx),
      notification: { create: async (a: any) => writes.push({ __w: 'notification', ...a }) },
    };
    const svc: any = new TelegramService(prisma, { log: async (e: any) => writes.push({ __w: 'audit', ...e }) }, {}, { publish: () => 0 });
    svc.mirrorToUser = async () => undefined; // no Telegram traffic from a unit test
    return { svc, writes };
  }

  await test('Back at Office still closes a trip whose window was released a minute earlier', async () => {
    const { svc, writes } = returnedAfterRelease();
    await svc.completeAfterReturn('r1');
    assert.ok(
      writes.some((w) => w.__w === 'requestDocument' && w.data.status === 'COMPLETED'),
      'the ride happened — the released booking must close, not stay APPROVED',
    );
    const cr = writes.find((w) => w.__w === 'carRequest');
    assert.strictEqual(cr?.data.status, 'COMPLETED');
    assert.strictEqual(cr?.data.vehicleId, 'v1', 'the closed request keeps the car it actually used');
    assert.strictEqual(cr?.data.driverId, 'd1', 'the closed request keeps the driver it actually used');
  });

  await test('a stale Back tap cannot close a released booking that has not started yet', async () => {
    // Administration released an UPCOMING booking (car back in the pool, request
    // APPROVED, waiting for a new car). The tap on the driver's old card used to
    // close a ride that never happened — the request became COMPLETED and could
    // never be re-assigned. Only a window that is really over may close itself.
    const { svc, writes } = returnedAfterRelease({ endDate: new Date(Date.now() + 6 * 864e5) });
    await svc.completeAfterReturn('r1');
    assert.ok(!writes.some((w) => w.__w === 'requestDocument'), 'the booking must stay APPROVED for a new car');
    assert.ok(!writes.some((w) => w.__w === 'carRequest'), 'nothing is completed');
    assert.ok(!writes.some((w) => w.__w === 'notification'), 'the requester is not told a ride happened');
  });

  await test('a fresh odometer capture reclaims the pending photo of the stage it replaced', async () => {
    // Driver sends the Ready dashboard photo, never types the kilo, then taps Back
    // at office: the capture is re-armed and the old file used to stay on the
    // volume for ever (the row stops naming it, storePendingPhoto only unlinks a
    // file the column still points at).
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ams-odo-'));
    const pendingDir = path.join(dir, 'odometer', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const oldName = '11111111-1111-1111-1111-111111111111.jpg';
    fs.writeFileSync(path.join(pendingDir, oldName), 'jpeg-bytes');
    const prev = process.env.UPLOAD_PATH;
    process.env.UPLOAD_PATH = dir;
    try {
      const writes: any[] = [];
      const prisma: any = {
        carAssignment: {
          findUnique: async () => ({ pendingOdoPhoto: oldName }),
          update: async (a: any) => { writes.push(a.data); },
        },
      };
      const svc: any = new TelegramService(prisma, { log: async () => {} }, {}, { publish: () => 0 });
      svc.armOdo('chat-1', 'a1', 'BACK'); // the unanswered READY capture is replaced
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(fs.existsSync(path.join(pendingDir, oldName)), false, 'the orphaned photo must be reclaimed');
      assert.strictEqual(writes[0].pendingOdoStage, 'BACK', 'the row arms the new stage');
      assert.strictEqual(writes[0].pendingOdoPhoto, null, 'the old photo is no longer referenced');
    } finally {
      if (prev === undefined) delete process.env.UPLOAD_PATH;
      else process.env.UPLOAD_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('Back at Office does not re-open a request that was cancelled meanwhile', async () => {
    const { svc, writes } = returnedAfterRelease({ status: 'CANCELLED' });
    await svc.completeAfterReturn('r1');
    assert.ok(!writes.some((w) => w.__w === 'requestDocument'), 'a cancelled request must stay cancelled');
  });

  await test('Back at Office with an unfinished trip still leaves completion to the trip form', async () => {
    const { svc, writes } = returnedAfterRelease({ taps: { releasedAt: null, driverBackAtOfficeAt: null, trip: { status: 'STARTED' } } });
    await svc.completeAfterReturn('r1');
    assert.ok(!writes.some((w) => w.__w === 'requestDocument'), 'open mileage must block auto-completion');
  });

  // the stage stamp must exist BEFORE completion runs (CAR-202611-0005 ordering)
  await test('a driver tap stamps the stage before the released booking is closed', async () => {
    const row: any = {
      id: 'a1', requestId: 'r1', vehicleId: 'v1', driverId: 'd1',
      driverNotedAt: null, driverArrivedAt: null, driverBackAtOfficeAt: null,
      estimatedReturnAt: null, telegramMessageId: null,
      request: { id: 'r1', docNumber: 'CAR-202611-0005', requesterId: 'u-req', requester: { fullName: 'U Req' } },
    };
    const writes: any[] = [];
    const prisma: any = {
      carAssignment: {
        findUnique: async () => row,
        findMany: async () => [],
        update: async (a: any) => {
          Object.assign(row, a.data);
          writes.push({ __w: 'carAssignment', ...a });
          return { ...row, vehicle: { vehicleNo: 'YGN-1' }, driver: { id: 'd1', name: 'U Aung' } };
        },
      },
      vehicle: { update: async () => undefined },
      driver: { update: async () => undefined },
      user: { findUnique: async () => null },
      notification: { create: async () => undefined, createMany: async () => undefined },
      requestDocument: {
        // the janitor already released this booking; the stamp is what is missing
        findUnique: async () => ({
          status: 'APPROVED', docNumber: 'CAR-202611-0005', requesterId: 'u-req',
          carAssignment: {
            releasedAt: new Date('2026-11-02T04:00:00Z'),
            driverBackAtOfficeAt: row.driverBackAtOfficeAt,
            vehicleId: 'v1', driverId: 'd1', trip: null,
          },
        }),
        update: async (a: any) => writes.push({ __w: 'requestDocument', ...a }),
      },
      carRequest: { update: async (a: any) => writes.push({ __w: 'carRequest', ...a }) },
      $transaction: async (cb: any) => cb(prisma),
    };
    const svc: any = new TelegramService(prisma, { log: async () => undefined }, { usersWithPermissions: async () => [] }, { publish: () => 0 });
    svc.call = async () => undefined; // no Telegram traffic from a unit test
    svc.mirrorToUser = async () => undefined;
    await svc.manualAck('a1', 'returned', { userId: 'u-admin', username: 'admin' });
    assert.ok(
      writes.some((w) => w.__w === 'requestDocument' && w.data.status === 'COMPLETED'),
      'the released booking must close on the driver own Back-at-Office tap',
    );
  });

  // ------------------------------------------------ 7) stale Telegram card
  function staleCard(tapped: number, current: string | null) {
    const row: any = {
      id: 'a1', requestId: 'r1', vehicleId: 'v1', driverId: 'd1', telegramMessageId: current,
      driverNotedAt: null, driverArrivedAt: null, driverBackAtOfficeAt: null, estimatedReturnAt: null,
      driver: { id: 'd1', name: 'U Aung', telegramChatId: 'chat-1' },
      vehicle: { vehicleNo: 'YGN-1' },
      carRequest: { destination: 'D', pickupLocation: 'P', startDate: new Date(), endDate: new Date(), timeSlot: 'FULL_DAY', purpose: null, sharedTripId: null },
      request: { id: 'r1', docNumber: 'CAR-1', requesterId: 'u-req', requester: { fullName: 'U Req' } },
    };
    const updates: any[] = [];
    const answers: string[] = [];
    const prisma: any = {
      carAssignment: {
        findUnique: async () => row,
        findMany: async () => [],
        update: async (a: any) => {
          Object.assign(row, a.data);
          updates.push(a);
          return row;
        },
      },
      vehicle: { update: async () => undefined },
      driver: { update: async () => undefined },
      user: { findUnique: async () => null },
      notification: { create: async () => undefined, createMany: async () => undefined },
    };
    const svc: any = new TelegramService(prisma, { log: async () => undefined }, { usersWithPermissions: async () => [] }, { publish: () => 0 });
    svc.call = async (_m: string, payload: any) => { if (payload?.callback_query_id) answers.push(String(payload.text ?? '')); };
    svc.editStageMessage = async () => undefined;
    svc.mirrorToUser = async () => undefined;
    svc.callbackMessages.set('chat-1:cb1', tapped);
    return { svc, updates, answers };
  }

  await test('a tap on a superseded Telegram card cannot stamp the new trip', async () => {
    const { svc, updates, answers } = staleCard(111, '999'); // old message tapped
    await svc.handleCallback('noted:a1', 'chat-1', 'cb1');
    assert.strictEqual(updates.length, 0, 'an outdated card must not write a stage stamp');
    assert.ok(answers.some((t) => /ဟောင်း/.test(t)), 'the driver must be told the card is out of date');
  });

  await test('a tap on the current card still stamps the stage', async () => {
    const { svc, updates } = staleCard(999, '999');
    try {
      await svc.handleCallback('noted:a1', 'chat-1', 'cb1');
    } catch {
      /* notify stubs are intentionally minimal — only the stamp matters here */
    }
    assert.strictEqual(updates.length, 1, 'the live card must still work');
    assert.ok(updates[0].data.driverNotedAt instanceof Date);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
