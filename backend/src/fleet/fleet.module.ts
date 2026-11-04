import { Module, forwardRef } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { FleetComplianceModule } from './compliance.module';
import { VehiclePhotosService } from './vehicle-photos.service';

@Module({
  imports: [
    TelegramModule,
    NotificationsModule,
    AuthModule,
    forwardRef(() => SettingsModule),
    FleetComplianceModule,
    // Vehicle photos are buffered in memory (bounded to 5 MB) so the file
    // signature is checked before anything is written to the uploads volume.
    MulterModule.register({ storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }),
  ],
  controllers: [FleetController],
  providers: [FleetService, VehiclePhotosService],
  exports: [VehiclePhotosService],
})
export class FleetModule {}
