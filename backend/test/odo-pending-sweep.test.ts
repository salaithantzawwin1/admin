/**
 * Janitor sweep for orphaned pending odometer photos.
 *
 * armOdo() deletes the file it replaces, but a deploy/crash between the row write
 * and the unlink (or a row removed outside the service) leaves a JPEG on the
 * uploads volume that no car_assignments row names. The 6-hourly cron must reclaim
 * exactly those — never a file still referenced, never a capture in flight, never
 * anything this service did not write.
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

const UUID_OLD = '11111111-1111-1111-1111-111111111111.jpg';
const UUID_FRESH = '22222222-2222-2222-2222-222222222222.jpg';
const UUID_REFERENCED = '33333333-3333-3333-3333-333333333333.jpg';
const NOT_OURS = 'notes.txt';

const { TripRemindersService } = require('../src/cars/trip-reminders.service');

function build(opts: { referenced?: string[]; rowsThrows?: boolean } = {}) {
  const prisma: any = {
    carAssignment: {
      findMany: async () => {
        if (opts.rowsThrows) throw new Error('db down');
        return (opts.referenced ?? []).map((pendingOdoPhoto) => ({ pendingOdoPhoto }));
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

function volume() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ams-odo-sweep-'));
  const pending = path.join(root, 'odometer', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  return { root, pending };
}

function write(pending: string, name: string, ageMs: number) {
  const full = path.join(pending, name);
  fs.writeFileSync(full, 'jpeg-bytes');
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(full, at, at);
  return full;
}

const HOUR = 3600 * 1000;

async function main() {
  await test('sweep removes an unreferenced capture older than the TTL', async () => {
    const { root, pending } = volume();
    const prev = process.env.UPLOAD_PATH;
    process.env.UPLOAD_PATH = root;
    try {
      const stale = write(pending, UUID_OLD, 48 * HOUR);
      const svc = build({ referenced: [] });
      const removed = await svc.sweepOrphanPendingOdoPhotos();
      assert.strictEqual(removed, 1, 'one orphan must be reclaimed');
      assert.strictEqual(fs.existsSync(stale), false, 'the stale orphan is gone');
    } finally {
      if (prev === undefined) delete process.env.UPLOAD_PATH;
      else process.env.UPLOAD_PATH = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('a file the database still references is never deleted', async () => {
    const { root, pending } = volume();
    const prev = process.env.UPLOAD_PATH;
    process.env.UPLOAD_PATH = root;
    try {
      const armed = write(pending, UUID_REFERENCED, 48 * HOUR);
      const svc = build({ referenced: [UUID_REFERENCED] });
      const removed = await svc.sweepOrphanPendingOdoPhotos();
      assert.strictEqual(removed, 0);
      assert.strictEqual(fs.existsSync(armed), true, 'an armed capture stays on disk');
    } finally {
      if (prev === undefined) delete process.env.UPLOAD_PATH;
      else process.env.UPLOAD_PATH = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('a fresh capture (inside the TTL) is left alone even without a row', async () => {
    const { root, pending } = volume();
    const prev = process.env.UPLOAD_PATH;
    process.env.UPLOAD_PATH = root;
    try {
      const fresh = write(pending, UUID_FRESH, 10 * 60 * 1000);
      const svc = build({ referenced: [] });
      const removed = await svc.sweepOrphanPendingOdoPhotos();
      assert.strictEqual(removed, 0, 'a capture in flight must not be swept');
      assert.strictEqual(fs.existsSync(fresh), true);
    } finally {
      if (prev === undefined) delete process.env.UPLOAD_PATH;
      else process.env.UPLOAD_PATH = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('only uuid-named images are touched', async () => {
    const { root, pending } = volume();
    const prev = process.env.UPLOAD_PATH;
    process.env.UPLOAD_PATH = root;
    try {
      const foreign = write(pending, NOT_OURS, 48 * HOUR);
      const svc = build({ referenced: [] });
      const removed = await svc.sweepOrphanPendingOdoPhotos();
      assert.strictEqual(removed, 0);
      assert.strictEqual(fs.existsSync(foreign), true, 'a foreign file is not ours to delete');
    } finally {
      if (prev === undefined) delete process.env.UPLOAD_PATH;
      else process.env.UPLOAD_PATH = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('a missing volume and a failing query are both no-ops, not crashes', async () => {
    const prev = process.env.UPLOAD_PATH;
    process.env.UPLOAD_PATH = path.join(os.tmpdir(), 'ams-odo-sweep-absent-dir');
    try {
      assert.strictEqual(await build().sweepOrphanPendingOdoPhotos(), 0, 'missing dir → 0');
      const { root } = volume();
      process.env.UPLOAD_PATH = root;
      write(path.join(root, 'odometer', 'pending'), UUID_OLD, 48 * HOUR);
      assert.strictEqual(await build({ rowsThrows: true }).sweepOrphanPendingOdoPhotos(), 0, 'db error → 0');
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      if (prev === undefined) delete process.env.UPLOAD_PATH;
      else process.env.UPLOAD_PATH = prev;
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
