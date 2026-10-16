import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
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

// ---------- VMS Phase B — document register DTOs (spec §6.1/§6.2) ----------

const RENEWAL_STATUSES = ['NOT_STARTED', 'REQUESTED', 'IN_PROGRESS', 'NOT_REQUIRED'] as const; // RENEWED is written by the renew action

class DocumentTypeDto {
  @IsString() @MinLength(2) @MaxLength(64) code!: string;
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  /** null/omitted = applies to every vehicle type */
  @IsOptional() @IsIn([...Object.values(VehicleType), null]) vehicleType?: VehicleType | null;
  @IsOptional() @IsBoolean() mandatoryForDispatch?: boolean;
  @IsOptional() @IsBoolean() allowNoExpiry?: boolean;
  @IsOptional() @IsArray() @IsInt({ each: true }) warningDays?: number[];
  @IsOptional() @IsInt() @Min(0) @Max(999) sortOrder?: number;
}

class DocumentTypeUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsIn([...Object.values(VehicleType), null]) vehicleType?: VehicleType | null;
  @IsOptional() @IsBoolean() mandatoryForDispatch?: boolean;
  @IsOptional() @IsBoolean() allowNoExpiry?: boolean;
  @IsOptional() @IsArray() @IsInt({ each: true }) warningDays?: number[];
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(999) sortOrder?: number;
}

class VehicleDocumentDto {
  @IsString() documentTypeId!: string;
  @IsOptional() @IsString() @MaxLength(64) documentNo?: string;
  @IsOptional() @IsString() @MaxLength(128) issuingAuthority?: string;
  @IsOptional() @IsDateString() issueDate?: string;
  /** Required unless the type has allowNoExpiry (spec §6.2). */
  @IsOptional() @IsDateString() expiryDate?: string;
  @IsOptional() @IsIn(RENEWAL_STATUSES) renewalStatus?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsString() attachmentId?: string;
}

class VehicleDocumentUpdateDto {
  @IsOptional() @IsString() @MaxLength(64) documentNo?: string | null;
  @IsOptional() @IsString() @MaxLength(128) issuingAuthority?: string | null;
  @IsOptional() @IsDateString() issueDate?: string | null;
  @IsOptional() @IsDateString() expiryDate?: string | null;
  @IsOptional() @IsIn(RENEWAL_STATUSES) renewalStatus?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
  @IsOptional() @IsString() attachmentId?: string | null;
}

class VehicleDocumentRenewDto {
  @IsOptional() @IsString() @MaxLength(64) documentNo?: string;
  @IsOptional() @IsString() @MaxLength(128) issuingAuthority?: string;
  @IsOptional() @IsDateString() issueDate?: string;
  @IsOptional() @IsDateString() expiryDate?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsString() attachmentId?: string;
}

const FUEL_TYPES = ['PETROL', 'DIESEL', 'HYBRID', 'EV'] as const;

export class VehicleDto {
  @IsString() @MinLength(2) @MaxLength(32) vehicleNo!: string;
  @IsIn(Object.values(VehicleType)) vehicleType!: VehicleType;
  @IsString() @MinLength(2) @MaxLength(64) brandModel!: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) capacity?: number;
  @IsOptional() @IsString() driverId?: string;
  @IsOptional() @IsDateString() registrationExpiry?: string;
  @IsOptional() @IsDateString() insuranceExpiry?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  // ---- Tier 1 identification & specification (all optional)
  @IsOptional() @IsString() @Matches(/^[A-HJ-NPR-Z0-9]{17}$/i, { message: 'VIN must be 17 characters (no I, O, Q)' }) vin?: string;
  @IsOptional() @IsIn(FUEL_TYPES) fuelType?: string;
  @IsOptional() @IsString() @MaxLength(64) engineNo?: string;
  @IsOptional() @IsString() @MaxLength(64) chassisNo?: string;
  @IsOptional() @IsString() @MaxLength(64) make?: string;
  @IsOptional() @IsString() @MaxLength(64) model?: string;
  @IsOptional() @IsInt() @Min(1950) @Max(2100) year?: number;
}

class VehicleUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(64) brandModel?: string;
  @IsOptional() @IsIn(Object.values(VehicleType)) vehicleType?: VehicleType;
  @IsOptional() @IsInt() @Min(1) @Max(60) capacity?: number;
  /** null clears the default driver ("blank"); undefined leaves it unchanged. */
  @IsOptional() @IsString() driverId?: string | null;
  @IsOptional() @IsIn(Object.values(VehicleStatus)) status?: VehicleStatus;
  /** null clears the date (renewal recorded elsewhere); undefined leaves it unchanged. */
  @IsOptional() @IsDateString() registrationExpiry?: string | null;
  @IsOptional() @IsDateString() insuranceExpiry?: string | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsInt() @Min(0) currentMileage?: number;
  // ---- Tier 1 identification & specification (null clears, string sets)
  @IsOptional() @IsString() @Matches(/^[A-HJ-NPR-Z0-9]{17}$/i, { message: 'VIN must be 17 characters (no I, O, Q)' }) vin?: string | null;
  @IsOptional() @IsIn([...FUEL_TYPES, null]) fuelType?: string | null;
  @IsOptional() @IsString() @MaxLength(64) engineNo?: string | null;
  @IsOptional() @IsString() @MaxLength(64) chassisNo?: string | null;
  @IsOptional() @IsString() @MaxLength(64) make?: string | null;
  @IsOptional() @IsString() @MaxLength(64) model?: string | null;
  @IsOptional() @IsInt() @Min(1950) @Max(2100) year?: number | null;
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

class VehicleUnavailabilityDto {
  @IsString() vehicleId!: string;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class VehicleUnavailabilityUpdateDto {
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
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
  /** null clears the date; undefined leaves it unchanged. */
  @IsOptional() @IsDateString() licenseExpiry?: string | null;
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

  /** Document-expiry alert feed (VMS spec §6.3/§13.1) — dashboard card + Fleet
   *  page: vehicle registration/insurance + driver licences not VALID today. */
  @Get('expiry-alerts')
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  expiryAlerts() {
    return this.fleet.expiryAlerts();
  }

  /** Vehicle unavailability windows — ACTIVE by default; ?all=true includes cancelled.
   *  Declared BEFORE vehicles/:id so 'unavailabilities' is never read as an id. */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('vehicles/unavailabilities')
  vehicleUnavailabilities(@Query('all') all?: string) {
    return this.fleet.listVehicleUnavailabilities(all === 'true');
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

  // ---------- document types (VMS §6.1 — Phase B) ----------

  /** Active types drive the register picker; managers pass ?all=true. */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('document-types')
  documentTypes(@Query('all') all?: string) {
    return this.fleet.listDocumentTypes(all === 'true');
  }

  @RequirePermissions(PERMISSIONS.FLEET_TYPES_MANAGE)
  @Post('document-types')
  createDocumentType(@Req() req, @Body() dto: DocumentTypeDto) {
    return this.fleet.createDocumentType(dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_TYPES_MANAGE)
  @Patch('document-types/:id')
  updateDocumentType(@Req() req, @Param('id') id: string, @Body() dto: DocumentTypeUpdateDto) {
    return this.fleet.updateDocumentType(id, dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_TYPES_MANAGE)
  @Delete('document-types/:id')
  deleteDocumentType(@Req() req, @Param('id') id: string) {
    return this.fleet.deleteDocumentType(id, this.actor(req));
  }

  // ---------- vehicle document register (VMS §6.2 — Phase B) ----------

  /** Full register incl. superseded history. Declared before vehicles/:id →
   *  the extra path segment keeps it distinct regardless of order. */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('vehicles/:id/documents')
  vehicleDocuments(@Param('id') id: string) {
    return this.fleet.listVehicleDocuments(id);
  }

  /** §6.5 compliance for this vehicle — the same rules as the dispatch block. */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('vehicles/:id/compliance')
  vehicleCompliance(@Param('id') id: string) {
    return this.fleet.vehicleCompliance(id);
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Post('vehicles/:id/documents')
  createVehicleDocument(@Req() req, @Param('id') id: string, @Body() dto: VehicleDocumentDto) {
    return this.fleet.createVehicleDocument(id, dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Patch('documents/:id')
  updateVehicleDocument(@Req() req, @Param('id') id: string, @Body() dto: VehicleDocumentUpdateDto) {
    return this.fleet.updateVehicleDocument(id, dto, this.actor(req));
  }

  /** Renewal: new record supersedes the old (history preserved — §6.2). */
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Post('documents/:id/renew')
  renewVehicleDocument(@Req() req, @Param('id') id: string, @Body() dto: VehicleDocumentRenewDto) {
    return this.fleet.renewVehicleDocument(id, dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Delete('documents/:id')
  deleteVehicleDocument(@Req() req, @Param('id') id: string) {
    return this.fleet.deleteVehicleDocument(id, this.actor(req));
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

  // ---------- vehicle unavailability windows (service / inspection / repair) ----------

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Post('vehicles/unavailabilities')
  async createVehicleUnavailability(@Req() req, @Body() dto: VehicleUnavailabilityDto) {
    try {
      return await this.fleet.createVehicleUnavailability(
        { vehicleId: dto.vehicleId, startsAt: dto.startsAt, endsAt: dto.endsAt, reason: dto.reason?.trim() || undefined },
        this.actor(req),
      );
    } catch (e) {
      if ((e as Error).message.includes('after start') || (e as Error).message.includes('not found') || (e as Error).message.includes('Invalid')) throw new BadRequestException((e as Error).message);
      throw new ConflictException((e as Error).message);
    }
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Patch('vehicles/unavailabilities/:id')
  async updateVehicleUnavailability(@Req() req, @Param('id') id: string, @Body() dto: VehicleUnavailabilityUpdateDto) {
    try {
      return await this.fleet.updateVehicleUnavailability(
        id,
        { startsAt: dto.startsAt, endsAt: dto.endsAt, reason: dto.reason?.trim() || undefined },
        this.actor(req),
      );
    } catch (e) {
      if ((e as Error).message.includes('after start') || (e as Error).message.includes('not found') || (e as Error).message.includes('Invalid')) throw new BadRequestException((e as Error).message);
      throw new ConflictException((e as Error).message);
    }
  }

  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Post('vehicles/unavailabilities/:id/cancel')
  cancelVehicleUnavailability(@Req() req, @Param('id') id: string) {
    return this.fleet.cancelVehicleUnavailability(id, this.actor(req));
  }

  /** Delete outright (admin cleanup) — unlike cancel, the row is removed. */
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @Delete('vehicles/unavailabilities/:id')
  deleteVehicleUnavailability(@Req() req, @Param('id') id: string) {
    return this.fleet.deleteVehicleUnavailability(id, this.actor(req));
  }
}
