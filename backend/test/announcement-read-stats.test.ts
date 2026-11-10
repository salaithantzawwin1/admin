/**
 * The numbers an admin chases (plan §9.4 F2/F3 / P7).
 *
 * F2 puts "Acked 31/128" on the admin list; F3 lists the people behind it. Both
 * read the same two facts — who is in the audience, and who has a read/ack row —
 * so this pins them once:
 *   1. `listAll()` adds `ackCount` from one grouped query (only real acks count);
 *   2. `readStats().people` covers the WHOLE audience, including people who never
 *      opened the notice (they are the ones worth chasing);
 *   3. it is sorted not-acked first, then department, then name;
 *   4. `departments`/`readRows` and the totals keep their old meaning.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/announcement-read-stats.test.ts
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

const ANN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const USERS = [
  { id: 'u-1', fullName: 'Aung Aung', username: 'aung', employee: { department: { id: 'd-1', name: 'Administration' } } },
  { id: 'u-2', fullName: 'Zaw Zaw', username: 'zaw', employee: { department: { id: 'd-2', name: 'IT' } } },
  { id: 'u-3', fullName: 'Su Su', username: 'su', employee: { department: { id: 'd-1', name: 'Administration' } } },
  { id: 'u-4', fullName: 'Mya Mya', username: 'mya', employee: null },
];

// u-1 read + acked, u-2 read only, u-3 and u-4 never opened it
const READS = [
  { announcementId: ANN, userId: 'u-1', readAt: new Date('2026-11-10T02:00:00Z'), ackAt: new Date('2026-11-10T02:05:00Z') },
  { announcementId: ANN, userId: 'u-2', readAt: new Date('2026-11-10T03:00:00Z'), ackAt: null },
];

function makeService(opts: { audience?: string[]; requiresAck?: boolean } = {}) {
  const prisma: any = {
    announcement: {
      findUnique: async () => ({ id: ANN, code: 'ANN-1', title: 'Power cut', requiresAck: opts.requiresAck ?? true }),
      findMany: async () => [
        {
          id: ANN,
          code: 'ANN-1',
          title: 'Power cut',
          status: 'PUBLISHED',
          requiresAck: opts.requiresAck ?? true,
          pinnedAt: null,
          createdAt: new Date('2026-11-10T01:00:00Z'),
          targets: [{ targetType: 'ALL', targetId: null, targetLabel: 'Everyone' }],
          createdBy: { fullName: 'Admin' },
          _count: { reads: 2 },
        },
      ],
    },
    announcementRead: {
      findMany: async () => READS,
      groupBy: async () => [{ announcementId: ANN, _count: { _all: 1 } }],
    },
    user: { findMany: async (a: any) => USERS.filter((u) => a.where.id.in.includes(u.id)) },
    $queryRaw: async () => [],
  };
  const svc: any = new AnnouncementsService(prisma, {} as any, {} as any, {} as any, {} as any);
  svc.audienceIds = async () => opts.audience ?? ['u-1', 'u-2', 'u-3', 'u-4'];
  return svc;
}

async function main() {
  console.log('announcement read stats');

  await test('listAll() carries ackCount for the card (F2)', async () => {
    const rows = await makeService().listAll();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ackCount, 1, 'only an explicit ack counts');
    assert.strictEqual(rows[0].audienceCount, 4);
    assert.strictEqual(rows[0]._count.reads, 2);
  });

  await test('a notice with no ack-requiring reads shows 0, not undefined', async () => {
    const svc: any = makeService();
    svc.prisma.announcementRead.groupBy = async () => [];
    const rows = await svc.listAll();
    assert.strictEqual(rows[0].ackCount, 0);
  });

  await test('readStats(): people covers the whole audience, not just the readers', async () => {
    const out = await makeService().readStats(ANN);
    assert.strictEqual(out.people.length, 4);
    const mya = out.people.find((p: any) => p.userId === 'u-4');
    assert.deepStrictEqual(
      { name: mya.name, department: mya.department, readAt: mya.readAt, ackAt: mya.ackAt },
      { name: 'Mya Mya', department: null, readAt: null, ackAt: null },
      'someone who never opened it still appears, with no timestamps',
    );
  });

  await test('readStats(): not-acked first, then department, then name', async () => {
    const out = await makeService().readStats(ANN);
    assert.deepStrictEqual(out.people.map((p: any) => p.userId), ['u-3', 'u-2', 'u-4', 'u-1']);
    // unacked first by department (Admin u-3, IT u-2), then no-department u-4,
    // and the one who already acked (u-1) last — whoever owes an ack is on top.
  });

  await test('readStats(): totals and per-department figures are unchanged', async () => {
    const out = await makeService().readStats(ANN);
    assert.deepStrictEqual(
      { target: out.target, read: out.read, unread: out.unread, acked: out.acked, requiresAck: out.requiresAck },
      { target: 4, read: 2, unread: 2, acked: 1, requiresAck: true },
    );
    const admin = out.departments.find((d: any) => d.name === 'Administration');
    assert.deepStrictEqual({ target: admin.target, read: admin.read, acked: admin.acked }, { target: 2, read: 1, acked: 1 });
    assert.deepStrictEqual(out.readRows, [
      { userId: 'u-1', readAt: READS[0].readAt, ackAt: READS[0].ackAt },
      { userId: 'u-2', readAt: READS[1].readAt, ackAt: null },
    ]);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
