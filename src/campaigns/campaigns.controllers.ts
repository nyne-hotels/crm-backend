import { Body, Controller, Get, HttpCode, Ip, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { Public, RequireAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CampaignFormService } from './campaign-form.service.js';
import {
  campaignResponseSchema,
  campaignSlugSchema,
  createCampaignSchema,
  updateCampaignSchema,
  type CampaignResponse,
  type CreateCampaign,
  type UpdateCampaign,
} from './campaigns.schemas.js';
import { CampaignsService } from './campaigns.service.js';

// Marketing → Campaigns. Every role sees them; admin and management add and change them.
@Controller('campaigns')
@RequireAccess('campaigns', 'view')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list() {
    return this.campaigns.list();
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

  // rename, change the link or the owner, or close / reopen with isActive
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
