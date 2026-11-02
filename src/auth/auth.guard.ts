import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq, isNull } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { setActingStaff } from '../db/request-context.js';
import { staffUsers } from '../db/schema/index.js';
import { INACTIVE_ACCOUNT, type Auth } from './auth.js';
import { ALLOW_PENDING_PASSWORD, InjectAuth, IS_PUBLIC, REQUIRED_ACCESS } from './decorators.js';
import { can, type Access, type Area } from './permissions.js';
import { forwardSetCookies } from './cookies.js';

// Global guard: every route needs a signed-in, active staff member unless it
// is marked @Public(). It also enforces @RequireAccess() and the forced
// password change, and tells the database who is acting (see request-context.ts).
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectAuth() private readonly auth: Auth,
    @InjectDb() private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // Reading the session also slides its expiry forward; pass the refreshed
    // cookie back so the browser keeps it too.
    const { headers, response: session } = await this.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    });
    forwardSetCookies(headers, res);
    if (!session) throw new UnauthorizedException('Sign in to continue');

    const [staff] = await this.db
      .select({
        id: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
        role: staffUsers.role,
        propertyId: staffUsers.propertyId,
        isActive: staffUsers.isActive,
      })
      .from(staffUsers)
      .where(and(eq(staffUsers.authUserId, session.user.id), isNull(staffUsers.deletedAt)));
    if (!staff || !staff.isActive || session.user.banned) {
      throw new UnauthorizedException(INACTIVE_ACCOUNT);
    }

    req.staff = {
      id: staff.id,
      authUserId: session.user.id,
      username: session.user.username ?? '',
      firstName: staff.firstName,
      lastName: staff.lastName,
      role: staff.role,
      propertyId: staff.propertyId,
      mustChangePassword: session.user.mustChangePassword,
    };
    setActingStaff(staff.id);

    if (
      session.user.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, targets)
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Choose a new password before continuing',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }

    const required = this.reflector.getAllAndOverride<{ area: Area; access: Exclude<Access, 'none'> }>(
      REQUIRED_ACCESS,
      targets,
    );
    if (required && !can(staff.role, required.area, required.access)) {
      throw new ForbiddenException('Your role does not have access to this');
    }
    return true;
  }
}
