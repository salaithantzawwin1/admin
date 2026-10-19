/* Ops utility: manually trigger the 08:30 daily document-expiry sweep
   (VMS spec §6.4 — same FleetService.runExpiryAlerts() the cron runs, so this
   exercises the real production path: alerts → fleet.manage recipients →
   Notifications, dedupe keys included).
   Run inside the backend container:
     docker exec ams-test-backend-1 node /app/prisma/fleet-expiry-manual.js
   Idempotent: each alert/recipient pair is inserted at most once per dedupe key. */
const { FleetService } = require('/app/dist/fleet/fleet.service');
const { PrismaService } = require('/app/dist/prisma/prisma.module');
const { AuditService } = require('/app/dist/audit/audit.service');
const { EventsService } = require('/app/dist/events/events.service');
const { NotificationsService } = require('/app/dist/notifications/notifications.service');
const { TelegramService } = require('/app/dist/telegram/telegram.service');
const { PermissionsService } = require('/app/dist/auth/permissions.service');
const { TimetableService } = require('/app/dist/settings/timetable.service');

(async () => {
  const prisma = new PrismaService();
  await prisma.$connect();
  const audit = new AuditService(prisma);
  const events = new EventsService(); // no polling/SSE loop outside the app
  const permissions = new PermissionsService(prisma, audit);
  const telegram = new TelegramService(prisma, audit, permissions, events);
  const notifications = new NotificationsService(prisma, telegram, events);
  const timetable = new TimetableService(prisma, audit);
  const fleet = new FleetService(prisma, audit, events, telegram, notifications, permissions, timetable);

  const result = await fleet.runExpiryAlerts();
  console.log('SWEEP RESULT:', JSON.stringify(result));

  const rows = await prisma.notification.findMany({
    where: { dedupeKey: { startsWith: 'doc-expiry:' } },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { userId: true, title: true, dedupeKey: true, createdAt: true },
  });
  console.log('RECENT doc-expiry NOTIFICATIONS:');
  for (const r of rows) console.table ? console.log(` ${r.createdAt.toISOString()}  ${r.userId}  ${r.title}`) : null;
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
