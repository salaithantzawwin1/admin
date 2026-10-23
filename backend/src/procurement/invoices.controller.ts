import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsISO8601, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions, AnyPermission } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { InvoicesService } from './invoices.service';

class InvoiceItemDto {
  @IsString() @MinLength(1) @MaxLength(200) description!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsString() @MaxLength(32) unit?: string;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsString() assetId?: string;
}

class CreateInvoiceDto {
  @IsString() supplierId!: string;
  @IsString() @MinLength(1) @MaxLength(100) supplierInvoiceNumber!: string;
  @IsISO8601() invoiceDate!: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsString() purchaseOrderId?: string;
  @IsOptional() @IsString() goodsReceiptId?: string;
  @IsOptional() @IsNumber() @Min(0) tax?: number;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  items!: InvoiceItemDto[];
}

@ApiBearerAuth()
@ApiTags('invoices')
@UseGuards(JwtAuthGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private invoices: InvoicesService) {}

  // The AP ledger carries supplier names + amounts, so the gate mirrors the
  // sidebar exactly (procurement.read | procurement.manage). The inventory.read
  // leg was the same bypass class as the /inventory/suppliers alias: every
  // default role holds inventory.read, so revoking procurement.read for FINANCE
  // in the matrix still leaked every invoice through this route.
  @Get()
  @AnyPermission([PERMISSIONS.PROCUREMENT_READ], [PERMISSIONS.PROCUREMENT_MANAGE])
  list(@Query('page') page = '1', @Query('pageSize') pageSize = '20', @Query('status') status?: string) {
    return this.invoices.list({ page: Number(page) || 1, pageSize: Math.min(Number(pageSize) || 20, 100), status });
  }

  @Get('recalc/:id')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  recalc(@Param('id') id: string) {
    return this.invoices.recomputeMatch(id);
  }

  @Get(':id')
  @AnyPermission([PERMISSIONS.PROCUREMENT_READ], [PERMISSIONS.PROCUREMENT_MANAGE])
  detail(@Param('id') id: string) {
    return this.invoices.byId(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  create(@Body() dto: CreateInvoiceDto, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.invoices.create(dto, { userId: user.id, username: user.username });
  }

  @Post('create-and-submit')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  createAndSubmit(@Body() dto: CreateInvoiceDto, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.invoices.createAndSubmit(dto, { userId: user.id, username: user.username });
  }

  @Post(':id/submit')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  submit(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.invoices.transition(id, 'submit', { userId: user.id, username: user.username });
  }

  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  approve(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.invoices.transition(id, 'approve', { userId: user.id, username: user.username });
  }

  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  reject(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.invoices.transition(id, 'reject', { userId: user.id, username: user.username });
  }

  @Post(':id/post')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  post(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.invoices.transition(id, 'post', { userId: user.id, username: user.username });
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  cancel(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.invoices.transition(id, 'cancel', { userId: user.id, username: user.username });
  }

  @Post(':id/redraft')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  redraft(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.invoices.transition(id, 'redraft', { userId: user.id, username: user.username });
  }
}
