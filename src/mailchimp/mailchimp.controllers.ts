import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { Public, RequireAccess } from '../auth/decorators.js';
import { MailchimpAudienceService } from './mailchimp-audience.service.js';
import type { McWebhook } from './mailchimp-audience-rules.js';

// Marketing → Unsubscribes & bounces: what Mailchimp has sent, and Check now.
@Controller('marketing/mailchimp')
@RequireAccess('marketingExport', 'view')
export class MailchimpAudienceController {
  constructor(private readonly audience: MailchimpAudienceService) {}

  @Get()
  status() {
    return this.audience.status();
  }

  @Post('check')
  @HttpCode(200)
  @RequireAccess('guestConsent', 'edit')
  async check() {
    await this.audience.check();
    return this.audience.status();
  }

  // the webhook's address holds its secret: admins only
  @Get('webhook')
  @RequireAccess('settings', 'edit')
  webhook() {
    return this.audience.webhookUrl();
  }
}

// Mailchimp's webhook. Mailchimp checks the address with a GET when it's
// added, then POSTs form fields. A wrong secret is a plain 404.
@Controller('public/mailchimp/webhook')
@Public()
export class MailchimpWebhookController {
  constructor(private readonly audience: MailchimpAudienceService) {}

  @Get(':secret')
  verify(@Param('secret') secret: string) {
    if (!this.audience.secretMatches(secret)) throw new NotFoundException();
    return { ok: true };
  }

  @Post(':secret')
  @HttpCode(200)
  receive(@Param('secret') secret: string, @Body() body: McWebhook) {
    return this.audience.webhook(secret, body ?? {});
  }
}
