/**
 * Inbound subscriber messages are stored, never swallowed (plan §6 / P4).
 *
 * Everything the audience sends the bot — text, photos, documents — must end up
 * in `telegram_inbound_messages`, whether or not a vehicle-trip conversation
 * consumed it, and a Reply to an announcement card must be linked to that exact
 * announcement (R1, R3, R5, R7 from the plan).
 *
 * Contract pinned here:
 *   1. a bound user's text/photo is stored with their id and the right kind;
 *   2. a Reply whose `reply_to_message.message_id` matches a card we sent links
 *      to that announcement and is labelled ANNOUNCEMENT_REPLY;
 *   3. a driver-only chat is stored but never linked (R5);
 *   4. `/start <code>` is stored masked, so the tab cannot leak a binding code;
 *   5. a re-delivered update (unique violation) returns the existing row;
 *   6. `TELEGRAM_INBOUND=0` turns capture off without touching routing;
 *   7. `markHandled()` labels the flow but never rewrites an announcement reply.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/announcement-inbound-capture.test.ts
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

type Harness = {
  svc: any;
  created: any[];
  updates: any[];
  published: string[];
  capture(input: any): Promise<any>;
};

/**
 * @param opts.user         bound AMS user in this chat
 * @param opts.driver       bound driver in this chat
 * @param opts.cardSends    announcement_chat_sends rows for the chat
 * @param opts.duplicate    make create() raise P2002
 * @param opts.insertThrows make create() fail with a plain error
 */
function makeService(opts: {
  user?: { id: string; fullName: string };
  driver?: { id: string; name: string };
  cardSends?: { messageId: bigint; announcementId: string }[];
  duplicate?: boolean;
  insertThrows?: boolean;
}): Harness {
  const created: any[] = [];
  const updates: any[] = [];
  const published: string[] = [];
  let seq = 0;
  const prisma: any = {
    user: { findFirst: async () => opts.user ?? null },
    driver: { findFirst: async () => opts.driver ?? null },
    announcementChatSend: {
      findFirst: async (a: any) =>
        (opts.cardSends ?? []).find(
          (s) => s.messageId === a.where.messageId && a.where.chatId === '4242',
        ) ?? null,
    },
    telegramInboundMessage: {
      create: async (a: any) => {
        if (opts.duplicate) throw Object.assign(new Error('unique'), { code: 'P2002' });
        if (opts.insertThrows) throw new Error('permission denied for table telegram_inbound_messages');
        created.push(a.data);
        seq += 1;
        return { id: `row-${seq}`, announcementId: a.data.announcementId ?? null };
      },
      findFirst: async () => ({ id: 'row-existing', announcementId: ANN }),
      updateMany: async (a: any) => {
        updates.push(a);
        return { count: 1 };
      },
    },
  };
  const events: any = { publish: (type: string) => published.push(type) };
  const svc = new AnnouncementsService(prisma, {} as any, {} as any, {} as any, {} as any, events);
  return { svc, created, updates, published, capture: (input: any) => svc.captureInbound(input) };
}

async function main() {
  console.log('announcement inbound capture');

  await test('a bound user’s text is stored as TEXT with their identity', async () => {
    const h = makeService({ user: { id: 'u-1', fullName: 'Aung Aung' } });
    const rec = await h.capture({ chatId: '4242', messageId: 11, text: 'မနက်ဖန် ရုံးပိတ်လား' });

    assert.strictEqual(h.created.length, 1);
    const d = h.created[0];
    assert.strictEqual(d.kind, 'TEXT');
    assert.strictEqual(d.text, 'မနက်ဖန် ရုံးပိတ်လား');
    assert.strictEqual(d.userId, 'u-1');
    assert.strictEqual(d.driverId, null);
    assert.strictEqual(d.senderName, 'Aung Aung', 'bound user wins over the Telegram first name');
    assert.strictEqual(d.announcementId, null);
    assert.strictEqual(d.handledBy, 'GENERAL');
    assert.strictEqual(d.state, 'NEW');
    assert.deepStrictEqual(rec, { id: 'row-1', announcementId: null });
    assert.deepStrictEqual(h.published, ['message.new'], 'the tab is told to refetch');
  });

  await test('a photo is stored as PHOTO with the largest size and its dimensions', async () => {
    const h = makeService({ user: { id: 'u-1', fullName: 'Aung Aung' } });
    await h.capture({
      chatId: '4242',
      messageId: 12,
      photo: { fileId: 'big', width: 1280, height: 960 },
      mediaGroupId: 'grp-1',
    });
    const d = h.created[0];
    assert.strictEqual(d.kind, 'PHOTO');
    assert.strictEqual(d.photoFileId, 'big');
    assert.strictEqual(d.photoWidth, 1280);
    assert.strictEqual(d.mediaGroupId, 'grp-1', 'album photos share their group id');
  });

  await test('a document is stored as DOCUMENT with its file name', async () => {
    const h = makeService({ user: { id: 'u-1', fullName: 'Aung Aung' } });
    await h.capture({ chatId: '4242', messageId: 13, documentName: 'report.pdf' });
    assert.strictEqual(h.created[0].kind, 'DOCUMENT');
    assert.strictEqual(h.created[0].documentName, 'report.pdf');
  });

  await test('a Reply to our card links to that announcement (R1)', async () => {
    const h = makeService({
      user: { id: 'u-1', fullName: 'Aung Aung' },
      cardSends: [{ messageId: 900n, announcementId: ANN }],
    });
    const rec = await h.capture({ chatId: '4242', messageId: 14, replyToMessageId: 900, text: 'သိပါပြီ' });
    const d = h.created[0];
    assert.strictEqual(d.announcementId, ANN);
    assert.strictEqual(d.handledBy, 'ANNOUNCEMENT_REPLY', 'linked at insert — no flow may relabel it');
    assert.strictEqual(d.replyToMessageId, 900n, 'BIGINT column gets a BigInt');
    assert.strictEqual(rec.announcementId, ANN);
  });

  await test('a Reply to some other bot message stays General', async () => {
    const h = makeService({
      user: { id: 'u-1', fullName: 'Aung Aung' },
      cardSends: [{ messageId: 900n, announcementId: ANN }],
    });
    const rec = await h.capture({ chatId: '4242', messageId: 15, replyToMessageId: 123, text: 'hi' });
    assert.strictEqual(h.created[0].announcementId, null);
    assert.strictEqual(rec.announcementId, null, 'no accidental thread');
  });

  await test('a driver-only chat is stored but never linked (R5)', async () => {
    const h = makeService({
      driver: { id: 'd-1', name: 'Ko Min' },
      cardSends: [{ messageId: 900n, announcementId: ANN }],
    });
    const rec = await h.capture({ chatId: '4242', messageId: 16, replyToMessageId: 900, text: 'ok' });
    const d = h.created[0];
    assert.strictEqual(d.driverId, 'd-1');
    assert.strictEqual(d.userId, null);
    assert.strictEqual(d.announcementId, null, 'drivers are not in an announcement audience');
    assert.strictEqual(rec.announcementId, null);
  });

  await test('an unbound chat is still stored, with the Telegram name', async () => {
    const h = makeService({});
    await h.capture({ chatId: '4242', messageId: 17, text: 'hello', senderName: 'Zaw' });
    const d = h.created[0];
    assert.strictEqual(d.userId, null);
    assert.strictEqual(d.driverId, null);
    assert.strictEqual(d.senderName, 'Zaw', 'shows as “Not linked”, not as an empty bubble');
  });

  await test('/start <code> is masked so the tab cannot leak a binding code', async () => {
    const h = makeService({ user: { id: 'u-1', fullName: 'Aung Aung' } });
    await h.capture({ chatId: '4242', messageId: 18, text: '/start USR-123456' });
    assert.strictEqual(h.created[0].text, '/start ••••');
    await h.capture({ chatId: '4242', messageId: 19, text: '/start' });
    assert.strictEqual(h.created[1].text, '/start');
  });

  await test('a re-delivered update (unique violation) returns the existing row', async () => {
    const h = makeService({ user: { id: 'u-1', fullName: 'Aung Aung' }, duplicate: true });
    const rec = await h.capture({ chatId: '4242', messageId: 20, text: 'again' });
    assert.deepStrictEqual(rec, { id: 'row-existing', announcementId: ANN });
    assert.strictEqual(h.created.length, 0, 'no duplicate bubble');
  });

  await test('a failing insert never throws into the poll loop', async () => {
    const h = makeService({ user: { id: 'u-1', fullName: 'Aung Aung' }, insertThrows: true });
    assert.strictEqual(await h.capture({ chatId: '4242', messageId: 21, text: 'boom' }), null);
  });

  await test('TELEGRAM_INBOUND=0 switches capture off without touching routing', async () => {
    const h = makeService({ user: { id: 'u-1', fullName: 'Aung Aung' } });
    process.env.TELEGRAM_INBOUND = '0';
    try {
      assert.strictEqual(await h.capture({ chatId: '4242', messageId: 22, text: 'off' }), null);
      assert.strictEqual(h.created.length, 0);
    } finally {
      delete process.env.TELEGRAM_INBOUND;
    }
  });

  await test('markHandled labels the flow, but never rewrites an announcement reply', async () => {
    const h = makeService({});
    await h.svc.markHandled('row-1', 'ODOMETER');
    assert.strictEqual(h.updates.length, 1);
    assert.strictEqual(h.updates[0].data.handledBy, 'ODOMETER');
    assert.deepStrictEqual(h.updates[0].where.handledBy, { not: 'ANNOUNCEMENT_REPLY' });
    await h.svc.markHandled(null, 'GENERAL');
    assert.strictEqual(h.updates.length, 1, 'nothing to label is a no-op');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
