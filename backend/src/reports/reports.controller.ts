import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports/procurement')
export class ReportsController {
  constructor(private reports: ReportsService) {}

  /** Document flow tiles (PR/PO/invoice + 3-way match) — §33/§44. */
  @Get('dashboard')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  dashboard() {
    return this.reports.dashboardTiles();
  }

  /** Vendor purchase report — real AP spend per supplier — §34. */
  @Get('vendors')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  vendors(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.vendorPurchaseReport(from, to);
  }

  /** Purchase by account — what the money was spent on — §33/§34. */
  @Get('accounts')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  accounts(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.purchaseByAccount(from, to);
  }

  /** Purchase by asset — cost history feeding — §33/§34. */
  @Get('assets')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  assets(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.purchaseByAsset(from, to);
  }

  /** Budget vs actual, one month — §9. */
  @Get('budget')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  budget(@Query('year') year?: string, @Query('month') month?: string) {
    const now = new Date();
    return this.reports.budgetVsActual(Number(year) || now.getUTCFullYear(), Number(month) || now.getUTCMonth() + 1);
  }
}
