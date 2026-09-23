import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.decorator';
import { PermissionsGuard } from './auth/permissions.guard';
import { UsersModule } from './users/users.module';
import { OrgModule } from './org/org.module';
import { AuditModule } from './audit/audit.module';
import { NumberingModule } from './numbering/numbering.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { TelegramModule } from './telegram/telegram.module';
import { WorkflowModule } from './workflow/workflow.module';
import { FleetModule } from './fleet/fleet.module';
import { CarsModule } from './cars/cars.module';
import { MeetingRoomsModule } from './meeting-rooms/meeting-rooms.module';
import { InventoryModule } from './inventory/inventory.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { SettingsModule } from './settings/settings.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    // single scheduler instance for every @Cron in the app — feature modules
    // previously each called forRoot(), creating redundant registries
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    OrgModule,
    AuditModule,
    NumberingModule,
    NotificationsModule,
    AttachmentsModule,
    WorkflowModule,
    FleetModule,
    CarsModule,
    SettingsModule,
    MeetingRoomsModule,
    InventoryModule,
    AnnouncementsModule,
    SuppliersModule,
    TelegramModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
