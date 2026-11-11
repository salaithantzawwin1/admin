process.env.UPLOAD_PATH = require('os').tmpdir() + '/ams-odo-test-' + process.pid;
/**
 * A dashboard photo that arrives with NO capture armed (plan: odometer rescue).
 *
 * Real incident, CAR-202611-0023: the driver tapped "Back at office", sent two
 * photos 4 minutes later, and only sent the kilo 80 minutes after that — by then
 * the 30-minute window was gone, the bot answered nothing, and the trip kept a
 * missing return reading forever. The poll loop now re-arms from the taps that
 * already happened and takes the photo as evidence.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/telegram-odometer-resume.test.ts
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

const { TelegramService } = require('../src/telegram/telegram.service');

const CHAT = '4242';
const DRIVER = 'drv-1';
const ASSIGN = 'as-9';

function build(opts: { trips?: any[]; driver?: boolean; fetchOk?: boolean } = {}) {
  const prisma: any = {
    systemSetting: { findMany: async () => [], findUnique: async () => null },
    driver: { findFirst: async () => (opts.driver === false ? null : { id: DRIVER }) },
    carAssignment: {
      findMany: async (args: any) => {
        build.lastQuery = args;
        return opts.trips ?? [];
      },
      findUnique: async () => ({ assignedAt: new Date(Date.now() - 60_000) }),
    },
    telegramInboundMessage: { findFirst: async () => null },
  };
  const svc: any = new TelegramService(prisma, {} as any, { usersWithPermissions: async () => [] } as any, {} as any);
  const sent: string[] = [];
  const marks: [string | null | undefined, string][] = [];
  svc.inbound = {
    capture: async () => ({ id: 'row-1', announcementId: null }),
    markHandled: async (id: string, by: string) => {
      marks.push([id, by]);
    },
  };
  svc.config = async () => ({ token: 'test-token', enabled: true });
  svc.call = async (_m: string, p: any) => {
    if (p?.text) sent.push(String(p.text));
    return { file_path: 'photos/odo.jpg', message_id: 1 };
  };
  const realFetch = global.fetch;
  global.fetch = (async () => ({
    ok: opts.fetchOk !== false,
    arrayBuffer: async () => Buffer.from('jpeg-bytes'),
  })) as any;
  return {
    svc,
    sent,
    marks,
    restore() {
      global.fetch = realFetch;
    },
  };
}

const photoUpdate = { update_id: 1, message: { message_id: 77, chat: { id: Number(CHAT) }, photo: [{ file_id: 'file-1', file_size: 900 }] } };

async function main() {
  console.log('telegram odometer rescue');

  await test('a photo after an expired window re-arms the return capture and asks for the kilo', async () => {
    const h = build({
      trips: [{ id: ASSIGN, startOdoKm: 341325, endOdoKm: null, driverArrivedAt: new Date(), driverBackAtOfficeAt: new Date() }],
    });
    try {
      assert.ok(!h.svc.pendingOdo.has(CHAT), 'nothing is armed before the photo');
      await h.svc.handleUpdate(photoUpdate);
      const pending = h.svc.pendingOdo.get(CHAT);
      assert.ok(pending, 'the capture is armed again');
      assert.strictEqual(pending.assignmentId, ASSIGN);
      assert.strictEqual(pending.stage, 'BACK');
      assert.ok(pending.photo?.buffer?.length, 'the photo is the evidence');
      assert.deepStrictEqual(h.marks, [['row-1', 'ODOMETER']], 'the inbound row is labelled ODOMETER');
      assert.ok(/ဓာတ်ပုံ/.test(h.sent.join(' | ')) && /ဂဏန်း/.test(h.sent.join(' | ')), 'the driver is told to send the number');
    } finally {
      h.restore();
    }
  });

  await test('a departure kilo still missing is what gets armed after an arrival tap', async () => {
    const h = build({
      trips: [{ id: ASSIGN, startOdoKm: null, endOdoKm: null, driverArrivedAt: new Date(), driverBackAtOfficeAt: null }],
    });
    try {
      await h.svc.handleUpdate(photoUpdate);
      assert.strictEqual(h.svc.pendingOdo.get(CHAT)?.stage, 'READY');
    } finally {
      h.restore();
    }
  });

  await test('a trip with both readings recorded never re-arms (a receipt is not evidence)', async () => {
    const h = build({
      trips: [{ id: ASSIGN, startOdoKm: 1, endOdoKm: 2, driverArrivedAt: new Date(), driverBackAtOfficeAt: new Date() }],
    });
    try {
      await h.svc.handleUpdate(photoUpdate);
      assert.ok(!h.svc.pendingOdo.has(CHAT), 'nothing armed');
      assert.deepStrictEqual(h.marks, [], 'the photo is stored as a plain message');
      assert.deepStrictEqual(h.sent, [], 'and the bot stays quiet');
    } finally {
      h.restore();
    }
  });

  await test('only the last day of trips is considered', async () => {
    const h = build({ trips: [] });
    try {
      await h.svc.handleUpdate(photoUpdate);
      const q = build.lastQuery;
      assert.strictEqual(q.where.driverId, DRIVER);
      const since = q.where.OR[0].driverBackAtOfficeAt.gte;
      assert.ok(since instanceof Date);
      const hours = (Date.now() - since.getTime()) / 3600_000;
      assert.ok(hours > 23.9 && hours < 24.1, `a 24 h window (${hours.toFixed(2)} h)`);
    } finally {
      h.restore();
    }
  });

  await test('an unbound chat falls through untouched', async () => {
    const h = build({ driver: false });
    try {
      await h.svc.handleUpdate(photoUpdate);
      assert.ok(!h.svc.pendingOdo.has(CHAT));
      assert.deepStrictEqual(h.sent, []);
    } finally {
      h.restore();
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error(`FAILED (${failures.length}): ${failures.join(' | ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
