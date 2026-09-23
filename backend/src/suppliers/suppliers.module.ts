import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
