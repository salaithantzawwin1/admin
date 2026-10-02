/**
 * E2E proof of the IN_USE badge fix — the exact user scenario:
 * create + submit + approve + assign a car for a FUTURE window, then the
 * Fleet Availability card must show AVAILABLE (with the booked window listed),
 * NOT IN_USE. Runs INSIDE the ams-test-backend-1 container.
 */
(async () => {
  const BASE = 'http://127.0.0.1:3000/api';
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

  const emp = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'employee1', password: 'ChangeMe#2026' }) })).json();
  const adm = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }) })).json();
  if (!emp.accessToken || !adm.accessToken) throw new Error('login failed');

  // pre-clean leftovers from earlier runs (they block the vehicle for this window)
  const all = await (await fetch(BASE + '/requests?page=1&pageSize=50', { headers: H(adm.accessToken) })).json();
  for (const r of (all.items || []).filter((x) => x.title?.includes('Badge Proof Depot') && ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'].includes(x.status))) {
    const c = await fetch(BASE + `/cars/requests/${r.id}/admin-cancel`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'leftover cleanup' }) });
    console.log('pre-clean', r.id.slice(0, 8), r.status, '→', c.status);
  }

  // a FUTURE window (default) or an ACTIVE window covering now (WINDOW_MODE=active)
  const start = process.env.WINDOW_MODE === 'active' ? new Date(Date.now() - 30 * 60000) : new Date(Date.now() + 24 * 3600 * 1000);
  if (process.env.WINDOW_MODE !== 'active') start.setUTCHours(3, 30, 0, 0);
  const end = new Date(start.getTime() + 90 * 60000);

  const cr = await fetch(BASE + '/cars/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ destination: 'Badge Proof Depot', startDate: start.toISOString(), endDate: end.toISOString(), passengers: 1, timeSlot: 'FULL_DAY' }) });
  const created = await cr.json();
  if (cr.status !== 201) throw new Error('create failed: ' + JSON.stringify(created).slice(0, 200));
  const requestId = created.request?.id || created.id;
  console.log('create:', cr.status, requestId);

  // submit → approve → assign (Administration)
  const sub = await fetch(BASE + `/requests/${requestId}/submit`, { method: 'POST', headers: H(emp.accessToken) });
  console.log('submit:', sub.status);
  const appr = await fetch(BASE + `/requests/${requestId}/approve`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'badge proof' }) });
  let apprStatus = appr.status;
  if (apprStatus !== 200 && apprStatus !== 201) {
    // fallback: administration auto-approve endpoint used elsewhere
    const fb = await fetch(BASE + `/requests/${requestId}/admin-approve`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({}) });
    apprStatus = fb.status;
  }
  console.log('approve:', apprStatus);

  // pick the first vehicle + optional driver
  const fleet = await (await fetch(BASE + '/cars/fleet-overview', { headers: H(adm.accessToken) })).json();
  const veh = fleet[0];
  console.log('assigning vehicle:', veh.vehicleNo);
  const asg = await fetch(BASE + `/cars/requests/${requestId}/assign`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ vehicleId: veh.id }) });
  if (asg.status !== 201 && asg.status !== 200) throw new Error('assign failed: ' + JSON.stringify(await asg.json()).slice(0, 200));
  console.log('assign:', asg.status);

  // THE CHECK — re-read the overview: this vehicle must NOT be IN_USE yet
  const after = await (await fetch(BASE + '/cars/fleet-overview', { headers: H(adm.accessToken) })).json();
  const me = after.find((v) => v.id === veh.id);
  console.log('DEBUG me:', JSON.stringify(me));
  console.log('DEBUG bookings count all:', after.map((v) => v.vehicleNo + '=' + v.bookings.length).join(' '));
  if (!me || !me.bookings.length) throw new Error('assigned booking missing from overview');
  const now = new Date();
  const covers = me.bookings.some((b) => new Date(b.startDate) <= now && now <= new Date(b.endDate));
  const ok = me.status === (covers ? 'IN_USE' : 'AVAILABLE');
  const p = (x) => { const d = new Date(x); return new Date(d.getTime() + 6.5 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' '); };
  console.log(`>>> ${me.vehicleNo}: badge=${me.status} | ${me.bookings[0]?.docNumber} ${p(me.bookings[0]?.startDate)}→${p(me.bookings[0]?.endDate)} covers_now=${covers} → ${ok ? 'PASS ✓' : 'FAIL ✗'}`);

  // cleanup: cancel the request (frees the vehicle link) then delete if possible
  const cancel = await fetch(BASE + `/cars/requests/${requestId}/admin-cancel`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'badge proof cleanup' }) });
  console.log('cleanup cancel:', cancel.status);
  if (!ok) process.exit(1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
