/* Ops utility: manually trigger the import/export license reminder sweep (same
   logic as the daily 08:45 cron). Run inside the backend container:
     docker exec ams-test-backend-1 node /app/prisma/licenses-reminders-manual.js
   Safe to run any time — one reminder per license per 60/30-day threshold
   (Notification.dedupeKey). */
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('/app/dist/app.module');
const { LicenseRemindersService } = require('/app/dist/licenses/license-reminders.service');

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const result = await app.get(LicenseRemindersService).runReminders();
  console.log('LICENSE REMINDERS:', JSON.stringify(result));
  await app.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
