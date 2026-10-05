/**
 * E2E proof for the three fleet features (ETA ⏰ / vehicle blocks 🛠 / buffer ~):
 *  1. POST /fleet/vehicles/unavailabilities blocks a car → the 7-day card shows
 *     the 🛠 window + UNDER_MAINTENANCE while it covers now, and assign() refuses.
 *  2. POST /cars/requests/:id/eta sets an ETA on an active trip → fleet card
 *     surfaces it; effective end follows the ETA.
 *  3. Bookings on the card carry likelyFreeFrom ≈ end + buffer (default 30 min).
 * Runs INSIDE the ams-test-backend-1 container (BASE = 127.0.0.1:3000/api).
 */
(async () => {
  const BASE = 'http://127.0.0.1:3000/api';
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
  const j = async (r) => { const b = await r.json().catch(() => ({})); return { status: r.status, body: b }; };

  const adm = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }) })).json();
  const emp = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'employee1', password: 'ChangeMe#2026' }) })).json();
  if (!adm.accessToken || !emp.accessToken) throw new Error('login failed');

  // pre-clean leftovers from earlier runs (proof trips still holding cars)
  const all = await (await fetch(BASE + '/requests?page=1&pageSize=50', { headers: H(adm.accessToken) })).json();
  for (const r of (all.items || []).filter((x) => ['Block Proof Depot', 'ETA Proof Depot'].includes(x.title) && ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'].includes(x.status))) {
    const c = await fetch(BASE + `/cars/requests/${r.id}/admin-cancel`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'leftover cleanup' }) });
    console.log('pre-clean', r.title, r.status, '→', c.status);
  }

  // ---------- 1) vehicle unavailability ----------
  // pre-clean leftovers from earlier runs (an ACTIVE block still bars the car)
  const oldBlocks = await (await fetch(BASE + '/fleet/vehicles/unavailabilities', { headers: H(adm.accessToken) })).json();
  for (const u of (Array.isArray(oldBlocks) ? oldBlocks : []).filter((u) => (u.reason || '') === 'E2E service block')) {
    const del = await fetch(BASE + `/fleet/vehicles/unavailabilities/${u.id}`, { method: 'DELETE', headers: H(adm.accessToken) });
    console.log('pre-clean block', u.id.slice(0, 8), '→', del.status);
  }
  const fleet0 = await (await fetch(BASE + '/fleet/vehicles', { headers: H(adm.accessToken) })).json();
  const veh = fleet0.find((v) => v.status === 'AVAILABLE');
  if (!veh) throw new Error('no AVAILABLE vehicle for the block test');
  const bs = new Date(Date.now() - 30 * 60000).toISOString();
  const be = new Date(Date.now() + 90 * 60000).toISOString();
  const mk = await j(await fetch(BASE + '/fleet/vehicles/unavailabilities', { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ vehicleId: veh.id, startsAt: bs, endsAt: be, reason: 'E2E service block' }) }));
  console.log('1) create block:', mk.status, JSON.stringify(mk.body.clashes ?? []));
  if (mk.status !== 201 && mk.status !== 200) throw new Error('block create failed: ' + JSON.stringify(mk.body).slice(0, 200));
  const blockId = mk.body.id;

  const list = await (await fetch(BASE + '/fleet/vehicles/unavailabilities', { headers: H(adm.accessToken) })).json();
  if (!list.some((u) => u.id === blockId)) throw new Error('block missing from the list');

  const ov = await (await fetch(BASE + '/cars/fleet-overview', { headers: H(adm.accessToken) })).json();
  const cardV = ov.find((v) => v.id === veh.id);
  const hasBlock = cardV.bookings.some((b) => (b.docNumber || '').startsWith('🛠'));
  console.log('1) card while blocked:', cardV.status, '| 🛠 row:', hasBlock);
  if (cardV.status !== 'UNDER_MAINTENANCE' || !hasBlock) throw new Error('block not reflected on the fleet card');
  const likely = cardV.bookings.find((b) => (b.docNumber || '').startsWith('🛠'));

  // assign() into the blocked window must be refused
  const bsF = new Date(Date.now() + 15 * 60000).toISOString();
  const beF = new Date(Date.now() + 45 * 60000).toISOString();
  const cr = await j(await fetch(BASE + '/cars/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ destination: 'Block Proof Depot', startDate: bsF, endDate: beF, passengers: 1, timeSlot: 'FULL_DAY' }) }));
  if (cr.status !== 201) throw new Error('create failed: ' + JSON.stringify(cr.body).slice(0, 200));
  const requestId = cr.body.request?.id || cr.body.id;
  await fetch(BASE + `/requests/${requestId}/submit`, { method: 'POST', headers: H(emp.accessToken) });
  await fetch(BASE + `/requests/${requestId}/approve`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'block proof' }) });
  const asgFail = await j(await fetch(BASE + `/cars/requests/${requestId}/assign`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ vehicleId: veh.id }) }));
  console.log('1) assign into blocked window:', asgFail.status, (asgFail.body.message || '').slice(0, 90));
  if (asgFail.status === 201 || asgFail.status === 200) throw new Error('assign into a blocked window was NOT refused');

  // cancel → car bookable again
  const cx = await j(await fetch(BASE + `/fleet/vehicles/unavailabilities/${blockId}/cancel`, { method: 'POST', headers: H(adm.accessToken) }));
  console.log('1) cancel block:', cx.status);
  if (cx.status !== 200 && cx.status !== 201) throw new Error('cancel failed');

  // ---------- 2) ETA on an active trip ----------
  const start = new Date(Date.now() - 30 * 60000).toISOString();
  const end = new Date(Date.now() + 30 * 60000).toISOString();
  const cr2 = await j(await fetch(BASE + '/cars/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ destination: 'ETA Proof Depot', startDate: start, endDate: end, passengers: 1, timeSlot: 'FULL_DAY' }) }));
  if (cr2.status !== 201) throw new Error('create#2 failed: ' + JSON.stringify(cr2.body).slice(0, 200));
  const reqId2 = cr2.body.request?.id || cr2.body.id;
  await fetch(BASE + `/requests/${reqId2}/submit`, { method: 'POST', headers: H(emp.accessToken) });
  const ap2 = await fetch(BASE + `/requests/${reqId2}/approve`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'eta proof' }) });
  console.log('2) approve:', ap2.status);
  const fleetV = await (await fetch(BASE + '/fleet/vehicles', { headers: H(adm.accessToken) })).json();
  const veh2 = fleetV.find((v) => v.status === 'AVAILABLE');
  if (!veh2) throw new Error('no AVAILABLE vehicle for the ETA test');
  const asg2 = await j(await fetch(BASE + `/cars/requests/${reqId2}/assign`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ vehicleId: veh2.id }) }));
  if (asg2.status !== 201 && asg2.status !== 200) throw new Error('assign#2 failed: ' + JSON.stringify(asg2.body).slice(0, 200));
  const etaAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const eta = await j(await fetch(BASE + `/cars/requests/${reqId2}/eta`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ eta: etaAt }) }));
  console.log('2) set ETA:', eta.status, eta.body.estimatedReturnAt);
  if (eta.status !== 200 && eta.status !== 201) throw new Error('eta failed: ' + JSON.stringify(eta.body).slice(0, 200));

  const ov2 = await (await fetch(BASE + '/cars/fleet-overview', { headers: H(adm.accessToken) })).json();
  const card2 = ov2.find((v) => v.id === veh2.id);
  // the proof trip is the (only) non-block booking on this freshly assigned car
  const bk = card2.bookings.find((b) => !(b.docNumber || '').startsWith('🛠'));
  console.log('2) card booking:', bk && bk.docNumber, 'ETA row:', !!(bk && bk.estimatedReturnAt), 'likelyFreeFrom:', bk && bk.likelyFreeFrom);
  if (!bk || !bk.estimatedReturnAt) throw new Error('ETA missing from the fleet card');

  // ---------- 3) buffer math ----------
  const lff = new Date(bk.likelyFreeFrom).getTime();
  const expected = new Date(etaAt).getTime() + 30 * 60000;
  console.log('3) likelyFreeFrom = ETA + 30 min:', Math.abs(lff - expected) < 60_000 ? 'PASS' : `FAIL (${lff} vs ${expected})`);
  if (Math.abs(lff - expected) >= 60_000) throw new Error('likelyFreeFrom is not ETA + 30 min');

  // cleanup: release the proof trip
  await fetch(BASE + `/cars/requests/${reqId2}/release`, { method: 'POST', headers: H(adm.accessToken) });
  console.log('ALL 3 FEATURES VERIFIED ON TESTING');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
