import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { PermissionsService } from '../auth/permissions.service';
import { PERMISSIONS } from '../auth/permissions';
import { daysUntilExpiry, ymd } from '../fleet/expiry';

/** Reminder days before the licence due date (the two the office asked for). */
export const LICENSE_REMINDER_DAYS = [60, 30] as const;

/**
 * Daily import/export licence reminder. One alert per licence per threshold:
 * at 60 days and again at 30, delivered in-app + Telegram to the people who
 * manage the register. `Notification.dedupeKey` makes a rerun, a restart or a
 * second instance unable to send the same reminder twice.
 */
@Injectable()
export class LicenseRemindersService {
  private readonly logger = new Logger(LicenseRemindersService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private permissions: PermissionsService,
  ) {}

  /** 08:45 Asia/Yangon — after the fleet expiry sweep at 08:30. */
  @Cron('45 8 * * *')
  async dailyReminders() {
    return this.runReminders();
  }

  /** Sweep body — `now` is injectable so tests can drive the clock. */
  async runReminders(now: Date = new Date()) {
    const licenses = await this.prisma.importExportLicense.findMany({
      where: { dueDate: { not: null } },
      select: { id: true, name: true, registrationNo: true, dueDate: true },
    });
    if (licenses.length === 0) return { due: 0, recipients: 0, sent: 0 };

    // The reminder a licence is currently inside: 60 → 30, the tightest one that
    // has been reached. A sweep that missed a day still sends the right one.
    const due: { license: (typeof licenses)[number]; left: number; threshold: number }[] = [];
    for (const license of licenses) {
      const left = daysUntilExpiry(license.dueDate as Date, now);
      if (left < 0) continue; // already expired — the register shows that
      const threshold = LICENSE_REMINDER_DAYS.filter((days) => left <= days).pop();
      if (threshold !== undefined) due.push({ license, left, threshold });
    }

    if (due.length === 0) return { due: 0, recipients: 0, sent: 0 };

    const recipients = await this.permissions.usersWithPermissions([PERMISSIONS.LICENSES_MANAGE]);
    if (recipients.length === 0) return { due: due.length, recipients: 0, sent: 0 };

    const key = (licenseId: string, threshold: number, userId: string) => `lic:${licenseId}:${threshold}:${userId}`;
    const existing = new Set(
      (
        await this.prisma.notification.findMany({
          where: { dedupeKey: { in: due.flatMap((row) => recipients.map((u) => key(row.license.id, row.threshold, u))) } },
          select: { dedupeKey: true },
        })
      ).map((row) => row.dedupeKey as string),
    );

    let sent = 0;
    for (const { license, left, threshold } of due) {
      const title = `🛂 Import/Export license — ${license.name} expires in ${left} day${left === 1 ? '' : 's'}`;
      const body =
        `Registration No. ${license.registrationNo ?? '—'} · due ${ymd(license.dueDate as Date)} (${threshold}-day reminder). ` +
        'Start the renewal and upload the new certificate.';
      for (const userId of recipients) {
        const dedupeKey = key(license.id, threshold, userId);
        if (existing.has(dedupeKey)) continue;
        try {
          await this.notifications.notify({ userId, type: 'LICENSE_EXPIRY', title, body, link: '/licenses', dedupeKey });
          sent += 1;
        } catch (e) {
          // unique-index race (another instance sent it first) = already done
          this.logger.warn(`license reminder skipped for ${userId}: ${(e as Error).message}`);
        }
      }
    }
    return { due: due.length, recipients: recipients.length, sent };
  }
}
