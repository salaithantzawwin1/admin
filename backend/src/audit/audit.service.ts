import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';

export interface AuditEntry {
  userId?: string;
  username?: string;
  action: string;
  module: string;
  recordId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string;
  userAgent?: string;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
}

@Injectable()
export class AuditService {
  private logger = new Logger('Audit');

  constructor(private prisma: PrismaService) {}

  /** Append-only: creates an audit record. Never updates or deletes. */
  async log(entry: AuditEntry) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: entry.userId,
          username: entry.username,
          action: entry.action,
          module: entry.module,
          recordId: entry.recordId,
          oldValue: entry.oldValue === undefined ? undefined : (entry.oldValue as object),
          newValue: entry.newValue === undefined ? undefined : (entry.newValue as object),
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          severity: entry.severity || 'INFO',
        },
      });
    } catch (e) {
      // audit must never break the main flow, but must be visible in logs
      this.logger.error(`Failed to write audit log: ${e}`);
    }
  }
}
