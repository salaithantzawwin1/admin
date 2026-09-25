import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DriverStatus, VehicleStatus, VehicleType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { FleetService } from './fleet.service';
import { Actor } from '../org/org.service';

class VehicleTypeDto {
  @IsString() @MinLength(2) @MaxLength(32) name!: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class VehicleTypeUpdateDto {
  @IsOptional() @IsBoolean() active?: boolean;
}

class VehicleDto {
  @IsString() @MinLength(2) @MaxLength(32) vehicleNo!: string;
  @IsIn(Object.values(VehicleType)) vehicleType!: VehicleType;
  @IsString() @MinLength(2) @MaxLength(64) brandModel!: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) capacity?: number;
  @IsOptional() @IsString() driverId?: string;
  @IsOptional() @IsDateString() registrationExpiry?: string;
  @IsOptional() @IsDateString() insuranceExpiry?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

class VehicleUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(64) brandModel?: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) capacity?: number;
  /** null clears the default driver ("blank"); undefined leaves it unchanged. */
  @IsOptional() @IsString() driverId?: string | null;
  @IsOptional() @IsIn(Object.values(VehicleStatus)) status?: VehicleStatus;
  @IsOptional() @IsDateString() registrationExpiry?: string;
  @IsOptional() @IsDateString() insuranceExpiry?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsInt() @Min(0) currentMileage?: number;
}

class DriverDto {
  @IsString() @MinLength(2) @MaxLength(128) name!: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(64) licenseNo?: string;
  @IsOptional() @IsDateString() licenseExpiry?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

class AbsenceDto {
  @IsString() driverId!: string;
  /** Calendar day of the leave (YYYY-MM-DD) — clock times come from the Company Time Table. */
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @IsIn(['FULL', 'HALF']) dayType!: 'FULL' | 'HALF';
  /** Required for HALF: which half of the working day. */
  @IsIn(['FULL_DAY', 'MORNING', 'EVENING']) period!: 'FULL_DAY' | 'MORNING' | 'EVENING';
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class AbsenceUpdateDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @IsIn(['FULL', 'HALF']) dayType!: 'FULL' | 'HALF';
  @IsIn(['FULL_DAY', 'MORNING', 'EVENING']) period!: 'FULL_DAY' | 'MORNING' | 'EVENING';
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class DriverUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(128) name?: string;
  /** null clears the field ("blank"); undefined leaves it unchanged. */
  @IsOptional() @IsString() @MaxLength(32) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(64) licenseNo?: string | null;
  @IsOptional() @IsDateString() licenseExpiry?: string;
  @IsOptional() @IsIn(Object.values(DriverStatus)) status?: DriverStatus;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

@ApiTags('fleet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('fleet')
export class FleetController {
  constructor(private fleet: FleetService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  // ---------- read: any authenticated user ----------
  @Get('vehicles')
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  vehicles(@Query('status') status?: VehicleStatus) {
    return this.fleet.listVehicles(status);
  }

  @Get('vehicles/:id')
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  vehicleDetail(@Param('id') id: string) {
    return this.fleet.vehicleDetail(id);
  }

  @Get('drivers')
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  drivers(@Query('status') status?: DriverStatus) {
    return this.fleet.listDrivers(status);
  }

  /** Driver ids busy over a window (web picker + Telegram picker exclusion list). */
  @Get('drivers/busy')
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  busyDrivers(@Query('start') start?: string, @Query('end') end?: string) {
    const s = start ? new Date(start) : new Date(0);
    const e = end ? new Date(end) : new Date('9999-12-31');
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      return [];
    }
    return this.fleet.busyDriverIds(s, e);
  }

  // ---------- vehicle type master data (Plan §6 — no hard-coded lists) ----------

  /** Active types drive the pickers; managers also see inactive ones. */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('vehicle-types')
  vehicleTypes() {
    return this.fleet.listVehicleTypes();
  }

  @RequirePermissions(PERMISSIONS.FLEET_TYPES_MANAGE)
  @Post('vehicle-types')
  createVehicleType(@Req() req, @Body() dto: VehicleTypeDto) {
    return this.fleet.createVehicleType(dto.name.trim().toUpperCase().replace(/\s+/g, '_'), this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_TYPES_MANAGE)
  @Patch('vehicle-types/:id')
  async updateVehicleType(@Req() req, @Param('id') id: string, @Body() dto: VehicleTypeUpdateDto) {
    return this.fleet.updateVehicleType(id, { active: dto.active }, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_TYPES_MANAGE)
  @Delete('vehicle-types/:id')
  deleteVehicleType(@Req() req, @Param('id') id: string) {
    return this.fleet.deleteVehicleType(id, this.actor(req));
  }

  // ---------- write: SYSTEM_ADMIN or ADMINISTRATION ----------
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Post('vehicles')
  createVehicle(@Req() req, @Body() dto: VehicleDto) {
    return this.fleet.createVehicle(dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Patch('vehicles/:id')
  updateVehicle(@Req() req, @Param('id') id: string, @Body() dto: VehicleUpdateDto) {
    return this.fleet.updateVehicle(id, dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Delete('vehicles/:id')
  deleteVehicle(@Req() req, @Param('id') id: string) {
    return this.fleet.deleteVehicle(id, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Post('drivers')
  createDriver(@Req() req, @Body() dto: DriverDto) {
    return this.fleet.createDriver(dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Patch('drivers/:id')
  updateDriver(@Req() req, @Param('id') id: string, @Body() dto: DriverUpdateDto) {
    return this.fleet.updateDriver(id, dto, this.actor(req));
  }

  /** Link this driver to an employee record (driver = a staff member). */
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Put('drivers/:id/employee')
  linkEmployee(@Req() req, @Param('id') id: string, @Body() body: { employeeId: string }) {
    if (!body?.employeeId) throw new BadRequestException('employeeId is required');
    return this.fleet.linkEmployee(id, body.employeeId, this.actor(req));
  }

  /** Remove the driver ↔ employee link. */
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Delete('drivers/:id/employee')
  unlinkEmployee(@Req() req, @Param('id') id: string) {
    return this.fleet.unlinkEmployee(id, this.actor(req));
  }

  /** Correlated assignment history — driver + linked employee merged. */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('drivers/:id/correlated-history')
  correlatedHistory(@Param('id') id: string) {
    return this.fleet.correlatedHistory(id);
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Delete('drivers/:id')
  deleteDriver(@Req() req, @Param('id') id: string) {
    return this.fleet.deleteDriver(id, this.actor(req));
  }

  /** Telegram binding state (bind codes) — fleet managers only. */
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Get('drivers/telegram-bindings')
  telegramBindings() {
    return this.fleet.listTelegramBindings();
  }

  /** Telegram: generate a new bind code — driver sends "/start <code>" to the bot. */
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Post('drivers/:id/telegram-bind-code')
  regenerateBindCode(@Req() req, @Param('id') id: string) {
    return this.fleet.regenerateBindCode(id, this.actor(req));
  }

  // ---------- driver absences (planned non-availability) ----------

  /** Planned absences — ACTIVE by default; ?all=true includes cancelled. */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('absences')
  absences(@Query('all') all?: string) {
    return this.fleet.listAbsences(all === 'true');
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Post('absences')
  async createAbsence(@Req() req, @Body() dto: AbsenceDto) {
    try {
      return await this.fleet.createAbsence(
        { driverId: dto.driverId, date: dto.date, dayType: dto.dayType, period: dto.period, reason: dto.reason?.trim() || undefined },
        this.actor(req),
      );
    } catch (e) {
      if ((e as Error).message.includes('after start') || (e as Error).message.includes('not found') || (e as Error).message.includes('must be')) throw new BadRequestException((e as Error).message);
      throw new ConflictException((e as Error).message);
    }
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Patch('absences/:id')
  async updateAbsence(@Req() req, @Param('id') id: string, @Body() dto: AbsenceUpdateDto) {
    try {
      return await this.fleet.updateAbsence(
        id,
        { date: dto.date, dayType: dto.dayType, period: dto.period, reason: dto.reason?.trim() || undefined },
        this.actor(req),
      );
    } catch (e) {
      if ((e as Error).message.includes('after start') || (e as Error).message.includes('not found') || (e as Error).message.includes('must be')) throw new BadRequestException((e as Error).message);
      throw new ConflictException((e as Error).message);
    }
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Post('absences/:id/cancel')
  cancelAbsence(@Req() req, @Param('id') id: string) {
    return this.fleet.cancelAbsence(id, this.actor(req));
  }

  /** Delete outright (admin cleanup) — unlike cancel, the row is removed. */
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Delete('absences/:id')
  deleteAbsence(@Req() req, @Param('id') id: string) {
    return this.fleet.deleteAbsence(id, this.actor(req));
  }
}
