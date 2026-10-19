import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
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

  @Post()
  @RequirePermissions(PERMISSIONS.PETTYCASH_MANAGE)
  create(@Req() req, @Body() dto: PettyCashDto) {
    return this.petty.create(dto, this.actor(req));
  }

  /** No edit — a wrong row is deleted (audited) and re-entered. */
  @Delete(':id')
  @RequirePermissions(PERMISSIONS.PETTYCASH_MANAGE)
  remove(@Req() req, @Param('id') id: string) {
    return this.petty.remove(id, this.actor(req));
  }
}
