/** Combined e2e: create + submit + approve + assign + Noted + age window → real janitor →
 *  auto-COMPLETED + car freed + Administration notified instantly. */
const svc = require('/app/dist/cars/trip-reminders.service.js');
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
const BASE = 'http://127.0.0.1:3000/api';
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
(async () => {
  const adm = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sysadmin', password: 'ChangeMe#2026' }) })).json();
  const emp = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'employee1', password: 'ChangeMe#2026' }) })).json();
  if (!adm.accessToken || !emp.accessToken) throw new Error('login failed');
  const prisma = new PrismaService();

  const fleet = await (await fetch(BASE + '/fleet/vehicles', { headers: H(adm.accessToken) })).json();
  const veh = fleet.find((v) => v.status === 'AVAILABLE');
  if (!veh) throw new Error('no AVAILABLE vehicle');
  const drvList = await (await fetch(BASE + '/fleet/drivers', { headers: H(adm.accessToken) })).json();
  const drvs = Array.isArray(drvList) ? drvList : drvList.items || [];
  const drv = drvs.find((d) => d.status === 'AVAILABLE') || drvs[0];
  if (!drv) throw new Error('no driver');

  const start = new Date(Date.now() - 60 * 60000).toISOString();
  const end = new Date(Date.now() + 60 * 60000).toISOString();
  const cr = await fetch(BASE + '/cars/requests', { method: 'POST', headers: H(emp.accessToken), body: JSON.stringify({ destination: 'Auto Close Proof', startDate: start, endDate: end, passengers: 1, timeSlot: 'FULL_DAY' }) });
  if (cr.status !== 201) throw new Error('create failed ' + cr.status + ' ' + (await cr.text()).slice(0, 150));
  const doc = await cr.json();
  const requestId = doc.id; // the create response IS the request document
  console.log('created', doc.docNumber, requestId);

  const sub = await fetch(BASE + `/requests/${requestId}/submit`, { method: 'POST', headers: H(emp.accessToken) });
  if (sub.status >= 400) throw new Error('submit failed ' + sub.status + ' ' + (await sub.text()).slice(0, 120));
  const ap = await fetch(BASE + `/requests/${requestId}/approve`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ comment: 'auto-close proof' }) });
  if (ap.status >= 400) throw new Error('approve failed ' + ap.status + ' ' + (await ap.text()).slice(0, 120));
  const asg = await fetch(BASE + `/cars/requests/${requestId}/assign`, { method: 'POST', headers: H(adm.accessToken), body: JSON.stringify({ vehicleId: veh.id, driverId: drv.id }) });
  if (asg.status !== 201 && asg.status !== 200) throw new Error('assign failed ' + asg.status + ' ' + (await asg.text()).slice(0, 150));
  await prisma.carAssignment.update({ where: { requestId }, data: { driverNotedAt: new Date() } });
  await prisma.carRequest.update({ where: { requestId }, data: { startDate: new Date(Date.now() - 63 * 60000), endDate: new Date(Date.now() - 3 * 60000) } });
  console.log('assigned', veh.vehicleNo, '/', drv.name, '| window aged past its end, Noted tapped');

  const adminBells = [];
  const trs = new svc.TripRemindersService(
    prisma,
    { notify: async () => {}, notifyMany: async (ids, n) => { for (const id of ids) adminBells.push({ userId: id, title: n.title, body: n.body }); } },
    { mirrorToUser: async () => {}, sendRaw: async () => {} },
    { usersWithPermissions: async () => ['admin-x'] },
  );
  await trs.releaseExpired();
  const doc2 = await prisma.requestDocument.findUnique({ where: { id: requestId }, select: { status: true } });
  const v = await prisma.vehicle.findUnique({ where: { id: veh.id }, select: { vehicleNo: true, status: true } });
  const bell = adminBells[0];
  console.log('doc after janitor:', JSON.stringify(doc2));
  console.log('vehicle after janitor:', JSON.stringify(v));
  console.log('admin bell:', bell ? bell.title + ' :: ' + (bell.body || '').slice(0, 140) : 'NONE');
  await prisma.$disconnect();
  if (!doc2 || doc2.status !== 'COMPLETED') throw new Error('janitor did not auto-COMPLETED the ride');
  if (!v || v.status !== 'AVAILABLE') throw new Error('vehicle was not freed');
  if (!bell || !bell.title.includes('Auto-closed')) throw new Error('Administration NOT notified instantly');
  console.log('PASS — auto-COMPLETED + car freed + instant Administration notice');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
