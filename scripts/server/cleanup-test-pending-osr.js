/** Testing-DB hygiene: reject the leftover PENDING_APPROVAL OSR docs (e2e strays). */
const BASE = 'http://127.0.0.1:3000/api';
(async () => {
  const login = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }) })).json();
  if (!login.accessToken) throw new Error('login failed');
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` };
  const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
  const p = new PrismaService();
  const strays = await p.requestDocument.findMany({
    where: { docType: 'OFFICE_SUPPLY_REQUEST', status: 'PENDING_APPROVAL' },
    select: { id: true, docNumber: true },
  });
  for (const s of strays) {
    const res = await fetch(BASE + `/requests/${s.id}/reject`, { method: 'POST', headers: H, body: JSON.stringify({ comment: 'testing-DB cleanup: e2e stray' }) });
    console.log(`reject ${s.docNumber}: HTTP ${res.status} ${res.status >= 400 ? (await res.text()).slice(0, 120) : 'OK'}`);
  }
  await p.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
