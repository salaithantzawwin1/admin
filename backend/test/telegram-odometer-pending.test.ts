/**
 * Persisted odometer capture (P8) + the number-first path (P7).
 *
 * Real incident, 2026-11-10: the driver tapped "Back at office", sent two
 * dashboard photos, and typed 341363 eighty minutes later. The photos lived only
 * in the bot's in-memory map (lost on deploy) and the number typed without a photo
 * was thrown away, so the trip kept a missing return reading.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/telegram-odometer-pending.test.ts
 */
process.env.UPLOAD_PATH = require('os').tmpdir() + '/ams-odo-pending-' + process.pid;

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
const ASSIGN = 'as-77';
const PENDING_DIR = path.join(process.env.UPLOAD_PATH, 'odometer', 'pending');

function build(seed: Record<string, unknown> = {}) {
  const row: any = {
    id: ASSIGN,
    assignedAt: new Date(Date.now() - 3600_000),
    pendingOdoStage: null,
    pendingOdoPhoto: null,
    pendingOdoFileId: null,
    pendingOdoKm: null,
    pendingOdoAt: null,
    ...seed,
  };
  const updates: any[] = [];
  const captures: any[] = [];
  const calls: any[] = [];
  const marks: [string | null | undefined, string][] = [];
  const prisma: any = {
    systemSetting: { findMany: async () => [], findUnique: async () => null },
    driver: { findFirst: async () => ({ id: 'drv-1' }) },
    telegramInboundMessage: { findFirst: async () => null },
    carAssignment: {
      findUnique: async () => row,
      findFirst: async () => (row.pendingOdoStage ? row : null),
      findMany: async () => [],
      update: async (args: any) => {
        updates.push(args);
        Object.assign(row, args.data);
        return row;
      },
    },
  };
  const svc: any = new TelegramService(prisma, {} as any, { usersWithPermissions: async () => [] } as any, {} as any);
  svc.inbound = {
    capture: async () => ({ id: 'row-1', announcementId: null }),
    markHandled: async (id: string, by: string) => {
      marks.push([id, by]);
    },
  };
  svc.config = async () => ({ token: 'test-token', enabled: true });
  svc.call = async (method: string, payload: any) => {
    calls.push({ method, payload });
    return { file_path: 'photos/odo.jpg', message_id: 1 };
  };
  svc.odoRef = {
    capture: async (assignmentId: string, data: any, actor: any) => {
      captures.push({ assignmentId, ...data, actor });
    },
  };
  const realFetch = global.fetch;
  global.fetch = (async () => ({ ok: true, arrayBuffer: async () => Buffer.from('jpeg-bytes') })) as any;
  return {
    svc, row, updates, captures, calls, marks,
    replies: () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload?.text ?? '')),
    restore: () => {
      global.fetch = realFetch;
    },
  };
}

const photoUpdate = {
  update_id: 1,
  message: { message_id: 71, chat: { id: Number(CHAT) }, photo: [{ file_id: 'file-9', file_size: 900 }] },
};
const textUpdate = (text: string) => ({ update_id: 2, message: { message_id: 72, chat: { id: Number(CHAT) }, text } });

async function main() {
  console.log('telegram odometer pending capture');

  await test('a photo is written to disk and recorded on the assignment', async () => {
    const h = build();
    try {
      h.svc.pendingOdo.set(CHAT, { assignmentId: ASSIGN, stage: 'BACK', at: Date.now() });
      await h.svc.handleUpdate(photoUpdate);
      const files = fs.existsSync(PENDING_DIR) ? fs.readdirSync(PENDING_DIR) : [];
      assert.ok(files.some((f: string) => f === h.row.pendingOdoPhoto), 'the file is on disk, not only in memory');
      assert.match(String(h.row.pendingOdoPhoto), /\.jpg$/);
      assert.strictEqual(h.row.pendingOdoFileId, 'file-9', 'the Telegram file id is kept for the audit trail');
      assert.strictEqual(h.row.pendingOdoStage, 'BACK');
      assert.deepStrictEqual(h.marks, [['row-1', 'ODOMETER']]);
      assert.ok(h.replies().some((t) => /ဂဏန်း/.test(t)), 'the driver is asked for the number');
    } finally {
      h.restore();
    }
  });

  await test('a number typed before the photo is kept and confirmed, never auto-recorded', async () => {
    const h = build();
    try {
      h.svc.pendingOdo.set(CHAT, { assignmentId: ASSIGN, stage: 'BACK', at: Date.now() });
      await h.svc.handleUpdate(textUpdate('341363'));
      assert.strictEqual(h.row.pendingOdoKm, 341363, 'the number is stored, not discarded');
      assert.strictEqual(h.captures.length, 0, 'nothing is recorded without the photo');
      assert.ok(h.replies().some((t) => /မှတ်ထားပါတယ်/.test(t)));

      // the photo arrives afterwards → a confirmation card, still no capture
      await h.svc.handleUpdate(photoUpdate);
      const card = h.calls.find((c) => c.payload?.reply_markup);
      assert.ok(card, 'a confirm card is sent');
      const buttons = card.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
      assert.deepStrictEqual(buttons, [`odo:ok:${ASSIGN}`, `odo:fix:${ASSIGN}`]);
      assert.strictEqual(h.captures.length, 0, 'the pairing is the driver\'s call');

      // tapping ✓ records it and clears the pending row
      await h.svc.handleOdoCallback(`odo:ok:${ASSIGN}`, CHAT, 'cb-1');
      assert.strictEqual(h.captures.length, 1);
      assert.strictEqual(h.captures[0].km, 341363);
      assert.strictEqual(h.captures[0].stage, 'BACK');
      assert.ok(h.captures[0].photo?.buffer?.length, 'the kept photo is the evidence');
      assert.strictEqual(h.row.pendingOdoStage, null, 'the capture is done');
      assert.strictEqual(h.row.pendingOdoPhoto, null);
    } finally {
      h.restore();
    }
  });

  await test('after a restart the persisted capture resumes and the number completes it', async () => {
    const h = build();
    try {
      // simulate what a deploy leaves behind: file on disk + row still waiting
      fs.mkdirSync(PENDING_DIR, { recursive: true });
      const name = 'restart-photo.jpg';
      fs.writeFileSync(path.join(PENDING_DIR, name), Buffer.from('jpeg-bytes'));
      h.row.pendingOdoStage = 'BACK';
      h.row.pendingOdoPhoto = name;
      h.row.pendingOdoAt = new Date(Date.now() - 60_000);

      await h.svc.handleUpdate(textUpdate('341363')); // fresh process: the map is empty
      assert.strictEqual(h.captures.length, 1, 'the number is recorded against the kept photo');
      assert.strictEqual(h.captures[0].km, 341363);
      assert.strictEqual(h.row.pendingOdoStage, null, 'and the pending row is cleared');
      assert.ok(!fs.existsSync(path.join(PENDING_DIR, name)), 'the pending file is cleaned up');
    } finally {
      h.restore();
    }
  });

  await test('a capture older than a day is not resumed', async () => {
    const h = build({
      pendingOdoStage: 'BACK',
      pendingOdoAt: new Date(Date.now() - 25 * 3600_000),
    });
    try {
      await h.svc.handleUpdate(textUpdate('341363'));
      assert.strictEqual(h.captures.length, 0, 'a stale capture never swallows a message');
    } finally {
      h.restore();
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
