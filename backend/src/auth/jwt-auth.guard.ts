import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Global JWT guard. Besides the Authorization: Bearer header, it accepts a
 * `token` query parameter — used only by <img> tags (e.g. inventory item
 * thumbnails) which cannot set custom headers.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest();
    if (!req.headers?.authorization && typeof req.query?.token === 'string') {
      // <img> tags cannot send headers — accept the JWT via ?token= instead
      req.headers.authorization = `Bearer ${req.query.token}`;
    }
    return super.canActivate(context);
  }
}
