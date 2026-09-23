// Run inside ams-backend-1: node /tmp/check-mirror.js
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const doc = await p.requestDocument.findFirst({
    where: { docType: 'CAR_REQUEST' },
    orderBy: { createdAt: 'desc' },
    select: { docNumber: true, status: true, createdAt: true, id: true },
  });
  console.log('latest car doc:', JSON.stringify(doc));

  const notifs = await p.notification.findMany({
    where: { user: { username: 'admin1' } },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { type: true, title: true, createdAt: true },
  });
  console.log('admin1 latest notifications:');
  notifs.forEach((n) => console.log(` - ${n.type} | ${n.title} | ${n.createdAt.toISOString()}`));

  const admin = await p.user.findUnique({ where: { username: 'admin1' }, select: { telegramChatId: true, telegramUsername: true } });
  console.log('admin1 telegram:', JSON.stringify(admin));
  await p.$disconnect();
})();
