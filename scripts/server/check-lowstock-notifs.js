/** LOW_STOCK notification history (read-only) — explains why alerts are quiet. */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const p = new PrismaService();
  const total = await p.notification.count({ where: { type: 'LOW_STOCK' } });
  const last14 = await p.notification.count({ where: { type: 'LOW_STOCK', createdAt: { gte: new Date(Date.now() - 14 * 864e5) } } });
  const newest = await p.notification.findFirst({ where: { type: 'LOW_STOCK' }, orderBy: { createdAt: 'desc' }, select: { title: true, createdAt: true } });
  console.log(`LOW_STOCK notifs total: ${total} | last 14d: ${last14} | newest: ${newest ? `${newest.title} @ ${newest.createdAt.toISOString()}` : 'none'}`);
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
