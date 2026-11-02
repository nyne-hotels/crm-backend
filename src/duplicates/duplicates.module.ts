import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module.js';
import { DuplicatesController, MergeHistoryController } from './duplicates.controllers.js';
import { DuplicatesService } from './duplicates.service.js';
import { MergeHistoryService } from './merge-history.service.js';

// Duplicates and merging (Module 6): Guests → Possible duplicates, the
// side-by-side merge screen with its preview, "Not a duplicate", and
// Settings → Merge history. The merge itself is merge_contacts() in the
// database (migration 0012); the rules around it are in merge-rules.ts.
@Module({
  imports: [GuestsModule],
  controllers: [DuplicatesController, MergeHistoryController],
  providers: [DuplicatesService, MergeHistoryService],
})
export class DuplicatesModule {}
