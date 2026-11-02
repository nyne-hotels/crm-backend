import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module.js';
import { GuestTagsService } from './guest-tags.service.js';
import {
  GuestKnowledgeController,
  NotesController,
  StayNotesController,
  UpcomingOccasionsController,
} from './knowledge.controllers.js';
import { NotesService } from './notes.service.js';
import { PreferencesService } from './preferences.service.js';
import { SpecialDatesService } from './special-dates.service.js';
import { UpcomingOccasionsService } from './upcoming-occasions.service.js';

// Guest knowledge (Module 4): likes and dislikes, notes (on the profile and on
// stays), birthdays and anniversaries, tags on a guest, and Upcoming occasions.
// The tag list itself is in Settings → Tags.
@Module({
  imports: [GuestsModule],
  controllers: [GuestKnowledgeController, StayNotesController, NotesController, UpcomingOccasionsController],
  providers: [PreferencesService, NotesService, SpecialDatesService, GuestTagsService, UpcomingOccasionsService],
})
export class KnowledgeModule {}
