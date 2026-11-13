/**
 * Janitor sweep for dashboard photos nothing points at any more.
 *
 * assign()/reassign() clear startOdoPhoto/endOdoPhoto and clearPending() clears the
 * armed capture, but none of them deletes the file — so a re-assigned booking leaves
 * a saved reading behind, and a crash between the row write and an unlink leaves a
 * capture behind. The 6-hourly sweep must reclaim exactly those, in both
 * odometer/ and odometer/pending/: never a file a row still names, never one inside
 * the TTL, never anything this service did not write.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/odo-pending-sweep.test.ts
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
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

const { TripRemindersService } = require('../src/cars/trip-reminders.service');

const OLD_SAVED = '11111111-1111-1111-1111-111111111111.jpg';
const OLD_CAPTURE = '22222222-2222-2222-2222-222222222222.jpg';
const REFERENCED = '33333333-3333-3333-3333-333333333333.jpg';
const NOT_OURS = 'notes.txt';
const HOUR = 3600 * 1000;

function build(rows: Partial<Record<'pendingOdoPhoto' | 'startOdoPhoto' | 'endOdoPhoto', string>>[] = [], rowsThrow = false) {
  const prisma: any = {
    carAssignment: {
      findMany: async () => {
        if (rowsThrow) throw new Error('db down');
        return rows;
      },
    },
  };
  const svc: any = new TripRemindersService(
    prisma,
    { notifyMany: async () => undefined } as any,
    {} as any,
    { usersWithPermissions: async () => [] } as any,
  );
  svc.logger = { log: () => undefined, warn: () => undefined };
  return svc;
}

/** A throwaway upload volume: <root>/odometer[/pending], wired through UPLOAD_PATH. */
async function withVolume(fn: (dirs: { saved: string; pending: string }) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ams-odo-sweep-'));
  const saved = path.join(root, 'odometer');
  const pending = path.join(saved, 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const prev = process.env.UPLOAD_PATH;
  process.env.UPLOAD_PATH = root;
  try {
    await fn({ saved, pending });
  } finally {
    if (prev === undefined) delete process.env.UPLOAD_PATH;
    else process.env.UPLOAD_PATH = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function write(dir: string, name: string, ageMs: number): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, 'jpeg-bytes');
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(full, at, at);
  return full;
}

async function main() {
  await test('a saved reading no row names is reclaimed, the one a row names is not', async () => {
    await withVolume(async ({ saved }) => {
      const orphan = write(saved, OLD_SAVED, 48 * HOUR);
      const kept = write(saved, REFERENCED, 48 * HOUR);
      const removed = await build([{ startOdoPhoto: REFERENCED }]).sweepOrphanedOdoPhotos();
      assert.strictEqual(removed, 1, 'exactly the unreferenced reading goes');
      assert.strictEqual(fs.existsSync(orphan), false);
      assert.strictEqual(fs.existsSync(kept), true, 'a referenced reading stays');
    });
  });

  await test('an abandoned capture is reclaimed from odometer/pending', async () => {
    await withVolume(async ({ pending }) => {
      const capture = write(pending, OLD_CAPTURE, 48 * HOUR);
      const removed = await build().sweepOrphanedOdoPhotos();
      assert.strictEqual(removed, 1);
      assert.strictEqual(fs.existsSync(capture), false);
    });
  });

  await test('nothing inside the TTL is touched, in either folder', async () => {
    await withVolume(async ({ saved, pending }) => {
      const freshSaved = write(saved, OLD_SAVED, 10 * 60 * 1000);
      const freshCapture = write(pending, OLD_CAPTURE, 10 * 60 * 1000);
      assert.strictEqual(await build().sweepOrphanedOdoPhotos(), 0);
      assert.strictEqual(fs.existsSync(freshSaved), true);
      assert.strictEqual(fs.existsSync(freshCapture), true);
    });
  });

  await test('only uuid-named images are touched', async () => {
    await withVolume(async ({ saved, pending }) => {
      const foreign = write(saved, NOT_OURS, 48 * HOUR);
      const sub = path.join(saved, 'some-folder');
      fs.mkdirSync(sub);
      assert.strictEqual(await build().sweepOrphanedOdoPhotos(), 0);
      assert.strictEqual(fs.existsSync(foreign), true, 'a foreign file is not ours to delete');
      assert.strictEqual(fs.existsSync(sub), true, 'a folder is not a capture');
      assert.strictEqual(fs.existsSync(pending), true);
    });
  });

  await test('a missing volume and a failing query are no-ops, not crashes', async () => {
    const prev = process.env.UPLOAD_PATH;
    process.env.UPLOAD_PATH = path.join(os.tmpdir(), 'ams-odo-sweep-absent');
    try {
      assert.strictEqual(await build().sweepOrphanedOdoPhotos(), 0, 'missing volume → 0');
    } finally {
      if (prev === undefined) delete process.env.UPLOAD_PATH;
      else process.env.UPLOAD_PATH = prev;
    }
    await withVolume(async ({ saved }) => {
      write(saved, OLD_SAVED, 48 * HOUR);
      assert.strictEqual(await build([], true).sweepOrphanedOdoPhotos(), 0, 'db error → 0');
    });
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
