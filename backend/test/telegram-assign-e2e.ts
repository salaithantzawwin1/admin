/**
 * Local E2E harness for the Telegram /assign command surface.
 *
 * Drives the REAL TelegramService.handleUpdate (the poll-loop entry point) and the
 * REAL TelegramCarActionsService, with only the Telegram Bot API transport replaced
 * by a spy — so message payloads and callback payloads are exactly what Telegram
 * would receive. No DB, no HTTP.
 *
 * Run:  cd backend && node -r ts-node/register/transpile-only test/telegram-assign-e2e.ts
 */
import { TelegramService } from '../src/telegram/telegram.service';
import { TelegramCarActionsService } from '../src/cars/telegram-car-actions.service';

// ----------------------------------------------------------------- fixtures
const CHAT_OK = '1501493695'; // bound ACTIVE user with cars.assign
const CHAT_NOPERM = '555000111'; // bound ACTIVE user WITHOUT cars.assign
const CHAT_INACTIVE = '555000222'; // bound but INACTIVE user
const CHAT_STRANGER = '555000333'; // not linked at all

const VEHICLES = [
  { id: 'v1', vehicleNo: 'YC-1234', brandModel: 'Toyota Hiace', status: 'AVAILABLE' },
  { id: 'v2', vehicleNo: 'YC-5678', brandModel: 'Hilux', status: 'AVAILABLE' },
];
const DRIVERS = [
  { id: 'd1', name: 'U Kyaw', status: 'AVAILABLE' },
  { id: 'd2', name: 'U Aung', status: 'AVAILABLE' },
];

const DAY = 24 * 3600 * 1000;
const now = Date.now();
const mkCr = (dest: string, vehicleId: string | null, assignment: { releasedAt: Date | null } | null) => ({
  destination: dest,
  startDate: new Date(now + 2 * DAY),
  endDate: new Date(now + 2 * DAY + 6 * 3600 * 1000),
  pickupLocation: 'Head Office',
  vehicleId,
  assignment,
});

let docs: any[] = [];

function seedDocs() {
  docs = [
    { id: 'r1', docNumber: 'CAR-202609-0036', docType: 'CAR_REQUEST', status: 'APPROVED', title: 'Car to Testing Place', requester: { fullName: 'Salai Thant Zaw Win' }, carRequest: mkCr('Testing Place', null, null) },
    { id: 'r2', docNumber: 'CAR-202609-0037', docType: 'CAR_REQUEST', status: 'PENDING_APPROVAL', title: 'Pending trip', requester: { fullName: 'Pending Person' }, carRequest: mkCr('Pending City', null, null) },
    { id: 'r3', docNumber: 'CAR-202609-0038', docType: 'CAR_REQUEST', status: 'APPROVED', title: 'Already assigned trip', requester: { fullName: 'Assigned Person' }, carRequest: mkCr('Assigned City', 'v9', { releasedAt: null }) },
    { id: 'r4', docNumber: 'CAR-202609-0039', docType: 'CAR_REQUEST', status: 'APPROVED', title: 'No vehicles left trip', requester: { fullName: 'Unlucky Person' }, carRequest: mkCr('Far City', null, null) },
  ];
}
seedDocs();

const USERS = [
  { id: 'u1', username: 'salaithantzawwin', fullName: 'Salai Thant Zaw Win', status: 'ACTIVE', telegramChatId: CHAT_OK },
  { id: 'u2', username: 'clerk1', fullName: 'Clerk One', status: 'ACTIVE', telegramChatId: CHAT_NOPERM },
  { id: 'u3', username: 'old1', fullName: 'Old One', status: 'SUSPENDED', telegramChatId: CHAT_INACTIVE },
];

// ------------------------------------------------------------- mock services
const prisma: any = {
  user: {
    findFirst: async ({ where }: any) => USERS.find((u) => u.telegramChatId === where.telegramChatId && u.status === where.status) ?? null,
  },
  systemSetting: { findMany: async () => [] },
  requestDocument: {
    findFirst: async ({ where }: any) => docs.find((d) => d.docNumber === where.docNumber && d.docType === where.docType) ?? null,
    findUnique: async ({ where }: any) => docs.find((d) => d.id === where.id) ?? null,
    findMany: async ({ where }: any) =>
      docs.filter((d) => d.docType === 'CAR_REQUEST' && d.status === 'APPROVED' && d.carRequest?.vehicleId === null),
  },
  driverAbsence: { findMany: async () => [] }, // no planned absences in the base fixture
  carRequest: { findMany: async () => [] }, // no busy vehicles in-window
  vehicle: {
    findMany: async ({ where, take }: any) => {
      const notIn: string[] = where?.id?.notIn ?? [];
      return VEHICLES.filter((v) => !notIn.includes(v.id)).slice(0, take ?? 8);
    },
    findUnique: async ({ where }: any) => VEHICLES.find((v) => v.id === where.id) ?? null,
  },
  driver: {
    findMany: async () => DRIVERS,
    findUnique: async ({ where }: any) => DRIVERS.find((d) => d.id === where.id) ?? null,
  },
};
const auditCalls: string[] = [];
const audit: any = { log: async (p: any) => { auditCalls.push(p.action); } };
const rejectComments: Array<{ rid: string; comment: string }> = [];
const workflow: any = {
  approve: async (rid: string) => {
    const d = docs.find((x) => x.id === rid);
    if (d) d.status = 'APPROVED';
  },
  reject: async (rid: string, comment: string) => {
    if (!comment) throw new Error('A comment is required when rejecting');
    const d = docs.find((x) => x.id === rid);
    if (d && d.status !== 'PENDING_APPROVAL') throw new Error(`Cannot reject from status ${d.status}`);
    if (d) d.status = 'REJECTED';
    rejectComments.push({ rid, comment });
  },
}; // enough of WorkflowService for the approve-stamp + reject paths
const assignCalls: Array<{ requestId: string; payload: any; actor: any }> = [];
const cars: any = {
  assign: async (requestId: string, payload: any, actor: any) => {
    assignCalls.push({ requestId, payload, actor });
    if (payload.driverId === 'd2') throw new Error('Vehicle YC-1234 is already booked for this window');
    return { ok: true };
  },
};

const apiLog: Array<{ method: string; payload: any }> = [];

const telegram = new TelegramService(prisma, audit);
(telegram as any).call = async (method: string, payload?: any) => {
  apiLog.push({ method, payload });
  // sendMessage returns a message_id (as the real API does) so sendAssignment persists it
  return method === 'sendMessage' ? { message_id: 1000 + apiLog.length } : null;
};

const permissions: any = {
  forUser: async (userId: string) => (userId === 'u1' ? ['cars.assign', 'approvals.act', 'requests.read.own'] : ['requests.read.own']),
};

const tgActions = new TelegramCarActionsService(prisma, audit, workflow, cars, telegram, permissions);
tgActions.wire(); // exactly what CarsModule.onApplicationBootstrap does

// ----------------------------------------------------------------- harness
let failures = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? ' ✅' : '❌ FAIL'} ${label}`);
  if (!cond) failures++;
};
const sent = (contains: string) =>
  apiLog.filter((e) => e.method === 'sendMessage' && typeof e.payload?.text === 'string' && e.payload.text.includes(contains));
const last = (method: string) => [...apiLog].reverse().find((e) => e.method === method);
const logLen = () => apiLog.length;

const text = (t: string, chatId: number) =>
  (telegram as any).handleUpdate({ update_id: apiLog.length + 1, message: { chat: { id: chatId }, text: t, from: { id: chatId, username: 'tester', first_name: 'Tester' } } });
const tap = (data: string, callbackId: string, msgId: number, chatId: number = Number(CHAT_OK)) =>
  (telegram as any).handleUpdate({ update_id: apiLog.length + 1, callback_query: { id: callbackId, data, from: { id: chatId }, message: { chat: { id: chatId }, message_id: msgId } } });

(async () => {
  console.log('— Telegram /assign E2E (local, no network) —');

  // 1. routing: unknown command is swallowed silently
  const before = logLen();
  const handledUnknown = await (telegram as any).commands.handleText('/ping', CHAT_OK);
  check(handledUnknown === false && logLen() === before, 'unknown /ping → unhandled, bot stays silent');

  // 2. chat not linked at all
  await text('/assign', Number(CHAT_STRANGER));
  check(sent('❌ Your Telegram is not linked to an AMS account.').length > 0, 'unlinked chat → "not linked" error');

  // 3. bound but INACTIVE user counts as not authorized
  await text('/assign', Number(CHAT_INACTIVE));
  check(sent('❌ Your Telegram is not linked').length >= 2, 'INACTIVE bound user → treated as not linked');

  // 4. bound user without cars.assign
  await text('/assign', Number(CHAT_NOPERM));
  check(sent('⛔ You need the car-assignment permission').length > 0, 'user without cars.assign → permission denied');

  // 5. bare /assign → queue of approved-unassigned docs
  await text('/assign', Number(CHAT_OK));
  const queueMsg = sent('Approved — waiting for vehicle').pop(); // inside <b> tags
  check(!!queueMsg, 'bare /assign → queue message sent');
  check(!!queueMsg && queueMsg.payload.text.includes('CAR-202609-0036') && queueMsg.payload.text.includes('CAR-202609-0039'), 'queue lists both approved-unassigned docs');
  check(!!queueMsg && queueMsg.payload.text.includes('(2)'), 'queue count = 2 (pending + assigned docs excluded)');

  // 6. not found
  await text('/assign CAR-202609-9999', Number(CHAT_OK));
  check(sent('❌ Car request CAR-202609-9999 not found.').length > 0, 'unknown doc number → not found error');

  // 7. wrong status: pending approval
  await text('/assign CAR-202609-0037', Number(CHAT_OK));
  check(sent('⚠️ CAR-202609-0037 is PENDING_APPROVAL — only APPROVED requests can be assigned.').length > 0, 'PENDING_APPROVAL doc → rejected with status');

  // 8. active assignment
  await text('/assign CAR-202609-0038', Number(CHAT_OK));
  check(sent('ℹ️ CAR-202609-0038 already has an active assignment').length > 0, 'actively assigned doc → politely refused');

  // 9. happy path: picker message with vehicle buttons + context
  await text('/assign CAR-202609-0036', Number(CHAT_OK));
  const picker = sent('Assign a vehicle — CAR-202609-0036').pop(); // inside <b> tags
  check(!!picker, 'approved-unassigned doc → picker message sent');
  const kb = picker?.payload?.reply_markup?.inline_keyboard ?? [];
  check(kb.length === 2, 'picker offers 2 available vehicles as inline buttons');
  check(kb[0]?.[0]?.text === 'YC-1234 — Toyota Hiace', 'button label = "YC-1234 — Toyota Hiace"');
  const vehicleCb = String(kb[0]?.[0]?.callback_data ?? '');
  check(vehicleCb.startsWith('wfa:pv:'), 'vehicle button uses short token callback (wfa:pv:…)');
  check(Buffer.byteLength(kb[0]?.[0]?.callback_data ?? '', 'utf8') <= 64, 'callback_data fits Telegram\'s 64-byte limit');
  check(!!picker?.payload?.text.includes('👤 Salai Thant Zaw Win'), 'picker shows requester');
  check(!!picker?.payload?.text.includes('🗺 Testing Place'), 'picker shows destination');
  check(!!picker?.payload?.text.includes('📅'), 'picker shows the time window');

  // 10. /assign@BotName suffix is stripped
  await text('/assign@AmsBot CAR-202609-0036', Number(CHAT_OK));
  check(sent('Assign a vehicle — CAR-202609-0036').length >= 2, '/assign@AmsBot … → bot suffix stripped, picker re-offered');

  // 11. zero vehicles available for the window
  (prisma.vehicle as any).findMany = async () => [];
  await text('/assign CAR-202609-0039', Number(CHAT_OK));
  check(sent('⚠️ No AVAILABLE vehicles').length > 0, 'no available vehicles → explanatory message (not a dead message)');
  check(sent('/assign CAR-202609-0039').length > 0, 'zero-vehicle message tells the admin how to retry');
  (prisma.vehicle as any).findMany = async ({ where, take }: any) => {
    const notIn: string[] = where?.id?.notIn ?? [];
    return VEHICLES.filter((v) => !notIn.includes(v.id)).slice(0, take ?? 8);
  };

  // 11b. STAGED APPROVE UX: [✅ Approve] paints the stamp + [🚗 Assign Car] — NO auto-picker
  const approveBefore = logLen();
  await tap('wfa:approve:r1', 'cb-approve', 90);
  const stampMsg = last('editMessageText');
  check(!!stampMsg && stampMsg.payload.text.includes('✅ Approved — CAR-202609-0036'), 'approve tap → message painted with ✅ Approved stamp');
  const skb = stampMsg?.payload?.reply_markup?.inline_keyboard ?? [];
  const avBtn: any = skb.flat().find((b: any) => b?.text === '🚗 Assign Car');
  check(!!avBtn, 'approved stamp carries a persistent [🚗 Assign Car] button');
  check(String(avBtn?.callback_data ?? '').startsWith('wfa:av:') && Buffer.byteLength(avBtn?.callback_data ?? '', 'utf8') <= 64, 'Assign Car callback is a short token within the 64-byte limit');
  check(!!skb.flat().find((b: any) => b?.text === '👁 Open in AMS'), 'Open in AMS button still present under the stamp');
  check(logLen() === approveBefore + 2, 'approve does NOT auto-send the picker (staged UX — assign on demand)');
  const approveToast = last('answerCallbackQuery');
  check(!!approveToast && approveToast.payload.text.includes('Approved'), 'approve tap acknowledged with a toast');

  // 11c. [🚗 Assign Car] re-offers the picker on demand (recoverable at any time)
  const avBefore = logLen();
  await tap(avBtn.callback_data, 'cb-av', 91);
  const rePicker = sent('Assign a vehicle — CAR-202609-0036').pop();
  check(logLen() > avBefore && !!rePicker, '[Assign Car] tap → vehicle picker re-offered');
  const reKb = rePicker?.payload?.reply_markup?.inline_keyboard ?? [];
  check(reKb.length === 2 && String(reKb[0]?.[0]?.callback_data ?? '').startsWith('wfa:pv:'), 're-offered picker carries fresh vehicle tokens');

  // 11d. expired Assign-Car token → polite answer
  await tap('wfa:av:deadbeef00', 'cb-av-expired', 92);
  check(!!last('answerCallbackQuery') && last('answerCallbackQuery')!.payload.text.includes('expired'), 'expired Assign-Car token → "expired" answer');

  // 11e. Assign-Car on an already-assigned doc → info, not a second picker
  await (tgActions as any).offerAssignVehicle('r3', CHAT_OK);
  check(sent('already has an active assignment').length > 0, 'Assign-Car on actively-assigned doc → "already assigned" info (no duplicate picker)');

  // 12. FULL action flow through the real poll-loop handler (callbacks with REAL button payloads)
  const driverPickerBefore = logLen();
  await tap(vehicleCb, 'cb-pickv-1', 100); // tap the exact callback_data Telegram would deliver
  const driverMsg = sent('Pick a driver — CAR-202609-0036').pop(); // inside <b> tags
  check(logLen() > driverPickerBefore && !!driverMsg, 'tapping a vehicle → driver picker message');
  const dkb = driverMsg?.payload?.reply_markup?.inline_keyboard ?? [];
  const driverCb = String(dkb.find((row: any[]) => row[0]?.text === 'U Kyaw')?.[0]?.callback_data ?? '');
  check(driverCb.startsWith('wfa:pd:'), 'driver buttons use short token callback (wfa:pd:…)');
  check(Buffer.byteLength(driverCb, 'utf8') <= 64, 'driver callback_data fits the 64-byte limit');
  check(dkb.some((row: any[]) => row[0]?.text === 'No driver (car only)'), '"No driver (car only)" option present');
  const toast = last('answerCallbackQuery');
  check(!!toast && toast.payload.text === 'Now pick a driver', 'vehicle tap acknowledged with a toast');

  // 12b. tampered / expired token → polite answer, nothing crashes
  await tap('wfa:pv:deadbeef00', 'cb-expired', 199);
  const expiredToast = last('answerCallbackQuery');
  check(!!expiredToast && expiredToast.payload.text.includes('expired'), 'unknown/expired token → "expired" answer, no crash');

  // 13. driver chosen → real cars.assign called with the bound actor
  await tap(driverCb, 'cb-pickd-1', 101);
  check(assignCalls.length === 1 && assignCalls[0].requestId === 'r1', 'driver tap → cars.assign() executed');
  check(assignCalls[0]?.payload?.vehicleId === 'v1' && assignCalls[0]?.payload?.driverId === 'd1', 'cars.assign receives chosen vehicle+driver');
  check(assignCalls[0]?.actor?.username === 'salaithantzawwin', 'assignment executed AS the bound AMS user');
  const done = last('editMessageText');
  check(!!done && done.payload.text.includes('✅ Assigned — CAR-202609-0036'), 'picker message repainted with ✅ Assigned');
  check(!!done && done.payload.message_id === 101, 'repaint targets the tapped message');
  check(!!last('answerCallbackQuery') && last('answerCallbackQuery')!.payload.text === 'Assigned — driver notified', 'success toast sent');

  // 13b. token is one-shot: second tap on the same driver button must NOT double-assign
  await tap(driverCb, 'cb-pickd-replay', 103);
  check(assignCalls.length === 1, 'replayed driver token → no second assign (one-shot)');
  const replayToast = last('answerCallbackQuery');
  check(!!replayToast && replayToast.payload.text.includes('expired'), 'replayed token answers "expired"');

  // 14. assign failure (overlap) → error painted, nothing crashes
  await text('/assign CAR-202609-0036', Number(CHAT_OK));
  const picker2 = sent('Assign a vehicle — CAR-202609-0036').pop();
  const v2cb = String(picker2?.payload?.reply_markup?.inline_keyboard.find((row: any[]) => row[0]?.text === 'YC-5678 — Hilux')?.[0]?.callback_data ?? '');
  await tap(v2cb, 'cb-pickv-2', 104);
  const driverMsg2 = sent('Pick a driver — CAR-202609-0036').pop();
  const d2cb = String(driverMsg2?.payload?.reply_markup?.inline_keyboard.find((row: any[]) => row[0]?.text === 'U Aung')?.[0]?.callback_data ?? '');
  await tap(d2cb, 'cb-pickd-2', 102);
  const failed = last('editMessageText');
  check(assignCalls.length === 2, 'second driver tap reaches cars.assign');
  check(!!failed && failed.payload.text.includes('⚠️ Vehicle YC-1234 is already booked'), 'assign error surfaces on the message');

  // ---------------------------------------------------------- driver stage mirrors
  // Mock the pieces notifyStage touches: notifications, ADMINISTRATION roster,
  // assigner/mirror user lookups, and the assignment row + stage update.
  const ADMIN_CHAT = '555000999';
  prisma.notification = { createMany: async () => undefined, create: async () => undefined } as any;
  (prisma as any).userRole = { findMany: async () => [{ userId: 'u9' }] }; // Administration roster (assigner u1 NOT in it)
  (prisma.user as any).findUnique = async ({ where }: any) => {
    if (where.id === 'u1') return { telegramChatId: CHAT_OK };
    if (where.id === 'u9') return { telegramChatId: ADMIN_CHAT };
    if (where.id === 'rq') return { telegramChatId: '555000888' }; // the requester
    return null;
  };
  const mkAssignment = (id: string) => ({
    id, vehicleId: 'v1', driverId: 'd1', assignedById: 'u1', // assigned via Telegram by u1
    driverNotedAt: null, driverArrivedAt: null, driverBackAtOfficeAt: null, telegramMessageId: '555',
  });
  (prisma as any).carAssignment = {
    findUnique: async ({ where }: any) => mkAssignment(where.id),
    update: async ({ data }: any) => ({
      ...mkAssignment('a1'), ...data,
      driver: { id: 'd1', name: 'U Kyaw', telegramChatId: null },
      vehicle: { id: 'v1', vehicleNo: 'YC-1234', brandModel: 'Toyota Hiace' },
      carRequest: { destination: 'Testing Place', pickupLocation: 'Head Office', startDate: new Date(), endDate: new Date(), timeSlot: 'AM', purpose: null },
      request: { id: 'r1', docNumber: 'CAR-202609-0036', requesterId: 'rq', requester: { fullName: 'Salai Thant Zaw Win', employee: null } },
    }),
  };
  (prisma.vehicle as any).update = async () => undefined; // freeVehicle
  (prisma.driver as any).update = async () => undefined;

  // 15. each driver stage mirrors into the ASSIGNER's chat (and Administration keeps getting theirs)
  await (telegram as any).manualAck('a1', 'noted', { userId: 'u9', username: 'admin1' });
  const notedMirrors = sent('✓ U Kyaw noted CAR-202609-0036');
  check(notedMirrors.length === 2, 'Noted stage mirrors to exactly 2 chats (assigner + Administration)');
  check(notedMirrors.some((m) => m.payload.chat_id === CHAT_OK), 'assigner chat receives the Noted mirror');
  check(notedMirrors.some((m) => m.payload.chat_id === ADMIN_CHAT), 'Administration chat still receives the Noted mirror');
  const reqNoted = sent('✓ Driver noted — CAR-202609-0036');
  check(reqNoted.length === 1 && reqNoted[0].payload.chat_id === '555000888', 'Noted → requester (only) gets the driver+vehicle acknowledgement');
  check(String(reqNoted[0]?.payload?.text ?? '').includes('U Kyaw'), 'requester Noted message names the driver');

  await (telegram as any).manualAck('a1', 'arrived', { userId: 'u9', username: 'admin1' });
  const readyMirrors = sent('🚦 U Kyaw ready — CAR-202609-0036');
  check(readyMirrors.some((m) => m.payload.chat_id === CHAT_OK), 'Ready stage mirrors to the assigner chat');
  check(sent('🚗 Car is ready — CAR-202609-0036').length === 1, 'requester still receives the car-ready message');

  await (telegram as any).manualAck('a1', 'returned', { userId: 'u9', username: 'admin1' });
  check(sent('🏁 Car available — CAR-202609-0036').some((m) => m.payload.chat_id === CHAT_OK), 'Back-at-office mirrors to the assigner chat');

  // 15b. assigner who IS Administration must get exactly ONE mirror (deduped)
  const beforeDedup = sent('✓ U Kyaw noted CAR-202609-0036').length;
  (prisma.userRole as any).findMany = async () => [{ userId: 'u1' }]; // assigner is in the Administration roster now
  await (telegram as any).manualAck('a2', 'noted', { userId: 'u9', username: 'admin1' });
  const dedupDelta = sent('✓ U Kyaw noted CAR-202609-0036').length - beforeDedup;
  check(dedupDelta === 1, 'assigner who is also Administration receives exactly ONE mirror (no duplicate)');
  (prisma.userRole as any).findMany = async () => [{ userId: 'u9' }];

  // ---------------------------------------------------------- reject flow (❌ button + reason conversation)
  // approver roster for offerApprovalButtons: our bound admin chat
  (prisma.userRole as any).findMany = async () => [{ user: { telegramChatId: CHAT_OK } }];
  apiLog.length = 0;

  // 20. the approval mirror now carries a Reject button
  await (tgActions as any).offerApprovalButtons('r2'); // r2 = CAR-202609-0037, still PENDING
  const mirror2 = sent('New car request — CAR-202609-0037').pop();
  const rejBtn: any = mirror2?.payload?.reply_markup?.inline_keyboard?.flat().find((b: any) => b?.text === '❌ Reject');
  check(!!rejBtn && rejBtn.callback_data === 'wfa:rej:r2', 'approval mirror offers [❌ Reject] beside [✅ Approve]');
  check(Buffer.byteLength(rejBtn?.callback_data ?? '', 'utf8') <= 64, 'Reject callback fits the 64-byte limit');

  // 21. tapping Reject arms the conversation and asks for a reason
  await tap('wfa:rej:r2', 'cb-rej-1', 70);
  const askMsg = sent('— please type the reason').pop();
  check(!!askMsg && String(askMsg.payload.text).includes('CAR-202609-0037') && String(askMsg.payload.text).includes('/cancel'), 'Reject tap → bot asks for a reason (with /cancel hint)');
  const rejToast = last('answerCallbackQuery');
  check(!!rejToast && rejToast.payload.text.includes('reason'), 'Reject tap acknowledged with a toast');
  check((telegram as any).rejects.hasPending(CHAT_OK), 'conversation armed — next text becomes the reason');

  // 21b. wrong status is refused (r1 already APPROVED by test 11b)
  await tap('wfa:rej:r1', 'cb-rej-done', 71);
  const doneToast = last('answerCallbackQuery');
  check(!!doneToast && doneToast.payload.text.includes('nothing to reject'), 'Reject on non-pending doc → refused, no conversation armed');
  check(!(telegram as any).rejects.hasPending(CHAT_OK) === false, 'original r2 conversation still armed (untouched)');

  // 22. /cancel aborts without touching the request
  await text('/cancel', Number(CHAT_OK));
  check(sent('Rejection of CAR-202609-0037 cancelled').length === 1, '/cancel aborts the reject conversation politely');
  check(!(telegram as any).rejects.hasPending(CHAT_OK), 'conversation state cleared after /cancel');
  check(docs.find((d) => d.id === 'r2')!.status === 'PENDING_APPROVAL', '/cancel leaves the request PENDING');

  // 23. real reject: re-arm → the next text IS the reason → workflow.reject runs
  await tap('wfa:rej:r2', 'cb-rej-2', 72);
  await text('Vehicle unavailable for that date', Number(CHAT_OK));
  check(rejectComments.some((c) => c.rid === 'r2' && c.comment === 'Vehicle unavailable for that date'), 'reason text → workflow.reject() called with the typed comment');
  check(docs.find((d) => d.id === 'r2')!.status === 'REJECTED', 'request transitions to REJECTED');
  const stamp2 = last('editMessageText');
  check(!!stamp2 && stamp2.payload.message_id === 72 && String(stamp2.payload.text).includes('❌ Rejected — CAR-202609-0037'), 'original mirror repaints with the ❌ outcome stamp');
  check(String(stamp2?.payload?.text ?? '').includes('Vehicle unavailable'), 'outcome stamp shows the reason');
  check(String(stamp2?.payload?.text ?? '').includes('by salaithantzawwin'), 'outcome stamp names the rejecting admin');
  check(!(telegram as any).rejects.hasPending(CHAT_OK), 'conversation consumed after successful reject');

  // 23b. rejection failure → reason surfaced, state cleared, request unchanged
  await tap('wfa:rej:r2', 'cb-rej-3', 73); // r2 now REJECTED → arming refused
  await tap('wfa:rej:r3', 'cb-rej-4', 74); // arm against r3… but r3 is APPROVED → refused
  const failToast = last('answerCallbackQuery');
  check(!!failToast && failToast.payload.text.includes('nothing to reject'), 'arming against already-final docs refused');

  // 23c. defense-in-depth: an UNBOUND chat must never inject a rejection (even if state leaked to it)
  (tgActions as any).pendingRejects.set(CHAT_STRANGER, { requestId: 'r2', docNumber: 'CAR-202609-0037', at: Date.now() });
  await text('sneaky reason', Number(CHAT_STRANGER));
  check(sent('❌ Your Telegram is not linked to an AMS account.').some((m) => m.payload.chat_id === CHAT_STRANGER), 'reason from unbound chat → not-linked error, nothing rejected');
  check(rejectComments.every((c) => c.comment !== 'sneaky reason'), 'unbound chat cannot inject a rejection');

  // ---------------------------------------------------------- post-assign message matrix
  // Drive the REAL sendAssignment → REAL driver-side handleCallback through all three
  // stages, asserting every chat's expected traffic end-to-end.
  const REQUESTER_CHAT = '555000888';
  const DRIVER_CHAT = '555000777'; // Telegram-bound driver
  // bot configured so sendAssignment/editStageMessage proceed past their config gate
  (prisma.systemSetting as any).findMany = async () => [
    { key: 'telegram.bot_token', value: 'TEST-TOKEN' },
    { key: 'telegram.enabled', value: 'true' },
  ];
  const fullAssignment = (id: string, driver = { id: 'd1', name: 'U Kyaw', telegramChatId: DRIVER_CHAT }) => ({
    id, vehicleId: 'v1', driverId: driver.id, assignedById: 'u1',
    driverNotedAt: null, driverArrivedAt: null, driverBackAtOfficeAt: null, telegramMessageId: '555',
    driver,
    vehicle: { id: 'v1', vehicleNo: 'YC-1234', brandModel: 'Toyota Hiace' },
    carRequest: { destination: 'Testing Place', pickupLocation: 'Head Office', startDate: new Date(), endDate: new Date(), timeSlot: 'AM', purpose: null },
    request: { id: 'r1', docNumber: 'CAR-202609-0036', requesterId: 'rq', requester: { fullName: 'Salai Thant Zaw Win', employee: { phone: '0977000111' } } },
  });
  (prisma as any).carAssignment = {
    findUnique: async ({ where }: any) =>
      where.id === 'a4'
        ? fullAssignment('a4', { id: 'd9', name: 'Bound Driver', telegramChatId: DRIVER_CHAT })
        : fullAssignment(where.id),
    update: async ({ data }: any) => ({ ...fullAssignment('a4', { id: 'd9', name: 'Bound Driver', telegramChatId: DRIVER_CHAT }), ...data }),
  };
  const assignedMsgCount = () => sent('Car Assigned — CAR-202609-0036').length;
  apiLog.length = 0; // isolate the matrix
  (prisma.userRole as any).findMany = async () => [{ userId: 'u9' }]; // pin roster shape (userId) for notifyStage

  // 16. assignment → driver receives the FULL route card (real sendAssignment)
  await (telegram as any).sendAssignment('a3');
  const driverCard = sent('Car Assigned — CAR-202609-0036').pop();
  check(!!driverCard && driverCard.payload.chat_id === DRIVER_CHAT, 'assigned → driver card with route details (driver chat)');
  check(!!driverCard && String(driverCard.payload.text).includes('📍 Pickup: Head Office'), 'driver card carries pickup, destination');
  check(!!driverCard && String(driverCard.payload.text).includes('👤 Requester: Salai Thant Zaw Win'), 'driver card carries requester + vehicle info');
  check(!!driverCard && String(driverCard.payload.text).includes('Open in Maps'), 'driver card carries a Maps link');
  const dkb2 = driverCard?.payload?.reply_markup?.inline_keyboard?.[0] ?? [];
  check(dkb2.length === 3 && dkb2.every((b: any) => !String(b.text).startsWith('✅')), 'driver card shows all 3 stage buttons (none done yet)');
  check(assignedMsgCount() === 1, 'exactly ONE assignment card was sent overall (requester/admin chats get none of it)');

  // 17. driver taps Noted → stage machine + mirrors (assigner + Administration)
  await tap('noted:a4', 'cb-noted', 555, Number(DRIVER_CHAT));
  check(auditCalls.includes('DRIVER_NOTED'), 'driver Noted tap → DRIVER_NOTED audit entry');
  check(sent('✓ Bound Driver noted CAR-202609-0036').length === 2, 'Noted mirrors = 2 (assigner + Administration chats)');
  check(sent('✓ Bound Driver noted CAR-202609-0036').every((m) => [CHAT_OK, ADMIN_CHAT].includes(m.payload.chat_id)), 'Noted mirrors go to assigner + Administration only');
  const notedToast = last('answerCallbackQuery');
  check(!!notedToast && notedToast.payload.text.includes('Administration notified'), 'Noted tap acknowledged to the DRIVER with a toast');
  check(!!last('editMessageText') && last('editMessageText')!.payload.message_id === 555, 'driver card repaints with stage progress (same message)');

  // 18. driver taps Ready → requester rich message + mirrors
  await tap('arrived:a4', 'cb-arrived', 555, Number(DRIVER_CHAT));
  check(auditCalls.includes('DRIVER_ARRIVED'), 'driver Ready tap → DRIVER_ARRIVED audit entry');
  const reqReady = sent('🚗 Car is ready — CAR-202609-0036');
  check(reqReady.length === 1 && reqReady[0].payload.chat_id === REQUESTER_CHAT, 'Ready → REQUESTER (only) gets the rich car-ready message');
  check(String(reqReady[0]?.payload?.text ?? '').includes('is ready. Pickup: Head Office'), 'requester message names the driver + vehicle + route');
  check(sent('🚦 Bound Driver ready — CAR-202609-0036').length === 2, 'Ready mirrors = 2 (assigner + Administration)');

  // 19. driver taps Back → vehicle freed + mirrors
  await tap('returned:a4', 'cb-back', 555, Number(DRIVER_CHAT));
  check(auditCalls.includes('DRIVER_RETURNED'), 'driver Back tap → DRIVER_RETURNED audit entry');
  const backMirrors = sent('🏁 Car available — CAR-202609-0036');
  check(backMirrors.length === 2 && backMirrors.every((m) => [CHAT_OK, ADMIN_CHAT].includes(m.payload.chat_id)), 'Back mirrors = 2 (assigner + Administration)');
  check(sent('Car is ready').length === 1, 'requester receives NO Back-at-office message');
  check(assignedMsgCount() === 1, 'requester/admin chats never receive the driver assignment card');

  console.log(failures === 0 ? '\nALL CHECKS PASSED ✅' : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
