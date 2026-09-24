import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnyPermission, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { InventoryService } from './inventory.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { Actor } from '../org/org.service';

export class CreateItemDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @IsIn(['STATIONERY', 'BOOKS', 'PAPER', 'ELECTRONICS', 'CLEANING', 'KITCHEN', 'FURNITURE', 'IT_SUPPLIES', 'OTHER']) category?: string;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;
  @IsOptional() @IsInt() @Min(0) balance?: number;
  @IsOptional() @IsInt() @Min(0) minStock?: number;
  @IsOptional() @IsInt() @Min(0) reorderLevel?: number;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class UpdateItemDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(['STATIONERY', 'BOOKS', 'PAPER', 'ELECTRONICS', 'CLEANING', 'KITCHEN', 'FURNITURE', 'IT_SUPPLIES', 'OTHER']) category?: string;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;
  @IsOptional() @IsInt() @Min(0) minStock?: number;
  @IsOptional() @IsInt() @Min(0) reorderLevel?: number;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class IssueRequestDto {
  @IsArray() items!: { itemId: string; quantity: number }[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RestockDto {
  @IsString() itemId!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @IsOptional() @Min(0) unitPrice?: number; // price per unit (spending report)
  @IsOptional() @IsString() @MaxLength(120) supplier?: string; // legacy free-text fallback
  @IsOptional() @IsString() supplierId?: string; // Supplier master id (preferred)
}

export class SupplierDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class UpdateSupplierDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('inventory')
export class InventoryController {
  constructor(private inventory: InventoryService, private suppliers: SuppliersService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  // ---------- items ----------
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get('items')
  items() {
    return this.inventory.itemsWithAlerts();
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('items')
  createItem(@Req() req, @Body() dto: CreateItemDto) {
    return this.inventory.createItem(dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Patch('items/:id')
  updateItem(@Req() req, @Param('id') id: string, @Body() dto: UpdateItemDto) {
    return this.inventory.updateItem(id, dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Delete('items/:id')
  deleteItem(@Req() req, @Param('id') id: string) {
    return this.inventory.deleteItem(id, this.actor(req));
  }

  // ---------- item images ----------
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('items/:id/image')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  setImage(@Req() req, @Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.inventory.setImage(id, file, this.actor(req));
  }

  /**
   * Item thumbnails render in plain <img> tags (no custom headers possible),
   * so auth happens via ?token=<JWT> picked up by JwtAuthGuard — no longer public.
   */
  @Get('items/:id/image')
  getImage(@Param('id') id: string, @Query('token') _token?: string, @Res() res?: Response) {
    return this.inventory.getImage(id).then(({ filePath, mime }) => {
      res!.setHeader('Content-Type', mime);
      res!.setHeader('Cache-Control', 'private, max-age=300');
      fs.createReadStream(filePath).pipe(res!);
    });
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Delete('items/:id/image')
  removeImage(@Req() req, @Param('id') id: string) {
    return this.inventory.removeImage(id, this.actor(req));
  }

  // ---------- issue requests ----------
  @RequirePermissions(PERMISSIONS.REQUESTS_CREATE)
  @Post('requests')
  createIssueRequest(@Req() req, @Body() dto: IssueRequestDto) {
    return this.inventory.createIssueRequest(dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.REQUESTS_READ_OWN)
  @Get('requests/mine')
  myRequests(@Req() req) {
    return this.inventory.myRequests(this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Get('requests/pending')
  pendingRequests() {
    return this.inventory.pendingRequests();
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('requests/:requestId/fulfill')
  fulfill(@Req() req, @Param('requestId') requestId: string) {
    return this.inventory.fulfill(requestId, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('requests/:requestId/reject')
  reject(@Req() req, @Param('requestId') requestId: string, @Body() body: { reason?: string }) {
    return this.inventory.rejectFulfillment(requestId, body.reason, this.actor(req));
  }

  /** Administration cancels an approved (not yet issued) supply request. */
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('requests/:requestId/admin-cancel')
  adminCancel(@Req() req, @Param('requestId') requestId: string, @Body() body: { reason?: string }) {
    return this.inventory.adminCancelSupply(requestId, body.reason, this.actor(req));
  }

  // ---------- restock ----------
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('restock')
  restock(@Req() req, @Body() dto: RestockDto) {
    return this.inventory.restock(dto, this.actor(req));
  }

  /** Spending per item for one month (defaults to the current month). */
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Get('spending')
  spending(@Query('start') start?: string, @Query('end') end?: string) {
    return this.inventory.spendingReport(start || undefined, end || undefined);
  }

  /** Lifetime purchased qty + cost per item. */
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Get('purchase-totals')
  purchaseTotals() {
    return this.inventory.purchaseTotals();
  }

  /** Monthly spending as CSV download. */
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Get('spending.csv')
  async spendingCsv(@Query('start') start?: string, @Query('end') end?: string, @Res() res?: Response) {
    const { filename, content } = await this.inventory.spendingCsv(start || undefined, end || undefined);
    res!.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res!.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res!.send(content);
  }

  /** Full movement ledger (Received/Issued + Who/When/What) for a month window. */
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get('ledger.csv')
  async ledgerCsv(@Query('start') start?: string, @Query('end') end?: string, @Res() res?: Response) {
    const { filename, content } = await this.inventory.ledgerCsv(start || undefined, end || undefined);
    res!.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res!.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res!.send(content);
  }

  /** Manual trigger for the low-stock alert pass (also runs daily at 08:00). */
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('low-stock/alert')
  alertNow(@Req() req) {
    return this.inventory.alertLowStock(this.actor(req));
  }

  /** Dashboard widget — most-issued items over the recent window. */
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get('movement-summary')
  movementSummary(@Query('days') days?: string) {
    return this.inventory.movementSummary(Number(days) || 30);
  }

  /** Auto-reorder queue — balance ≤ reorder level with suggested top-up qty. */
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Get('reorder-suggestions')
  reorderSuggestions() {
    return this.inventory.reorderSuggestions();
  }

  /** Manual trigger for the reorder alert pass (also runs daily at 08:00). */
  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('reorder/alert')
  reorderAlertNow(@Req() req) {
    return this.inventory.alertReorder();
  }

  /** Supplies issued to one employee (issued-items history on the Employees page). */
  @AnyPermission([PERMISSIONS.ORG_READ], [PERMISSIONS.EMPLOYEES_READ])
  @Get('employees/:id/issued-items')
  employeeIssuedItems(@Param('id') id: string) {
    return this.inventory.employeeIssuedItems(id);
  }

  // ---------- suppliers master (delegates to the standalone Suppliers module) ----------
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get('suppliers')
  listSuppliersAlias(@Query('all') all?: string) {
    return this.suppliers.list(all === '1');
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post('suppliers')
  createSupplier(@Req() req, @Body() dto: SupplierDto) {
    return this.suppliers.create(dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Patch('suppliers/:id')
  updateSupplier(@Req() req, @Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Delete('suppliers/:id')
  deleteSupplier(@Req() req, @Param('id') id: string) {
    return this.suppliers.remove(id, this.actor(req));
  }

  // ---------- history ----------
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get('items/:id/history')
  itemHistory(@Param('id') id: string) {
    return this.inventory.itemHistory(id);
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get('low-stock')
  lowStock() {
    return this.inventory.lowStock();
  }
}
