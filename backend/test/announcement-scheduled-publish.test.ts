/**
 * Scheduled announcements must be DELIVERED, not just flipped to PUBLISHED.
 *
 * The lifecycle cron used to run `updateMany({status:'SCHEDULED'}) →
 * PUBLISHED` and nothing else: no in-app notification, no Telegram card, no ✓
 * Acknowledge button. A scheduled URGENT notice therefore arrived in silence
 * and its acknowledgement stats stayed at 0/0 forever.
 *
 * The Telegram fan-out also capped recipients at `userIds.slice(0, 100)`, so
 * everyone past the 100th audience member never got the card — or the ack
 * button — and the ack percentage was wrong on large audiences.
 *
 * Contract pinned here:
 *   1. the cron path notifies the audience and sends a card to EVERY bound
 *      chat (no 100 cap), then audits with via='schedule';
 *   2. a row already claimed by another tick is skipped (no double delivery);
 *   3. a delivery failure puts the notice back to SCHEDULED so the next tick
 *      retries, instead of leaving it published-but-unannounced;
 *   4. the manual publish path delivers through the same function (via='publish').
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/announcement-scheduled-publish.test.ts
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

const ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  code: 'ANN-202611-0007',
  title: 'Generator test — building A',
  content: '<p>Power will be cut 14:00–15:00.</p>',
  priority: 'URGENT',
  requiresAck: true,
  status: 'SCHEDULED',
  publishAt: new Date('2026-11-10T07:00:00Z'),
};

type Harness = {
  svc: any;
  notified: string[][];
  cards: string[];
  albums: string[];
  audit: any[];
  statusUpdates: any[];
  revertCalls: any[];
};

/**
 * @param opts.audience   user ids in the audience
 * @param opts.bound      how many of them have a telegramChatId
 * @param opts.claimCount what the claim updateMany reports (0 = already claimed)
 * @param opts.notifyThrows simulate the in-app notification write failing
 */
function makeService(opts: {
  audience: string[];
  bound: number;
  claimCount?: number;
  notifyThrows?: boolean;
  due?: { id: string }[];
}): Harness {
  const notified: string[][] = [];
  const cards: string[] = [];
  const albums: string[] = [];
  const audit: any[] = [];
  const statusUpdates: any[] = [];
  const revertCalls: any[] = [];

  const prisma: any = {
    announcement: {
      findMany: async () => (opts.due ?? [{ id: ROW.id }]).map((d) => ({ id: d.id })),
      findUnique: async () => ({ ...ROW }),
      update: async (a: any) => {
        statusUpdates.push(a.data);
        return { ...ROW, ...a.data };
      },
      updateMany: async (a: any) => {
        if (a.data.status === 'PUBLISHED') {
          statusUpdates.push(a.data);
          return { count: opts.claimCount ?? 1 };
        }
        if (a.data.status === 'SCHEDULED') {
          revertCalls.push(a);
          return { count: 1 };
        }
        return { count: 0 }; // expiry sweep
      },
    },
    announcementTarget: { findMany: async () => [{ targetType: 'ALL', targetId: null }] },
    attachment: { findMany: async () => [] },
    user: {
      findMany: async (a: any) => {
        // audienceIds() for ALL — no id filter
        if (!a?.where?.id) return opts.audience.map((id) => ({ id }));
        // Telegram fan-out — only bound chats
        const ids: string[] = a.where.id.in ?? [];
        const boundIds = opts.audience.slice(0, opts.bound);
        return ids.filter((id) => boundIds.includes(id)).map(() => ({ telegramChatId: '4242' }));
      },
    },
  };

  const notifications: any = {
    notifyMany: async (userIds: string[]) => {
      if (opts.notifyThrows) throw new Error('notification insert failed');
      notified.push(userIds);
    },
  };
  const auditSvc: any = { log: async (e: any) => audit.push(e) };
  const telegram: any = {
    sendAnnouncementCard: async (chatId: string) => {
      cards.push(chatId);
    },
    sendPhotoAlbum: async (chatId: string) => {
      albums.push(chatId);
      return [{ message_id: 1 }];
    },
  };

  const svc = new AnnouncementsService(prisma, {} as any, notifications, auditSvc, telegram);
  return { svc, notified, cards, albums, audit, statusUpdates, revertCalls };
}

async function main() {
  console.log('announcement scheduled publish');

  await test('cron delivers to the whole audience, not the first 100', async () => {
    const audience = Array.from({ length: 150 }, (_, i) => `u-${i}`);
    const h = makeService({ audience, bound: 150 });
    await h.svc.lifecycleCron();

    assert.strictEqual(h.notified.length, 1, 'one notification fan-out');
    assert.strictEqual(h.notified[0].length, 150, 'every audience member notified');
    assert.strictEqual(h.cards.length, 150, 'every bound chat got the announcement card');
    assert.strictEqual(h.audit.filter((a) => a.action === 'ANNOUNCEMENT_PUBLISHED').length, 1);
    assert.strictEqual(h.audit.find((a) => a.action === 'ANNOUNCEMENT_PUBLISHED').newValue.via, 'schedule');
    assert.strictEqual(
      h.audit.find((a) => a.action === 'ANNOUNCEMENT_PHOTOS_TELEGRAM').newValue.recipients,
      150,
      'fan-out audit reports the real recipient count',
    );
  });

  await test('unbound users are skipped without reducing the others', async () => {
    const audience = Array.from({ length: 60 }, (_, i) => `u-${i}`);
    const h = makeService({ audience, bound: 40 });
    await h.svc.lifecycleCron();
    assert.strictEqual(h.cards.length, 40, 'only chats that exist get a card');
    assert.strictEqual(h.notified[0].length, 60, 'in-app notification still reaches everyone');
  });

  await test('an already-claimed row is not delivered twice', async () => {
    const h = makeService({ audience: ['u-1'], bound: 1, claimCount: 0 });
    await h.svc.lifecycleCron();
    assert.strictEqual(h.notified.length, 0, 'nothing sent when the claim loses the race');
    assert.strictEqual(h.cards.length, 0);
  });

  await test('a failed delivery returns the notice to SCHEDULED for a retry', async () => {
    const h = makeService({ audience: ['u-1'], bound: 1, notifyThrows: true });
    await h.svc.lifecycleCron();
    assert.strictEqual(h.revertCalls.length, 1, 'status reverted');
    assert.strictEqual(h.revertCalls[0].data.status, 'SCHEDULED');
    assert.strictEqual(h.cards.length, 0, 'no half-delivered Telegram cards on a failed run');
  });

  await test('manual publish uses the same delivery path', async () => {
    const h = makeService({ audience: ['u-1', 'u-2'], bound: 2 });
    await h.svc.publish(ROW.id, { userId: 'admin-1', username: 'sysadmin' });
    assert.strictEqual(h.notified[0].length, 2);
    assert.strictEqual(h.cards.length, 2);
    const entry = h.audit.find((a) => a.action === 'ANNOUNCEMENT_PUBLISHED');
    assert.strictEqual(entry.newValue.via, 'publish');
    assert.strictEqual(entry.username, 'sysadmin');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
