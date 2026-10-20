import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { PAYMENT_METHODS, PaymentsService } from './payments.service';

class RecordPaymentDto {
  @IsString() invoiceId!: string;
  @IsNumber() @Min(0.01, { message: 'amount must be greater than 0' }) amount!: number;
  /** Payment date (defaults to now). */
  @IsOptional() @IsDateString() date?: string;
  @IsIn(PAYMENT_METHODS as unknown as string[]) method!: string;
  @IsOptional() @IsString() @MaxLength(160) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@ApiBearerAuth()
@ApiTags('payments')
@UseGuards(JwtAuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private payments: PaymentsService) {}

  /** Payment register (§26) — PY-coded rows with their invoice rollup. */
  @Get()
  @RequirePermissions(PERMISSIONS.PAYMENTS_READ)
  list(
    @Query('page') page = '1', @Query('pageSize') pageSize = '20',
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('supplierId') supplierId?: string, @Query('status') status?: string,
  ) {
    return this.payments.list({
      page: Number(page) || 1, pageSize: Math.min(Number(pageSize) || 20, 100),
      from, to, supplierId, status,
    });
  }

  /** Outstanding invoices (balance > 0, overdue first) — also the record-payment picker. */
  @Get('payables')
  @RequirePermissions(PERMISSIONS.PAYMENTS_READ)
  payables(@Query('from') from?: string, @Query('to') to?: string, @Query('supplierId') supplierId?: string) {
    return this.payments.payables({ from, to, supplierId });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PAYMENTS_READ)
  byId(@Param('id') id: string) {
    return this.payments.byId(id);
  }

  /** Finance records a payment against an APPROVED/POSTED invoice. */
  @Post()
  @RequirePermissions(PERMISSIONS.PAYMENTS_MANAGE)
  record(@Body() dto: RecordPaymentDto, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.payments.record(dto, { userId: user.id, username: user.username });
  }

  /** No edit — a wrong payment is deleted (audited) and re-entered. */
  @Delete(':id')
  @RequirePermissions(PERMISSIONS.PAYMENTS_MANAGE)
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { id: string; username: string };
    return this.payments.remove(id, { userId: user.id, username: user.username });
  }
}
