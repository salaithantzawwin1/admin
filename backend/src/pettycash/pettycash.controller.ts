import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnyPermission, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { PettyCashService } from './pettycash.service';
import { Actor } from '../org/org.service';

export class PettyCashDto {
  @IsIn(['TOPUP', 'EXPENSE']) type!: string;
  @IsNumber() @Min(0.01, { message: 'amount must be greater than 0' }) amount!: number;
  /** Ledger date (defaults to now). */
  @IsOptional() @IsDateString() date?: string;
  /** Paid-to (expense) / drawn-from (top-up). */
  @IsOptional() @IsString() @MaxLength(160) payee?: string;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(500) description?: string;
  /** v2 P1-1: the bill this expense settled (EXPENSE only). */
  @IsOptional() @IsString() invoiceId?: string;
}

export class LinkInvoiceDto {
  @IsString() @IsNotEmpty() invoiceId!: string;
}

@ApiTags('petty-cash')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('petty-cash')
export class PettyCashController {
  constructor(private petty: PettyCashService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  /** { items, totals: { topup, expense, balance } } — balance is always computed. */
  @Get()
  @RequirePermissions(PERMISSIONS.PETTYCASH_READ)
  list(@Query('from') from?: string, @Query('to') to?: string, @Query('type') type?: string) {
    return this.petty.list({ from, to, type });
  }

  /** §41 report export (respects from/to). */
  @Get('csv')
  @RequirePermissions(PERMISSIONS.PETTYCASH_READ)
  async csv(@Query('from') from?: string, @Query('to') to?: string, @Res() res: Response = undefined as never) {
    const body = await this.petty.csv({ from, to });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="petty-cash-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(body);
  }

  /**
   * v2 P1-1: unlinked expenses that plausibly settled this invoice — the picker
   * behind "Link petty-cash expense". Read-only; must be declared before ':id'.
   */
  @Get('linkable/:invoiceId')
  @AnyPermission(
    [PERMISSIONS.PETTYCASH_READ],
    [PERMISSIONS.PAYMENTS_READ],
    [PERMISSIONS.PROCUREMENT_READ],
    [PERMISSIONS.PROCUREMENT_MANAGE],
  )
  linkable(@Param('invoiceId') invoiceId: string) {
    return this.petty.linkable(invoiceId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PETTYCASH_MANAGE)
  create(@Req() req, @Body() dto: PettyCashDto) {
    return this.petty.create(dto, this.actor(req));
  }

  /** v2 P1-1: link an expense already in the ledger to the bill it paid. */
  @Post(':id/link-invoice')
  @AnyPermission([PERMISSIONS.PETTYCASH_MANAGE], [PERMISSIONS.PAYMENTS_MANAGE])
  linkInvoice(@Req() req, @Param('id') id: string, @Body() dto: LinkInvoiceDto) {
    return this.petty.linkInvoice(id, dto.invoiceId, this.actor(req));
  }

  /** No edit — a wrong row is deleted (audited) and re-entered. */
  @Delete(':id')
  @RequirePermissions(PERMISSIONS.PETTYCASH_MANAGE)
  remove(@Req() req, @Param('id') id: string) {
    return this.petty.remove(id, this.actor(req));
  }
}
