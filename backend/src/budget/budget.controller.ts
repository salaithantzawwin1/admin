import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { BudgetService, SetBudgetInput } from './budget.service';

class SetBudgetDto {
  @IsString() accountId!: string;
  @IsInt() @Min(2000) year!: number;
  @IsInt() @IsIn([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) month!: number;
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

@ApiTags('budgets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('budgets')
export class BudgetController {
  constructor(private budget: BudgetService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  list(
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('accountId') accountId?: string,
  ) {
    const now = new Date();
    return this.budget.list({
      year: Number(year) || now.getUTCFullYear(),
      month: month ? Number(month) : undefined,
      accountId,
    });
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  set(@Req() req: Request, @Body() dto: SetBudgetDto) {
    const user = req.user as { id: string; username: string };
    return this.budget.set(dto as SetBudgetInput, { userId: user.id, username: user.username });
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_MANAGE)
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as { id: string; username: string };
    return this.budget.remove(id, { userId: user.id, username: user.username });
  }
}
