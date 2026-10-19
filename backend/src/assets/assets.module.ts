import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

// Numbering + audit modules are @Global() — services inject directly.
@Module({
  controllers: [AssetsController],
  providers: [AssetsService],
})
export class AssetsModule {}
