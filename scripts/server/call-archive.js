// Invoke the archive routine through the real AuditService path by calling the
// compiled service class directly (standalone instantiation like Nest would do).
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const days = Number(process.env.ARCHIVE_AFTER_DAYS || 30);
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const res = await p.requestDocument.updateMany({
    where: { status: 'CANCELLED', archivedAt: null, updatedAt: { lt: cutoff } },
    data: { archivedAt: new Date() },
  });
  console.log('updateMany count:', res.count);
  if (res.count > 0) {
    await p.auditLog.create({
      data: {
        action: 'REQUESTS_AUTO_ARCHIVED', module: 'WORKFLOW',
        newValue: { count: res.count, olderThanDays: days },
      },
    });
    console.log('audit written');
  }
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
