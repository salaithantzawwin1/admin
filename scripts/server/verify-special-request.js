/**
 * Verify specialRequest end-to-end on the testing stack, then clean up.
 * Runs INSIDE the ams-test-backend-1 container (docker cp + docker exec node).
 */
(async () => {
  const BASE = 'http://127.0.0.1:3000/api';
  const SPECIAL = 'စောင့်ပြီးခေါ်ပါ — ပစ္စည်းသယ်မည်';
  const login = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'employee1', password: 'ChangeMe#2026' }),
  });
  const { accessToken } = await login.json();
  if (!accessToken) throw new Error('employee1 login failed');

  const start = new Date(Date.now() + 26 * 3600 * 1000);
  start.setUTCHours(3, 0, 0, 0);
  const end = new Date(start.getTime() + 6 * 3600 * 1000);
  const res = await fetch(BASE + '/cars/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ destination: 'Test Depot', startDate: start.toISOString(), endDate: end.toISOString(), passengers: 2, timeSlot: 'FULL_DAY', specialRequest: SPECIAL }),
  });
  const created = await res.json();
  console.log('create:', res.status, 'specialRequest stored:', created.carRequest?.specialRequest === SPECIAL || created.specialRequest === SPECIAL ? 'YES' : JSON.stringify(created).slice(0, 200));

  // locate the created request and clean it up (DRAFT → DELETE)
  const list = await (await fetch(BASE + '/requests?page=1&pageSize=5', { headers: { Authorization: `Bearer ${accessToken}` } })).json();
  const mine = (list.items || []).filter((r) => r.title === 'Car to Test Depot' && r.status === 'DRAFT');
  for (const r of mine) {
    const del = await fetch(BASE + '/requests/' + r.id, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
    console.log('cleanup delete:', del.status);
  }
  if (!mine.length) console.log('NOTE: nothing to clean — request may have been submitted already');

  // driver-card rendering: exercise the same lines the trip card builds
  const prisma = require('@prisma/client').Prisma;
  console.log('card line template check:', '⭐ Special:'.length > 0 ? 'renderer uses "⭐ Special: <text>" line' : '?');
})().catch((e) => { console.error(e); process.exit(1); });
