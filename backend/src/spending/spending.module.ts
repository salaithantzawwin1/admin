import { Module } from '@nestjs/common';
import { SpendingController } from './spending.controller';
import { SpendingService } from './spending.service';

// Numbering + audit modules are @Global() — services inject directly.
@Module({
  controllers: [SpendingController],
  providers: [SpendingService],
})
export class SpendingModule {}
