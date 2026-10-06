/** Phase 2: invoke the REAL expireStaleRequests() and assert the result (testing stack). */
const requestId = process.argv[2];
if (!requestId) { console.error('usage: node verify-expire-stale-run.js <requestId>'); process.exit(1); }
const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
const { TripRemindersService } = require('/app/dist/cars/trip-reminders.service.js');
(async () => {
  const prisma = new PrismaService();
  const svc = new TripRemindersService(prisma, { notify: async () => {} }, { mirrorToUser: async () => {} }, {});
  await svc.expireStaleRequests();
  const doc = await prisma.requestDocument.findUnique({ where: { id: requestId }, select: { docNumber: true, status: true } });
  const audit = await prisma.auditLog.findFirst({ where: { recordId: requestId, action: 'REQUEST_AUTO_EXPIRED' } });
  const notif = await prisma.notification.findFirst({ where: { requestId, type: 'CANCELLED' }, select: { title: true, body: true } });
  console.log('doc:', JSON.stringify(doc));
  console.log('audit:', audit ? audit.action + ' ' + JSON.stringify(audit.newValue) : 'NONE');
  console.log('notif:', notif ? notif.title + ' :: ' + notif.body : 'NONE');
  await prisma.$disconnect();
  if (!doc || doc.status !== 'CANCELLED') { console.error('FAIL: not cancelled'); process.exit(1); }
  if (!audit) { console.error('FAIL: no audit row'); process.exit(1); }
  console.log('PASS — expireStaleRequests cancelled the stale request');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
