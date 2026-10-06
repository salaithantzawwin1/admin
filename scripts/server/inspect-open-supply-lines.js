/** Which open supply line references an inactive item? */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const p = new PrismaService();
  const rows = await p.supplyRequestLine.findMany({
    where: { item: { isActive: false }, status: { in: ['PENDING', 'OUT_OF_STOCK'] }, supplyRequest: { status: { not: 'REJECTED' } } },
    select: { id: true, status: true, quantity: true, item: { select: { code: true } }, supplyRequest: { select: { requestId: true, note: true, request: { select: { docNumber: true, status: true, submittedAt: true } } } } },
  });
  console.log(JSON.stringify(rows, null, 1));
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
