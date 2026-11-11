/**
 * The subscriber's announcement list order (plan §9.4 F8 / P9).
 *
 * A newer normal notice used to bury an older Urgent one that still needed an
 * acknowledgement, and a pin group could be split by the same problem. The rule
 * pinned here:
 *   1. pinned notices first (newest pin first), then unpinned;
 *   2. inside a group: needs ack → unread → already read;
 *   3. newest first inside each rank;
 *   4. `pinnedAt` travels with the row so the UI keeps its pin groups.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/announcement-list-order.test.ts
 */
const assert = require('assert');
const { AnnouncementsService } = require('../src/announcements/announcements.service');

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

/** One visible announcement row, as listMine() reads it from Prisma. */
function row(over: {
  code: string;
  publishAt: string;
  pinnedAt?: Date | null;
  requiresAck?: boolean;
  read?: boolean;
  acked?: boolean;
}) {
  return {
    id: `id-${over.code}`,
    code: over.code,
    title: `Title ${over.code}`,
    content: '<p>body</p>',
    category: 'GENERAL',
    priority: 'NORMAL',
    status: 'PUBLISHED',
    publishAt: new Date(over.publishAt),
    startAt: null,
    endAt: null,
    requiresAck: over.requiresAck ?? false,
    pinnedAt: over.pinnedAt ?? null,
    createdBy: { fullName: 'Admin' },
    targets: [{ targetType: 'ALL', targetId: null }],
    reads: over.read
      ? [{ readAt: new Date(over.publishAt), ackAt: over.acked ? new Date(over.publishAt) : null }]
      : [],
    attachments: [],
  };
}

function makeService(rows: any[]) {
  const prisma: any = {
    userRole: { findMany: async () => [{ role: { name: 'EMPLOYEE' } }] },
    employee: { findFirst: async () => ({ departmentId: null, branchId: null }) },
    announcement: { findMany: async () => rows },
  };
  return new AnnouncementsService(prisma, {} as any, {} as any, {} as any, {} as any);
}

const ACTOR = { userId: 'u-1', username: 'reader' };

const ROWS = [
  // newest first, exactly how the DB hands them over
  row({ code: 'READ-NEW', publishAt: '2026-11-10T09:00:00Z', read: true }),
  row({ code: 'URGENT-OLD', publishAt: '2026-11-08T09:00:00Z', requiresAck: true }),
  row({ code: 'UNREAD-NEW', publishAt: '2026-11-10T10:00:00Z' }),
  row({ code: 'ACKED', publishAt: '2026-11-09T09:00:00Z', requiresAck: true, read: true, acked: true }),
  row({ code: 'PINNED', publishAt: '2026-11-01T09:00:00Z', pinnedAt: new Date('2026-11-10T11:00:00Z'), read: true }),
];

async function main() {
  console.log('announcement list order (F8)');

  await test('an unacked notice sorts above newer read and unread notices', async () => {
    const list = await makeService(ROWS).listMine(ACTOR);
    const codes = list.map((a: any) => a.code);
    assert.deepStrictEqual(codes, ['PINNED', 'URGENT-OLD', 'UNREAD-NEW', 'READ-NEW', 'ACKED'],
      `unexpected order: ${codes.join(' > ')}`);
  });

  await test('pinned notices stay on top, newest pin first', async () => {
    const rows = [
      row({ code: 'A', publishAt: '2026-11-10T10:00:00Z' }),
      row({ code: 'PIN-OLD', publishAt: '2026-11-10T09:00:00Z', pinnedAt: new Date('2026-11-09T08:00:00Z') }),
      row({ code: 'PIN-NEW', publishAt: '2026-11-01T09:00:00Z', pinnedAt: new Date('2026-11-10T08:00:00Z') }),
    ];
    const codes = (await makeService(rows).listMine(ACTOR)).map((a: any) => a.code);
    assert.deepStrictEqual(codes, ['PIN-NEW', 'PIN-OLD', 'A']);
  });

  await test('an acked notice is not re-sorted as "needs ack"', async () => {
    const rows = [
      row({ code: 'DONE', publishAt: '2026-11-10T10:00:00Z', requiresAck: true, read: true, acked: true }),
      row({ code: 'PLAIN', publishAt: '2026-11-10T11:00:00Z', read: true }),
      row({ code: 'WAITING', publishAt: '2026-11-01T09:00:00Z', requiresAck: true }),
    ];
    const codes = (await makeService(rows).listMine(ACTOR)).map((a: any) => a.code);
    assert.deepStrictEqual(codes, ['WAITING', 'PLAIN', 'DONE']);
  });

  await test('pinnedAt travels with the row so the UI keeps its pin groups', async () => {
    const list = await makeService(ROWS).listMine(ACTOR);
    const pinned = list.find((a: any) => a.code === 'PINNED');
    assert.ok(pinned.pinnedAt instanceof Date, 'pinnedAt is returned');
    assert.strictEqual(list.find((a: any) => a.code === 'READ-NEW').pinnedAt, null);
  });

  await test('newest first inside the same rank', async () => {
    const rows = [
      row({ code: 'R-OLD', publishAt: '2026-11-01T09:00:00Z', read: true }),
      row({ code: 'R-NEW', publishAt: '2026-11-10T09:00:00Z', read: true }),
    ];
    const codes = (await makeService(rows).listMine(ACTOR)).map((a: any) => a.code);
    assert.deepStrictEqual(codes, ['R-NEW', 'R-OLD']);
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
