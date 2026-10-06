/** Debug: inspect the newest OFFICE_SUPPLY_REQUEST docs + the pending-queue query result. */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const p = new PrismaService();
  const docs = await p.requestDocument.findMany({
    where: { docType: 'OFFICE_SUPPLY_REQUEST' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, docNumber: true, status: true, title: true, submittedAt: true, supplyRequest: { select: { id: true, status: true } } },
  });
  console.log(JSON.stringify(docs, null, 1));
  const q = await p.requestDocument.findMany({
    where: { docType: 'OFFICE_SUPPLY_REQUEST', status: 'APPROVED', supplyRequest: { status: 'PENDING' } },
    select: { docNumber: true, status: true },
  });
  console.log('pending-queue result:', q.map((d) => d.docNumber).join(', ') || '(empty)');
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
