const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rows = await p.auditLog.findMany({ where: { action: 'REQUESTS_AUTO_ARCHIVED' }, orderBy: { createdAt: 'desc' }, take: 2 });
  console.log(JSON.stringify(rows.map(r => ({ action: r.action, newValue: r.newValue, at: r.createdAt }))));
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
