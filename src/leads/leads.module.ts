import { Module } from '@nestjs/common';
import { InteractionsService } from './interactions.service.js';
import { GuestLeadsController, InteractionsController, LeadsController } from './leads.controllers.js';
import { LeadsService } from './leads.service.js';

// Sales (Module 7): leads with their board, list, detail and timeline, My
// follow-ups, logged conversations, and the Leads panel on the guest profile.
// The status rules and automatic conversion are pure functions in
// lead-rules.ts; lead-writer.ts logs status changes and converts leads when
// a booking arrives (called by the stays module).
@Module({
  controllers: [LeadsController, InteractionsController, GuestLeadsController],
  providers: [LeadsService, InteractionsService],
})
export class LeadsModule {}
