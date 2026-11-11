/**
 * The escalation half of the announcements plan (P9): what happens *after* a
 * notice is published and some people still owe an acknowledgement.
 *
 *   1. F5 — raising the priority of a live notice re-sends the ack prompt, but
 *      only to people who have not acked (and without the photo album);
 *   2. F7 — a daily cron sends one digest per notice per person per day to the
 *      creator + `announcements.manage` holders, and skips notices that are
 *      young or fully acked;
 *   3. F9 — the publish path no longer asks NotificationsService to mirror to
 *      Telegram, because the card is the Telegram message;
 *   4. retention — the inbox purge deletes rows past the window, and can be
 *      switched off.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/announcement-escalation.test.ts
 */
const assert = require('assert');
const { AnnouncementsService } = require('../src/announcements/announcements.service');
const { MessagesService } = require('../src/messages/messages.service');

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
const CREATOR = 'u-creator';
const MANAGER = 'u-manager';

const row = (over: Record<string, unknown> = {}) => ({
  id: ANN,
  code: 'ANN-202611-0007',
  title: 'Water tank cleaning',
  content: '<p>Tankers on site from 08:00.</p>',
  status: 'PUBLISHED',
  priority: 'URGENT',
  requiresAck: true,
  publishAt: new Date('2026-11-09T01:00:00Z'),
  endAt: null,
  createdById: CREATOR,
  targets: [],
  ...over,
});

/**
 * Fake prisma/router. `acked` decides who has ackAt set; `bound` is who is
 * reachable on Telegram; managers/list queries are told apart by their `where`.
 */
function makeService(opts: {
  acked?: string[];
  bound?: string[];
  audience?: string[];
  managers?: string[];
  attachmentCount?: number;
  notifyImpl?: (p: any) => Promise<any>;
} = {}) {
  const calls: any = { notifyMany: [], notify: [], audit: [], cards: [], albums: [], mirrors: [] };
  const acked = opts.acked ?? [];
  const bound = opts.bound ?? [];
  const audience = opts.audience ?? ['u-1', 'u-2', 'u-3'];

  const prisma: any = {
    announcement: {
      findUnique: async () => row(),
      findMany: async () => [row()],
      // Prisma ignores `undefined` fields and returns the merged row — mimic that,
      // otherwise a partial update would blank every field it did not mention
      update: async ({ data }: any) =>
        row(Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))),
      updateMany: async () => ({ count: 0 }),
    },
    announcementRead: {
      findMany: async () => acked.map((userId) => ({ announcementId: ANN, userId, ackAt: new Date() })),
    },
    attachment: {
      findMany: async () => Array.from({ length: opts.attachmentCount ?? 1 }, (_, i) => ({ storedName: `p${i}.jpg` })),
    },
    announcementChatSend: { createMany: async () => ({ count: 0 }) },
    $queryRaw: async () => [],
    user: {
      findMany: async (a: any) => {
        if (a.where.userRoles) return (opts.managers ?? [MANAGER]).map((id) => ({ id }));
        if (a.where.telegramChatId) {
          const ids: string[] = a.where.id?.in ?? [];
          return bound.filter((id) => ids.includes(id)).map((id) => ({ id, telegramChatId: `chat-${id}` }));
        }
        const ids: string[] = a.where.id?.in ?? [];
        return ids.map((id) => ({ id, fullName: `Name ${id}` }));
      },
    },
  };

  const notifications = {
    notifyMany: async (userIds: string[], data: any) => {
      calls.notifyMany.push({ userIds, data });
    },
    notify: async (p: any) => {
      calls.notify.push(p);
      if (opts.notifyImpl) return opts.notifyImpl(p);
      return { id: 'n-1' };
    },
  };
  const audit = { log: async (e: any) => calls.audit.push(e) };
  const telegram = {
    sendPhotoAlbum: async (_chat: string, _files: string[], _caption: string) => {
      calls.albums.push(_chat);
      return [{ message_id: 10 }];
    },
    sendAnnouncementCard: async (_chat: string, a: any) => {
      calls.cards.push({ chat: _chat, priority: a.priority, requiresAck: a.requiresAck });
      return { message_id: 11 };
    },
    mirrorToUser: async (userId: string) => {
      calls.mirrors.push(userId);
    },
  };

  const svc: any = new AnnouncementsService(prisma, {} as any, notifications, audit, telegram);
  svc.audienceIds = async () => audience;
  return { svc, calls };
}

async function main() {
  console.log('announcement escalation (F5 / F7 / F9 / retention)');

  // ---------- F5 ----------

  await test('F5: raising NORMAL → URGENT re-notifies only the un-acked audience', async () => {
    const { svc, calls } = makeService({ acked: ['u-1'], bound: ['u-1', 'u-2', 'u-3'] });
    svc.prisma.announcement.findUnique = async () => row({ priority: 'NORMAL', requiresAck: false });
    await svc.update(ANN, { priority: 'URGENT' }, { userId: 'admin', username: 'admin' });

    assert.strictEqual(calls.notifyMany.length, 1, 'one re-notify batch');
    const [{ userIds, data }] = calls.notifyMany;
    assert.deepStrictEqual(userIds, ['u-2', 'u-3'], 'u-1 already acked');
    assert.ok(/Priority raised to URGENT/.test(data.title), data.title);
    assert.strictEqual(data.skipTelegram, true, 'the card is the Telegram message');
    assert.strictEqual(data.link, '/announcements');

    // the prompt goes to people who can act on it: bound, un-acked only
    assert.deepStrictEqual(calls.cards.map((c: any) => c.chat), ['chat-u-2', 'chat-u-3']);
    assert.strictEqual(calls.cards[0].requiresAck, true, 'card carries the ack button');
    assert.strictEqual(calls.albums.length, 0, 'no second copy of the photos');
  });

  await test('F5: the re-notify is audited with who was chased', async () => {
    const { svc, calls } = makeService({ acked: ['u-1'] });
    svc.prisma.announcement.findUnique = async () => row({ priority: 'IMPORTANT' });
    await svc.update(ANN, { priority: 'EMERGENCY' }, { userId: 'admin', username: 'admin' });

    const entry = calls.audit.find((e: any) => e.action === 'ANNOUNCEMENT_RENOTIFIED');
    assert.ok(entry, 'audit row written');
    assert.strictEqual(entry.oldValue.priority, 'IMPORTANT');
    assert.strictEqual(entry.newValue.priority, 'EMERGENCY');
    assert.strictEqual(entry.newValue.renotified, 2);
    assert.strictEqual(entry.newValue.alreadyAcked, 1);
  });

  await test('F5: lowering the priority re-notifies nobody', async () => {
    const { svc, calls } = makeService();
    svc.prisma.announcement.findUnique = async () => row({ priority: 'URGENT' });
    await svc.update(ANN, { priority: 'NORMAL' }, { userId: 'admin', username: 'admin' });
    assert.strictEqual(calls.notifyMany.length, 0);
    assert.strictEqual(calls.cards.length, 0);
  });

  await test('F5: editing a DRAFT never sends anything, even if the priority jumps', async () => {
    const { svc, calls } = makeService();
    svc.prisma.announcement.findUnique = async () => row({ status: 'DRAFT', priority: 'NORMAL' });
    await svc.update(ANN, { priority: 'EMERGENCY' }, { userId: 'admin', username: 'admin' });
    assert.strictEqual(calls.notifyMany.length, 0);
  });

  await test('F5: a title edit with the same priority does not re-notify', async () => {
    const { svc, calls } = makeService();
    await svc.update(ANN, { title: 'Water tank cleaning (moved)' }, { userId: 'admin', username: 'admin' });
    assert.strictEqual(calls.notifyMany.length, 0, 'no priority change → no noise');
  });

  await test('F5: everyone already acked → no re-notify at all', async () => {
    const { svc, calls } = makeService({ acked: ['u-1', 'u-2', 'u-3'] });
    svc.prisma.announcement.findUnique = async () => row({ priority: 'NORMAL' });
    await svc.update(ANN, { priority: 'URGENT' }, { userId: 'admin', username: 'admin' });
    assert.strictEqual(calls.notifyMany.length, 0);
    assert.strictEqual(calls.audit.filter((e: any) => e.action === 'ANNOUNCEMENT_RENOTIFIED').length, 0);
  });

  await test('F5: a re-notify failure never fails the edit itself', async () => {
    const { svc } = makeService();
    svc.prisma.announcement.findUnique = async () => row({ priority: 'NORMAL' });
    svc.notifications.notifyMany = async () => {
      throw new Error('notifications down');
    };
    const updated = await svc.update(ANN, { priority: 'URGENT' }, { userId: 'admin', username: 'admin' });
    assert.strictEqual(updated.priority, 'URGENT', 'the edit is already saved');
  });

  // ---------- F9 ----------

  await test('F9: publish skips the Telegram mirror (the card replaces it)', async () => {
    const { svc, calls } = makeService({ bound: ['u-1'] });
    svc.prisma.announcement.findUnique = async () => row({ status: 'DRAFT' });
    await svc.publish(ANN, { userId: 'admin', username: 'admin' });
    assert.strictEqual(calls.notifyMany.length, 1);
    assert.strictEqual(calls.notifyMany[0].data.skipTelegram, true, 'no duplicate DM');
    assert.strictEqual(calls.cards.length, 1, 'the card still goes out');
  });

  await test('F9: a failed card falls back to plain text so the chat is not left silent', async () => {
    const { svc, calls } = makeService({ bound: ['u-1'] });
    svc.prisma.announcement.findUnique = async () => row({ status: 'DRAFT' });
    svc.telegram.sendAnnouncementCard = async () => {
      throw new Error('telegram 400');
    };
    await svc.publish(ANN, { userId: 'admin', username: 'admin' });
    assert.deepStrictEqual(calls.mirrors, ['u-1'], 'fallback mirror used only on failure');
  });

  // ---------- F7 ----------

  await test('F7: digest goes to creator + announcements.manage, one per notice per day', async () => {
    const { svc, calls } = makeService({ acked: ['u-1'], audience: ['u-1', 'u-2', 'u-3'], managers: [MANAGER] });
    const sent = await svc.unackedDigestCron();

    assert.strictEqual(sent, 2, 'creator + manager');
    assert.deepStrictEqual(calls.notify.map((n: any) => n.userId).sort(), [CREATOR, MANAGER].sort());
    const first = calls.notify[0];
    assert.ok(/2 still unacked/.test(first.title), first.title);
    assert.strictEqual(first.type, 'ANNOUNCEMENT');
    assert.ok(/ANN-202611-0007/.test(first.body), first.body);
    assert.ok(/2 of 3 have not acknowledged/.test(first.body), first.body);
    assert.strictEqual(first.link, `/announcements?ann=${ANN}`);
    assert.ok(/^ann:.+:digest:\d{4}-\d{2}-\d{2}:/.test(first.dedupeKey), first.dedupeKey);
  });

  await test('F7: the query only picks live IMPORTANT+ notices that are over 24 h old', async () => {
    const { svc } = makeService();
    let where: any = null;
    svc.prisma.announcement.findMany = async (a: any) => {
      where = a.where;
      return [];
    };
    await svc.unackedDigestCron();
    assert.strictEqual(where.status, 'PUBLISHED');
    assert.strictEqual(where.requiresAck, true);
    assert.deepStrictEqual(where.priority.in, ['IMPORTANT', 'URGENT', 'EMERGENCY']);
    const age = Date.now() - where.publishAt.lte.getTime();
    assert.ok(age >= 24 * 60 * 60 * 1000 - 5000 && age <= 24 * 60 * 60 * 1000 + 5000, `cutoff ${age} ms`);
  });

  await test('F7: nothing is sent once everyone has acked', async () => {
    const { svc, calls } = makeService({ acked: ['u-1', 'u-2', 'u-3'] });
    const sent = await svc.unackedDigestCron();
    assert.strictEqual(sent, 0);
    assert.strictEqual(calls.notify.length, 0);
  });

  await test('F7: a second run the same day is throttled by dedupeKey (P2002), not duplicated', async () => {
    const seen = new Set<string>();
    const { svc, calls } = makeService({
      acked: [],
      notifyImpl: async (p: any) => {
        if (seen.has(p.dedupeKey)) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        seen.add(p.dedupeKey);
        return { id: 'n' };
      },
    });
    const first = await svc.unackedDigestCron();
    const second = await svc.unackedDigestCron();
    assert.strictEqual(first, 2);
    assert.strictEqual(second, 0, 'same day → no second digest');
    assert.strictEqual(calls.notify.length, 4, 'both runs attempted, only two landed');
  });

  await test('F7: one announcement failing does not stop the others', async () => {
    const { svc, calls } = makeService({
      notifyImpl: async (p: any) => {
        if (p.userId === CREATOR) throw new Error('boom');
        return { id: 'n' };
      },
    });
    const sent = await svc.unackedDigestCron();
    assert.strictEqual(sent, 1, 'the manager still got it');
    assert.strictEqual(calls.notify.length, 2);
  });

  // ---------- retention ----------

  await test('retention: purges only rows past the window', async () => {
    const prisma: any = { telegramInboundMessage: { deleteMany: async (a: any) => ({ count: 7, where: a.where }) } };
    const svc: any = new MessagesService(prisma);
    const old = process.env.TELEGRAM_INBOUND_RETENTION_DAYS;
    delete process.env.TELEGRAM_INBOUND_RETENTION_DAYS;
    let where: any = null;
    prisma.telegramInboundMessage.deleteMany = async (a: any) => {
      where = a.where;
      return { count: 7 };
    };
    const count = await svc.retentionCron();
    assert.strictEqual(count, 7);
    const ageDays = (Date.now() - where.receivedAt.lt.getTime()) / 86_400_000;
    assert.ok(Math.abs(ageDays - 180) < 0.01, `cutoff ${ageDays} days`);
    if (old === undefined) delete process.env.TELEGRAM_INBOUND_RETENTION_DAYS;
    else process.env.TELEGRAM_INBOUND_RETENTION_DAYS = old;
  });

  await test('retention: TELEGRAM_INBOUND_RETENTION_DAYS is honoured, 0 disables the purge', async () => {
    let calls = 0;
    const svc: any = new MessagesService({ telegramInboundMessage: { deleteMany: async () => { calls++; return { count: 0 }; } } });
    process.env.TELEGRAM_INBOUND_RETENTION_DAYS = '30';
    let where: any = null;
    svc.prisma.telegramInboundMessage.deleteMany = async (a: any) => {
      where = a.where;
      calls++;
      return { count: 0 };
    };
    await svc.retentionCron();
    const age = (Date.now() - where.receivedAt.lt.getTime()) / 86_400_000;
    assert.ok(Math.abs(age - 30) < 0.01, `cutoff ${age} days`);

    process.env.TELEGRAM_INBOUND_RETENTION_DAYS = '0';
    await svc.retentionCron();
    assert.strictEqual(calls, 1, 'disabled → no delete issued');
    delete process.env.TELEGRAM_INBOUND_RETENTION_DAYS;
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`FAILED (${failures.length}): ${failures.join(' | ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
