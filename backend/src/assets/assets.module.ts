import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

// Asset photos are buffered in memory (bounded to 5 MB) so the file signature
// can be checked before anything is written to the uploads volume.
@Module({
  imports: [MulterModule.register({ storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } })],
  controllers: [AssetsController],
  providers: [AssetsService],
  // receiving (GRN) auto-registers the fixed assets it delivers
  exports: [AssetsService],
})
export class AssetsModule {}
