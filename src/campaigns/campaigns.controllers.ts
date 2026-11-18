import { Body, Controller, Get, HttpCode, Ip, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Public, RequireAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CampaignFormService } from './campaign-form.service.js';
import { CampaignPeopleService } from './campaign-people.service.js';
import { CampaignReportService } from './campaign-report.service.js';
import { CampaignSyncService } from './campaign-sync.service.js';
import {
  campaignResponseSchema,
  campaignSlugSchema,
  createCampaignSchema,
  peopleQuerySchema,
  reportQuerySchema,
  updateCampaignSchema,
  type CampaignResponse,
  type CreateCampaign,
  type PeopleQuery,
  type ReportQuery,
  type UpdateCampaign,
} from './campaigns.schemas.js';
import { CampaignsService } from './campaigns.service.js';

// Marketing → Campaigns. Every role sees them; admin and management add and change them.
@Controller('campaigns')
@RequireAccess('campaigns', 'view')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly reports: CampaignReportService,
    private readonly people: CampaignPeopleService,
    private readonly syncs: CampaignSyncService,
  ) {}

  @Get()
  list() {
    return this.campaigns.list();
  }

  // ---- Mailchimp (see CampaignReportService) ----
  // headline figures of every sent email, for the list
  @Get('mailchimp/summaries')
  summaries() {
    return this.reports.summaries();
  }

  // sent emails to link a campaign to
  @Get('mailchimp/emails')
  @RequireAccess('campaigns', 'edit')
  emails() {
    return this.reports.emails();
  }

  @Get(':id/report')
  report(@Param('id', ParseIntPipe) id: number, @Query(new ZodValidationPipe(reportQuerySchema)) query: ReportQuery) {
    return this.reports.report(id, query.fresh === '1');
  }

  @Get(':id/email-html')
  emailHtml(@Param('id', ParseIntPipe) id: number) {
    return this.reports.emailHtml(id);
  }

  // ---- synced from Mailchimp (see CampaignSyncService) ----
  // recipients matched and added, bookings that followed, and the sync's state
  @Get(':id/results')
  results(@Param('id', ParseIntPipe) id: number) {
    return this.people.results(id);
  }

  @Get(':id/people')
  peopleList(@Param('id', ParseIntPipe) id: number, @Query(new ZodValidationPipe(peopleQuerySchema)) query: PeopleQuery) {
    return this.people.people(id, query);
  }

  // Sync now
  @Post(':id/sync')
  @HttpCode(200)
  @RequireAccess('campaigns', 'edit')
  async sync(@Param('id', ParseIntPipe) id: number) {
    await this.syncs.sync(id);
    return this.people.results(id);
  }

  // a guest's campaign emails, for their profile
  @Get('contact/:contactId/emails')
  contactEmails(@Param('contactId', ParseIntPipe) contactId: number) {
    return this.people.forContact(contactId);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.get(id);
  }

  @Post()
  @RequireAccess('campaigns', 'edit')
  create(@Body(new ZodValidationPipe(createCampaignSchema)) body: CreateCampaign) {
    return this.campaigns.create(body);
  }

  // rename, change the link or the owner, link the Mailchimp email, or close / reopen with isActive
  @Patch(':id')
  @RequireAccess('campaigns', 'edit')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(updateCampaignSchema)) body: UpdateCampaign) {
    return this.campaigns.update(id, body);
  }
}

// The campaign site's form (campaigns/), without signing in. main.ts lets
// only the campaign site's address call these from a browser (CORS).
@Controller('public/campaigns')
@Public()
export class PublicCampaignsController {
  constructor(private readonly form: CampaignFormService) {}

  @Get(':slug')
  get(@Param('slug', new ZodValidationPipe(campaignSlugSchema)) slug: string) {
    return this.form.get(slug);
  }

  @Post(':slug/responses')
  @HttpCode(201)
  submit(
    @Param('slug', new ZodValidationPipe(campaignSlugSchema)) slug: string,
    @Body(new ZodValidationPipe(campaignResponseSchema)) body: CampaignResponse,
    @Ip() ip: string,
  ) {
    return this.form.submit(slug, body, ip);
  }
}
