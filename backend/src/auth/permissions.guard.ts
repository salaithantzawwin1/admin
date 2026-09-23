import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsService } from './permissions.service';

export const PERMISSIONS_KEY = 'ams_permissions';

/** Declare the permissions required by an endpoint. All listed must be present (AND). */
export const RequirePermissions = (...perms: string[]) => SetMetadata(PERMISSIONS_KEY, perms);

/** Declare alternate permission sets: any one set suffices (OR of ANDs). */
export const AnyPermission = (...sets: string[][]) => SetMetadata(PERMISSIONS_KEY, sets);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector, private permissions: PermissionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[][]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user?.id) return false;

    const granted = await this.permissions.forUser(user.id);
    (req as { userPermissions?: string[] }).userPermissions = granted;

    // Accept both flat codes ['a','b'] (RequirePermissions) and sets [['a'],['b']] (AnyPermission)
    const sets = required.map((entry) => (Array.isArray(entry) ? entry : [entry]));
    const ok = sets.some((set) => set.every((p) => granted.includes(p)));
    if (!ok) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }
    return true;
  }
}
