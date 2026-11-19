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

  // ------------------------------------------- 6) Step 2: escalation stages
  function escalation(rows: any[], presetAudits: any[] = []) {
    const audits: any[] = [...presetAudits];
    const notices: any[] = [];
    const sent: string[] = [];
    let args: any = null;
    const prisma: any = {
      carAssignment: { findMany: async (p: any) => { args = p; return rows; } },
      notification: {
        findFirst: async ({ where: w }: any) =>
          notices.find((n) => n.requestId === w.requestId && n.type === w.type) ?? null,
      },
      auditLog: {
        // honour the throttle window: a marker written now (no createdAt) counts as
        // fresh, a preset one only matches while it is younger than the cutoff
        findFirst: async ({ where: w }: any) => {
          const cutoff = w.createdAt?.gte as Date | undefined;
          return audits.find((x) =>
            x.action === w.action && x.recordId === w.recordId &&
            (!cutoff || !x.createdAt || x.createdAt >= cutoff),
          ) ?? null;
        },
        create: async (p: any) => { audits.push({ ...p.data, createdAt: new Date() }); return {}; },
      },
    };
    const svc: any = new TripRemindersService(
      prisma,
      { notifyMany: async (_ids: string[], n: any) => { notices.push(n); }, notify: async () => ({}) } as any,
      { sendRaw: async (_chat: string, text: string) => { sent.push(text); }, mirrorToUser: async () => ({}) } as any,
      { usersWithPermissions: async () => ['u-admin'] } as any,
    );
    return { svc, args: () => args, audits, notices, sent };
  }

  const escalationRow = (over: Record<string, unknown> = {}) => ({
    id: 'a9', requestId: 'r9', vehicleId: 'v9', driverId: 'd9',
    estimatedReturnAt: null,
    driver: { id: 'd9', name: 'Naing Naing Tun', telegramChatId: 'chat-9' },
    vehicle: { vehicleNo: '9F1213', brandModel: 'Toyota HiAce' },
    request: {
      id: 'r9', docNumber: 'CAR-202611-0039',
      carRequest: { endDate: endedAgo(180), destination: 'Mandalay' },
    },
    trip: null,
    ...over,
  });

  await test('escalateOverdueRunning: the query is ETA-aware and reads the trip status', async () => {
    const t = escalation([]);
    await t.svc.escalateOverdueRunning();
    const { where, include } = t.args();
    assert.strictEqual(where.OR.length, 2);
    assert.ok(where.OR[0].request.carRequest.endDate.lt instanceof Date, 'planned end in the past');
    assert.strictEqual(where.OR[0].estimatedReturnAt, null, 'no ETA reported');
    assert.ok(where.OR[1].estimatedReturnAt.lt instanceof Date, 'an expired ETA is overdue too');
    assert.deepStrictEqual(include.trip, { select: { status: true } },
      'held rows must be distinguishable from STARTED');
  });

  await test('escalateOverdueRunning: a held ride under +2h nudges the driver only', async () => {
    const t = escalation([escalationRow({
      request: { id: 'r9', docNumber: 'CAR-202611-0039', carRequest: { endDate: endedAgo(30) } },
    })]);
    await t.svc.escalateOverdueRunning();
    assert.strictEqual(t.sent.length, 1, 'the driver is still nudged');
    assert.strictEqual(t.notices.length, 0, 'no admin alert before +2h');
    assert.strictEqual(t.audits.length, 0);
  });

  await test('escalateOverdueRunning: a held ride gets the manual-close alert once, from +2h', async () => {
    const t = escalation([escalationRow()]);
    await t.svc.escalateOverdueRunning();
    assert.strictEqual(t.audits.filter((a) => a.action === 'CAR_OVERDUE_CLOSE_REQUIRED').length, 1);
    assert.strictEqual(t.notices.length, 1);
    assert.match(t.notices[0].title, /Return overdue — CAR-202611-0039 \(3h 0m\)/);
    assert.match(t.notices[0].body, /Close the trip manually/);
    assert.ok(!t.notices.some((n) => /Trip overdue/.test(n.title)),
      'a held row must not also get the STARTED-style alert');
    await t.svc.escalateOverdueRunning(); // the next hourly tick
    assert.strictEqual(t.notices.length, 1, 'the close marker is throttled');
  });

  await test('escalateOverdueRunning: a STARTED trip keeps the immediate alert and no close marker', async () => {
    const t = escalation([escalationRow({
      trip: { status: 'STARTED' },
      request: { id: 'r9', docNumber: 'CAR-202611-0039', carRequest: { endDate: endedAgo(30) } },
    })]);
    await t.svc.escalateOverdueRunning();
    assert.strictEqual(t.notices.length, 1);
    assert.match(t.notices[0].title, /Trip overdue/);
    assert.strictEqual(t.audits.filter((a) => a.action === 'CAR_OVERDUE_CLOSE_REQUIRED').length, 0);
  });

  await test('escalateOverdueRunning: the ETA, not the planned end, sets the overdue minutes', async () => {
    const t = escalation([escalationRow({ estimatedReturnAt: endedAgo(30) })]);
    await t.svc.escalateOverdueRunning();
    assert.strictEqual(t.sent.length, 1, 'still nudged');
    assert.strictEqual(t.notices.length, 0, 'planned end was 3h ago, but the ETA was 30 min ago');
  });

  await test('escalateOverdueRunning: past 25h the close alert drops to once a day', async () => {
    const prior = { action: 'CAR_OVERDUE_CLOSE_REQUIRED', recordId: 'r9', createdAt: new Date(Date.now() - 13 * 3600 * 1000) };
    // 13h-old marker: the 12h window would re-alert, the daily one must not
    const daily = escalation([escalationRow({
      request: { id: 'r9', docNumber: 'CAR-202611-0039', carRequest: { endDate: endedAgo(26 * 60) } },
    })], [prior]);
    await daily.svc.escalateOverdueRunning();
    assert.strictEqual(daily.notices.length, 0, 'no second alert inside the day');

    const twelve = escalation([escalationRow()], [prior]);
    await twelve.svc.escalateOverdueRunning();
    assert.strictEqual(twelve.notices.length, 1, 'under 25h the 12h window still re-alerts');
  });

  await test('escalateOverdueRunning: the driver is nudged for the first 24 h only', async () => {
    const t = escalation([escalationRow({
      request: { id: 'r9', docNumber: 'CAR-202611-0039', carRequest: { endDate: endedAgo(30 * 60) } },
    })]);
    await t.svc.escalateOverdueRunning();
    assert.strictEqual(t.sent.length, 0, 'hourly pings stop after a day on the road');
    assert.strictEqual(t.notices.length, 1, 'Administration still gets the manual-close alert');
  });

  // ------------------------------------------------ 7) Step 2.6: day-end digest
  /**
   * Minimal Prisma `where` evaluator (OR/AND, dates, null, not) so the digest
   * tests run the QUERY, not only the in-memory bucket filters — a row that no
   * arm asks for must never reach the message.
   */
  function matchesWhere(row: any, where: any): boolean {
    return Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
      if (key === 'OR') return (cond as any[]).some((c) => matchesWhere(row, c));
      if (key === 'AND') return (cond as any[]).every((c) => matchesWhere(row, c));
      const value = row?.[key];
      if (cond === null) return value == null;
      if (cond instanceof Date) return value != null && new Date(value).getTime() === cond.getTime();
      if (typeof cond !== 'object') return value === cond;
      const ops = Object.keys(cond);
      if (!ops.some((op) => ['not', 'lt', 'lte', 'gt', 'gte'].includes(op))) return matchesWhere(value, cond);
      if ('not' in cond) return cond.not === null ? value != null : value !== cond.not;
      if (value == null) return false;
      const t = new Date(value).getTime();
      if ('lt' in cond && !(t < new Date(cond.lt).getTime())) return false;
      if ('lte' in cond && !(t <= new Date(cond.lte).getTime())) return false;
      if ('gt' in cond && !(t > new Date(cond.gt).getTime())) return false;
      if ('gte' in cond && !(t >= new Date(cond.gte).getTime())) return false;
      return true;
    });
  }

  function digest(assignments: any[]) {
    const sent: string[] = [];
    const prisma: any = {
      carAssignment: {
        findMany: async (args: any) => {
          assert.ok(args?.where, 'the digest must ask for a window');
          return assignments.filter((a) => matchesWhere(a, args.where));
        },
      },
      user: { findMany: async () => [{ telegramChatId: 'chat-admin' }] },
    };
    const svc: any = new TripRemindersService(
      prisma,
      { notify: async () => ({}), notifyMany: async () => ({}) } as any,
      { sendRaw: async (_chat: string, text: string) => { sent.push(text); }, mirrorToUser: async () => ({}) } as any,
      { usersWithPermissions: async () => ['u-admin'] } as any,
    );
    return { svc, sent };
  }

  const digestRow = (over: Record<string, unknown> = {}) => ({
    releasedAt: null, driverBackAtOfficeAt: null, endOdoAt: null,
    startOdoKm: 341626, startOdoAt: endedAgo(240), driverArrivedAt: endedAgo(230),
    estimatedReturnAt: null,
    driver: { name: 'Naing Naing Tun' },
    vehicle: { vehicleNo: '9F1213' },
    trip: null,
    request: { docNumber: 'CAR-202611-0039', status: 'IN_PROGRESS', carRequest: { endDate: endedAgo(180) } },
    ...over,
  });

  await test('dayEndDigest: a held ride gets its own bucket instead of vanishing', async () => {
    const t = digest([digestRow()]);
    await t.svc.dayEndDigest();
    assert.strictEqual(t.sent.length, 1, 'the digest is sent');
    assert.match(t.sent[0], /Overdue returns — close with the return km/);
    assert.match(t.sent[0], /CAR-202611-0039/);
  });

  await test('dayEndDigest: a ride whose ⏰ ETA is still ahead is not listed as overdue', async () => {
    const t = digest([digestRow({ estimatedReturnAt: new Date(Date.now() + 3600 * 1000) })]);
    await t.svc.dayEndDigest();
    assert.strictEqual(t.sent.length, 0, 'not overdue until the ETA passes');
  });

  await test('dayEndDigest: a ride held for days is still listed every evening', async () => {
    // the window ended four days ago — a `endDate >= dayStart` floor dropped it
    const t = digest([digestRow({
      request: { docNumber: 'CAR-202611-0039', status: 'IN_PROGRESS', carRequest: { endDate: endedAgo(4 * 24 * 60) } },
    })]);
    await t.svc.dayEndDigest();
    assert.strictEqual(t.sent.length, 1, 'a car stuck since last week still reports');
    assert.match(t.sent[0], /Overdue returns — close with the return km/);
    assert.match(t.sent[0], /4 d late/, 'the message says how long it has been out');
  });

  await test('dayEndDigest: an old ride that was closed is not dragged back in', async () => {
    const t = digest([digestRow({
      driverBackAtOfficeAt: endedAgo(4 * 24 * 60),
      request: { docNumber: 'CAR-202611-0030', status: 'COMPLETED', carRequest: { endDate: endedAgo(4 * 24 * 60) } },
    })]);
    await t.svc.dayEndDigest();
    assert.strictEqual(t.sent.length, 0, 'history stays history');
  });

  await test('dayEndDigest: a STARTED trip stays in the mileage bucket, not the hold', async () => {
    const t = digest([digestRow({ trip: { status: 'STARTED' } })]);
    await t.svc.dayEndDigest();
    assert.strictEqual(t.sent.length, 1);
    assert.match(t.sent[0], /Mileage open/);
    assert.doesNotMatch(t.sent[0], /Overdue returns/, 'a STARTED trip has its own close-out, not the manual hold');
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
