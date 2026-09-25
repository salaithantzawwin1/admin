import { Body, Controller, ConflictException, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { LdapService, AdConfig } from './ldap.service';
import { HolidaysService, Holiday } from './holidays.service';
import { TimetableService, CompanyTimetable } from './timetable.service';
import { TelegramConfigService, TelegramConfig } from './telegram-config.service';

class AdConfigDto {
  @IsOptional() @IsString() @MaxLength(255) url?: string;
  @IsOptional() @IsString() @MaxLength(255) baseDn?: string;
  @IsOptional() @IsString() @MaxLength(255) bindDn?: string;
  @IsOptional() @IsString() @MaxLength(255) bindPassword?: string;
  @IsOptional() @IsString() @MaxLength(64) defaultRole?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class TestConnectionDto {
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() baseDn?: string;
  @IsOptional() @IsString() bindDn?: string;
  @IsOptional() @IsString() bindPassword?: string;
}

class HolidayListDto {
  @IsArray()
  @IsOptional()
  holidays?: Holiday[];
}

class TelegramConfigDto {
  @IsOptional() @IsString() @MaxLength(255) botToken?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(255) webUrl?: string;
}

class TelegramTestDto {
  @IsString() chatId!: string;
}

class JoinApproveDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() driverId?: string;
}

class TimetableDto {
  @IsString() fullStart!: string;
  @IsString() fullEnd!: string;
  @IsString() morningStart!: string;
  @IsString() morningEnd!: string;
  @IsString() eveningStart!: string;
  @IsString() eveningEnd!: string;
  @IsOptional() @IsArray() workDays?: number[];
}

@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('settings')
export class SettingsController {
  constructor(private ldap: LdapService, private holidays: HolidaysService, private timetable: TimetableService, private telegramConfig: TelegramConfigService) {}

  /** Company Time Table — office hours used by leave/absence windows. */
  @Get('timetable')
  getTimetable() {
    return this.timetable.get();
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Put('timetable')
  setTimetable(@Body() dto: TimetableDto, @Req() req) {
    return this.timetable.update(dto as Partial<CompanyTimetable>, { userId: req.user.id, username: req.user.username });
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('ad')
  getAd() {
    return this.ldap.getConfig();
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Patch('ad')
  setAd(@Body() dto: AdConfigDto) {
    return this.ldap.setConfig(dto as Partial<AdConfig>);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('ad/test')
  testAd(@Body() dto: TestConnectionDto) {
    // unsaved form values take precedence so the admin can test before saving
    const cfg: Partial<AdConfig> = {
      url: dto.url,
      baseDn: dto.baseDn,
      bindDn: dto.bindDn,
      bindPassword: dto.bindPassword,
    };
    return this.ldap.testConnection(
      dto.url ? (cfg as AdConfig) : undefined,
    );
  }

  /** Public-holiday list for a year (all authenticated users — used by the meeting calendar). */
  @Get('holidays/:year')
  getHolidays(@Param('year') year: string) {
    return this.holidays.list(Number(year));
  }

  /** Replace the public-holiday list for a year (System Admin). */
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Put('holidays/:year')
  setHolidays(@Param('year') year: string, @Body() dto: HolidayListDto, @Req() req) {
    return this.holidays.update(Number(year), dto.holidays ?? [], { userId: req.user.id, username: req.user.username });
  }

  // ---------------- Telegram (driver notifications) ----------------

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('telegram')
  getTelegram() {
    return this.telegramConfig.getConfig();
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Patch('telegram')
  setTelegram(@Body() dto: TelegramConfigDto, @Req() req) {
    return this.telegramConfig.setConfig(dto as Partial<TelegramConfig>, { userId: req.user.id, username: req.user.username });
  }

  /** Send a Telegram test message to the given chat id (admin pastes their own chat id). */
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('telegram/test')
  testTelegram(@Body() dto: TelegramTestDto) {
    return this.telegramConfig.sendTest(dto.chatId.trim());
  }

  // ---------------- Telegram join requests (draft → approve) ----------------

  /** Telegram users who /start-ed the bot, waiting for approval. */
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('telegram/joins')
  listJoins(@Query('status') status?: string) {
    return this.telegramConfig.listJoins(status);
  }

  /** Bind-history timeline for one chat (who held it, when, who decided). */
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('telegram/chats/:chatId/history')
  chatHistory(@Param('chatId') chatId: string) {
    return this.telegramConfig.chatHistory(chatId);
  }

  /** Approve a join draft — bind the chat to the picked system user or driver. */
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('telegram/joins/:id/approve')
  async approveJoin(@Req() req, @Param('id') id: string, @Body() dto: JoinApproveDto) {
    const actor = { userId: req.user.id, username: req.user.username };
    try {
      return await this.telegramConfig.approveJoin(id, { userId: dto.userId, driverId: dto.driverId }, actor);
    } catch (e) {
      throw new ConflictException((e as Error).message);
    }
  }

  /** Reject a join draft. */
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('telegram/joins/:id/reject')
  async rejectJoin(@Req() req, @Param('id') id: string) {
    try {
      return await this.telegramConfig.rejectJoin(id, { userId: req.user.id, username: req.user.username });
    } catch (e) {
      throw new ConflictException((e as Error).message);
    }
  }

  /** Re-assign an approved join's chat to another system user or driver (fix wrong assign). */
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('telegram/joins/:id/reassign')
  async reassignJoin(@Req() req, @Param('id') id: string, @Body() dto: JoinApproveDto) {
    try {
      return await this.telegramConfig.reassignJoin(id, { userId: dto.userId, driverId: dto.driverId }, { userId: req.user.id, username: req.user.username });
    } catch (e) {
      throw new ConflictException((e as Error).message);
    }
  }

  /** Release an approved chat from its holder — the join flips back to PENDING. */
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post('telegram/joins/:id/unbind')
  async unbindJoin(@Req() req, @Param('id') id: string) {
    try {
      return await this.telegramConfig.unbindJoinChat(id, { userId: req.user.id, username: req.user.username });
    } catch (e) {
      throw new ConflictException((e as Error).message);
    }
  }
}
