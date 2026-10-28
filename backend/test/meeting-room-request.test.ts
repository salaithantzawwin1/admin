/**
 * Meeting room request — detail access + room assign / change / clear.
 *
 * Why:
 *  • findByRequest() had NO access check: any authenticated user could read
 *    anyone's meeting detail (verified: a finance account got 200 on someone
 *    else's meeting), while the car endpoint already 403'd outsiders. Access is
 *    now owner / SYSTEM_ADMIN / meeting-rooms.assign / approvals.act — the same
 *    rule the car panel uses.
 *  • assign() demanded status APPROVED, but assigning sets the doc IN_PROGRESS —
 *    so the "clear the room" branch was unreachable AND only nulled roomId
 *    without reverting the doc (a roomless IN_PROGRESS would silently fall out
 *    of every query). Result: a wrongly assigned room could only be fixed by
 *    cancelling the whole request, even though admin-shift's own error message
 *    told admins to "unassign it". Assign now also accepts IN_PROGRESS: a
 *    re-assign frees the old room (when no other live booking uses it), and a
 *    clear frees the room and re-queues the request as APPROVED.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/meeting-room-request.test.ts
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
const OWNER = { userId: 'u-owner', username: 'owner' };
const START = new Date(Date.now() + 3600_000);
const END = new Date(Date.now() + 7200_000);

const MR_ROW = {
  requestId: 'req-1',
  title: 'Sync',
  attendees: 5,
  startTime: START,
  endTime: END,
  roomId: null as string | null,
  status: 'APPROVED',
  room: null,
  request: { requesterId: 'u-owner' },
};

const ROOMS: Record<string, any> = {
  'room-a': { id: 'room-a', name: 'Room A', location: 'GF', capacity: 10, status: 'IN_USE' },
  'room-b': { id: 'room-b', name: 'Room B', location: '1F', capacity: 12, status: 'AVAILABLE' },
  'room-small': { id: 'room-small', name: 'Hut', location: null, capacity: 3, status: 'AVAILABLE' },
  'room-oos': { id: 'room-oos', name: 'OOS', location: null, capacity: 20, status: 'OUT_OF_SERVICE' },
};

function assignedRequest(overrides: any = {}) {
  return {
    id: 'req-1',
    docNumber: 'MTG-0007',
    status: 'IN_PROGRESS',
    requesterId: 'u-owner',
    meetingRequest: {
      requestId: 'req-1',
      title: 'Sync',
      attendees: 5,
      roomId: 'room-a',
      startTime: START,
      endTime: END,
      ...(overrides.meetingRequest ?? {}),
    },
    requester: { telegramChatId: null },
    ...(overrides.request ?? {}),
  };
}

interface Opts {
  mrRow?: any; // meetingRoomRequest.findUnique (findByRequest)
  request?: any; // requestDocument.findUnique (assign)
  rooms?: Record<string, any>;
  conflicts?: any[];
  /** freeRoom: number of OTHER live bookings still on the old room */
  otherCount?: number;
  /** permission codes granted to the caller of findByRequest */
  perms?: string[];
  isSystemAdmin?: boolean;
}

function makePrisma(opts: Opts) {
  const calls: { name: string; where?: any; data?: any }[] = [];
  const rec = (name: string) => async (args: any) => {
    calls.push({ name, where: args?.where, data: args?.data });
    return {};
  };
  const prisma: any = {
    meetingRoomRequest: {
      findUnique: async () => opts.mrRow ?? null,
      findMany: async () => opts.conflicts ?? [], // overlap re-check in assign()
      count: async () => opts.otherCount ?? 0, // freeRoom: other live bookings
      update: rec('meetingRoomRequest.update'),
    },
    meetingRoom: {
      findUnique: async (a: any) => opts.rooms?.[a?.where?.id] ?? null,
      update: rec('meetingRoom.update'),
    },
    requestDocument: {
      findUnique: async () => opts.request ?? null,
      update: rec('requestDocument.update'),
    },
    userRole: {
      findFirst: async () => (opts.isSystemAdmin ? { userId: 'u-admin' } : null),
    },
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
    __calls: calls,
  };
  return prisma;
}

function makeService(prisma: any, perms: string[]) {
  const { MeetingRoomsService } = require('../src/meeting-rooms/meeting-rooms.service');
  const notifications: any[] = [];
  const audits: any[] = [];
  const svc = new MeetingRoomsService(
    prisma,
    {} as any,
    { notify: async (n: any) => notifications.push(n) } as any,
    { log: async (a: any) => audits.push(a) } as any,
    {
      forUser: async () => perms,
      userHas: async (_u: string, code: string) => perms.includes(code),
      usersWithPermissions: async () => [],
    } as any,
    { sendRaw: async () => undefined } as any,
  );
  return { svc, notifications, audits };
}

function upd(prisma: any, name: string) {
  return prisma.__calls.filter((c: any) => c.name === name);
}

async function main() {
  console.log('\n-- meeting request: detail access --');

  await test('stranger cannot read a meeting request detail', async () => {
    const prisma = makePrisma({ mrRow: { ...MR_ROW } });
    const { svc } = makeService(prisma, []);
    await assert.rejects(() => svc.findByRequest('req-1', { userId: 'u-stranger', username: 's' }), /No access/);
  });

  await test('requester reads their own meeting detail', async () => {
    const prisma = makePrisma({ mrRow: { ...MR_ROW } });
    const { svc } = makeService(prisma, []);
    const row = await svc.findByRequest('req-1', OWNER);
    assert.strictEqual(row.requestId, 'req-1');
  });

  await test('approvals.act holder reads it (approver parity with the car panel)', async () => {
    const prisma = makePrisma({ mrRow: { ...MR_ROW } });
    const { svc } = makeService(prisma, ['approvals.act']);
    const row = await svc.findByRequest('req-1', { userId: 'u-head', username: 'head' });
    assert.strictEqual(row.requestId, 'req-1');
  });

  await test('meeting-rooms.assign holder reads it (Administration)', async () => {
    const prisma = makePrisma({ mrRow: { ...MR_ROW } });
    const { svc } = makeService(prisma, ['meeting-rooms.assign']);
    const row = await svc.findByRequest('req-1', { userId: 'u-admin2', username: 'admin2' });
    assert.strictEqual(row.requestId, 'req-1');
  });

  await test('SYSTEM_ADMIN reads it (role bypass, like cars)', async () => {
    const prisma = makePrisma({ mrRow: { ...MR_ROW }, isSystemAdmin: true });
    const { svc } = makeService(prisma, []);
    const row = await svc.findByRequest('req-1', { userId: 'u-admin', username: 'sysadmin' });
    assert.strictEqual(row.requestId, 'req-1');
  });

  console.log('\n-- meeting request: assign / change / clear --');

  await test('clear frees the room and re-queues the request as APPROVED', async () => {
    const prisma = makePrisma({ request: assignedRequest(), rooms: ROOMS, otherCount: 0 });
    const { svc, notifications, audits } = makeService(prisma, []);
    const res = await svc.assign('req-1', undefined, ACTOR);
    assert.deepStrictEqual(res, { success: true });

    const mrUpd = upd(prisma, 'meetingRoomRequest.update')[0];
    assert.deepStrictEqual(mrUpd.data, { roomId: null, status: 'APPROVED' }, 'mr must drop the room and go back to APPROVED');
    const docUpd = upd(prisma, 'requestDocument.update')[0];
    assert.strictEqual(docUpd.data.status, 'APPROVED', 'doc must revert to APPROVED so it re-enters the queue');
    const roomUpd = upd(prisma, 'meetingRoom.update')[0];
    assert.strictEqual(roomUpd.data.status, 'AVAILABLE', 'old room must be freed when no other live booking uses it');
    assert.ok(notifications.some((n) => /Room removed/.test(n.title)), 'requester must be notified');
    assert.ok(audits.some((a) => a.action === 'MEETING_ROOM_CLEARED'), 'audit entry expected');
  });

  await test('clear keeps the room IN_USE while another live booking still uses it', async () => {
    const prisma = makePrisma({ request: assignedRequest(), rooms: ROOMS, otherCount: 1 });
    const { svc } = makeService(prisma, []);
    await svc.assign('req-1', undefined, ACTOR);
    assert.strictEqual(upd(prisma, 'meetingRoom.update').length, 0, 'room must not be freed while busy');
  });

  await test('clear with no room assigned is a safe no-op', async () => {
    const prisma = makePrisma({ request: assignedRequest({ meetingRequest: { roomId: null } }), rooms: ROOMS });
    const { svc } = makeService(prisma, []);
    const res = await svc.assign('req-1', undefined, ACTOR);
    assert.deepStrictEqual(res, { success: true });
    assert.strictEqual(prisma.__calls.length, 0, 'no writes for a no-op');
  });

  await test('re-assign: new room booked, old room freed, doc stays IN_PROGRESS', async () => {
    const prisma = makePrisma({ request: assignedRequest(), rooms: ROOMS, conflicts: [], otherCount: 0 });
    const { svc, notifications, audits } = makeService(prisma, []);
    await svc.assign('req-1', 'room-b', ACTOR);

    const mrUpd = upd(prisma, 'meetingRoomRequest.update')[0];
    assert.deepStrictEqual(mrUpd.data, { roomId: 'room-b', status: 'IN_PROGRESS' });
    const docUpd = upd(prisma, 'requestDocument.update')[0];
    assert.strictEqual(docUpd.data.status, 'IN_PROGRESS');

    const roomUpds = upd(prisma, 'meetingRoom.update');
    assert.deepStrictEqual(
      roomUpds.map((c: any) => ({ id: c.where.id, status: c.data.status })),
      [
        { id: 'room-b', status: 'IN_USE' },
        { id: 'room-a', status: 'AVAILABLE' },
      ],
      'new room booked, old room freed',
    );
    assert.ok(notifications.some((n) => /Room changed/.test(n.title)), 'requester must be told the room changed');
    const audit = audits.find((a) => a.action === 'MEETING_ROOM_ASSIGNED');
    assert.ok(audit, 'assignment audit expected');
    assert.deepStrictEqual(audit.oldValue, { roomId: 'room-a' }, 'audit must record the previous room');
  });

  await test('fresh assign on an APPROVED request books the room and completes as before', async () => {
    const fresh = assignedRequest({ request: { status: 'APPROVED' } });
    fresh.meetingRequest.roomId = null;
    const prisma = makePrisma({ request: fresh, rooms: ROOMS, conflicts: [], otherCount: 0 });
    const { svc, notifications } = makeService(prisma, []);
    await svc.assign('req-1', 'room-a', ACTOR);
    const mrUpd = upd(prisma, 'meetingRoomRequest.update')[0];
    assert.deepStrictEqual(mrUpd.data, { roomId: 'room-a', status: 'IN_PROGRESS' });
    assert.ok(notifications.some((n) => /Room assigned to/.test(n.title)), 'plain assign wording expected');
    assert.strictEqual(upd(prisma, 'meetingRoom.update').length, 1, 'no old room to free');
  });

  await test('COMPLETED request cannot be (re)assigned', async () => {
    const prisma = makePrisma({ request: assignedRequest({ request: { status: 'COMPLETED' } }), rooms: ROOMS });
    const { svc } = makeService(prisma, []);
    await assert.rejects(() => svc.assign('req-1', 'room-b', ACTOR), /Only APPROVED or IN_PROGRESS/);
  });

  await test('too-small room is rejected with 409', async () => {
    const prisma = makePrisma({ request: assignedRequest(), rooms: ROOMS, conflicts: [] });
    const { svc } = makeService(prisma, []);
    await assert.rejects(() => svc.assign('req-1', 'room-small', ACTOR), /seats 3/);
  });

  await test('out-of-service room is rejected with 409', async () => {
    const prisma = makePrisma({ request: assignedRequest(), rooms: ROOMS, conflicts: [] });
    const { svc } = makeService(prisma, []);
    await assert.rejects(() => svc.assign('req-1', 'room-oos', ACTOR), /OUT_OF_SERVICE/);
  });

  await test('double-booking overlap is rejected with 409', async () => {
    const prisma = makePrisma({
      request: assignedRequest(),
      rooms: ROOMS,
      conflicts: [{ request: { docNumber: 'MTG-0001' }, startTime: START, endTime: END }],
    });
    const { svc } = makeService(prisma, []);
    await assert.rejects(() => svc.assign('req-1', 'room-b', ACTOR), /already booked/);
  });

  await test('unknown room → 404', async () => {
    const prisma = makePrisma({ request: assignedRequest(), rooms: ROOMS, conflicts: [] });
    const { svc } = makeService(prisma, []);
    await assert.rejects(() => svc.assign('req-1', 'no-such-room', ACTOR), /Room not found/);
  });

  console.log(`\n  ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
}

main();
