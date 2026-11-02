import { Module } from '@nestjs/common';
import { BookingImportService } from './imports/booking-import.service.js';
import { BookingImportController, GuestStaysController, StaysController } from './stays.controller.js';
import { StaysService } from './stays.service.js';

// Stays → list, detail, add / edit, check in and out, cancel, booking file
// import, and the Stays panel on the guest profile (Module 3).
// BookingImportController comes first so /stays/imports isn't taken for /stays/:id.
@Module({
  controllers: [BookingImportController, GuestStaysController, StaysController],
  providers: [StaysService, BookingImportService],
})
export class StaysModule {}
