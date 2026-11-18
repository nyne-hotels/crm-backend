import { Module } from '@nestjs/common';
import { MailchimpAudienceService } from './mailchimp-audience.service.js';
import { MailchimpClient } from './mailchimp.client.js';
import { MailchimpAudienceController, MailchimpWebhookController } from './mailchimp.controllers.js';

// Mailchimp: its Marketing API (mailchimp.client.ts), used by campaign
// reports and the sync, and the audience's unsubscribes and bounces, applied
// to the CRM from the webhook and a daily check (mailchimp-audience.service.ts).
@Module({
  controllers: [MailchimpAudienceController, MailchimpWebhookController],
  providers: [MailchimpClient, MailchimpAudienceService],
  exports: [MailchimpClient],
})
export class MailchimpModule {}
