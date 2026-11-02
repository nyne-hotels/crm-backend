import { Module } from '@nestjs/common';
import { ContactMethodsService } from './contact-methods.service.js';
import { GuestsController } from './guests.controller.js';
import { GuestsService } from './guests.service.js';

// Guests → list, search, profile, add / edit / delete, emails and phones (Module 2).
@Module({
  controllers: [GuestsController],
  providers: [GuestsService, ContactMethodsService],
  exports: [GuestsService],
})
export class GuestsModule {}
