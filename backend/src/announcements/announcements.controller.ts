import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { AnnouncementsService, TargetInput } from './announcements.service';
import { Actor } from '../org/org.service';

const CATEGORIES = ['GENERAL', 'OFFICE', 'FACILITY', 'TRANSPORT', 'MEETING_ROOM', 'MAINTENANCE', 'SAFETY', 'HOLIDAY', 'IT', 'EMERGENCY', 'OTHER'];
const PRIORITIES = ['NORMAL', 'IMPORTANT', 'URGENT', 'EMERGENCY'];

export class CreateAnnouncementDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsString() @MinLength(3) @MaxLength(20000) content!: string;
  @IsOptional() @IsIn(CATEGORIES) category?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: string;
  @IsOptional() @IsISO8601() publishAt?: string; // set → SCHEDULED (or immediate publish)
  @IsOptional() @IsISO8601() endAt?: string;
  @IsArray() targets!: TargetInput[];
}

export class UpdateAnnouncementDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(20000) content?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: string;
  @IsOptional() @IsISO8601() endAt?: string; // explicit null clears it (JSON null)
}

@ApiTags('announcements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('announcements')
export class AnnouncementsController {
  constructor(private announcements: AnnouncementsService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  // ---------- employee (any authenticated user with announcements.read) ----------
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_READ)
  @Get('mine')
  listMine(@Req() req) {
    return this.announcements.listMine(this.actor(req));
  }

  /** Called when a user opens the detail view — marks it read. */
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_READ)
  @Post(':id/read')
  markRead(@Req() req, @Param('id') id: string) {
    return this.announcements.markRead(id, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_READ)
  @Post(':id/ack')
  ack(@Req() req, @Param('id') id: string) {
    return this.announcements.ack(id, this.actor(req));
  }

  // ---------- Administration ----------
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @Get()
  listAll() {
    return this.announcements.listAll();
  }

  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @Post()
  create(@Req() req, @Body() dto: CreateAnnouncementDto) {
    return this.announcements.create(dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @Patch(':id')
  update(@Req() req, @Param('id') id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.announcements.update(id, dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @Post(':id/publish')
  publish(@Req() req, @Param('id') id: string) {
    return this.announcements.publish(id, this.actor(req));
  }

  /** Pull a live announcement back to DRAFT (audience keeps read/ack history). */
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @Post(':id/unpublish')
  unpublish(@Req() req, @Param('id') id: string) {
    return this.announcements.unpublish(id, this.actor(req));
  }

  /** Pin/unpin — pinned notices sort first on the admin list and every /mine. */
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @Post(':id/pin')
  togglePin(@Req() req, @Param('id') id: string) {
    return this.announcements.togglePin(id, this.actor(req));
  }

  /** Target/read/unread counts (requiresAck announcements). */
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @Get(':id/read-stats')
  readStats(@Param('id') id: string) {
    return this.announcements.readStats(id);
  }

  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @Delete(':id')
  remove(@Req() req, @Param('id') id: string) {
    return this.announcements.remove(id, this.actor(req));
  }
}
