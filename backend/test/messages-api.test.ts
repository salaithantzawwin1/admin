/**
 * The Messages tab reads one inbox and nothing else (plan §7–§8 / P5).
 *
 * These tests pin the parts the UI depends on and that are easy to break:
 *   1. `threads()` puts every message in exactly one thread — its announcement,
 *      or General — with total/unread/lastAt, and deleted announcements survive;
 *   2. `list()` filters by announcement/handledBy/kind/state, clamps paging,
 *      rejects an unknown enum value with 400, and never returns a raw BigInt;
 *   3. the sender join fills the department name, and `ackAt` comes from the same
 *      sender's announcement read record (null when they never acknowledged);
 *   4. `markRead` writes state/readAt/readById and 404s on an unknown id;
 *   5. `readAll` only touches NEW rows and honours General (`announcementId=none`);
 *   6. every route carries `messages.read` — an announcements-only caller is
 *      refused by the same guard the rest of the app uses.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/messages-api.test.ts
 */
const assert = require('assert');
const { MessagesService } = require('../src/messages/messages.service');
const { MessagesController } = require('../src/messages/messages.controller');
const { PermissionsGuard, PERMISSIONS_KEY } = require('../src/auth/permissions.guard');
const { PERMISSIONS } = require('../src/auth/permissions');
const { ForbiddenException, BadRequestException, NotFoundException } = require('@nestjs/common');

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

const ANN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A tiny in-memory prisma covering only what MessagesService reads. */
function makePrisma(opts: {
  rows: any[];
  users?: any[];
  announcements?: any[];
  reads?: any[];
}) {
  const calls: { listWhere?: any; listSkip?: any; listTake?: any; updateMany?: any; update?: any; readWhere?: any } = {};
  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    if ('announcementId' in where) {
      if (where.announcementId === null ? row.announcementId !== null : row.announcementId !== where.announcementId) {
        return false;
      }
    }
    for (const key of ['handledBy', 'kind', 'state']) {
      if (where[key] !== undefined && row[key] !== where[key]) return false;
    }
    return true;
  };
  const prisma: any = {
    telegramInboundMessage: {
      groupBy: async () => {
        const groups = new Map<string, { announcementId: string | null; state: string; _count: { _all: number }; _max: { receivedAt: Date } }>();
        for (const r of opts.rows) {
          const k = `${r.announcementId ?? 'none'}:${r.state}`;
          const g = groups.get(k) ?? {
            announcementId: r.announcementId,
            state: r.state,
            _count: { _all: 0 },
            _max: { receivedAt: r.receivedAt },
          };
          g._count._all += 1;
          if (r.receivedAt > g._max.receivedAt) g._max.receivedAt = r.receivedAt;
          groups.set(k, g);
        }
        return [...groups.values()];
      },
      count: async (a: any) => opts.rows.filter((r) => matches(r, a?.where)).length,
      findMany: async (a: any) => {
        calls.listWhere = a.where;
        calls.listSkip = a.skip;
        calls.listTake = a.take;
        return opts.rows
          .filter((r) => matches(r, a.where))
          .sort((x, y) => y.receivedAt.getTime() - x.receivedAt.getTime())
          .slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? 50));
      },
      findUnique: async (a: any) => opts.rows.find((r) => r.id === a.where.id) ?? null,
      update: async (a: any) => {
        calls.update = a;
        return { ...a.where, ...a.data };
      },
      updateMany: async (a: any) => {
        calls.updateMany = a;
        return { count: opts.rows.filter((r) => matches(r, a.where) && r.state === 'NEW').length };
      },
    },
    announcement: {
      findMany: async (a: any) =>
        (opts.announcements ?? []).filter((x) => a.where.id.in.includes(x.id)),
    },
    user: {
      findMany: async (a: any) =>
        (opts.users ?? []).filter((u) => a.where.id.in.includes(u.id)),
    },
    announcementRead: {
      findMany: async (a: any) => {
        calls.readWhere = a.where;
        return (opts.reads ?? []).filter((r: any) =>
          a.where.OR.some((p: any) => p.announcementId === r.announcementId && p.userId === r.userId),
        );
      },
    },
  };
  return { prisma, calls };
}

const row = (over: any) => ({
  id: over.id ?? 'row-1',
  chatId: '4242',
  telegramMessageId: 10n,
  replyToMessageId: null,
  mediaGroupId: null,
  userId: null,
  driverId: null,
  senderName: null,
  kind: 'TEXT',
  text: 'hi',
  photoFileId: null,
  photoWidth: null,
  photoHeight: null,
  documentName: null,
  announcementId: null,
  handledBy: 'GENERAL',
  state: 'NEW',
  readAt: null,
  receivedAt: new Date('2026-11-10T01:00:00Z'),
  ...over,
});

const baseRows = [
  row({ id: 'g1', receivedAt: new Date('2026-11-10T01:00:00Z') }),
  row({ id: 'g2', receivedAt: new Date('2026-11-10T03:00:00Z'), state: 'READ' }),
  row({ id: 'a1', announcementId: ANN_A, userId: 'u-1', handledBy: 'ANNOUNCEMENT_REPLY', receivedAt: new Date('2026-11-10T02:00:00Z') }),
  row({ id: 'a2', announcementId: ANN_A, userId: 'u-1', kind: 'PHOTO', photoFileId: 'F1', photoWidth: 800, photoHeight: 600, receivedAt: new Date('2026-11-10T04:00:00Z') }),
  row({ id: 'b1', announcementId: ANN_B, userId: 'u-2', receivedAt: new Date('2026-11-10T05:00:00Z') }),
];

async function main() {
  console.log('messages api');

  await test('threads(): one row per announcement + General, newest reply first', async () => {
    const { prisma } = makePrisma({
      rows: baseRows,
      announcements: [
        { id: ANN_A, code: 'ANN-A', title: 'Power cut', status: 'PUBLISHED', publishAt: new Date('2026-11-09T00:00:00Z'), requiresAck: true },
        { id: ANN_B, code: 'ANN-B', title: 'Water cut', status: 'PUBLISHED', publishAt: null, requiresAck: false },
      ],
    });
    const out = await new MessagesService(prisma).threads();

    assert.deepStrictEqual(
      { total: out.general.total, unread: out.general.unread },
      { total: 2, unread: 1 },
      'General counts everything that is not linked',
    );
    assert.deepStrictEqual(out.threads.map((t: any) => t.code), ['ANN-B', 'ANN-A'], 'B has the newest reply');
    const a = out.threads.find((t: any) => t.code === 'ANN-A');
    assert.deepStrictEqual({ total: a.total, unread: a.unread, requiresAck: a.requiresAck }, { total: 2, unread: 2, requiresAck: true });
  });

  await test('threads(): an announcement deleted under its replies still lists (SetNull keeps rows)', async () => {
    const { prisma } = makePrisma({
      rows: [row({ id: 'x', announcementId: ANN_A, userId: null })],
      announcements: [],
    });
    const out = await new MessagesService(prisma).threads();
    assert.strictEqual(out.threads.length, 1);
    assert.strictEqual(out.threads[0].title, 'Deleted announcement');
    assert.strictEqual(out.threads[0].code, null);
  });

  await test('list(): General, an announcement, or everything', async () => {
    const svc = new MessagesService(makePrisma({ rows: baseRows }).prisma);
    assert.deepStrictEqual((await svc.list({ announcementId: 'none' })).items.map((i: any) => i.id), ['g2', 'g1']);
    assert.deepStrictEqual((await svc.list({ announcementId: ANN_A })).items.map((i: any) => i.id), ['a2', 'a1']);
    assert.strictEqual((await svc.list({})).total, 5, 'no filter = the whole inbox');
  });

  await test('list(): kind / state / handledBy filters narrow the same way', async () => {
    const svc = new MessagesService(makePrisma({ rows: baseRows }).prisma);
    assert.deepStrictEqual((await svc.list({ kind: 'PHOTO' })).items.map((i: any) => i.id), ['a2']);
    assert.deepStrictEqual((await svc.list({ state: 'READ' })).items.map((i: any) => i.id), ['g2']);
    const reply = await svc.list({ handledBy: 'ANNOUNCEMENT_REPLY' });
    assert.deepStrictEqual(reply.items.map((i: any) => i.id), ['a1']);
    assert.strictEqual(reply.unread, 1, 'unread is reported for the filtered set');
  });

  await test('list(): paging is clamped and never asks for a negative page', async () => {
    const h = makePrisma({ rows: baseRows });
    const svc = new MessagesService(h.prisma);
    const page1 = await svc.list({ page: '1', pageSize: '2' });
    assert.deepStrictEqual({ page: page1.page, pageSize: page1.pageSize, n: page1.items.length }, { page: 1, pageSize: 2, n: 2 });
    assert.strictEqual(h.calls.listSkip, 0);
    assert.strictEqual(h.calls.listTake, 2);
    const clamped = await svc.list({ page: '-3', pageSize: '9999' });
    assert.deepStrictEqual({ page: clamped.page, pageSize: clamped.pageSize }, { page: 1, pageSize: 100 });
  });

  await test('list(): an unknown enum value is a 400, not an empty page', async () => {
    const svc = new MessagesService(makePrisma({ rows: baseRows }).prisma);
    for (const q of [{ kind: 'VIDEO' }, { state: 'DONE' }, { handledBy: 'MAYBE' }]) {
      await assert.rejects(() => svc.list(q), (e: any) => e instanceof BadRequestException && /must be one of/.test(e.message));
    }
  });

  await test('list(): sender gets their department and ackAt from their own read record', async () => {
    const acked = new Date('2026-11-10T04:30:00Z');
    const { prisma, calls } = makePrisma({
      rows: baseRows,
      users: [
        { id: 'u-1', fullName: 'Aung Aung', employee: { department: { name: 'Administration' } } },
        { id: 'u-2', fullName: 'Su Su', employee: null },
      ],
      reads: [{ announcementId: ANN_A, userId: 'u-1', ackAt: acked }],
    });
    const out = await new MessagesService(prisma).list({ announcementId: ANN_A });
    const photo = out.items.find((i: any) => i.id === 'a2');
    assert.deepStrictEqual(photo.sender, {
      userId: 'u-1',
      driverId: null,
      name: 'Aung Aung',
      department: 'Administration',
      linked: true,
    });
    assert.strictEqual(photo.ackAt, acked, 'IMPORTANT+ card was acknowledged by this sender');
    assert.deepStrictEqual(photo.photo, { fileId: 'F1', width: 800, height: 600 });
    assert.strictEqual(calls.readWhere.OR.length, 2, 'one ack lookup for the page, not one per row');
  });

  await test('list(): a General message has no ack and BigInt ids come back as strings', async () => {
    const out = await new MessagesService(makePrisma({ rows: baseRows }).prisma).list({ announcementId: 'none' });
    const g = out.items[0];
    assert.strictEqual(g.ackAt, null);
    assert.strictEqual(g.messageId, '10', 'JSON-safe, not a BigInt');
    assert.strictEqual(g.sender.linked, false, 'an unbound chat shows as Not linked');
  });

  await test('markRead(): stamps state, reader and time; unknown id 404s', async () => {
    const h = makePrisma({ rows: baseRows });
    const svc = new MessagesService(h.prisma);
    assert.deepStrictEqual(await svc.markRead('g1', 'u-9'), { ok: true, id: 'g1' });
    assert.strictEqual(h.calls.update.data.state, 'READ');
    assert.strictEqual(h.calls.update.data.readById, 'u-9');
    assert.ok(h.calls.update.data.readAt instanceof Date);
    await assert.rejects(() => svc.markRead('nope', 'u-9'), (e: any) => e instanceof NotFoundException);
  });

  await test('readAll(): clears only NEW rows, and General means announcementId IS NULL', async () => {
    const h = makePrisma({ rows: baseRows });
    const svc = new MessagesService(h.prisma);
    assert.deepStrictEqual(await svc.readAll('none', 'u-9'), { updated: 1 });
    assert.strictEqual(h.calls.updateMany.where.state, 'NEW', 'an existing read is never overwritten');
    assert.strictEqual(h.calls.updateMany.where.announcementId, null);
    assert.strictEqual(h.calls.updateMany.data.readById, 'u-9');
    assert.strictEqual((await svc.readAll(ANN_A, 'u-9')).updated, 2);
    assert.strictEqual(h.calls.updateMany.where.announcementId, ANN_A);
  });

  await test('unreadCount(): one number for the tab badge', async () => {
    const out = await new MessagesService(makePrisma({ rows: baseRows }).prisma).unreadCount();
    assert.deepStrictEqual(out, { count: 4 });
  });

  await test('every route requires messages.read (announcements-only caller is refused)', async () => {
    const handlers = ['threads', 'unreadCount', 'list', 'markRead', 'readAll'];
    const controller = new MessagesController({} as any);
    const reflector = {
      getAllAndOverride: (key: string, targets: any[]) => {
        for (const t of targets) {
          const v = Reflect.getMetadata ? Reflect.getMetadata(key, t) : undefined;
          if (v) return v;
        }
        return undefined;
      },
    };
    const guard = new PermissionsGuard(reflector as any, { forUser: async () => ['announcements.read', 'announcements.manage'] } as any);
    const ctx = (handler: string) =>
      ({
        getHandler: () => controller[handler],
        getClass: () => MessagesController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u-1' } }) }),
      }) as any;

    const required = reflector.getAllAndOverride(PERMISSIONS_KEY, [controller['threads'], MessagesController]);
    assert.deepStrictEqual(required, [PERMISSIONS.MESSAGES_READ], 'declared once at class level, inherited by all');
    for (const h of handlers) {
      await assert.rejects(
        () => guard.canActivate(ctx(h)),
        (e: any) => e instanceof ForbiddenException,
        `${h} must refuse a caller without messages.read`,
      );
    }
    const allowed = new PermissionsGuard(reflector as any, { forUser: async () => [PERMISSIONS.MESSAGES_READ] } as any);
    for (const h of handlers) assert.strictEqual(await allowed.canActivate(ctx(h)), true, `${h} allows messages.read`);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
