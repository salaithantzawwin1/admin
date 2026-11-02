import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { MAINTENANCE_STATUSES, MAINTENANCE_TYPES, MaintenanceService } from './maintenance.service';
import { Actor } from '../org/org.service';

// ---------- §13/§14 maintenance record (service history) ----------

export class MaintenanceRecordDto {
  @IsString() assetId!: string;
  @IsOptional() @IsIn(MAINTENANCE_TYPES as unknown as string[]) type?: string;
  @IsOptional() @IsIn(MAINTENANCE_STATUSES as unknown as string[]) status?: string;
  /** Service date — drives the MRC-YYMM stamp and the history order. */
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsString() @MaxLength(2000) problem?: string;
  @IsOptional() @IsString() @MaxLength(2000) workDone?: string;
  @IsOptional() @IsString() vendorId?: string;
  @IsOptional() @IsString() @MaxLength(160) technician?: string;
  @IsOptional() @IsNumber() @Min(0) costParts?: number;
  @IsOptional() @IsNumber() @Min(0) costLabor?: number;
  @IsOptional() @IsNumber() @Min(0) costOther?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000) downtimeHours?: number;
  @IsOptional() @IsDateString() warrantyEndDate?: string;
  @IsOptional() @IsDateString() nextDueDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** Every field optional; null clears a text/date field, undefined leaves it. */
export class MaintenanceRecordUpdateDto {
  @IsOptional() @IsIn(MAINTENANCE_TYPES as unknown as string[]) type?: string;
  @IsOptional() @IsIn(MAINTENANCE_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsString() @MaxLength(2000) problem?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) workDone?: string | null;
  @IsOptional() @IsString() vendorId?: string | null;
  @IsOptional() @IsString() @MaxLength(160) technician?: string | null;
  @IsOptional() @IsNumber() @Min(0) costParts?: number;
  @IsOptional() @IsNumber() @Min(0) costLabor?: number;
  @IsOptional() @IsNumber() @Min(0) costOther?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000) downtimeHours?: number | null;
  @IsOptional() @IsDateString() warrantyEndDate?: string | null;
  @IsOptional() @IsDateString() nextDueDate?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
}

// ---------- §15 preventive schedules ----------

export class MaintenanceScheduleDto {
  @IsString() assetId!: string;
  @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @IsInt() @Min(1) @Max(120) intervalMonths!: number;
  @IsOptional() @IsDateString() lastDoneAt?: string;
  /** Omit to derive it from lastDoneAt + intervalMonths. */
  @IsOptional() @IsDateString() nextDueAt?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class MaintenanceScheduleUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) title?: string;
  @IsOptional() @IsInt() @Min(1) @Max(120) intervalMonths?: number;
  @IsOptional() @IsDateString() lastDoneAt?: string | null;
  @IsOptional() @IsDateString() nextDueAt?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}

export class ScheduleDoneDto {
  /** When the service actually happened; defaults to today. */
  @IsOptional() @IsDateString() doneAt?: string;
}

@ApiTags('maintenance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('maintenance')
export class MaintenanceController {
  constructor(private maintenance: MaintenanceService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  /** Service history — newest first, optionally scoped to one asset. */
  @Get('records')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_READ)
  list(
    @Query('assetId') assetId?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.maintenance.list({ assetId, type, from, to });
  }

  /** Overdue / due-soon counts for the page header tile. */
  @Get('summary')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_READ)
  summary() {
    return this.maintenance.summary();
  }

  @Get('records/:id')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_READ)
  detail(@Param('id') id: string) {
    return this.maintenance.detail(id);
  }

  @Post('records')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_MANAGE)
  create(@Req() req, @Body() dto: MaintenanceRecordDto) {
    return this.maintenance.create(dto, this.actor(req));
  }

  @Patch('records/:id')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_MANAGE)
  update(@Req() req, @Param('id') id: string, @Body() dto: MaintenanceRecordUpdateDto) {
    return this.maintenance.update(id, dto, this.actor(req));
  }

  @Delete('records/:id')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_MANAGE)
  remove(@Req() req, @Param('id') id: string) {
    return this.maintenance.remove(id, this.actor(req));
  }

  /** Preventive schedules with their due state (OVERDUE / DUE_SOON / OK). */
  @Get('schedules')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_READ)
  schedules(@Query('assetId') assetId?: string, @Query('dueOnly') dueOnly?: string) {
    return this.maintenance.listSchedules({ assetId, dueOnly: dueOnly === '1' || dueOnly === 'true' });
  }

  @Post('schedules')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_MANAGE)
  createSchedule(@Req() req, @Body() dto: MaintenanceScheduleDto) {
    return this.maintenance.createSchedule(dto, this.actor(req));
  }

  @Patch('schedules/:id')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_MANAGE)
  updateSchedule(@Req() req, @Param('id') id: string, @Body() dto: MaintenanceScheduleUpdateDto) {
    return this.maintenance.updateSchedule(id, dto, this.actor(req));
  }

  /** "Service done" — rolls the schedule forward one interval. */
  @Post('schedules/:id/done')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_MANAGE)
  completeSchedule(@Req() req, @Param('id') id: string, @Body() dto: ScheduleDoneDto) {
    return this.maintenance.completeSchedule(id, dto, this.actor(req));
  }

  @Delete('schedules/:id')
  @RequirePermissions(PERMISSIONS.MAINTENANCE_MANAGE)
  removeSchedule(@Req() req, @Param('id') id: string) {
    return this.maintenance.removeSchedule(id, this.actor(req));
  }
}
