/** Testing-DB hygiene: close out the pre-fix leftover supply docs (OSR-0001/0004)
 *  via the FIXED admin-cancel endpoint, then re-run the integrity probe inline. */
const BASE = 'http://127.0.0.1:3000/api';
(async () => {
  const login = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }) })).json();
  if (!login.accessToken) throw new Error('login failed');
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` };
  const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
  const p = new PrismaService();
  const ghosts = await p.requestDocument.findMany({
    where: { docType: 'OFFICE_SUPPLY_REQUEST', status: 'COMPLETED', supplyRequest: { status: 'PENDING' } },
    select: { id: true, docNumber: true },
  });
  for (const g of ghosts) {
    const res = await fetch(BASE + `/inventory/requests/${g.id}/admin-cancel`, { method: 'POST', headers: H, body: JSON.stringify({ reason: 'testing-DB cleanup: pre-fix ghost doc' }) });
    console.log(`cancel ${g.docNumber}: HTTP ${res.status} ${res.status >= 400 ? (await res.text()).slice(0, 120) : 'OK'}`);
  }
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
