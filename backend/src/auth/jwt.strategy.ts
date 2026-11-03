import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.module';
import { jwtSecret } from '../util/jwt-secret';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService, private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET')?.trim() || jwtSecret(),
    });
  }

  async validate(payload: { sub: string; username: string; iat?: number }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException();
    // A password change/reset ends every session that existed before it: a
    // stolen token must not survive the remedy for the theft.
    if (user.passwordChangedAt && payload.iat && payload.iat * 1000 < user.passwordChangedAt.getTime()) {
      throw new UnauthorizedException('Your password changed — sign in again');
    }
    return { id: user.id, username: user.username, fullName: user.fullName, roles: user.userRoles.map((ur) => ur.role) };
  }
}
