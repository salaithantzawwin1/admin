const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const docs = await p.requestDocument.findMany({
    where: { docType: 'PURCHASE_REQUEST' },
    select: {
      id: true, docNumber: true, status: true, title: true, createdAt: true,
      purchaseRequest: { select: { id: true, items: { select: { id: true } } } },
    },
  });
  for (const d of docs) {
    const pr = d.purchaseRequest;
    console.log(`${d.docNumber} — ${d.status} — created ${d.createdAt.toISOString().slice(0, 10)}`);
    console.log(`   purchaseRequest: ${pr ? 'exists (id ' + pr.id + '), items: ' + pr.items.length : 'MISSING — orphan doc'}`);
  }
  await p.$disconnect();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
