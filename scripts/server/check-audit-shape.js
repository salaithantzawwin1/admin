const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rows = await p.auditLog.findMany({ where: { action: { startsWith: 'REQUESTS_' } }, orderBy: { createdAt: 'desc' }, take: 5 });
  console.log('recent REQUESTS_* rows:', JSON.stringify(rows.map(r => ({ action: r.action, at: r.createdAt }))));
  // replicate the service's audit.log shape to see whether the insert works standalone
  const probe = await p.auditLog.create({ data: { action: 'REQUESTS_AUTO_ARCHIVED', module: 'WORKFLOW', newValue: { count: 1, olderThanDays: 30, probe: true } } });
  console.log('direct insert ok:', probe.id);
  const found = await p.auditLog.findMany({ where: { action: 'REQUESTS_AUTO_ARCHIVED' } });
  console.log('now count:', found.length);
  await p.auditLog.delete({ where: { id: probe.id } });
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
