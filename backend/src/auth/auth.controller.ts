import { Controller, Body, Get, Patch, Post, Req, UseGuards, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsString, MinLength } from 'class-validator';
import { RoleName } from '@prisma/client';
import { AuthService } from './auth.service';
import { PermissionsService } from './permissions.service';
import { LoginThrottleService } from './login-throttle.service';
import { Public } from './public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Roles } from './roles.decorator';
import { RequirePermissions } from './permissions.guard';
import { PERMISSIONS, ALL_PERMISSION_CODES } from './permissions';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

export class SetRolePermissionsDto {
  @IsArray() @IsString({ each: true }) @IsIn(ALL_PERMISSION_CODES, { each: true }) permissions!: string[];
}

export class PreviewPermissionsDto {
  @IsArray() @IsString({ each: true }) @IsIn(Object.values(RoleName), { each: true }) roles!: RoleName[];
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private permissionsService: PermissionsService,
    private loginThrottle: LoginThrottleService,
  ) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req) {
    const ip = req.ip || (req.headers['x-forwarded-for'] as string) || undefined;
    const result = await this.auth.login(dto.username, dto.password, ip, req.headers['user-agent']);
    this.loginThrottle.success(ip ?? 'unknown', dto.username);
    // attach effective permissions to the session payload
    const perms = await this.permissionsService.forUser(result.user.id);
    return { ...result, permissions: perms };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req) {
    const profile = await this.auth.profile(req.user.id);
    const permissions = await this.permissionsService.forUser(req.user.id);
    return { ...profile, permissions };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@Req() req, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(req.user.id, dto.currentPassword, dto.newPassword);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @RequirePermissions(PERMISSIONS.USERS_READ)
  @Get('permissions/catalog')
  catalog() {
    return ALL_PERMISSION_CODES.map((code) => ({ code, description: PERMISSIONS[code.toUpperCase().replace(/\./g, '_') as keyof typeof PERMISSIONS] }));
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @RequirePermissions(PERMISSIONS.USERS_READ)
  @Get('permissions/matrix')
  async matrix() {
    const roles = await this.permissionsService.matrixView();
    return { catalog: ALL_PERMISSION_CODES, roles };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Patch('permissions/roles/:roleName')
  async setRolePermissions(
    @Param('roleName') roleName: string,
    @Body() dto: SetRolePermissionsDto,
    @Req() req,
  ) {
    if (roleName === 'SYSTEM_ADMIN') {
      return { success: false, error: 'SYSTEM_ADMIN is the superuser role — its permissions cannot be changed.' };
    }
    const updated = await this.permissionsService.setRolePermissions(roleName, dto.permissions, {
      userId: req.user.id,
      username: req.user.username,
    });
    if (!updated) {
      return { success: false, error: 'Role not found' };
    }
    return { success: true, permissions: updated };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('permissions/preview')
  async preview(@Body() dto: PreviewPermissionsDto) {
    const permissions = await this.permissionsService.forRoleNames(dto.roles);
    return { permissions };
  }
}
