const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rows = await p.systemSetting.findMany({ where: { key: { in: ['telegram.bot_token', 'telegram.enabled'] } } });
  console.log('settings:', JSON.stringify(rows.map(r => [r.key, r.value])));
  const a = await p.carAssignment.findUnique({
    where: { id: 'cab5b485-093b-4dda-bece-ca161037e07d' },
    include: { driver: true, carRequest: true },
  });
  console.log('carRequestId:', a.carRequestId);
  console.log('driver chat:', a.driver && a.driver.telegramChatId);
  console.log('has carRequest:', !!a.carRequest);
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
