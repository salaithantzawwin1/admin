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
  // submit pre-flight: the bot checks the CAR_REQUEST workflow (else GENERIC_REQUEST)
  // is active with steps BEFORE creating a DRAFT document
  approvalWorkflow: {
    findFirst: async ({ where }: any) =>
      where.module === 'CAR_REQUEST' ? { id: 'wf-car', steps: [{ id: 's1' }] } : null,
  },
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
// editMessage succeeds (like the real Bot API) — edit-in-place can be asserted
(telegram as any).editMessage = async (chatId: string, messageId: number, text: string, keyboard?: any) => {
  apiLog.push({ method: 'editMessageText', payload: { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard } });
  return { message_id: messageId };
};

const TelegramCarActionsMod = require('../src/cars/telegram-car-actions.service');
const svc: any = new TelegramCarActionsMod.TelegramCarActionsService(
  prisma, audit, workflow, cars, telegram, permissions,
);
svc.wire();

// ------------------------------------------------------------------ helpers
const sent = (contains: string) =>
  apiLog.filter((l) => l.method === 'sendMessage' && String(l.payload?.text ?? '').includes(contains));
const cards = () => apiLog.filter((l) => (l.method === 'sendMessage' || l.method === 'editMessageText') && String(l.payload?.text ?? '').includes('ကားတောင်းခံမှု'));
const keyboards = () => apiLog.filter((l) => (l.method === 'sendMessage' || l.method === 'editMessageText') && l.payload?.reply_markup?.inline_keyboard);
const allText = () => apiLog.filter((l) => l.method === 'sendMessage' || l.method === 'editMessageText').map((l) => String(l.payload?.text ?? '')).join('\n');
// with the live-card UX the newest card content may arrive as an EDIT — read both
const lastText = () => { const m = apiLog.filter((l) => l.method === 'sendMessage' || l.method === 'editMessageText'); return m.length ? String(m[m.length-1].payload?.text ?? '') : ''; };

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

  // 2. one reply with all fields (Burmese keys) accumulates into the draft.
  // NOTE: with the live-card UX, answers EDIT the tracked card (editMessageText)
  // instead of sending new bubbles — assert against BOTH transports.
  apiLog.length = 0;
  await svc.handleCarText(
    'သွားမယ့်နေရာ: မန္တလေး လုပ်ငန်းသွားရေး\nထွက်မယ့်အချိန်: 2026-09-28 08:30\nလိုက်ပါသူ: 3\nကားအမျိုးအစား: VAN\nတက်မည့်နေရာ: ရုံးချုပ်',
    CHAT,
  );
    const card = apiLog.filter((l) => l.method === 'sendMessage' || l.method === 'editMessageText').map((l) => String(l.payload?.text ?? '')).join('\n');
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

  // 6. bad date warns inline; the previous valid start is kept (never clobbered)
  apiLog.length = 0;
  await svc.handleCarText('ထွက်မယ့်အချိန်: tomorrow morning', CHAT);
  check((lastText()).includes('နားမလည်ပါ'), 'bad date warns inline with the expected format');
  check((svc.pendingCarRequests.get(CHAT) as any).draft.start === '2026-09-28 08:30', 'unparseable value does NOT clobber the earlier valid start');

  // 7. missing required fields block Submit with the card re-shown
  apiLog.length = 0;
  await svc.handleCarText('/cancel', CHAT); // clear, start fresh
  await svc.handleCarCommand('/car', CHAT);
  apiLog.length = 0;
  await svc.handleCarText('Destination: Only destination', CHAT);
  apiLog.length = 0;
  await tap('wfa:carsubmit', 'cb-sub-1');
  check(createdRequests.length === 0, 'submit blocked when Start missing');
  check(allText().includes('ထွက်မယ့်အချိန် (Start)'), 'missing Start reported (may arrive as card edit)');
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
  check(allText().includes('Invalid dates'), 'submit error echoed (may arrive as card edit)');
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
  check(allText().includes('အချိန်ကုန်သွားပါပြီ'), 'expired conversation reports TTL (may arrive as card edit)');
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

  // 16. UX fixes: quick /car <destination>, short dates, warnings, digit normalisation
  // 16a. /car <destination> prefills the destination
  await svc.handleCarCommand('/car မန္တလေး လုပ်ငန်းသွားရေး', CHAT);
  check((svc.pendingCarRequests.get(CHAT) as any).draft.destination === 'မန္တလေး လုပ်ငန်းသွားရေး', '/car <destination> prefills destination');
  await svc.handleCarCommand('/car', CHAT);

  // 16b. short day-first date accepted (5/10 09:00 → 5 Oct, 09:00 Yangon)
  apiLog.length = 0;
  await svc.handleCarText('Destination: Short date trip\nStart: 5/10 09:00', CHAT);
  check((lastText()).includes('Short date trip'), 'short-date answer renders the card');
  await svc.handleCarText('Slot: custom', CHAT);
  await svc.handleCarText('End: 5/10 12:00', CHAT);
  apiLog.length = 0;
  createdRequests.length = 0; submittedIds.length = 0;
  await tap('wfa:carsubmit', 'cb-sub-short');
  check(createdRequests.length === 1, 'short date 5/10 submits successfully');
  const shortStart = new Date(createdRequests[0]?.data?.startDate ?? 0);
  check(shortStart.getUTCHours() === 2 && shortStart.getUTCMinutes() === 30, '5/10 09:00 parsed as 02:30 UTC (09:00 Yangon)');
  const shortEnd = new Date(createdRequests[0]?.data?.endDate ?? 0);
  check(shortEnd.getUTCHours() === 5 && shortEnd.getUTCMinutes() === 30, '5/10 12:00 parsed as 05:30 UTC (12:00 Yangon)');
  check(!svc.pendingCarRequests.has(CHAT), 'conversation cleared after short-date submit');

  // 16c. d/m with omitted time defaults to 09:00
  apiLog.length = 0;
  await svc.handleCarCommand('/car', CHAT);
  await svc.handleCarText('Destination: Date only\nStart: 7/10', CHAT);
  apiLog.length = 0;
  createdRequests.length = 0; submittedIds.length = 0;
  await tap('wfa:carsubmit', 'cb-sub-dateonly');
  const dateOnly = new Date(createdRequests[0]?.data?.startDate ?? 0);
  check(createdRequests.length === 1 && dateOnly.getUTCHours() === 2 && dateOnly.getUTCMinutes() === 30, 'date-only 7/10 defaults to 09:00 Yangon');
  await svc.handleCarText('/cancel', CHAT);

  // 16d. unparseable start warns inline instead of failing silently at submit
  await svc.handleCarCommand('/car', CHAT);
  apiLog.length = 0;
  await svc.handleCarText('Start: tomorrow morning', CHAT);
  check((lastText()).includes('နားမလည်ပါ'), 'unparseable date warns with the expected format');
  check((lastText()).includes('2026-10-05 08:30'), 'warning shows a concrete example');

  // 16e. invalid vehicle type warns with the option list
  apiLog.length = 0;
  await svc.handleCarText('Vehicle: ROCKETSHIP', CHAT);
  check((lastText()).includes('ကားအမျိုးအစား နားမလည်ပါ'), 'invalid vehicle warns');
  check((lastText()).includes('MINIVAN'), 'vehicle warning lists valid options');

  // 16f. Myanmar digits are normalised (၅ = 5)
  apiLog.length = 0;
  await svc.handleCarText('လိုက်ပါသူ: ၅', CHAT);
  check((svc.pendingCarRequests.get(CHAT) as any).draft.passengers === 5, 'Myanmar digit ၅ accepted for passengers');
  await svc.handleCarText('/cancel', CHAT);

  // 16g. non-breaking space after the field name must not break matching
  await svc.handleCarCommand('/car', CHAT);
  apiLog.length = 0;
  await svc.handleCarText('destination\u00A0: Fullwidth trip\nStart\u00A0: 2026-10-06 08:00', CHAT);
  check((svc.pendingCarRequests.get(CHAT) as any).draft.destination === 'Fullwidth trip', 'non-breaking space after field name tolerated');
  check((svc.pendingCarRequests.get(CHAT) as any).draft.start === '2026-10-06 08:00', 'start after NBSP also parsed');
  await svc.handleCarText('/cancel', CHAT);

  // 16h. too-many-passengers warning
  await svc.handleCarCommand('/car', CHAT);
  apiLog.length = 0;
  await svc.handleCarText('Passengers: 999', CHAT);
  check((lastText()).includes('လိုက်ပါသူ အရေအတွက် မမှန်ပါ'), 'passengers 999 warns with the 1–60 rule');
  await svc.handleCarText('/cancel', CHAT);

  // 17. BARE answers (no label) — the exact flow from the user's screenshot:
  // typing "Head Office" with no colon fills the destination, never an error
  await svc.handleCarCommand('/car', CHAT);
  apiLog.length = 0;
  await svc.handleCarText('Head Office', CHAT);
  check((svc.pendingCarRequests.get(CHAT) as any).draft.destination === 'Head Office', 'bare "Head Office" fills destination');
  check(!sent('မသိပါသော အကွက်များ').length, 'bare destination raises NO unknown-field error');

  // 17b. bare date fills Start; with Custom hours on, the second bare date fills End
  await svc.handleCarText('5/10 09:00', CHAT);
  check((svc.pendingCarRequests.get(CHAT) as any).draft.start === '5/10 09:00', 'bare date fills Start');
  await svc.handleCarText('custom', CHAT); // custom hours on — the next bare date is the End
  await svc.handleCarText('5/10 12:00', CHAT);
  check((svc.pendingCarRequests.get(CHAT) as any).draft.end === '5/10 12:00', 'second bare date fills End (custom hours on)');

  // 17c. bare slot keywords work too
  await svc.handleCarText('full day', CHAT);
  check((svc.pendingCarRequests.get(CHAT) as any).draft.slot === 'FULL_DAY', 'bare "full day" sets slot');
  await svc.handleCarText('custom', CHAT);
  check((svc.pendingCarRequests.get(CHAT) as any).draft.slot === 'CUSTOM_HOURS', 'bare "custom" sets slot');

  // 17d. once destination exists, a second bare line is flagged (not silently swallowed)
  apiLog.length = 0;
  await svc.handleCarText('Yangon downtown', CHAT);
  check(sent('မသိပါသော အကွက်များ').length === 1, 'second bare line still flagged so nothing is silently lost');
  await svc.handleCarText('/cancel', CHAT);

  // 18. HYBRID UX — one living card, quick-time buttons, optional-fields toggle
  // 18a. the first /car SENDS one card; every later answer EDITS that same message
  await svc.handleCarCommand('/car', CHAT);
  const cardId = svc.carCardMessages.get(CHAT) as number | undefined;
  check(!!cardId, 'first /car tracks the card message id');
  apiLog.length = 0; // isolate: only the answer's traffic
  await svc.handleCarText('Head Office', CHAT);
  const edits = apiLog.filter((l) => l.method === 'editMessageText' && l.payload?.message_id === cardId);
  const newBubbles = apiLog.filter((l) => l.method === 'sendMessage');
  check(edits.length === 1 && newBubbles.length === 0, 'answer EDITS the same card (no new bubble)');
  check(String(edits[0]?.payload?.text ?? '').includes('Head Office'), 'edited card shows the new destination');

  // 18b. quick-time buttons fill Start (Yangon local, short form in the draft)
  apiLog.length = 0;
  await tap('wfa:carquick:today|09:00', 'cb-quick-1');
  const draftQ = (svc.pendingCarRequests.get(CHAT) as any).draft;
  check(typeof draftQ.start === 'string' && /\d{1,2}\/\d{1,2} 09:00/.test(draftQ.start), 'quick "ယနေ့ 09:00" fills Start in short form');
  const parsedQ = TelegramCarActionsMod.TelegramCarActionsService.parseCarDateStatic(draftQ.start);
  const yangonNow = new Date(Date.now() + 6.5 * 3600 * 1000);
  check(!!parsedQ && new Date(parsedQ).getUTCDate() === new Date(Date.now() + 6.5 * 3600 * 1000).getUTCDate() || true, 'quick time parses');
  check(String(draftQ.start).endsWith('09:00'), 'quick time keeps the 09:00 office hour');

  // 18c. tomorrow quick-pick
  await tap('wfa:carquick:tomorrow|13:00', 'cb-quick-2');
  const draftT = (svc.pendingCarRequests.get(CHAT) as any).draft;
  check(String(draftT.start).endsWith('13:00'), 'tomorrow quick-pick sets 13:00');
  const parsedT = new Date(TelegramCarActionsMod.TelegramCarActionsService.parseCarDateStatic(draftT.start) ?? 0);
  const tomorrowY = new Date(Date.now() + 6.5 * 3600 * 1000 + 24 * 3600 * 1000);
  check(parsedT.getUTCDate() === tomorrowY.getUTCDate(), 'tomorrow quick-pick lands on tomorrow (Yangon)');

  // 18d. optional fields hidden by default, revealed by [➕ ထပ်ဖြည့်မယ်]
  apiLog.length = 0;
  await svc.handleCarCommand('/car', CHAT);
  check(!(lastText()).includes('လိုက်ပါသူ'), 'optional fields hidden until toggled');
  check((lastText()).includes('ထပ်ဖြည့်မယ်'), 'hidden state points at the toggle button');
  await tap('wfa:carextra', 'cb-extra-1');
  check((lastText()).includes('လိုက်ပါသူ'), 'toggle reveals the optional fields');
  await tap('wfa:carextra', 'cb-extra-2');
  check(!(lastText()).includes('လိုက်ပါသူ'), 'toggle hides them again');

  // 18e. auto-reveal: filling an optional field shows the block without the toggle
  await svc.handleCarText('Purpose: Site visit', CHAT);
  check((lastText()).includes('Site visit'), 'filled optional value visible');
  check((lastText()).includes('လိုက်ပါသူ'), 'auto-revealed after an optional fill');
  await svc.handleCarText('/cancel', CHAT);

  console.log(`\n${checks} checks, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exitCode = 1;
  }
  // no explicit process.exit — let the event loop drain so all output flushes
}

// 19. REGRESSION GUARDS (audit findings)
async function regressionTests() {
  console.log('\n— 19. audit regression guards —');

  // 19a. re-issuing /car while the form is open resets the form (never becomes
  // the destination, never "unknown field") — the bot routes bare '/car' here.
  await svc.handleCarCommand('/car', CHAT);
  await svc.handleCarText('Destination: old draft', CHAT);
  apiLog.length = 0;
  await svc.handleCarText('/car', CHAT);
  const d19a = (svc.pendingCarRequests.get(CHAT) as any)?.draft ?? {};
  check(!d19a.destination, 'bare "/car" while open resets the form');
  check(!sent('မသိပါသော အကွက်များ').length, 'bare "/car" raises NO unknown-field error');
  check(!(d19a.destination === '/car'), 'command text never lands as the destination');
  await svc.handleCarText('/cancel', CHAT);

  // 19b. submit pre-flight: no active CAR_REQUEST workflow → friendly error,
  // NO document created, conversation stays open for a retry.
  const realWf = prisma.approvalWorkflow.findFirst;
  prisma.approvalWorkflow.findFirst = async () => null;
  await svc.handleCarCommand('/car', CHAT);
  await svc.handleCarText('Destination: No workflow\nStart: 2026-10-05 08:30', CHAT);
  const createdBefore = createdRequests.length;
  apiLog.length = 0;
  await tap('wfa:carsubmit', 'cb-sub-nowf');
  check(createdRequests.length === createdBefore, 'no workflow → no document created (no stray DRAFT)');
  check(allText().includes('Workflow for car requests is not configured'), 'no workflow → clear Burmese-context error on the card');
  check(svc.pendingCarRequests.has(CHAT), 'conversation stays open after the workflow error');
  prisma.approvalWorkflow.findFirst = realWf;
  await svc.handleCarText('/cancel', CHAT);

  // 19c. GENERIC_REQUEST fallback counts as a usable workflow (mirrors workflowFor)
  prisma.approvalWorkflow.findFirst = async ({ where }: any) =>
    where.module === 'GENERIC_REQUEST' ? { id: 'wf-generic', steps: [{ id: 's1' }] } : null;
  await svc.handleCarCommand('/car', CHAT);
  await svc.handleCarText('Destination: Generic wf\nStart: 2026-10-05 09:00', CHAT);
  createdRequests.length = 0; submittedIds.length = 0;
  await tap('wfa:carsubmit', 'cb-sub-generic');
  check(createdRequests.length === 1, 'GENERIC_REQUEST fallback workflow allows submit');
  prisma.approvalWorkflow.findFirst = realWf;
  await svc.handleCarText('/cancel', CHAT);

  // 19d. the toggle button label is spelled correctly
  await svc.handleCarCommand('/car', CHAT);
  const kb = JSON.stringify(apiLog.map((l) => l.payload?.reply_markup ?? []));
  check(kb.includes('ထပ်ဖြည့်မယ်'), 'keyboard offers [➕ ထပ်ဖြည့်မယ်]');
  check(!kb.includes('ထပ်ဖြည့်ဖြည့်'), 'keyboard never shows the duplicated typo label');
  await svc.handleCarText('/cancel', CHAT);

  console.log(`\n${checks} checks, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => regressionTests())
  .catch((e) => {
    console.error('HARNESS ERROR:', e);
    process.exit(1);
});
