// Check at runtime (inside the Nest app) whether the hook got wired.
// NOTE: cannot reach into the running Nest instance from a separate node process —
// instead check via a real submit + logs. This script only verifies DB preconditions.
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const admins = await p.userRole.findMany({
    where: { role: { name: 'ADMINISTRATION' }, user: { status: 'ACTIVE', telegramChatId: { not: null } } },
    select: { user: { select: { username: true, telegramChatId: true } } },
  });
  console.log('bound ADMINISTRATION users right now:', JSON.stringify(admins));
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
