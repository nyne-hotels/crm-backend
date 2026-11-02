import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { RequireAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { ConsentChannel } from './consent-rules.js';
import {
  changeConsentSchema,
  commitUploadSchema,
  consentChannelSchema,
  emailListFilterSchema,
  listEmailListSchema,
  previewUploadSchema,
  type ChangeConsent,
  type CommitUpload,
  type EmailListFilter,
  type ListEmailList,
  type PreviewUpload,
} from './consent.schemas.js';
import { EmailListService } from './email-list.service.js';
import { EmailUploadsService } from './email-uploads.service.js';
import { GuestConsentService } from './guest-consent.service.js';

// The Consent panel on the guest profile. Every role sees it; admin,
// management and marketing record consent and set do not contact; only
// admin and management clear it.
@Controller('guests/:guestId')
@RequireAccess('guestConsent', 'view')
export class GuestConsentController {
  constructor(private readonly consent: GuestConsentService) {}

  @Get('consents')
  get(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.consent.get(guestId);
  }

  @Put('consents/:channel')
  @RequireAccess('guestConsent', 'edit')
  change(
    @Param('guestId', ParseIntPipe) guestId: number,
    @Param('channel', new ZodValidationPipe(consentChannelSchema)) channel: ConsentChannel,
    @Body(new ZodValidationPipe(changeConsentSchema)) body: ChangeConsent,
  ) {
    return this.consent.change(guestId, channel, body);
  }

  @Post('do-not-contact')
  @HttpCode(200)
  @RequireAccess('guestConsent', 'edit')
  setDoNotContact(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.consent.setDoNotContact(guestId);
  }

  @Delete('do-not-contact')
  @RequireAccess('clearDoNotContact', 'edit')
  clearDoNotContact(@Param('guestId', ParseIntPipe) guestId: number) {
    return this.consent.clearDoNotContact(guestId);
  }
}

// Marketing → Email list and its export (every role views; export is logged).
@Controller('marketing')
@RequireAccess('marketingExport', 'view')
export class MarketingController {
  constructor(
    private readonly emailList: EmailListService,
    private readonly uploads: EmailUploadsService,
  ) {}

  @Get('email-list')
  list(@Query(new ZodValidationPipe(listEmailListSchema)) query: ListEmailList) {
    return this.emailList.list(query);
  }

  @Post('email-list/export')
  @HttpCode(200)
  @RequireAccess('marketingExport', 'edit')
  export(@Body(new ZodValidationPipe(emailListFilterSchema)) body: EmailListFilter) {
    return this.emailList.export(body);
  }

  @Get('exports')
  exports() {
    return this.emailList.history();
  }

  // Marketing → Upload unsubscribes or bounces
  @Post('uploads/preview')
  @HttpCode(200)
  @RequireAccess('guestConsent', 'edit')
  previewUpload(@Body(new ZodValidationPipe(previewUploadSchema)) body: PreviewUpload) {
    return this.uploads.preview(body);
  }

  @Post('uploads')
  @RequireAccess('guestConsent', 'edit')
  upload(@Body(new ZodValidationPipe(commitUploadSchema)) body: CommitUpload) {
    return this.uploads.commit(body);
  }
}
