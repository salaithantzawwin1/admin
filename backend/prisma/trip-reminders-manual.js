/* Ops utility: manually trigger the 24h trip-reminder pass (same logic as the daily 07:30 cron).
   Run inside the backend container:  docker exec ams-backend-1 node /app/prisma/trip-reminders-manual.js
   Safe to run any time — idempotent (one TRIP_REMINDER per request). */
const { TripRemindersService } = require('/app/dist/cars/trip-reminders.service');
const { PrismaService } = require('/app/dist/prisma/prisma.module');
const { NotificationsService } = require('/app/dist/notifications/notifications.service');

(async () => {
  const prisma = new PrismaService();
  await prisma.$connect();
  const svc = new TripRemindersService(prisma, new NotificationsService(prisma));
  const sent = await svc.runOnce();
  console.log('REMINDERS SENT:', sent);
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
