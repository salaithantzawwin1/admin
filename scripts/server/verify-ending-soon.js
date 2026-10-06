/** E2E proof (testing stack): T-15 ending-soon nudge + instant admin auto-close notice. */
(async () => {
  const BASE = 'http://127.0.0.1:3000/api';
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
  const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

  const adm = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }) })).json();
  const emp = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'employee1', password: 'ChangeMe#2026' }) })).json();
  if (!adm.accessToken || !emp.accessToken) throw new Error('login failed');

  // pre-clean leftovers
  const all = await (await fetch(BASE + '/requests?page=1&pageSize=50', { headers: H(adm.accessToken) })).json();
  for (const r of (all.items || []).filter((x) => x.title === 'Ending Soon Proof' && ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'].includes(x.status))) {
    await fetch(BASE + `/cars/requests/${r.id}/admin-cancel`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'leftover cleanup' }) });
  }

  const fleet = await (await fetch(BASE + '/fleet/vehicles', { headers: H(adm.accessToken) })).json();
  const veh = fleet.find((v) => v.status === 'AVAILABLE');
  if (!veh) throw new Error('no AVAILABLE vehicle');
  const drvList = await (await fetch(BASE + '/fleet/drivers', { headers: H(adm.accessToken) })).json();
  const drvs = Array.isArray(drvList) ? drvList : drvList.items || [];
  const drv = drvs.find((d) => d.status === 'AVAILABLE') || drvs[0];
  if (!drv) throw new Error('no driver');

  // trip window: ends in ~8 minutes (inside the T-15 window)
  const start = new Date(Date.now() - 52 * 60000).toISOString();
  const end = new Date(Date.now() + 8 * 60000).toISOString();
  const cr = await j(await fetch(BASE + '/cars/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ destination: 'Ending Soon Proof', startDate: start, endDate: end, passengers: 1, timeSlot: 'FULL_DAY' }) }));
  if (cr.status !== 201) throw new Error('create failed: ' + JSON.stringify(cr.body).slice(0, 200));
  const requestId = cr.body.request?.id || cr.body.id;
  await fetch(BASE + `/requests/${requestId}/submit`, { method: 'POST', headers: H(emp.accessToken) });
  const ap = await fetch(BASE + `/requests/${requestId}/approve`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'ending-soon proof' }) });
  if (ap.status !== 200 && ap.status !== 201) throw new Error('approve failed');
  const asg = await j(await fetch(BASE + `/cars/requests/${requestId}/assign`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ vehicleId: veh.id, driverId: drv.id }) }));
  if (asg.status !== 201 && asg.status !== 200) throw new Error('assign failed: ' + JSON.stringify(asg.body).slice(0, 200));
  console.log('trip', requestId, 'assigned:', veh.vehicleNo, '/', drv.name, '| window ends', end);

  // invoke the REAL endingSoonNudge inside this container (same process style as the janitor proof)
  const svc = require('/app/dist/cars/trip-reminders.service.js');
  const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
  const prisma = new PrismaService();
  const trs = new svc.TripRemindersService(prisma, { notify: async () => {}, notifyMany: async () => {} }, { mirrorToUser: async () => {}, sendRaw: async (chat, text) => console.log('TELEGRAM→', chat.slice(0, 8) + ':', text.split('\n')[0]) }, { usersWithPermissions: async () => [] });
  await trs.endingSoonNudge();
  const bell = await prisma.notification.findFirst({ where: { requestId, type: 'WINDOW_ENDING' }, select: { title: true, body: true } });
  console.log('requester bell:', bell ? bell.title + ' :: ' + bell.body : 'NONE');
  if (!bell) throw new Error('WINDOW_ENDING bell missing');
  console.log('PASS — ending-soon nudge ran; requester bell written (driver copy fires if the driver has a Telegram link)');

  // ---- phase 2: window passes → janitor auto-closes → admin notified instantly
  const { execSync } = require('child_process');
  execSync(`psql -U ams -d ams -tA -c "UPDATE car_requests SET \\"endDate\\" = now() - interval '5 minutes', \\"startDate\\" = now() - interval '65 minutes' WHERE \\"requestId\\" = '${requestId}'"`, { stdio: 'inherit', env: { ...process.env, PGHOST: process.env.PGHOST || '127.0.0.1' } });
  const adminBefore = await prisma.notification.count({ where: { type: 'TRIP_COMPLETED', title: { contains: 'Auto-closed' } } });
  await trs.releaseExpired();
  const doc = await prisma.requestDocument.findUnique({ where: { id: requestId }, select: { status: true } });
  const adminAfter = await prisma.notification.count({ where: { type: 'TRIP_COMPLETED', title: { contains: 'Auto-closed' } } });
  const adminBell = await prisma.notification.findFirst({ where: { requestId, title: { contains: 'Auto-closed' } }, select: { title: true, body: true } });
  console.log('doc after janitor:', JSON.stringify(doc));
  console.log('admin auto-close bells:', adminBefore, '→', adminAfter);
  console.log('admin bell:', adminBell ? adminBell.title + ' :: ' + adminBell.body.slice(0, 120) : 'NONE');
  await prisma.$disconnect();
  if (!doc || doc.status !== 'COMPLETED') throw new Error('janitor did not auto-close the ride');
  if (adminAfter <= adminBefore || !adminBell) throw new Error('Administration was NOT notified of the auto-close');
  console.log('PASS — auto-close + instant Administration notice');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
