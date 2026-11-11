/**
 * Telegram odometer evidence tests — a dashboard photo that arrived BEFORE the
 * driver tapped Ready / Back (or before the capture was re-armed) must still
 * become the reading's evidence instead of being answered with "send the photo
 * first" and silently lost (the trip then showed no kilo photo at all).
 *
 * Mock Prisma + stubbed bot API, REAL TelegramService.handleOdoText.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/telegram-odometer-evidence.test.ts
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
const ASSIGN = 'as-1';
// the trip started 10 minutes ago; the photo arrived a minute later (the driver
// sent it just before tapping "Back at office"), the number a few seconds after
const ASSIGNED_AT = new Date(Date.now() - 10 * 60_000);
const PHOTO_AT = new Date(Date.now() - 9 * 60_000);

function build(opts: { photo?: { photoFileId: string; receivedAt: Date } | null; fetchOk?: boolean } = {}) {
  const captured: any[] = [];
  const replies: string[] = [];
  let findFirstWhere: any = null;
  const prisma: any = {
    carAssignment: { findUnique: async () => ({ assignedAt: ASSIGNED_AT }) },
    telegramInboundMessage: {
      findFirst: async (args: any) => {
        findFirstWhere = args?.where ?? null;
        return opts.photo ?? null;
      },
    },
  };
  const svc: any = new TelegramService(prisma, {} as any, {} as any, {} as any);
  svc.config = async () => ({ token: 'test-token', enabled: true });
  svc.call = async (_method: string, payload: any) => {
    if (payload?.text) replies.push(payload.text);
    return { file_path: 'photos/odo.jpg' };
  };
  svc.odoRef = {
    capture: async (assignmentId: string, data: any, actor: any) => {
      captured.push({ assignmentId, data, actor });
      return { ok: true };
    },
  };
  const realFetch = global.fetch;
  global.fetch = (async () => ({
    ok: opts.fetchOk !== false,
    arrayBuffer: async () => Buffer.from('jpeg-bytes'),
  })) as any;
  return {
    svc,
    captured,
    replies,
    get where() {
      return findFirstWhere;
    },
    restore() {
      global.fetch = realFetch;
    },
  };
}

/** The capture is armed (the driver already tapped) but no photo is in memory. */
function arm(svc: any, extra: Record<string, unknown> = {}) {
  svc.pendingOdo.set(CHAT, { assignmentId: ASSIGN, stage: 'BACK', at: Date.now(), ...extra });
}

async function main() {
  await test('a photo sent before the tap becomes the reading evidence', async () => {
    const h = build({ photo: { photoFileId: 'file-1', receivedAt: PHOTO_AT } });
    try {
      arm(h.svc);
      const consumed = await h.svc.handleOdoText(CHAT, '341363');
      assert.strictEqual(consumed, true);
      assert.strictEqual(h.captured.length, 1, 'the reading is captured');
      assert.strictEqual(h.captured[0].data.km, 341363);
      assert.ok(h.captured[0].data.photo?.buffer?.length, 'the stored photo is the evidence');
      assert.ok(!h.svc.pendingOdo.has(CHAT), 'the capture is settled');
      assert.ok(
        h.replies.every((t: string) => !/ဓာတ်ပုံ/.test(t) || /မှတ်တမ်းတင်ပြီး/.test(t)),
        `never nags for a photo that is already there (${h.replies.join(' | ')})`,
      );
    } finally {
      h.restore();
    }
  });

  await test('the fallback only looks at photos from this chat, after the assignment started', async () => {
    const h = build({ photo: { photoFileId: 'file-1', receivedAt: PHOTO_AT } });
    try {
      arm(h.svc);
      await h.svc.handleOdoText(CHAT, '341363');
      assert.strictEqual(h.where.chatId, CHAT, 'scoped to the driver chat');
      assert.strictEqual(h.where.kind, 'PHOTO', 'photos only');
      assert.strictEqual(h.where.announcementId, null, 'a card reply is never odometer evidence');
      assert.ok(h.where.receivedAt.gte instanceof Date);
      assert.strictEqual(
        h.where.receivedAt.gte.toISOString(),
        ASSIGNED_AT.toISOString(),
        'never reaches back past the assignment start',
      );
    } finally {
      h.restore();
    }
  });

  await test('no stored photo → still asks for one and keeps the capture armed', async () => {
    const h = build({ photo: null });
    try {
      arm(h.svc);
      const consumed = await h.svc.handleOdoText(CHAT, '341363');
      assert.strictEqual(consumed, true);
      assert.strictEqual(h.captured.length, 0, 'nothing is captured without evidence');
      assert.ok(/ဓာတ်ပုံ/.test(h.replies.join(' | ')), 'the driver is asked for the photo');
      assert.ok(h.svc.pendingOdo.has(CHAT), 'still armed for the next message');
    } finally {
      h.restore();
    }
  });

  await test('a photo already in memory is used without a lookup', async () => {
    const h = build({ photo: { photoFileId: 'file-9', receivedAt: new Date() } });
    try {
      arm(h.svc, { photo: { buffer: Buffer.from('in-memory'), size: 9 } });
      await h.svc.handleOdoText(CHAT, '341363');
      assert.strictEqual(h.captured.length, 1);
      assert.strictEqual(h.captured[0].data.photo.buffer.toString(), 'in-memory');
      assert.strictEqual(h.where, null, 'no unnecessary query');
    } finally {
      h.restore();
    }
  });

  await test('a failed download keeps the capture armed instead of dropping the reading', async () => {
    const h = build({ photo: { photoFileId: 'file-1', receivedAt: new Date() }, fetchOk: false });
    try {
      arm(h.svc);
      await h.svc.handleOdoText(CHAT, '341363');
      assert.strictEqual(h.captured.length, 0);
      assert.ok(h.svc.pendingOdo.has(CHAT), 'the driver can retry');
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
