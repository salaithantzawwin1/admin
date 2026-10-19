import { Module } from '@nestjs/common';
import { PettyCashController } from './pettycash.controller';
import { PettyCashService } from './pettycash.service';

// Numbering + audit modules are @Global() — services inject directly.
@Module({
  controllers: [PettyCashController],
  providers: [PettyCashService],
})
export class PettyCashModule {}
