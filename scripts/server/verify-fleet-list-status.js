/**
 * E2E proof that the Fleet admin lists (/fleet/vehicles, /fleet/drivers) show
 * window-based effective status: a car+driver assigned to a FUTURE window stay
 * AVAILABLE until the trip starts. Runs INSIDE the ams-test-backend-1 container.
 */
(async () => {
  const BASE = 'http://127.0.0.1:3000/api';
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
  const adm = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }) })).json();
  const emp = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'employee1', password: 'ChangeMe#2026' }) })).json();
  if (!adm.accessToken || !emp.accessToken) throw new Error('login failed');

  // pre-clean leftovers that would block the window
  const all = await (await fetch(BASE + '/requests?page=1&pageSize=50', { headers: H(adm.accessToken) })).json();
  for (const r of (all.items || []).filter((x) => x.title?.includes('Badge Proof Depot') && ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'].includes(x.status))) {
    await fetch(BASE + `/cars/requests/${r.id}/admin-cancel`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'leftover cleanup' }) });
  }

  const start = new Date(Date.now() + 24 * 3600 * 1000); start.setUTCHours(3, 30, 0, 0);
  const end = new Date(start.getTime() + 90 * 60000);
  const cr = await fetch(BASE + '/cars/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ destination: 'Badge Proof Depot', startDate: start.toISOString(), endDate: end.toISOString(), passengers: 1, timeSlot: 'FULL_DAY' }) });
  const created = await cr.json();
  if (cr.status !== 201) throw new Error('create failed');
  const requestId = created.request?.id || created.id;
  await fetch(BASE + `/requests/${requestId}/submit`, { method: 'POST', headers: H(emp.accessToken) });
  const appr = await fetch(BASE + `/requests/${requestId}/approve`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'list status proof' }) });
  if (appr.status !== 201 && appr.status !== 200) throw new Error('approve failed');

  const vehicles = await (await fetch(BASE + '/fleet/vehicles', { headers: H(adm.accessToken) })).json();
  const drivers = await (await fetch(BASE + '/fleet/drivers', { headers: H(adm.accessToken) })).json();
  const veh = vehicles[0];
  const drv = drivers.find((d) => d.status === 'AVAILABLE');
  const asg = await fetch(BASE + `/cars/requests/${requestId}/assign`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ vehicleId: veh.id, driverId: drv?.id }) });
  if (asg.status !== 201 && asg.status !== 200) throw new Error('assign failed: ' + JSON.stringify(await asg.json()).slice(0, 150));

  const after = await (await fetch(BASE + '/fleet/vehicles', { headers: H(adm.accessToken) })).json();
  const drvAfter = await (await fetch(BASE + '/fleet/drivers', { headers: H(adm.accessToken) })).json();
  const vehNow = after.find((v) => v.id === veh.id);
  const drvNow = drv ? drvAfter.find((d) => d.id === drv.id) : null;
  const vOk = vehNow.status === 'AVAILABLE';
  const dOk = !drv || drvNow.status === 'AVAILABLE';
  console.log(`>>> vehicle ${vehNow.vehicleNo}: after future assign → ${vehNow.status} ${vOk ? 'PASS ✓' : 'FAIL ✗ (expected AVAILABLE)'}`);
  if (drv) console.log(`>>> driver ${drvNow.name}: after future assign → ${drvNow.status} ${dOk ? 'PASS ✓' : 'FAIL ✗ (expected AVAILABLE)'}`);

  const cancel = await fetch(BASE + `/cars/requests/${requestId}/admin-cancel`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'list status proof cleanup' }) });
  console.log('cleanup cancel:', cancel.status);
  if (!vOk || !dOk) process.exit(1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
