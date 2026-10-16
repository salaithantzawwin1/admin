import { Module } from '@nestjs/common';
import { FleetComplianceService } from './compliance.service';

/**
 * Leaf module for the document-compliance rules (VMS §6.5/§7.3). It imports
 * nothing (PrismaService/AuditService are @Global), so FleetModule and
 * CarsModule can both depend on it without ever creating an import cycle.
 */
@Module({
  providers: [FleetComplianceService],
  exports: [FleetComplianceService],
})
export class FleetComplianceModule {}
