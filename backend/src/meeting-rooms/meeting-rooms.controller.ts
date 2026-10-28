import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { MeetingRoomsService } from './meeting-rooms.service';
import { Actor } from '../org/org.service';

/**
 * Bodies are validated DTOs — an inline type annotation never runs
 * class-validator, so bad input reached Prisma and came back as HTTP 500
 * (missing title, attendees "abc", meetingType "WEDDING", itAssist "yes",
 * non-uuid roomId, ...). Cars already used DTOs; meetings now match.
 */
class CreateMeetingRequestDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsInt() @Min(1) @Max(9999) attendees?: number;
  @IsDateString() startTime!: string;
  @IsOptional() @IsDateString() endTime?: string;
  @IsOptional() @IsIn(['INTERNAL', 'EXTERNAL']) meetingType?: string;
  @IsOptional() @IsString() @MaxLength(300) externalCompanies?: string;
  @IsOptional() @IsString() @MaxLength(2000) attendeeNames?: string;
  @IsOptional() @IsBoolean() itAssist?: boolean;
  @IsOptional() @IsBoolean() reservedDriver?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) services?: string;
}

/** Omit `roomId` to free an assigned room and re-queue the request. */
class AssignRoomDto {
  @IsOptional() @IsUUID() roomId?: string;
}

class ShiftMeetingDto {
  @IsDateString() startTime!: string;
  @IsDateString() endTime!: string;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

class AdminCancelMeetingDto {
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

class CreateRoomDto {
  @IsString() @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsInt() @Min(1) @Max(9999) capacity?: number;
  @IsOptional() @IsString() @MaxLength(500) facilities?: string;
}

class UpdateRoomDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsInt() @Min(1) @Max(9999) capacity?: number;
  @IsOptional() @IsString() @MaxLength(500) facilities?: string;
  @IsOptional() @IsIn(['AVAILABLE', 'IN_USE', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE']) status?: string;
}

class FacilityDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

@ApiTags('meeting-rooms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('meeting-rooms')
export class MeetingRoomsController {
  constructor(private rooms: MeetingRoomsService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  @Post('requests')
  create(@Req() req, @Body() body: CreateMeetingRequestDto) {
    return this.rooms.create(body, this.actor(req));
  }

  /** Administration queue: approved but no room yet. */
  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Get('requests/approved-unassigned')
  queue() {
    return this.rooms.listApprovedUnassigned();
  }

  @Get('availability/conflicts')
  conflicts(@Query('startTime') startTime?: string, @Query('endTime') endTime?: string, @Query('attendees') attendees?: string) {
    return this.rooms.checkWindowConflicts(startTime!, endTime!, attendees ? Number(attendees) : undefined);
  }

  @Get('rooms-overview')
  overview() {
    return this.rooms.roomsOverview();
  }

  /** Monthly availability calendar (Plan §7): per-room bookings for one month. */
  @Get('availability/month')
  month(@Query('start') start?: string, @Query('end') end?: string) {
    return this.rooms.monthlyAvailability(start, end);
  }

  @Get('requests/:requestId')
  byRequest(@Req() req, @Param('requestId') requestId: string) {
    return this.rooms.findByRequest(requestId, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Post('requests/:requestId/assign')
  assign(@Req() req, @Param('requestId') requestId: string, @Body() body: AssignRoomDto) {
    return this.rooms.assign(requestId, body.roomId, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Patch('requests/:requestId/admin-shift')
  shift(@Req() req, @Param('requestId') requestId: string, @Body() body: ShiftMeetingDto) {
    return this.rooms.adminShiftTime(requestId, body, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Post('requests/:requestId/complete')
  complete(@Req() req, @Param('requestId') requestId: string) {
    return this.rooms.complete(requestId, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Post('requests/:requestId/admin-cancel')
  cancel(@Req() req, @Param('requestId') requestId: string, @Body() body: AdminCancelMeetingDto) {
    return this.rooms.adminCancel(requestId, body.comment, this.actor(req));
  }

  // ---------- facility master data (Plan §7 — no hard-coded lists) ----------

  /** Active facilities drive the checkbox picker; managers also see inactive ones. */
  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Get('facilities')
  facilities() {
    return this.rooms.listFacilities();
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_FACILITIES_MANAGE)
  @Post('facilities')
  createFacility(@Req() req, @Body() body: FacilityDto) {
    if (!body?.name?.trim()) throw new BadRequestException('Facility name is required');
    return this.rooms.createFacility(body.name.trim(), body.active, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_FACILITIES_MANAGE)
  @Patch('facilities/:id')
  updateFacility(@Req() req, @Param('id') id: string, @Body() body: FacilityDto) {
    return this.rooms.updateFacility(id, { active: body?.active }, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_FACILITIES_MANAGE)
  @Delete('facilities/:id')
  deleteFacility(@Req() req, @Param('id') id: string) {
    return this.rooms.deleteFacility(id, this.actor(req));
  }

  // ---------- room setup CRUD (Administration) ----------

  @Get('setup')
  listSetup() {
    return this.rooms.listRooms();
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Post('setup')
  createRoom(@Req() req, @Body() body: CreateRoomDto) {
    return this.rooms.createRoom(body, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Patch('setup/:id')
  updateRoom(@Req() req, @Param('id') id: string, @Body() body: UpdateRoomDto) {
    return this.rooms.updateRoom(id, body, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Delete('setup/:id')
  deleteRoom(@Req() req, @Param('id') id: string) {
    return this.rooms.deleteRoom(id, this.actor(req));
  }
}
