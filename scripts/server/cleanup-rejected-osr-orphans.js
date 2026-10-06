/** Testing-only: close the orphaned supply rows of a REJECTED OSR doc (data hygiene). */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const p = new PrismaService();
  const docs = await p.requestDocument.findMany({
    where: { docType: 'OFFICE_SUPPLY_REQUEST', status: 'REJECTED', supplyRequest: { status: { not: 'REJECTED' } } },
    select: { id: true, docNumber: true, supplyRequest: { select: { id: true } } },
  });
  for (const d of docs) {
    const r = await p.supplyRequestLine.updateMany({ where: { supplyRequestId: d.supplyRequest.id, status: { in: ['PENDING', 'OUT_OF_STOCK'] } }, data: { status: 'REJECTED' } });
    await p.officeSupplyRequest.update({ where: { requestId: d.id }, data: { status: 'REJECTED' } });
    console.log(`${d.docNumber}: ${r.count} line(s) -> REJECTED, supply header -> REJECTED`);
  }
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
