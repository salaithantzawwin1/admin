import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { MeetingRoomsService } from './meeting-rooms.service';
import { Actor } from '../org/org.service';

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
  create(@Req() req, @Body() body: { title: string; description?: string; attendees?: number; startTime: string; endTime?: string }) {
    return this.rooms.create(body, this.actor(req));
  }

  /** Administration queue: approved but no room yet. */
  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Get('requests/approved-unassigned')
  queue() {
    return this.rooms.listApprovedUnassigned();
  }

  @Get('availability/conflicts')
  conflicts(@Query('startTime') startTime?: string, @Query('endTime') endTime?: string) {
    return this.rooms.checkWindowConflicts(startTime!, endTime!);
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
  byRequest(@Param('requestId') requestId: string) {
    return this.rooms.findByRequest(requestId);
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Post('requests/:requestId/assign')
  assign(@Req() req, @Param('requestId') requestId: string, @Body() body: { roomId?: string }) {
    return this.rooms.assign(requestId, body.roomId, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Patch('requests/:requestId/admin-shift')
  shift(@Req() req, @Param('requestId') requestId: string, @Body() body: { startTime: string; endTime: string; comment?: string }) {
    return this.rooms.adminShiftTime(requestId, body, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Post('requests/:requestId/complete')
  complete(@Req() req, @Param('requestId') requestId: string) {
    return this.rooms.complete(requestId, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Post('requests/:requestId/admin-cancel')
  cancel(@Req() req, @Param('requestId') requestId: string, @Body() body: { comment?: string }) {
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
  createFacility(@Req() req, @Body() body: { name: string; active?: boolean }) {
    if (!body?.name?.trim()) throw new BadRequestException('Facility name is required');
    return this.rooms.createFacility(body.name.trim(), body.active, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_FACILITIES_MANAGE)
  @Patch('facilities/:id')
  updateFacility(@Req() req, @Param('id') id: string, @Body() body: { active?: boolean }) {
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
  createRoom(@Req() req, @Body() body: { name: string; location?: string; capacity?: number; facilities?: string }) {
    return this.rooms.createRoom(body, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Patch('setup/:id')
  updateRoom(@Req() req, @Param('id') id: string, @Body() body: { name?: string; location?: string; capacity?: number; facilities?: string; status?: string }) {
    return this.rooms.updateRoom(id, body, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.MEETING_ROOMS_ASSIGN)
  @Delete('setup/:id')
  deleteRoom(@Req() req, @Param('id') id: string) {
    return this.rooms.deleteRoom(id, this.actor(req));
  }
}
