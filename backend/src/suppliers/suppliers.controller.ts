import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UseGuards } from '@nestjs/common';
import { AnyPermission, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { SuppliersService } from './suppliers.service';
import { Actor } from '../org/org.service';

export class SupplierDto {
  @IsString() @MinLength(2) @MaxLength(128) name!: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class UpdateSupplierDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(128) name?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ContactLogDto {
  @IsOptional() @IsString() @MaxLength(120) person?: string;
  @IsOptional() @IsIn(['CALL', 'EMAIL', 'VISIT', 'TELEGRAM', 'OTHER']) channel?: string;
  @IsString() @MinLength(2) @MaxLength(500) summary!: string;
  @IsOptional() @IsString() followUpAt?: string;
  @IsOptional() @IsString() contactedAt?: string;
}

export class PoDraftDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsArray() lines!: { itemId: string; quantity: number; unitPrice?: number }[];
}

export class PoDraftUpdateDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsArray() lines?: { itemId: string; quantity: number; unitPrice?: number }[];
}

@ApiTags('suppliers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('suppliers')
export class SuppliersController {
  constructor(private suppliers: SuppliersService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  /** Supplier master list — active only by default, ?all=1 includes deactivated. */
  // OR: inventory.read (store view) or the dedicated suppliers.read
  @AnyPermission([PERMISSIONS.INVENTORY_READ], [PERMISSIONS.SUPPLIERS_READ])
  @Get()
  list(@Query('all') all?: string) {
    return this.suppliers.list(all === '1');
  }

  /** Purchase history for one supplier (Who/When/What of their PURCHASE txs). */
  @AnyPermission([PERMISSIONS.INVENTORY_READ], [PERMISSIONS.SUPPLIERS_READ])
  @Get(':id/history')
  history(@Param('id') id: string, @Query('start') start?: string, @Query('end') end?: string) {
    return this.suppliers.purchaseHistory(id, start || undefined, end || undefined);
  }

  @AnyPermission([PERMISSIONS.INVENTORY_MANAGE], [PERMISSIONS.SUPPLIERS_MANAGE])
  @Post()
  async create(@Req() req, @Body() dto: SupplierDto) {
    return this.suppliers.create(dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.INVENTORY_MANAGE], [PERMISSIONS.SUPPLIERS_MANAGE])
  @Patch(':id')
  async update(@Req() req, @Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.INVENTORY_MANAGE], [PERMISSIONS.SUPPLIERS_MANAGE])
  @Delete(':id')
  async remove(@Req() req, @Param('id') id: string) {
    return this.suppliers.remove(id, this.actor(req));
  }

  // ---------- vendor management (Purchasing) ----------

  @AnyPermission([PERMISSIONS.INVENTORY_READ], [PERMISSIONS.SUPPLIERS_READ])
  @Get(':id/contact-logs')
  contactLogs(@Param('id') id: string) {
    return this.suppliers.listContactLogs(id);
  }

  @AnyPermission([PERMISSIONS.INVENTORY_MANAGE], [PERMISSIONS.SUPPLIERS_MANAGE])
  @Post(':id/contact-logs')
  createContactLog(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: ContactLogDto,
  ) {
    return this.suppliers.createContactLog(id, dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.INVENTORY_MANAGE], [PERMISSIONS.SUPPLIERS_MANAGE])
  @Delete(':id/contact-logs/:logId')
  deleteContactLog(@Req() req, @Param('id') id: string, @Param('logId') logId: string) {
    return this.suppliers.deleteContactLog(id, logId, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.INVENTORY_READ], [PERMISSIONS.SUPPLIERS_READ])
  @Get(':id/po-drafts')
  poDrafts(@Param('id') id: string) {
    return this.suppliers.listPurchaseDrafts(id);
  }

  @AnyPermission([PERMISSIONS.INVENTORY_MANAGE], [PERMISSIONS.SUPPLIERS_MANAGE])
  @Post(':id/po-drafts')
  createPoDraft(@Req() req, @Param('id') id: string, @Body() dto: PoDraftDto) {
    return this.suppliers.createPurchaseDraft(id, dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.INVENTORY_MANAGE], [PERMISSIONS.SUPPLIERS_MANAGE])
  @Patch(':id/po-drafts/:draftId')
  updatePoDraft(@Req() req, @Param('id') id: string, @Param('draftId') draftId: string, @Body() dto: PoDraftUpdateDto) {
    return this.suppliers.updatePurchaseDraft(id, draftId, dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.INVENTORY_MANAGE], [PERMISSIONS.SUPPLIERS_MANAGE])
  @Delete(':id/po-drafts/:draftId')
  deletePoDraft(@Req() req, @Param('id') id: string, @Param('draftId') draftId: string) {
    return this.suppliers.deletePurchaseDraft(id, draftId, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.INVENTORY_MANAGE], [PERMISSIONS.SUPPLIERS_MANAGE])
  @Post(':id/po-drafts/:draftId/submit')
  submitPoDraft(@Req() req, @Param('id') id: string, @Param('draftId') draftId: string) {
    return this.suppliers.submitPurchaseDraft(id, draftId, this.actor(req));
  }
}
