/**
 * Announcement → Telegram message-id tracking (plan §5 / P3).
 *
 * A subscriber answers an announcement with Telegram's *Reply*. That update
 * carries `reply_to_message.message_id`, which is the ONLY reliable link back to
 * the announcement being answered — without it the Messages tab could just show
 * "newest card in this chat" and would attribute a reply to the wrong notice as
 * soon as two are visible.
 *
 * For that to work two things must hold:
 *   1. `sendAnnouncementCard()` returns the id Telegram assigned, and `null`
 *      when nothing was sent (bot disabled, API error, foreign webhook — all of
 *      which already return null from `call()`);
 *   2. every successful fan-out writes those ids (card + album photos) to
 *      `announcement_chat_sends`, and a bookkeeping failure never breaks the
 *      publish.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/announcement-chat-sends.test.ts
 */
const assert = require('assert');
const { AnnouncementsService } = require('../src/announcements/announcements.service');
const { TelegramService } = require('../src/telegram/telegram.service');

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

/** TelegramService with `call()` stubbed — no token, no fetch, no polling. */
function telegramWithCall(result: unknown) {
  const prisma: any = { systemSetting: { findUnique: async () => ({ value: 'https://ams.example' }) } };
  const svc: any = new TelegramService(prisma, {} as any, {} as any, {} as any);
  const calls: any[] = [];
  svc.call = async (method: string, payload: any) => {
    calls.push({ method, payload });
    return result;
  };
  return { svc, calls };
}

const CARD = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  code: 'ANN-202611-0009',
  title: 'Water tank cleaning',
  priority: 'URGENT',
  requiresAck: true,
};

const ROW = {
  id: CARD.id,
  code: CARD.code,
  title: CARD.title,
  content: '<p>Tank cleaning Saturday 08:00.</p>',
  priority: 'URGENT',
  requiresAck: true,
  status: 'DRAFT',
};

type Harness = { svc: any; inserts: any[][]; stats: { cards: number } };

/**
 * @param opts.cardId     what sendAnnouncementCard reports (null = Telegram refused)
 * @param opts.albumIds   ids reported by sendPhotoAlbum
 * @param opts.insertThrows the chat-send insert fails
 */
function makeService(opts: { cardId: number | null; albumIds?: number[]; insertThrows?: boolean }): Harness {
  const inserts: any[][] = [];
  const stats = { cards: 0 };
  const prisma: any = {
    announcement: {
      findUnique: async () => ({ ...ROW }),
      update: async (a: any) => ({ ...ROW, ...a.data }),
      updateMany: async () => ({ count: 1 }),
    },
    announcementTarget: { findMany: async () => [{ targetType: 'ALL', targetId: null }] },
    announcementRead: { findMany: async () => [] },
    attachment: { findMany: async () => [{ storedName: 'a.png', mimeType: 'image/png' }] },
    user: {
      findMany: async (a: any) =>
        a?.where?.id ? (a.where.id.in ?? []).map(() => ({ telegramChatId: '4242' })) : [{ id: 'u-1' }],
    },
    announcementChatSend: {
      createMany: async (a: any) => {
        if (opts.insertThrows) throw new Error('relation "announcement_chat_sends" does not exist');
        inserts.push(a.data);
        return { count: a.data.length };
      },
    },
  };
  const notifications: any = { notifyMany: async () => undefined };
  const auditSvc: any = { log: async () => undefined };
  const telegram: any = {
    sendAnnouncementCard: async () => {
      stats.cards += 1;
      return opts.cardId === null ? null : { message_id: opts.cardId };
    },
    sendPhotoAlbum: async () => (opts.albumIds ?? []).map((message_id) => ({ message_id })),
  };
  const svc = new AnnouncementsService(prisma, {} as any, notifications, auditSvc, telegram);
  return { svc, inserts, stats };
}

async function main() {
  console.log('announcement chat sends');

  await test('sendAnnouncementCard returns the message id Telegram assigned', async () => {
    const { svc, calls } = telegramWithCall({ message_id: 42, chat: { id: 4242 } });
    const res = await svc.sendAnnouncementCard('4242', CARD, 'body');
    assert.deepStrictEqual(res, { message_id: 42 }, 'id comes straight back');
    assert.strictEqual(calls[0].method, 'sendMessage');
    assert.strictEqual(calls[0].payload.chat_id, '4242');
    assert.ok(calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data === `anack:${CARD.id}`, 'ack button kept');
  });

  await test('sendAnnouncementCard returns null when the send failed', async () => {
    const { svc } = telegramWithCall(null);
    const res = await svc.sendAnnouncementCard('4242', CARD, 'body');
    assert.strictEqual(res, null, 'no id invented for a message that never went out');
  });

  await test('sendAnnouncementCard tolerates a reply without message_id', async () => {
    const { svc } = telegramWithCall({ chat: { id: 4242 } });
    assert.strictEqual(await svc.sendAnnouncementCard('4242', CARD, 'body'), null);
  });

  await test('a successful fan-out records the card and album ids for that chat', async () => {
    const h = makeService({ cardId: 42, albumIds: [40, 41] });
    await h.svc.publish(ROW.id, { userId: 'admin-1', username: 'sysadmin' });

    assert.strictEqual(h.inserts.length, 1, 'one insert per delivered chat');
    const data = h.inserts[0];
    assert.strictEqual(data.length, 3, 'card + both album photos remembered');
    assert.ok(data.every((r: any) => r.chatId === '4242' && r.announcementId === ROW.id));
    assert.deepStrictEqual(
      data.map((r: any) => r.messageId),
      [42n, 40n, 41n],
      'card first, then the album (stored as BigInt for the BIGINT column)',
    );
  });

  await test('a refused card records nothing but still reaches the chat', async () => {
    const h = makeService({ cardId: null });
    await h.svc.publish(ROW.id, { userId: 'admin-1', username: 'sysadmin' });
    assert.strictEqual(h.stats.cards, 1, 'the send was attempted');
    assert.strictEqual(h.inserts.length, 0, 'no id to remember');
  });

  await test('a failing chat-send insert never breaks the publish', async () => {
    const h = makeService({ cardId: 42, insertThrows: true });
    await h.svc.publish(ROW.id, { userId: 'admin-1', username: 'sysadmin' });
    assert.strictEqual(h.stats.cards, 1, 'the card still went out');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
