import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RoleName, UserStatus } from '@prisma/client';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';

export class CreateUserDto {
  @IsString() @MinLength(3) @MaxLength(64) username!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
  @IsString() @MinLength(1) @MaxLength(128) fullName!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsArray() @IsIn(Object.values(RoleName), { each: true }) roles!: RoleName[];
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) fullName?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsArray() @IsIn(Object.values(RoleName), { each: true }) roles?: RoleName[];
}

export class SetStatusDto {
  @IsIn(Object.values(UserStatus)) status!: UserStatus;
}

export class ResetPasswordDto {
  @IsString() @MinLength(8) @MaxLength(128) newPassword!: string;
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  private actor(req) {
    return { userId: req.user.id, username: req.user.username };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.USERS_READ)
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.users.list(Number(page || 1), Math.min(100, Number(pageSize || 25)));
  }

  @Post()
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  create(@Req() req, @Body() dto: CreateUserDto) {
    return this.users.create(dto, this.actor(req));
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  update(@Req() req, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto, this.actor(req));
  }

  /** Force-unbind the user's Telegram chat (Administration). */
  @Delete(':id/telegram')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  unbindTelegram(@Req() req, @Param('id') id: string) {
    return this.users.unbindTelegram(id, this.actor(req));
  }

  @Patch(':id/status')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  setStatus(@Req() req, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.users.setStatus(id, dto.status, this.actor(req));
  }

  /** Lift a "Too many login attempts" lockout before its timer expires. */
  @Post(':id/unlock')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  unlock(@Req() req, @Param('id') id: string) {
    return this.users.unlock(id, this.actor(req));
  }

  @Patch(':id/password')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  resetPassword(@Req() req, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.users.resetPassword(id, dto.newPassword, this.actor(req));
  }

  @Get('roles')
  roles() {
    return Object.values(RoleName);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  remove(@Req() req, @Param('id') id: string) {
    return this.users.remove(id, this.actor(req));
  }
}
