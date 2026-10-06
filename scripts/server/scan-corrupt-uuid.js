/** Bisect approvalActions relation: each scalar field of approval_actions, one at a time. */
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
(async () => {
  const p = new PrismaService();
  const fields = ['id', 'requestId', 'level', 'approverId', 'action', 'comment', 'previousStatus', 'newStatus', 'createdAt'];
  for (const f of fields) {
    try {
      await p.requestDocument.findUnique({ where: { id: 'cec3502b-94b0-414d-b9af-2b576abfdb16' }, select: { approvalActions: { select: { [f]: true } } } });
      console.log('ok  ', f);
    } catch (e) { console.log('FAIL', f, '→ corrupt column in approval_actions hydration'); }
  }
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
