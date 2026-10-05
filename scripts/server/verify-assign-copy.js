/** E2E proof: the requester's "Vehicle assigned to CAR-…" bell copy names the driver. */
(async () => {
  const BASE = 'http://127.0.0.1:3000/api';
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
  const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

  const adm = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }) })).json();
  const emp = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'employee1', password: 'ChangeMe#2026' }) })).json();
  if (!adm.accessToken || !emp.accessToken) throw new Error('login failed');

  // pre-clean leftovers from earlier runs
  const all = await (await fetch(BASE + '/requests?page=1&pageSize=50', { headers: H(adm.accessToken) })).json();
  for (const r of (all.items || []).filter((x) => x.title === 'Assign Copy Proof' && ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'].includes(x.status))) {
    const c = await fetch(BASE + `/cars/requests/${r.id}/admin-cancel`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'leftover cleanup' }) });
    console.log('pre-clean', r.id.slice(0, 8), '→', c.status);
  }

  const fleet = await (await fetch(BASE + '/fleet/vehicles', { headers: H(adm.accessToken) })).json();
  const veh = fleet.find((v) => v.status === 'AVAILABLE');
  if (!veh) throw new Error('no AVAILABLE vehicle');
  const drvList = await (await fetch(BASE + '/fleet/drivers', { headers: H(adm.accessToken) })).json();
  const drvs = Array.isArray(drvList) ? drvList : drvList.items || [];
  const drv = drvs.find((d) => d.status === 'AVAILABLE') || drvs[0];
  if (!drv) throw new Error('no driver in the pool');
  console.log('vehicle:', veh.vehicleNo, '| driver:', drv.name);

  const start = new Date(Date.now() + 15 * 60000).toISOString();
  const end = new Date(Date.now() + 3 * 3600 * 60000).toISOString();
  const cr = await j(await fetch(BASE + '/cars/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ destination: 'Assign Copy Proof', startDate: start, endDate: end, passengers: 1, timeSlot: 'FULL_DAY' }) }));
  if (cr.status !== 201) throw new Error('create failed: ' + JSON.stringify(cr.body).slice(0, 200));
  const requestId = cr.body.request?.id || cr.body.id;
  await fetch(BASE + `/requests/${requestId}/submit`, { method: 'POST', headers: H(emp.accessToken) });
  const ap = await j(await fetch(BASE + `/requests/${requestId}/approve`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'assign-copy proof' }) }));
  console.log('approve:', ap.status);
  const asg = await j(await fetch(BASE + `/cars/requests/${requestId}/assign`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ vehicleId: veh.id, driverId: drv.id }) }));
  console.log('assign:', asg.status);
  if (asg.status !== 201 && asg.status !== 200) throw new Error('assign failed: ' + JSON.stringify(asg.body).slice(0, 200));

  const notes = await (await fetch(BASE + '/notifications?page=1&pageSize=20', { headers: H(emp.accessToken) })).json();
  const bell = (notes.items || []).find((n) => n.type === 'CAR_ASSIGNED' && (n.title || '').startsWith('Vehicle assigned to') && (n.body || '').includes(veh.vehicleNo));
  console.log('bell:', bell ? `${bell.title} :: ${bell.body}` : 'NOT FOUND');
  if (!bell) throw new Error('requester CAR_ASSIGNED notification not found');
  const expect = `Driver ${drv.name}`;
  if (!bell.body.includes(expect)) throw new Error(`body missing "${expect}": ${bell.body}`);
  console.log('PASS — requester copy names the driver:', expect);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
