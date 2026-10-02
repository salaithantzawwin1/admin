/** Verify the IN_USE badge reflects physical state (window covering now), not future bookings. */
(async () => {
  const BASE = 'http://127.0.0.1:3000/api';
  const login = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }),
  });
  const { accessToken } = await login.json();
  if (!accessToken) throw new Error('login failed');
  const list = await (await fetch(BASE + '/cars/fleet-overview', { headers: { Authorization: 'Bearer ' + accessToken } })).json();
  const now = new Date();
  const p = (d) => new Date(d.getTime() + 6.5 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
  console.log('NOW(Yangon):', p(now));
  let bad = 0;
  for (const v of list) {
    if (!v.bookings.length) { console.log(`${v.vehicleNo}: badge=${v.status} (no bookings)`); continue; }
    for (const b of v.bookings) {
      const s = new Date(b.startDate), e = new Date(b.endDate);
      const covers = s <= now && now <= e;
      // BOOKED is a valid presentational state for future-only bookings;
      // the invariant that matters: IN_USE only while a window covers now.
      const ok = covers ? v.status === 'IN_USE' : (v.status === 'AVAILABLE' || v.status === 'BOOKED');
      if (!ok) bad++;
      console.log(`${v.vehicleNo}: badge=${v.status} | ${b.docNumber} ${p(s)}→${p(e)} covers_now=${covers} ${ok ? 'OK' : '<<< MISMATCH'}`);
    }
  }
  console.log(bad === 0 ? 'ALL BADGES CONSISTENT' : `${bad} MISMATCH(ES)`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
