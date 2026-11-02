import { Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller.js';
import { CompaniesService } from './companies.service.js';

// Companies (Module 7): travel agents, DMCs, OTAs, corporates and media, with
// their people, the stays booked through them and a timeline of conversations
// and notes. Also the company pick-list (/companies/options).
@Module({
  controllers: [CompaniesController],
  providers: [CompaniesService],
})
export class CompaniesModule {}
