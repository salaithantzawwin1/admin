/**
 * Inbound capture must not break — or be broken by — the existing conversations
 * (plan §6, R1–R7 / P4).
 *
 * The poll loop routes one message through: odometer capture → reject reason →
 * custom ETA → /car form → slash commands → /start. The message log is inserted
 * BEFORE that routing and labelled afterwards, so these rules must hold:
 *
 *   R1  a Reply to one of our announcement cards is never consumed by an armed
 *       flow, and no "photo first" nag is sent for it;
 *   R3  text a flow consumed is stored with that flow's label;
 *   R4  `/msg <text>` files a message and leaves every flow armed;
 *   R7  command precedence is unchanged (`/assign` still runs as a command).
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/telegram-inbound-routing.test.ts
 */
const assert = require('assert');
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

type Harness = {
  svc: any;
  captured: any[];
  marks: [string | null | undefined, string][];
  sent: string[];
  odometerText: string[];
  odometerPhoto: number;
  commandTexts: string[];
  formTexts: string[];
};

/**
 * @param opts.announcementId   what capture() links the message to
 * @param opts.odoArmed         an odometer capture is waiting in this chat
 * @param opts.formOpen         the /car form is open in this chat
 * @param opts.odoConsumesText  the odometer handler accepts the text as a reading
 */
function makeService(opts: {
  announcementId?: string | null;
  odoArmed?: boolean;
  formOpen?: boolean;
  odoConsumesText?: boolean;
}): Harness {
  const prisma: any = {
    systemSetting: { findMany: async () => [], findUnique: async () => null },
  };
  const svc: any = new TelegramService(prisma, {} as any, { usersWithPermissions: async () => [] } as any, {} as any);
  const captured: any[] = [];
  const marks: [string | null | undefined, string][] = [];
  const sent: string[] = [];
  const odometerText: string[] = [];
  const commandTexts: string[] = [];
  const formTexts: string[] = [];

  svc.inbound = {
    capture: async (input: any) => {
      captured.push(input);
      return { id: 'row-1', announcementId: opts.announcementId ?? null };
    },
    markHandled: async (id: string | null | undefined, by: string) => {
      marks.push([id, by]);
    },
  };
  // no real Telegram calls — record what the bot would have said
  svc.call = async (_method: string, payload: any) => {
    sent.push(String(payload?.text ?? ''));
    return { message_id: 1 };
  };
  svc.handleOdoText = async (_chatId: string, text: string) => {
    odometerText.push(text);
    return opts.odoConsumesText ?? false;
  };
  svc.handleOdoPhoto = async () => {
    svc.odoPhoto = (svc.odoPhoto ?? 0) + 1;
  };
  svc.commands = {
    handleText: async (text: string) => {
      commandTexts.push(text);
      return true;
    },
  };
  svc.carRequests = {
    hasPending: () => !!opts.formOpen,
    handleText: async (text: string) => {
      formTexts.push(text);
    },
  };
  if (opts.odoArmed) svc.pendingOdo.set('4242', { assignmentId: 'as-1', stage: 'READY', at: Date.now() });

  return {
    svc,
    captured,
    marks,
    sent,
    odometerText,
    get odometerPhoto() {
      return svc.odoPhoto ?? 0;
    },
    commandTexts,
    formTexts,
  } as Harness;
}

const update = (message: any) => ({ update_id: 1, message: { chat: { id: 4242 }, ...message } });

async function main() {
  console.log('telegram inbound routing');

  await test('a card reply is stored and returns before any armed flow (R1)', async () => {
    const h = makeService({ announcementId: 'ann-1', odoArmed: true });
    await h.svc.handleUpdate(update({ message_id: 77, text: '22' , reply_to_message: { message_id: 900 } }));

    assert.strictEqual(h.captured.length, 1, 'stored first');
    assert.strictEqual(h.captured[0].replyToMessageId, 900, 'the reply target is passed through');
    assert.strictEqual(h.odometerText.length, 0, 'the reading flow never saw the number');
    assert.strictEqual(h.sent.length, 0, 'no “photo first” nag for a card reply');
    assert.deepStrictEqual(h.marks, [], 'label decided at insert (ANNOUNCEMENT_REPLY)');
  });

  await test('a photo reply to a card is stored and never becomes odometer evidence (R1/R2)', async () => {
    const h = makeService({ announcementId: 'ann-1', odoArmed: true });
    await h.svc.handleUpdate(
      update({
        message_id: 78,
        photo: [
          { file_id: 'small', width: 90, height: 90 },
          { file_id: 'large', width: 1280, height: 960 },
        ],
        reply_to_message: { message_id: 900 },
      }),
    );
    assert.strictEqual(h.captured[0].photo.fileId, 'large', 'largest size is stored');
    assert.strictEqual(h.odometerPhoto, 0, 'the odometer never takes a card reply as evidence');
  });

  await test('a normal odometer photo is stored AND consumed (R2/R3)', async () => {
    const h = makeService({ odoArmed: true });
    await h.svc.handleUpdate(update({ message_id: 79, photo: [{ file_id: 'dash', width: 800, height: 600 }] }));
    assert.strictEqual(h.captured[0].photo.fileId, 'dash');
    assert.strictEqual(h.odometerPhoto, 1, 'the flow still runs');
    assert.deepStrictEqual(h.marks, [['row-1', 'ODOMETER']], 'and the row says who took it');
  });

  await test('a reading consumed by the odometer is labelled ODOMETER (R3)', async () => {
    const h = makeService({ odoArmed: true, odoConsumesText: true });
    await h.svc.handleUpdate(update({ message_id: 80, text: '123456' }));
    assert.deepStrictEqual(h.odometerText, ['123456']);
    assert.deepStrictEqual(h.marks, [['row-1', 'ODOMETER']]);
  });

  await test('a /car form answer is labelled CAR_FORM (R3)', async () => {
    const h = makeService({ formOpen: true });
    await h.svc.handleUpdate(update({ message_id: 81, text: 'Yangon → Mandalay' }));
    assert.deepStrictEqual(h.formTexts, ['Yangon → Mandalay']);
    assert.deepStrictEqual(h.marks, [['row-1', 'CAR_FORM']]);
  });

  await test('/msg files the message and leaves the odometer armed (R4)', async () => {
    const h = makeService({ odoArmed: true });
    await h.svc.handleUpdate(update({ message_id: 82, text: '/msg car breakdown at 3pm' }));
    assert.deepStrictEqual(h.marks, [['row-1', 'GENERAL']], 'never labelled ODOMETER');
    assert.strictEqual(h.odometerText.length, 0, 'the armed flow is untouched');
    assert.ok(h.svc.pendingOdo.has('4242'), 'still armed for the next number');
    assert.strictEqual(h.sent.length, 1, 'answered with one confirmation line');
    assert.ok(h.sent[0].startsWith('✓'), 'confirmation text');
  });

  await test('a slash command still wins while a flow is armed (R7)', async () => {
    const h = makeService({ odoArmed: true });
    await h.svc.handleUpdate(update({ message_id: 83, text: '/assign CAR-202611-0001' }));
    assert.deepStrictEqual(h.commandTexts, ['/assign CAR-202611-0001'], 'command precedence unchanged');
    assert.deepStrictEqual(h.marks, [['row-1', 'COMMAND']]);
  });

  await test('a plain text with no flow armed is logged as GENERAL', async () => {
    const h = makeService({});
    await h.svc.handleUpdate(update({ message_id: 84, text: 'hello there' }));
    assert.strictEqual(h.captured[0].text, 'hello there');
    assert.deepStrictEqual(h.marks, [], 'nothing consumed it — stays GENERAL from insert');
  });

  await test('a caption on a photo becomes the message text', async () => {
    const h = makeService({});
    await h.svc.handleUpdate(
      update({ message_id: 85, photo: [{ file_id: 'p', width: 10, height: 10 }], caption: 'broken chair' }),
    );
    assert.strictEqual(h.captured[0].text, 'broken chair');
    assert.strictEqual(h.captured[0].photo.fileId, 'p');
  });

  await test('capture is optional — an unwired bot still routes normally', async () => {
    const h = makeService({ odoArmed: true, odoConsumesText: true });
    delete h.svc.inbound;
    await h.svc.handleUpdate(update({ message_id: 86, text: '999' }));
    assert.deepStrictEqual(h.odometerText, ['999'], 'flow unaffected by a missing hook');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
