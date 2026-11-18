import { Module } from '@nestjs/common';
import { MailchimpModule } from '../mailchimp/mailchimp.module.js';
import { CampaignFormService } from './campaign-form.service.js';
import { CampaignPeopleService } from './campaign-people.service.js';
import { CampaignReportService } from './campaign-report.service.js';
import { CampaignSyncService } from './campaign-sync.service.js';
import { CampaignsController, PublicCampaignsController } from './campaigns.controllers.js';
import { CampaignsService } from './campaigns.service.js';
import { TurnstileVerifier } from './turnstile.js';

// Campaigns: Marketing → Campaigns in the CRM, and the public form in
// campaigns/ whose responses become leads (source 'campaign') for the
// campaign's owner. The slug, opt-in and note rules are pure functions in
// campaign-rules.ts; the Cloudflare bot check is in turnstile.ts. Each
// campaign's Mailchimp report is in campaign-report.service.ts; its
// recipients and their opens and clicks are synced by campaign-sync.service.ts.
@Module({
  imports: [MailchimpModule],
  controllers: [CampaignsController, PublicCampaignsController],
  providers: [
    CampaignsService,
    CampaignFormService,
    CampaignReportService,
    CampaignSyncService,
    CampaignPeopleService,
    TurnstileVerifier,
  ],
})
export class CampaignsModule {}
