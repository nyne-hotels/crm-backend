import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { authUsers } from '../db/schema/index.js';
import type { Auth } from './auth.js';
import { forwardSetCookies } from './cookies.js';
import { AllowPendingPasswordChange, CurrentStaff, InjectAuth } from './decorators.js';
import { passwordSchema } from './password.schema.js';
import { ROLE_LABELS, ROLE_PERMISSIONS } from './permissions.js';
import type { SignedInStaff } from './signed-in-staff.js';

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

// The signed-in staff member: who they are, what their role allows, and their own password.
@Controller('me')
export class MeController {
  constructor(
    @InjectAuth() private readonly auth: Auth,
    @InjectDb() private readonly db: Database,
  ) {}

  @Get()
  @AllowPendingPasswordChange()
  me(@CurrentStaff() staff: SignedInStaff) {
    return {
      ...staff,
      roleLabel: ROLE_LABELS[staff.role],
      permissions: ROLE_PERMISSIONS[staff.role],
    };
  }

  // Used for both the forced change after a temporary password and "Change password"
  // in the top bar. Signs out every other session.
  @Post('password')
  @HttpCode(204)
  @AllowPendingPasswordChange()
  async changePassword(
    @CurrentStaff() staff: SignedInStaff,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (body.newPassword === body.currentPassword) {
      throw new BadRequestException('Choose a password that is different from the current one');
    }
    const { headers } = await this.auth.api.changePassword({
      headers: fromNodeHeaders(req.headers),
      body: { ...body, revokeOtherSessions: true },
      returnHeaders: true,
    });
    // revokeOtherSessions replaces the current session too, so pass on the new cookie
    forwardSetCookies(headers, res);
    await this.db
      .update(authUsers)
      .set({ mustChangePassword: false, updatedAt: new Date() })
      .where(eq(authUsers.id, staff.authUserId));
  }
}
