/** Verify the REAL expireStaleRequests() cancels a stale car request (testing stack). */
(async () => {
  const BASE = 'http://127.0.0.1:3000/api';
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
  const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

  const emp = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'employee1', password: 'ChangeMe#2026' }) })).json();
  if (!emp.accessToken) throw new Error('login failed');

  // create a normal (future-window) request, then age its endDate via SQL
  const start = new Date(Date.now() + 2 * 3600 * 60000).toISOString();
  const end = new Date(Date.now() + 4 * 3600 * 60000).toISOString();
  const cr = await j(await fetch(BASE + '/cars/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ destination: 'Expire Proof Depot', startDate: start, endDate: end, passengers: 1, timeSlot: 'FULL_DAY' }) }));
  if (cr.status !== 201) throw new Error('create failed: ' + JSON.stringify(cr.body).slice(0, 200));
  const requestId = cr.body.request?.id || cr.body.id;
  console.log('created', requestId);

  console.log('NOW_AGE_IT:' + requestId); // caller runs the SQL UPDATE between phases
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
