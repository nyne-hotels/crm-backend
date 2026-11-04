import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { RequireAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ContactMethodsService } from './contact-methods.service.js';
import {
  createContactMethodSchema,
  createGuestSchema,
  findMatchesSchema,
  listGuestsSchema,
  updateContactMethodSchema,
  updateGuestSchema,
  type CreateContactMethod,
  type CreateGuest,
  type FindMatches,
  type ListGuests,
  type UpdateContactMethod,
  type UpdateGuest,
} from './guests.schemas.js';
import { GuestsService } from './guests.service.js';

// Every role can find and view guests; admin and management add, edit and delete.
@Controller('guests')
@RequireAccess('guests', 'view')
export class GuestsController {
  constructor(
    private readonly guests: GuestsService,
    private readonly contactMethods: ContactMethodsService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(listGuestsSchema)) query: ListGuests) {
    return this.guests.list(query);
  }

  // before :id so "matches" isn't read as an id
  @Get('matches')
  matches(@Query(new ZodValidationPipe(findMatchesSchema)) query: FindMatches) {
    return this.guests.findMatches(query);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.guests.get(id);
  }

  @Post()
  @RequireAccess('guests', 'edit')
  create(@Body(new ZodValidationPipe(createGuestSchema)) body: CreateGuest) {
    return this.guests.create(body);
  }

  @Patch(':id')
  @RequireAccess('guests', 'edit')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(updateGuestSchema)) body: UpdateGuest) {
    return this.guests.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAccess('guests', 'edit')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.guests.remove(id);
  }

  // Bringing back a deleted guest is for admins (Settings → Deleted items).
  @Post(':id/restore')
  @RequireAccess('settings', 'edit')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.guests.restore(id);
  }

  // ---------- emails and phones ----------
  @Post(':id/contact-methods')
  @RequireAccess('guests', 'edit')
  addContactMethod(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(createContactMethodSchema)) body: CreateContactMethod,
  ) {
    return this.contactMethods.add(id, body);
  }

  @Patch(':id/contact-methods/:methodId')
  @RequireAccess('guests', 'edit')
  updateContactMethod(
    @Param('id', ParseIntPipe) id: number,
    @Param('methodId', ParseIntPipe) methodId: number,
    @Body(new ZodValidationPipe(updateContactMethodSchema)) body: UpdateContactMethod,
  ) {
    return this.contactMethods.update(id, methodId, body);
  }

  @Delete(':id/contact-methods/:methodId')
  @RequireAccess('guests', 'edit')
  removeContactMethod(@Param('id', ParseIntPipe) id: number, @Param('methodId', ParseIntPipe) methodId: number) {
    return this.contactMethods.remove(id, methodId);
  }
}
