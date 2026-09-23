import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName } from '@prisma/client';

export const ROLES_KEY = 'ams_roles';
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RoleName[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    const userRoles: RoleName[] = (user?.roles || []).map((r: { name: RoleName }) => r.name);
    return required.some((r) => userRoles.includes(r));
  }
}
