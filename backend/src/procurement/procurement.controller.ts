import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
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
  @IsOptional() @IsISO8601() requiredDate?: string;
  @IsOptional() @IsIn(['NORMAL', 'URGENT']) priority?: string;
  @IsOptional() @IsString() @MaxLength(64) budgetCode?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PrItemDto)
  items!: PrItemDto[];
}

export class UpdatePurchaseRequestDto extends CreatePurchaseRequestDto {}

@ApiTags('procurement')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('procurement')
export class ProcurementController {
  constructor(private procurement: ProcurementService, private permissions: PermissionsService) {}

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

  // ---------- master CRUD (procurement.manage — accounts/assets seed data) ----------

  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  @Post('accounts')
  createAccount(@Req() req, @Body() body: { name: string; code?: string; categoryName?: string }) {
    return this.procurement.createAccount(body, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  @Patch('accounts/:id')
  updateAccount(@Req() req, @Param('id') id: string, @Body() body: { name?: string; active?: boolean }) {
    return this.procurement.updateAccount(id, body, this.actor(req));
  }
}
