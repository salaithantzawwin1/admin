import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.decorator';
import { PermissionsService } from './permissions.service';
import { LoginThrottleService } from './login-throttle.service';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET || 'dev_only_secret_change_me',
        signOptions: { expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
      }),
    }),
    AuditModule,
    SettingsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, RolesGuard, PermissionsService, LoginThrottleService],
  exports: [JwtModule, PermissionsService, LoginThrottleService],
})
export class AuthModule {}
