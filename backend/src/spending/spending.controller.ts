import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsDateString, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnyPermission } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { SpendingService } from './spending.service';
import { Actor } from '../org/org.service';

/**
 * One spend entry — the money, the machine it was for, the service it paid for
 * and any stock it consumed, all in one submission. Gated on either money or
 * asset rights: whoever may record petty cash OR administer assets can use it,
 * and the service refuses the parts the actor may not touch.
 */
export class SpendEntryDto {
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  /** Total paid. Omit when the entry is only stock taken from the store. */
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsOptional() @IsString() @MaxLength(160) payee?: string;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsString() supplierId?: string;
  /** PETTY_CASH writes the petty-cash ledger row; OTHER just records the spend. */
  @IsOptional() @IsIn(['PETTY_CASH', 'OTHER']) paidFrom?: string;
  @IsOptional() @IsString() assetId?: string;
  @IsOptional() @IsIn(['SERVICE', 'REPAIR', 'PART', 'CONSUMABLE', 'PURCHASE', 'OTHER']) costKind?: string;
  /** Optional service log: { type, problem, workDone, nextDueDate }. */
  @IsOptional() @IsObject() maintenance?: {
    type?: string; problem?: string; workDone?: string; nextDueDate?: string;
  };
  /** Stock taken from the store: [{ itemId, quantity }]. */
  @IsOptional() @IsArray() stockLines?: { itemId: string; quantity: number }[];
  /** Bought into the store: [{ itemId, quantity, unitPrice }]. */
  @IsOptional() @IsArray() purchaseLines?: { itemId: string; quantity: number; unitPrice?: number }[];
}

@ApiTags('spending')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('spending')
export class SpendingController {
  constructor(private spending: SpendingService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  @Post('entries')
  @AnyPermission([PERMISSIONS.PETTYCASH_MANAGE], [PERMISSIONS.ASSETS_MANAGE])
  create(@Req() req, @Body() dto: SpendEntryDto) {
    return this.spending.create(dto, this.actor(req));
  }
}
