import { Module } from '@nestjs/common';
import { GuestConsentController, MarketingController } from './consent.controllers.js';
import { EmailListService } from './email-list.service.js';
import { GuestConsentService } from './guest-consent.service.js';

// Consent and the marketing list (Module 5): the Consent panel and do not
// contact on the profile, and Marketing → Email list with its logged export.
// Consent itself changes only through recordConsentChoices() (consent-writer.ts),
// which the booking import and Mailchimp's unsubscribes (email-changes.ts) use too.
@Module({
  controllers: [GuestConsentController, MarketingController],
  providers: [GuestConsentService, EmailListService],
})
export class ConsentModule {}
