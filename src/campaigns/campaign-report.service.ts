import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { campaigns, countries } from '../db/schema/index.js';
import { MailchimpClient } from '../mailchimp/mailchimp.client.js';
import {
  CAMPAIGN_FIELDS,
  REPORT_LIST_FIELDS,
  toReport,
  toSummaries,
  type McCampaign,
  type McClickDetails,
  type McDomains,
  type McLocations,
  type McReport,
  type McReportsPage,
} from './mailchimp-report.js';

const MAX = 1000; // Mailchimp's largest page

// ---------------------------------------------------------------------
// Campaign reports from Mailchimp: each CRM campaign is linked to its one
// Mailchimp email (campaigns.mailchimp_campaign_id), and its page shows that
// email's report, fetched live (kept for 5 minutes, see MailchimpClient).
// The CRM's own figures (form leads) come with the campaign itself.
// ---------------------------------------------------------------------
@Injectable()
export class CampaignReportService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly mailchimp: MailchimpClient,
  ) {}

  // Sent Mailchimp emails, newest first, to link a campaign to; each says
  // which CRM campaign has it already.
  async emails() {
    const page = await this.mailchimp.get<{ campaigns: McCampaign[] }>('/campaigns', {
      status: 'sent',
      sort_field: 'send_time',
      sort_dir: 'DESC',
      count: MAX,
      fields: 'campaigns.id,campaigns.send_time,campaigns.emails_sent,campaigns.settings.title,campaigns.settings.subject_line',
    });
    const linked = await this.linkedCampaigns();
    return page.campaigns.map((c) => ({
      id: c.id,
      title: c.settings.title?.trim() || null,
      subject: c.settings.subject_line?.trim() || null,
      sentAt: c.send_time || null,
      sent: c.emails_sent,
      linkedTo: linked.get(c.id) ?? null,
    }));
  }

  // For the campaign list: each sent email's headline figures, in one request.
  async summaries() {
    const page = await this.mailchimp.get<McReportsPage>('/reports', { count: MAX, fields: REPORT_LIST_FIELDS });
    return toSummaries(page);
  }

  // A campaign's full report. `fresh` is the Refresh button.
  async report(campaignId: number, fresh: boolean) {
    const mailchimpId = await this.mailchimpIdOf(campaignId);
    const at = <T>(path: string, query: Record<string, string | number>) => this.mailchimp.get<T>(path, query, { fresh });
    const id = encodeURIComponent(mailchimpId);
    const [campaign, report, clicks, locations, domains, names] = await Promise.all([
      at<McCampaign>(`/campaigns/${id}`, { fields: CAMPAIGN_FIELDS }),
      at<McReport>(`/reports/${id}`, { exclude_fields: '_links,ecommerce,facebook_likes,delivery_status' }),
      at<McClickDetails>(`/reports/${id}/click-details`, { count: MAX, exclude_fields: 'urls_clicked._links,_links' }),
      at<McLocations>(`/reports/${id}/locations`, { count: MAX, exclude_fields: '_links' }),
      at<McDomains>(`/reports/${id}/domain-performance`, { exclude_fields: '_links' }),
      this.countryNames(),
    ]);
    return { fetchedAt: new Date().toISOString(), ...toReport(campaign, report, clicks, locations, domains, names) };
  }

  // The email itself, for the preview. Shown in a sandboxed frame by the app.
  async emailHtml(campaignId: number) {
    const mailchimpId = await this.mailchimpIdOf(campaignId);
    const content = await this.mailchimp.get<{ html?: string }>(`/campaigns/${encodeURIComponent(mailchimpId)}/content`, {
      fields: 'html',
    });
    return { html: content.html ?? '' };
  }

  // Is it a sent email in Mailchimp? Checked before a campaign is linked to it.
  async assertSentEmail(mailchimpId: string) {
    const campaign = await this.mailchimp.get<Pick<McCampaign, 'status'>>(`/campaigns/${encodeURIComponent(mailchimpId)}`, {
      fields: 'status',
    });
    if (campaign.status !== 'sent') {
      throw new NotFoundException('That Mailchimp email hasn’t been sent yet. Link it once it has gone out.');
    }
  }

  private async mailchimpIdOf(campaignId: number) {
    const [row] = await this.db
      .select({ mailchimpId: campaigns.mailchimpCampaignId })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
    if (!row) throw new NotFoundException('Campaign not found');
    if (!row.mailchimpId) throw new NotFoundException('This campaign isn’t linked to a Mailchimp email yet');
    return row.mailchimpId;
  }

  private async linkedCampaigns() {
    const rows = await this.db
      .select({ id: campaigns.id, name: campaigns.name, mailchimpId: campaigns.mailchimpCampaignId })
      .from(campaigns)
      .where(and(isNotNull(campaigns.mailchimpCampaignId), isNull(campaigns.deletedAt)));
    return new Map(rows.map((r) => [r.mailchimpId!, { id: r.id, name: r.name }]));
  }

  private async countryNames() {
    const rows = await this.db.select({ code: countries.code, name: countries.name }).from(countries);
    return new Map(rows.map((r) => [r.code, r.name]));
  }
}
