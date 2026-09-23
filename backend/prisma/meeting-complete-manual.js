/* Ops utility: complete an IN_PROGRESS meeting whose window already ended (same logic
   as the half-hourly auto-complete cron in MeetingRoomsService).
   Run inside the backend container:  docker exec ams-backend-1 node /app/prisma/meeting-complete-manual.js [requestId]
   Without an argument it completes ALL ended IN_PROGRESS meetings. Safe to run any time —
   already-completed meetings are rejected by the status guard. */
const { MeetingRoomsService } = require('/app/dist/meeting-rooms/meeting-rooms.service');
const { PrismaService } = require('/app/dist/prisma/prisma.module');
const { NumberingService } = require('/app/dist/numbering/numbering.service');
const { NotificationsService } = require('/app/dist/notifications/notifications.service');
const { AuditService } = require('/app/dist/audit/audit.service');

(async () => {
  const prisma = new PrismaService();
  await prisma.$connect();
  const svc = new MeetingRoomsService(prisma, new NumberingService(prisma), new NotificationsService(prisma), new AuditService(prisma));
  const n = await svc.autoCompleteEnded();
  console.log('MEETINGS COMPLETED:', n);
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
