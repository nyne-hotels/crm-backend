import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentStaff, RequireAccess } from '../auth/decorators.js';
import type { SignedInStaff } from '../auth/signed-in-staff.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { GuestTagsService } from './guest-tags.service.js';
import {
  addTagSchema,
  createNoteSchema,
  createPreferenceSchema,
  createSpecialDateSchema,
  listUpcomingSchema,
  updateNoteSchema,
  updatePreferenceSchema,
  updateSpecialDateSchema,
  type AddTag,
  type CreateNote,
  type CreatePreference,
  type CreateSpecialDate,
  type ListUpcoming,
  type UpdateNote,
  type UpdatePreference,
  type UpdateSpecialDate,
} from './knowledge.schemas.js';
import { NotesService } from './notes.service.js';
import { PreferencesService } from './preferences.service.js';
import { SpecialDatesService } from './special-dates.service.js';
import { UpcomingOccasionsService } from './upcoming-occasions.service.js';

// What staff know about a guest: likes and dislikes, notes, special dates and
// tags (the 'guests' area). Every role reads them; admin and management add,
// edit and delete (marketing views only).
@Controller('guests/:guestId')
@RequireAccess('guests', 'view')
export class GuestKnowledgeController {
  constructor(
    private readonly preferences: PreferencesService,
    private readonly notes: NotesService,
    private readonly specialDates: SpecialDatesService,
    private readonly tags: GuestTagsService,
  ) {}

  // ---------- likes and dislikes ----------
  @Get('preferences')
  listPreferences(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.preferences.list(guestId);
  }

  @Post('preferences')
  @RequireAccess('guests', 'edit')
  addPreference(
    @Param('guestId', ParseIntPipe) guestId: number,
    @Body(new ZodValidationPipe(createPreferenceSchema)) body: CreatePreference,
  ) {
    return this.preferences.create(guestId, body);
  }

  @Patch('preferences/:id')
  @RequireAccess('guests', 'edit')
  updatePreference(
    @Param('guestId', ParseIntPipe) guestId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updatePreferenceSchema)) body: UpdatePreference,
  ) {
    return this.preferences.update(guestId, id, body);
  }

  @Delete('preferences/:id')
  @HttpCode(204)
  @RequireAccess('guests', 'edit')
  async removePreference(@Param('guestId', ParseIntPipe) guestId: number, @Param('id', ParseIntPipe) id: number) {
    await this.preferences.remove(guestId, id);
  }

  // ---------- notes (edit and delete are on /notes/:id) ----------
  @Get('notes')
  listNotes(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.notes.forGuest(guestId);
  }

  @Post('notes')
  @RequireAccess('guests', 'edit')
  addNote(@Param('guestId', ParseIntPipe) guestId: number, @Body(new ZodValidationPipe(createNoteSchema)) body: CreateNote) {
    return this.notes.addToGuest(guestId, body);
  }

  // ---------- birthdays and anniversaries ----------
  @Get('special-dates')
  listSpecialDates(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.specialDates.list(guestId);
  }

  @Post('special-dates')
  @RequireAccess('guests', 'edit')
  addSpecialDate(
    @Param('guestId', ParseIntPipe) guestId: number,
    @Body(new ZodValidationPipe(createSpecialDateSchema)) body: CreateSpecialDate,
  ) {
    return this.specialDates.create(guestId, body);
  }

  @Patch('special-dates/:id')
  @RequireAccess('guests', 'edit')
  updateSpecialDate(
    @Param('guestId', ParseIntPipe) guestId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateSpecialDateSchema)) body: UpdateSpecialDate,
  ) {
    return this.specialDates.update(guestId, id, body);
  }

  @Delete('special-dates/:id')
  @HttpCode(204)
  @RequireAccess('guests', 'edit')
  async removeSpecialDate(@Param('guestId', ParseIntPipe) guestId: number, @Param('id', ParseIntPipe) id: number) {
    await this.specialDates.remove(guestId, id);
  }

  // ---------- tags (the profile lists them; these return the whole profile) ----------
  @Post('tags')
  @RequireAccess('guests', 'edit')
  addTag(@Param('guestId', ParseIntPipe) guestId: number, @Body(new ZodValidationPipe(addTagSchema)) body: AddTag) {
    return this.tags.add(guestId, body.tagId);
  }

  @Delete('tags/:tagId')
  @RequireAccess('guests', 'edit')
  removeTag(@Param('guestId', ParseIntPipe) guestId: number, @Param('tagId', ParseIntPipe) tagId: number) {
    return this.tags.remove(guestId, tagId);
  }
}

// Notes on the stay detail. They are the guest's notes too (see NotesService).
@Controller('stays/:stayId/notes')
@RequireAccess('guests', 'view')
export class StayNotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  list(@Param('stayId', ParseIntPipe) stayId: number) {
    return this.notes.forStay(stayId);
  }

  @Post()
  @RequireAccess('guests', 'edit')
  add(@Param('stayId', ParseIntPipe) stayId: number, @Body(new ZodValidationPipe(createNoteSchema)) body: CreateNote) {
    return this.notes.addToStay(stayId, body.body);
  }
}

// Editing and deleting a note, wherever it shows: only its author or an admin.
@Controller('notes')
@RequireAccess('guests', 'edit')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateNoteSchema)) body: UpdateNote,
    @CurrentStaff() staff: SignedInStaff,
  ) {
    return this.notes.update(id, body, staff);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: SignedInStaff) {
    await this.notes.remove(id, staff);
  }
}

// Guests → Upcoming occasions.
@Controller('special-dates/upcoming')
@RequireAccess('guests', 'view')
export class UpcomingOccasionsController {
  constructor(private readonly upcoming: UpcomingOccasionsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listUpcomingSchema)) query: ListUpcoming) {
    return this.upcoming.list(query);
  }
}
