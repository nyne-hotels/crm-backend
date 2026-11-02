import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentStaff, RequireAccess } from '../../auth/decorators.js';
import type { SignedInStaff } from '../../auth/signed-in-staff.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  createStaffUserSchema,
  listStaffUsersSchema,
  resetPasswordSchema,
  updateStaffUserSchema,
  type CreateStaffUser,
  type ListStaffUsers,
  type UpdateStaffUser,
} from './staff-users.schemas.js';
import { StaffUsersService } from './staff-users.service.js';

const headersOf = (req: Request) => fromNodeHeaders(req.headers);

@Controller('settings/staff-users')
@RequireAccess('settings', 'edit')
export class StaffUsersController {
  constructor(private readonly staffUsers: StaffUsersService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listStaffUsersSchema)) query: ListStaffUsers) {
    return this.staffUsers.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.staffUsers.get(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(createStaffUserSchema)) body: CreateStaffUser, @Req() req: Request) {
    return this.staffUsers.create(body, headersOf(req));
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateStaffUserSchema)) body: UpdateStaffUser,
    @Req() req: Request,
    @CurrentStaff() actor: SignedInStaff,
  ) {
    return this.staffUsers.update(id, body, headersOf(req), actor);
  }

  @Post(':id/reset-password')
  @HttpCode(204)
  async resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
    @Req() req: Request,
  ) {
    await this.staffUsers.resetPassword(id, body.temporaryPassword, headersOf(req));
  }

  @Post(':id/sign-out-everywhere')
  @HttpCode(204)
  async signOutEverywhere(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    await this.staffUsers.signOutEverywhere(id, headersOf(req));
  }

  @Post(':id/deactivate')
  deactivate(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @CurrentStaff() actor: SignedInStaff) {
    return this.staffUsers.setActive(id, false, headersOf(req), actor);
  }

  @Post(':id/reactivate')
  reactivate(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @CurrentStaff() actor: SignedInStaff) {
    return this.staffUsers.setActive(id, true, headersOf(req), actor);
  }
}
