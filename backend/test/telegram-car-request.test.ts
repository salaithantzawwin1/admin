/**
 * Unit tests for the Telegram /car conversational request flow.
 *
 * Drives the REAL TelegramCarActionsService /car handlers with a mock Prisma
 * and a spy telegram.call() — same harness style as telegram-assign-e2e.ts.
 * No DB, no HTTP.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/telegram-car-request.test.ts
 */
const assert = require('assert');

let checks = 0;
const failures: string[] = [];
function check(cond: unknown, label: string) {
  if (cond) {
    checks++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

// ------------------------------------------------------------------ mocks
const CHAT = '777000111';

const prisma: any = {
  user: {
    findFirst: async ({ where }: any) =>
      where.telegramChatId === CHAT
        ? { id: 'u1', username: 'requester1', fullName: 'Requester One' }
        : null,
  },
  systemSetting: { findUnique: async () => ({ value: 'https://ams.example.com' }) },
};

const createdRequests: any[] = [];
const submittedIds: string[] = [];
const cars: any = {
  createCarRequest: async (data: any, actor: any) => {
    createdRequests.push({ data, actor });
    return { id: `req-${createdRequests.length}`, docNumber: `CAR-202609-00${createdRequests.length + 40}` };
  },
};
const workflow: any = {
  submit: async (id: string, actor: any) => {
    submittedIds.push({ id, actor });
  },
  onSubmittedTelegram: () => undefined,
};

const apiLog: Array<{ method: string; payload: any }> = [];
const audit: any = { log: async () => ({}) };
const permissions: any = {
  forUser: async () => ['requests.create'],
  usersWithPermissions: async () => ['u2'],
};

// TelegramService with a recorded call() — same trick as telegram-assign-e2e
const TelegramServiceMod = require('../src/telegram/telegram.service');
const telegram = new TelegramServiceMod.TelegramService(prisma, audit, permissions, { publish: () => 0 });
(telegram as any).call = async (method: string, payload?: any) => {
  apiLog.push({ method, payload });
  return method === 'sendMessage' ? { message_id: 500 + apiLog.length } : null;
};

const TelegramCarActionsMod = require('../src/cars/telegram-car-actions.service');
const svc: any = new TelegramCarActionsMod.TelegramCarActionsService(
  prisma, audit, workflow, cars, telegram, permissions,
);
svc.wire();

// ------------------------------------------------------------------ helpers
const sent = (contains: string) =>
  apiLog.filter((l) => l.method === 'sendMessage' && String(l.payload?.text ?? '').includes(contains));
const keyboards = () => apiLog.filter((l) => l.method === 'sendMessage' && l.payload?.reply_markup?.inline_keyboard);
const allText = () => apiLog.filter((l) => l.method === 'sendMessage').map((l) => String(l.payload?.text ?? '')).join('\n');
const lastText = () => { const m = apiLog.filter((l) => l.method === 'sendMessage'); return m.length ? String(m[m.length-1].payload?.text ?? '') : ''; };

async function tap(data: string, callbackId: string) {
  await (svc as any).handleAction(data, CHAT, callbackId);
}

// ------------------------------------------------------------------ tests
async function main() {
  // 1. /car renders the bilingual form card + keyboard
  apiLog.length = 0;
  await svc.handleCarCommand('/car', CHAT);
  check(sent('ကားတောင်းခံ'), 'form card opens with Burmese title');
  check(sent('New car request'), 'card carries English subtitle');
  check(sent('သွားမယ့်နေရာ'), 'card lists Destination with Burmese label');
  check(keyboards().length >= 1, 'card carries inline keyboard');
  assert.ok(
    JSON.stringify(lastText() && apiLog.filter((l) => l.method === 'sendMessage').map((l) => l.payload?.reply_markup?.inline_keyboard ?? [])).includes('wfa:carsubmit'),
    'keyboard has Submit callback',
  );

  // 2. one reply with all fields (Burmese keys) accumulates into the draft
  apiLog.length = 0;
  await svc.handleCarText(
    'သွားမယ့်နေရာ: မန္တလေး လုပ်ငန်းသွားရေး\nထွက်မယ့်အချိန်: 2026-09-28 08:30\nလိုက်ပါသူ: 3\nကားအမျိုးအစား: VAN\nတက်မည့်နေရာ: ရုံးချုပ်',
    CHAT,
  );
    const card = apiLog.filter((l) => l.method === 'sendMessage').map((l) => String(l.payload?.text ?? '')).join('\n');
  check(card.includes('မန္တလေး လုပ်ငန်းသွားရေး'), 'destination filled');
  check(card.includes('2026-09-28 08:30'), 'start filled');
  check(card.includes('ရုံးချုပ်'), 'pickup filled');
  check(card.includes('VAN'), 'vehicle fuzzy-matched to VAN');

  // 3. English keys also match
  apiLog.length = 0;
  await svc.handleCarText('Purpose: Site inspection', CHAT);
  check((lastText()).includes('Site inspection'), 'English key Purpose matched');

  // 4. slot via inline button callback
  apiLog.length = 0;
  await tap('wfa:carslot:HALF_DAY_PM', 'cb-slot-1');
  check((lastText()).includes('Half PM'), 'slot button updated card');

  // 5. unknown key re-echoes the field list, never aborts
  apiLog.length = 0;
  await svc.handleCarText('Random: junk', CHAT);
  check(sent('မသိပါသော အကွက်များ').length === 1, 'unknown key flagged');
  check((lastText()).includes('မန္တလေး'), 'draft survives unknown key');

  // 6. bad date renders ❌ in card
  apiLog.length = 0;
  await svc.handleCarText('ထွက်မယ့်အချိန်: tomorrow morning', CHAT);
  check((lastText()).includes('မမှန်ပါ'), 'bad date marked invalid');

  // 7. missing required fields block Submit with the card re-shown
  apiLog.length = 0;
  await svc.handleCarText('/cancel', CHAT); // clear, start fresh
  await svc.handleCarCommand('/car', CHAT);
  apiLog.length = 0;
  await svc.handleCarText('Destination: Only destination', CHAT);
  apiLog.length = 0;
  await tap('wfa:carsubmit', 'cb-sub-1');
  check(createdRequests.length === 0, 'submit blocked when Start missing');
  check(sent('ထွက်မယ့်အချိန် (Start)').length >= 1, 'missing Start reported');
  check(apiLog.some((l) => l.method === 'answerCallbackQuery'), 'toast answered');

  // 8. happy path: submit → createCarRequest + workflow.submit as the BOUND user
  apiLog.length = 0;
  await svc.handleCarText('Destination: Bago trip\nStart: 2026-09-30 09:00', CHAT);
  apiLog.length = 0;
  await tap('wfa:carsubmit', 'cb-sub-2');
  check(createdRequests.length === 1, 'createCarRequest called once');
  assert.deepStrictEqual(createdRequests[0].data.destination, 'Bago trip');
  check(createdRequests[0].data.timeSlot, 'FULL_DAY', 'slot defaults to FULL_DAY');
  check(createdRequests[0].data.passengers, 1, 'passengers default 1');
  check(createdRequests[0].actor.userId, 'u1', 'request created AS THE BOUND USER');
  check(submittedIds.length === 1 && submittedIds[0].actor.userId === 'u1', 'workflow.submit called as the bound user');
  check(sent('CAR-202609-00').length >= 1, 'success card carries doc number');
  assert.ok(
    JSON.stringify(apiLog.filter((l) => l.method === 'sendMessage').map((l) => l.payload?.reply_markup ?? [])).includes('Open in AMS'),
    'success card has Open in AMS',
  );
  check(!svc.pendingCarRequests.has(CHAT), 'conversation cleared after submit');

  // 9. submit failure keeps the conversation open with the error echoed
  cars.createCarRequest = async () => { throw new Error('Invalid dates'); };
  await svc.handleCarCommand('/car', CHAT);
  await svc.handleCarText('Destination: Fail case\nStart: 2026-10-01 08:00', CHAT);
  apiLog.length = 0;
  await tap('wfa:carsubmit', 'cb-sub-3');
  check(sent('Invalid dates').length === 1, 'submit error echoed');
  check(svc.pendingCarRequests.has(CHAT), 'conversation stays open after failure');
  cars.createCarRequest = async (data: any, actor: any) => {
    createdRequests.push({ data, actor });
    return { id: `req-${createdRequests.length}`, docNumber: `CAR-202609-00${createdRequests.length + 40}` };
  };

  // 10. /cancel clears
  await svc.handleCarText('/cancel', CHAT);
  check(!svc.pendingCarRequests.has(CHAT), '/cancel clears the conversation');

  // 11. TTL expiry
  await svc.handleCarCommand('/car', CHAT);
  (svc.pendingCarRequests.get(CHAT) as any).at = Date.now() - 16 * 60 * 1000;
  apiLog.length = 0;
  await svc.handleCarText('Destination: late answer', CHAT);
  check(sent('အချိန်ကုန်သွားပါပြီ').length === 1, 'expired conversation reports TTL');
  check(!svc.pendingCarRequests.has(CHAT), 'expired state cleared');

  // 12. unlinked chat cannot open the form
  apiLog.length = 0;
  await svc.handleCarCommand('/car', 'unlinked-chat');
  check(sent('not linked').length === 1, 'unlinked chat rejected');
  check(!svc.pendingCarRequests.has('unlinked-chat'), 'no state for unlinked chat');

  // 13. vehicle fuzzy match invalid → unchanged + card still renders
  await svc.handleCarCommand('/car', CHAT);
  await svc.handleCarText('ကားအမျိုးအစား: ROCKETSHIP', CHAT);
  const draftAfterBadVehicle = (svc.pendingCarRequests.get(CHAT) as any).draft;
  check(!draftAfterBadVehicle.vehicle, 'invalid vehicle type not stored');

  // 14. /skip semantics
  await svc.handleCarText('Pickup: /skip', CHAT);
  check(!(svc.pendingCarRequests.get(CHAT) as any).draft.pickup, '/skip clears pickup');
  await svc.handleCarText('Pickup: ရုံးချုပ်', CHAT);
  await svc.handleCarText('Pickup: -', CHAT);
  check(!(svc.pendingCarRequests.get(CHAT) as any).draft.pickup, '"-" clears pickup');

  // 15. supersede: /car resets an in-progress draft
  await svc.handleCarText('Destination: first draft', CHAT);
  await svc.handleCarCommand('/car', CHAT);
  check(!(svc.pendingCarRequests.get(CHAT) as any).draft.destination, '/car resets draft');

  console.log(`\n${checks} checks, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exitCode = 1;
  }
  // no explicit process.exit — let the event loop drain so all output flushes
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
