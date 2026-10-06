/** Read-only: list Telegram join request rows (prod-safe inspection). */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const p = new PrismaService();
  const rows = await p.telegramJoinRequest.findMany({ select: { id: true, chatId: true, status: true, displayName: true, tgUsername: true, createdAt: true } });
  console.log(JSON.stringify(rows, null, 1));
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
