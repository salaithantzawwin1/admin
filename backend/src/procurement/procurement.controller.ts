import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { PermissionsService } from '../auth/permissions.service';
import { ProcurementService, CreatePrInput } from './procurement.service';
import { Actor } from '../org/org.service';

class PrItemDto {
  @IsString() @MinLength(1) @MaxLength(200) description!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsString() @MaxLength(32) unit?: string;
  @IsOptional() estimatedUnitPrice?: number;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsString() assetId?: string;
}

export class CreatePurchaseRequestDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) justification?: string;
  @IsOptional() @IsString() @MaxLength(32) requiredDate?: string;
  @IsOptional() @IsIn(['NORMAL', 'URGENT']) priority?: string;
  @IsOptional() @IsString() @MaxLength(64) budgetCode?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PrItemDto)
  items!: PrItemDto[];
}

export class UpdatePurchaseRequestDto extends CreatePurchaseRequestDto {}

class RfqVendorDto {
  @IsString() supplierId!: string;
}

class CreateRfqDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) specification?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsISO8601() dueDate?: string; // quotation due date (design §11)
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RfqVendorDto)
  vendors?: RfqVendorDto[];
}

class UpdateRfqDto extends CreateRfqDto {}

/** Chart-of-accounts master data (Settings → Accounts). Code optional + unique; '' clears it. */
class CreateAccountDto {
  @IsOptional() @IsString() @MaxLength(32) code?: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class UpdateAccountDto {
  @IsOptional() @IsString() @MaxLength(32) code?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class AddRfqVendorDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsInt() @Min(0) priority?: number;
  @IsOptional() @IsString() @MaxLength(200) contactReason?: string;
}

class QuotationItemDto {
  @IsString() @MinLength(1) @MaxLength(200) description!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsString() @MaxLength(32) unit?: string;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) taxPercent?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @IsOptional() @IsInt() @Min(0) deliveryDays?: number;
  @IsOptional() @IsInt() @Min(0) warrantyMonths?: number;
}

class AddQuotationDto {
  @IsString() supplierId!: string;
  @IsString() @MinLength(1) @MaxLength(100) quoteNumber!: string;
  @IsOptional() @IsISO8601() quoteDate?: string;
  @IsOptional() @IsISO8601() dueDate?: string; // promised delivery date
  @IsOptional() @IsISO8601() validUntil?: string;
  @IsOptional() @IsString() @MaxLength(200) paymentTerms?: string;
  @IsOptional() taxIncluded?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => QuotationItemDto)
  items!: QuotationItemDto[];
}

class CreateComparisonDto {
  @IsString() recommendedSupplierId!: string;
  @IsString() recommendedQuoteId!: string;
  @IsString() @MinLength(1) @MaxLength(2000) selectionReason!: string;
  @IsOptional() @IsString() @MaxLength(300) supportingDocument?: string;
}

@ApiTags('procurement')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('procurement')
export class ProcurementController {
  constructor(
    private procurement: ProcurementService,
    private permissions: PermissionsService,
  ) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  /** Same pattern as /requests list: office-wide visibility needs procurement.read. */
  private async canReadAll(req): Promise<boolean> {
    const granted = await this.permissions.forUser(req.user.id);
    return granted.includes(PERMISSIONS.PROCUREMENT_READ);
  }

  // ---------- master lookups (PR form pickers) ----------
  @Get('accounts')
  accounts(@Query('all') all?: string) {
    return this.procurement.listAccounts(all === '1');
  }

  @Get('account-categories')
  accountCategories() {
    return this.procurement.listAccountCategories();
  }

  // ---------- chart of accounts CRUD (Settings → Accounts) ----------
  @Post('accounts')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  createAccount(@Req() req, @Body() body: CreateAccountDto) {
    return this.procurement.createAccount(body, this.actor(req));
  }

  @Patch('accounts/:id')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  updateAccount(@Req() req, @Param('id') id: string, @Body() body: UpdateAccountDto) {
    return this.procurement.updateAccount(id, body, this.actor(req));
  }

  @Delete('accounts/:id')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  deleteAccount(@Req() req, @Param('id') id: string) {
    return this.procurement.deleteAccount(id, this.actor(req));
  }

  @Get('assets')
  assets() {
    return this.procurement.listAssets();
  }

  // ---------- purchase requests ----------
  @Get('requests')
  async list(
    @Req() req,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
  ) {
    return this.procurement.list({
      page: Number(page) || 1,
      pageSize: Math.min(Number(pageSize) || 50, 200),
      status,
      canReadAll: await this.canReadAll(req),
      actor: this.actor(req),
    });
  }

  @Get('requests/:requestId')
  async byRequest(@Req() req, @Param('requestId') requestId: string) {
    return this.procurement.byRequest(requestId, {
      ...this.actor(req),
      canReadAll: await this.canReadAll(req),
    });
  }

  @Post('requests')
  create(@Req() req, @Body() body: CreatePurchaseRequestDto) {
    return this.procurement.create(body as CreatePrInput, this.actor(req));
  }

  @Patch('requests/:requestId')
  update(@Req() req, @Param('requestId') requestId: string, @Body() body: UpdatePurchaseRequestDto) {
    return this.procurement.update(requestId, body as CreatePrInput, this.actor(req));
  }

  // ---------- RFQ (design §11): Request for Quotation ----------
  @Get('rfqs')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  async rfqs(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.procurement.listRfqs({
      page: Number(page) || 1,
      pageSize: Math.min(Number(pageSize) || 20, 100),
    });
  }

  @Get('rfqs/:rfqId')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  async rfq(@Req() req, @Param('rfqId') rfqId: string) {
    return this.procurement.byRfq(rfqId, {
      ...this.actor(req),
      canReadAll: await this.canReadAll(req),
    });
  }

  @Post('rfqs')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  createRfq(@Req() req, @Body() body: CreateRfqDto) {
    return this.procurement.createRfq(body, this.actor(req));
  }

  @Patch('rfqs/:rfqId')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  updateRfq(@Req() req, @Param('rfqId') rfqId: string, @Body() body: UpdateRfqDto) {
    return this.procurement.updateRfq(rfqId, body, this.actor(req));
  }

  @Patch('rfqs/:rfqId/status')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  rfqStatus(@Req() req, @Param('rfqId') rfqId: string, @Body() body: { status: string }) {
    return this.procurement.updateRfqStatus(rfqId, body?.status, this.actor(req));
  }

  @Patch('rfqs/:rfqId/close')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  closeRfq(@Req() req, @Param('rfqId') rfqId: string) {
    return this.procurement.closeRfq(rfqId, this.actor(req));
  }

  // ---------- RFQ vendors (design §11) ----------
  @Get('rfqs/:rfqId/vendors')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  rfqVendors(@Param('rfqId') rfqId: string) {
    return this.procurement.listRfqVendors(rfqId);
  }

  @Post('rfqs/:rfqId/vendors')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  addRfqVendor(@Req() req, @Param('rfqId') rfqId: string, @Body() body: AddRfqVendorDto) {
    return this.procurement.addRfqVendor(rfqId, body, this.actor(req));
  }

  // ---------- Vendor quotation (design §12) ----------
  @Get('rfqs/:rfqId/quotations')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  rfqQuotations(@Param('rfqId') rfqId: string) {
    return this.procurement.listQuotations(rfqId);
  }

  @Post('rfqs/:rfqId/quotations')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  addQuotation(@Req() req, @Param('rfqId') rfqId: string, @Body() body: AddQuotationDto) {
    return this.procurement.addQuotation(rfqId, body, this.actor(req));
  }

  /** Live comparison view (design §13) — quotes sorted by net total. */
  @Get('rfqs/:rfqId/comparison')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  rfqComparisonSummary(@Param('rfqId') rfqId: string) {
    return this.procurement.compareQuotations(rfqId);
  }

  // ---------- Comparison decision (design §13-14) ----------
  @Get('rfqs/:rfqId/decision')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  rfqDecision(@Param('rfqId') rfqId: string) {
    return this.procurement.findComparison(rfqId);
  }

  @Post('rfqs/:rfqId/decision')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  createComparison(@Req() req, @Param('rfqId') rfqId: string, @Body() body: CreateComparisonDto) {
    return this.procurement.createComparison(rfqId, body, this.actor(req));
  }
}
