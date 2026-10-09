import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsISO8601, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { PurchaseOrdersService } from './purchase-orders.service';

class PoItemDto {
  @IsString() @MinLength(1) @MaxLength(200) description!: string;
  @IsOptional() @IsString() inventoryItemId?: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsString() @MaxLength(32) unit?: string;
  @IsNumber() @Min(0) unitPrice!: number;
}

class CreatePoDto {
  @IsOptional() @IsString() purchaseRequestId?: string;
  @IsString() supplierId!: string;
  @IsOptional() @IsISO8601() expectedDelivery?: string;
  @IsOptional() @IsString() @MaxLength(300) deliveryAddress?: string;
  @IsOptional() @IsString() @MaxLength(200) paymentTerms?: string;
  @IsOptional() @IsString() @MaxLength(200) deliveryTerms?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PoItemDto)
  items!: PoItemDto[];
}

class GrnLineDto {
  @IsString() poItemId!: string;
  @IsInt() @Min(0) receivedQty!: number;
  @IsInt() @Min(0) acceptedQty!: number;
  @IsOptional() @IsInt() @Min(0) rejectedQty?: number;
  @IsOptional() @IsString() @MaxLength(300) condition?: string;
}

class CreateGrnDto {
  @IsOptional() @IsString() deliveryNoteNo?: string;
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsString() @MaxLength(1000) remarks?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => GrnLineDto)
  items!: GrnLineDto[];
}

@ApiBearerAuth()
@ApiTags('purchase-orders')
@UseGuards(JwtAuthGuard)
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private po: PurchaseOrdersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  list(@Query('page') page = '1', @Query('pageSize') pageSize = '20', @Query('status') status?: string) {
    return this.po.list({ page: Number(page) || 1, pageSize: Math.min(Number(pageSize) || 20, 100), status });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  detail(@Param('id') id: string) {
    return this.po.byId(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  create(@Body() dto: CreatePoDto, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.po.create(dto, { userId: user.id, username: user.username });
  }

  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  approve(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.po.transition(id, 'approve', { userId: user.id, username: user.username });
  }

  @Post(':id/send')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  send(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.po.transition(id, 'send', { userId: user.id, username: user.username });
  }

  @Post(':id/close')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  close(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.po.transition(id, 'close', { userId: user.id, username: user.username });
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  cancel(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.po.transition(id, 'cancel', { userId: user.id, username: user.username });
  }

  @Post(':id/grn')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  createGrn(@Param('id') id: string, @Body() dto: CreateGrnDto, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.po.createGrn(id, dto, { userId: user.id, username: user.username });
  }
}
