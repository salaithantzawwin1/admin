/** Live e2e on the testing stack: DELETE /settings/telegram/joins/:id */
const BASE = 'http://127.0.0.1:3000/api';
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const login = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }) })).json();
  if (!login.accessToken) throw new Error('login failed');
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` };
  const prisma = new PrismaService();

  // 1) seed a fake PENDING join (like a /start from an unknown Telegram user)
  const chatId = '999777' + String(Date.now()).slice(-6);
  const seeded = await prisma.telegramJoinRequest.create({ data: { chatId, tgUsername: 'e2e_delete', displayName: 'E2E Delete' } });

  // 2) visible in the PENDING list
  const list1 = await (await fetch(BASE + '/settings/telegram/joins?status=PENDING', { headers: H })).json();
  if (!list1.some((j) => j.id === seeded.id)) throw new Error('seeded join not in PENDING list');

  // 3) DELETE it
  const del = await fetch(BASE + `/settings/telegram/joins/${seeded.id}`, { method: 'DELETE', headers: H });
  if (del.status !== 200 && del.status !== 201) throw new Error('delete failed ' + del.status + ' ' + (await del.text()).slice(0, 150));
  const delBody = await del.json();
  if (!delBody.ok) throw new Error('delete did not return ok');

  // 4) gone from every list
  const list2 = await (await fetch(BASE + '/settings/telegram/joins?status=ALL', { headers: H })).json();
  if (list2.some((j) => j.id === seeded.id)) throw new Error('deleted join still listed');

  // 5) audit row written with the chat id
  const audit = await prisma.auditLog.findFirst({ where: { action: 'TELEGRAM_JOIN_DELETED', recordId: seeded.id } });
  if (!audit || audit.oldValue?.chatId !== chatId) throw new Error('TELEGRAM_JOIN_DELETED audit row missing or wrong');

  // 6) guard: an APPROVED join cannot be deleted
  const approved = await prisma.telegramJoinRequest.create({ data: { chatId: chatId + 'b', displayName: 'E2E Approved', status: 'APPROVED' } });
  const del2 = await fetch(BASE + `/settings/telegram/joins/${approved.id}`, { method: 'DELETE', headers: H });
  const del2text = await del2.text();
  if (del2.status < 400 || !/unbind/i.test(del2text)) throw new Error('APPROVED delete was not refused: ' + del2.status + ' ' + del2text.slice(0, 120));

  // 7) guard: unknown id
  const del3 = await fetch(BASE + `/settings/telegram/joins/00000000-0000-4000-8000-000000000000`, { method: 'DELETE', headers: H });
  if (del3.status < 400 || !/not found/i.test(await del3.text())) throw new Error('unknown id was not refused');

  // cleanup both rows
  await prisma.telegramJoinRequest.deleteMany({ where: { chatId: { in: [chatId, chatId + 'b'] } } });
  await prisma.$disconnect();
  console.log('PASS — pending join deleted via API, audit row written, APPROVED + unknown-id guards refuse');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
