import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { TelegramService } from '../telegram/telegram.service';
import { CarsService } from './cars.service';
import { Actor } from '../org/org.service';

/**
 * Vehicle types accepted on car requests — MUST mirror the Prisma `VehicleType`
 * enum. The old hard-coded 7-value list rejected MINIVAN/MINIBUS/LIMOUSINE/
 * STAFF_BUS/VAN_CARGO requests with 400 even though the schema and the Fleet
 * panel accept them.
 */
const VEHICLE_TYPES = [
  'SEDAN', 'SUV', 'PICKUP', 'VAN', 'BUS', 'TRUCK', 'OTHER',
  'MINIVAN', 'MINIBUS', 'LIMOUSINE', 'STAFF_BUS', 'VAN_CARGO',
] as const;

class CreateCarRequestDto {
  @IsString() @MinLength(2) @MaxLength(200) destination!: string;
  @IsDateString() startDate!: string;
  @IsOptional() @IsDateString() endDate?: string; // optional — defaults to 17:00 same day
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) purpose?: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) passengers?: number;
  @IsOptional() @IsIn(VEHICLE_TYPES) vehicleTypeRequired?: string;
  @IsOptional() @IsIn(['FULL_DAY', 'HALF_DAY_AM', 'HALF_DAY_PM', 'CUSTOM_HOURS']) timeSlot?: string;
  @IsOptional() @IsString() @MaxLength(200) pickupLocation?: string;
}

class UpdateCarRequestDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) destination?: string;
  @IsOptional() @IsString() @MaxLength(500) purpose?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(60) passengers?: number;
  @IsOptional() @IsIn(VEHICLE_TYPES) vehicleTypeRequired?: string;
  @IsOptional() @IsIn(['FULL_DAY', 'HALF_DAY_AM', 'HALF_DAY_PM', 'CUSTOM_HOURS']) timeSlot?: string;
  @IsOptional() @IsString() @MaxLength(200) pickupLocation?: string;
}

class AssignDto {
  @IsString() vehicleId!: string;
  @IsOptional() @IsString() driverId?: string;
}

class StartTripDto {
  @IsInt() @Min(0) startMileage!: number;
}

class CompleteTripDto {
  @IsInt() @Min(0) endMileage!: number;
  @IsOptional() @IsString() @MaxLength(1000) remarks?: string;
}

class ExpenseDto {
  @IsIn(['FUEL', 'TOLL', 'PARKING', 'REPAIR', 'OTHER']) type!: string;
  @IsNumber() @Min(0.01) @Max(999999999) amount!: number;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsDateString() expenseDate?: string;
}

@ApiTags('cars')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cars')
export class CarsController {
  constructor(private cars: CarsService, private telegram: TelegramService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  @Post('requests')
  create(@Req() req, @Body() dto: CreateCarRequestDto) {
    return this.cars.createCarRequest(dto, this.actor(req));
  }

  /** APPROVED car requests still waiting for a vehicle assignment (Administration queue).
   *  fleet.read guard: the queue carries requester names + destinations — previously
   *  ANY logged-in user could read it (same for /assignments and /availability below). */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('requests/approved-unassigned')
  approvedUnassigned() {
    return this.cars.listApprovedUnassigned();
  }

  /** Car requests in my department(s) still missing the optional manager ack. */
  @Get('manager-acks/pending')
  pendingManagerAcks(@Req() req) {
    return this.cars.myPendingManagerAcks(req.user.id);
  }

  /** OPTIONAL manager ack — pure FYI, never blocks the workflow. */
  @Post('requests/:requestId/manager-ack')
  managerAck(@Req() req, @Param('requestId') requestId: string) {
    return this.cars.managerAck(requestId, this.actor(req));
  }

  /** Clash preview for a time window (form pre-warning, before submitting). */
  @Get('availability/conflicts')
  windowConflicts(@Query('startDate') startDate: string, @Query('endDate') endDate: string) {
    return this.cars.checkWindowConflicts(startDate, endDate);
  }

  /** Fleet status overview for requesters (informational, no personal data). */
  @Get('fleet-overview')
  fleetOverview() {
    return this.cars.requesterFleetOverview();
  }

  @Get('requests/:requestId')
  byRequest(@Req() req, @Param('requestId') requestId: string) {
    return this.cars.findByRequest(requestId, this.actor(req));
  }

  @Patch('requests/:requestId')
  update(@Req() req, @Param('requestId') requestId: string, @Body() dto: UpdateCarRequestDto) {
    return this.cars.updateCarRequest(requestId, dto, this.actor(req));
  }

  /** Vehicle availability in a window — fleet data, not personal: fleet.read. */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('availability')
  availability(
    @Query('vehicleId') vehicleId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('excludeRequestId') excludeRequestId?: string,
  ) {
    return this.cars.checkAvailability(vehicleId, startDate, endDate, excludeRequestId);
  }

  /** Assignment list carries requester names — Administration/superuser eyes only. */
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @Get('assignments')
  assignments(@Query('activeOnly') activeOnly?: string) {
    return this.cars.listAssignments(activeOnly === 'true');
  }

  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('requests/:requestId/assign')
  assign(@Req() req, @Param('requestId') requestId: string, @Body() dto: AssignDto) {
    return this.cars.assign(requestId, dto, this.actor(req));
  }

  /** Administration manual ack override — same effects as the driver's Telegram buttons
   *  (used when the driver confirms by phone and Telegram is unavailable). */
  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('assignments/simulate-ack')
  simulateAck(@Req() req, @Body() dto: { assignmentId?: string; action?: string }) {
    if (!dto.assignmentId || !['noted', 'arrived', 'returned'].includes(dto.action ?? '')) {
      throw new BadRequestException('assignmentId and action (noted|arrived|returned) are required');
    }
    return this.telegram.manualAck(dto.assignmentId, dto.action as 'noted' | 'arrived' | 'returned', this.actor(req));
  }


  /** Administration: cancel an APPROVED/assigned car request (fleet plan change). */
  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('requests/:requestId/admin-cancel')
  adminCancel(@Req() req, @Param('requestId') requestId: string, @Body() body: { comment?: string }) {
    return this.cars.adminCancelApproved(requestId, body.comment, this.actor(req));
  }

  /** Administration: shift the time window of an APPROVED/PENDING car request. */
  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Patch('requests/:requestId/admin-shift')
  adminShift(@Req() req, @Param('requestId') requestId: string, @Body() body: { startDate: string; endDate: string; comment?: string }) {
    return this.cars.adminShiftTime(requestId, body, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('requests/:requestId/reassign')
  reassign(@Req() req, @Param('requestId') requestId: string, @Body() body: { vehicleId?: string; driverId?: string }) {
    if (!body?.vehicleId) throw new BadRequestException('vehicleId is required');
    return this.cars.reassign(requestId, { vehicleId: body.vehicleId, driverId: body.driverId || undefined }, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('requests/:requestId/release')
  release(@Req() req, @Param('requestId') requestId: string) {
    return this.cars.release(requestId, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('requests/:requestId/trip/start')
  startTrip(@Req() req, @Param('requestId') requestId: string, @Body() dto: StartTripDto) {
    return this.cars.startTrip(requestId, dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.CARS_ASSIGN)
  @Post('requests/:requestId/trip/complete')
  completeTrip(@Req() req, @Param('requestId') requestId: string, @Body() dto: CompleteTripDto) {
    return this.cars.completeTrip(requestId, dto, this.actor(req));
  }

  /** Expense access (cars.assign or the request's owner) is enforced in the service —
   *  these endpoints previously had NO access control at all. */
  @Post('requests/:requestId/expenses')
  addExpense(@Req() req, @Param('requestId') requestId: string, @Body() dto: ExpenseDto) {
    return this.cars.addExpense(requestId, dto, this.actor(req));
  }

  @Get('requests/:requestId/expenses')
  expenses(@Req() req, @Param('requestId') requestId: string) {
    return this.cars.listExpenses(requestId, this.actor(req));
  }
}
