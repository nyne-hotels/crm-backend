import { Module } from '@nestjs/common';
import { CampaignFormService } from './campaign-form.service.js';
import { CampaignsController, PublicCampaignsController } from './campaigns.controllers.js';
import { CampaignsService } from './campaigns.service.js';

// Campaigns: Marketing → Campaigns in the CRM, and the public form in
// campaigns/ whose responses become leads (source 'campaign') for the
// campaign's owner. The slug, opt-in and note rules are pure functions in
// campaign-rules.ts.
@Module({
  controllers: [CampaignsController, PublicCampaignsController],
  providers: [CampaignsService, CampaignFormService],
})
export class CampaignsModule {}
