import { createParamDecorator, Inject, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Access, Area } from './permissions.js';
import type { SignedInStaff } from './signed-in-staff.js';

export const AUTH = Symbol('AUTH');
export const InjectAuth = () => Inject(AUTH);

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_ACCESS = 'auth:access';
export const ALLOW_PENDING_PASSWORD = 'auth:allow-pending-password';

// Route needs no sign-in.
export const Public = () => SetMetadata(IS_PUBLIC, true);

// Route needs this access to an area, e.g. @RequireAccess('settings', 'edit').
// Without it, any signed-in staff member may call the route.
export const RequireAccess = (area: Area, access: Exclude<Access, 'none'>) =>
  SetMetadata(REQUIRED_ACCESS, { area, access });

// Route stays usable while the user still has to replace a temporary password.
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

// The signed-in staff member, as loaded by the AuthGuard.
export const CurrentStaff = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SignedInStaff =>
    ctx.switchToHttp().getRequest<Request>().staff!,
);
