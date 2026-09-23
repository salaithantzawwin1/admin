const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const doc = await p.requestDocument.findUnique({ where: { docNumber: 'CAR-202609-0026' } });
  console.log('0026:', JSON.stringify({ status: doc.status, archivedAt: doc.archivedAt, updatedAt: doc.updatedAt }));
  const cancelled = await p.requestDocument.findMany({ where: { status: 'CANCELLED' }, select: { docNumber: true, archivedAt: true, updatedAt: true } });
  console.log('cancelled docs:', JSON.stringify(cancelled));
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
