import { Module } from '@nestjs/common';
import { GuestConsentController, MarketingController } from './consent.controllers.js';
import { EmailListService } from './email-list.service.js';
import { EmailUploadsService } from './email-uploads.service.js';
import { GuestConsentService } from './guest-consent.service.js';

// Consent and the marketing list (Module 5): the Consent panel and do not
// contact on the profile, Marketing → Email list with its logged export, and
// unsubscribe and bounce uploads. Consent itself changes only through
// recordConsentChoices() (consent-writer.ts), which the booking import uses too.
@Module({
  controllers: [GuestConsentController, MarketingController],
  providers: [GuestConsentService, EmailListService, EmailUploadsService],
})
export class ConsentModule {}
