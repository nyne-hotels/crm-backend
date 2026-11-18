// ---------------------------------------------------------------------
// A campaign's Mailchimp report, reshaped for the CRM's report page. Pure
// functions over Mailchimp's answers, so they're tested without Mailchimp.
//
// Every rate here is a fraction (0.146 = 14.6%). Mailchimp mixes them: a
// report's own rates are fractions, but list_stats are percentages.
//
// Opens: Apple Mail (Mail Privacy Protection) opens every email it receives,
// read or not, which inflates opens a lot (37% vs 15% on Nyne's emails). The
// report leads with Mailchimp's figures that leave those out
// ("proxy_excluded"), and keeps the all-in figures beside them.
// ---------------------------------------------------------------------

// ---------- what Mailchimp sends (only the fields used) ----------
export interface McCampaign {
  id: string;
  status: string; // 'sent', 'save', 'schedule' …
  send_time: string | null;
  emails_sent: number;
  long_archive_url?: string; // the email's web version
  recipients: { list_name?: string; segment_text?: string; recipient_count?: number };
  settings: { subject_line?: string; preview_text?: string; title?: string; from_name?: string; reply_to?: string };
}

export interface McReport {
  id: string;
  emails_sent: number;
  abuse_reports: number;
  unsubscribed: number;
  send_time: string;
  bounces: { hard_bounces: number; soft_bounces: number; syntax_errors: number };
  forwards: { forwards_count: number };
  opens: {
    opens_total: number;
    unique_opens: number;
    open_rate: number;
    proxy_excluded_unique_opens?: number;
    proxy_excluded_open_rate?: number;
    last_open?: string;
  };
  clicks: { clicks_total: number; unique_subscriber_clicks: number; click_rate: number; last_click?: string };
  list_stats?: { open_rate?: number; proxy_excluded_open_rate?: number; click_rate?: number; unsub_rate?: number };
  industry_stats?: { type?: string; open_rate?: number; click_rate?: number; bounce_rate?: number; unsub_rate?: number };
  timeseries?: { timestamp: string; unique_opens: number; proxy_excluded_unique_opens?: number; recipients_clicks: number }[];
}

export interface McClickDetails {
  urls_clicked: { url: string; total_clicks: number; unique_clicks: number; click_percentage: number; last_click?: string }[];
}

export interface McLocations {
  locations: { country_code: string; opens: number; proxy_excluded_opens?: number }[];
}

export interface McDomains {
  domains: {
    domain: string;
    emails_sent: number;
    delivered: number;
    bounces: number;
    opens: number;
    clicks: number;
    unsubs: number;
  }[];
}

// ---------- what the CRM shows ----------
export interface CampaignReport {
  email: {
    id: string;
    title: string | null; // Mailchimp's own name for it
    subject: string | null;
    previewText: string | null;
    fromName: string | null;
    replyTo: string | null;
    sentAt: string | null;
    audience: string | null;
    segment: string | null; // who in the audience it went to, in Mailchimp's words
    webVersionUrl: string | null;
  };
  sent: number;
  delivered: number;
  bounces: { hard: number; soft: number };
  unsubscribed: number;
  spamReports: number;
  forwards: number;
  opens: {
    people: number; // without Apple Mail's automatic opens
    rate: number;
    allPeople: number; // with them
    allRate: number;
    total: number; // every open, counting repeats
    last: string | null;
  };
  clicks: { people: number; rate: number; total: number; last: string | null };
  // the same audience's average over its campaigns, and Mailchimp's industry average when it has one
  audienceAverage: { openRate: number | null; clickRate: number | null } | null;
  industryAverage: { name: string | null; openRate: number | null; clickRate: number | null } | null;
  hourly: { at: string; opens: number; allOpens: number; clicks: number }[]; // the first day, hour by hour
  links: { url: string; clicks: number; uniqueClicks: number; share: number; last: string | null }[];
  countries: { code: string; name: string | null; opens: number; allOpens: number }[];
  domains: { domain: string; sent: number; delivered: number; bounces: number; opens: number; clicks: number; unsubscribed: number }[];
}

const percentToFraction = (v: number | undefined) => (typeof v === 'number' ? v / 100 : null);
const fraction = (v: number | undefined) => (typeof v === 'number' ? v : null);
const text = (v: string | undefined | null) => (v && v.trim() ? v.trim() : null);

export function toReport(
  campaign: McCampaign,
  report: McReport,
  clicks: McClickDetails,
  locations: McLocations,
  domains: McDomains,
  countryNames: Map<string, string>,
): CampaignReport {
  const bounced = report.bounces.hard_bounces + report.bounces.soft_bounces + report.bounces.syntax_errors;
  const list = report.list_stats;
  const industry = report.industry_stats;

  // Mailchimp splits big countries into regions; the CRM shows countries
  const byCountry = new Map<string, { opens: number; allOpens: number }>();
  for (const l of locations.locations) {
    const code = l.country_code?.toUpperCase() || '';
    if (!code) continue;
    const c = byCountry.get(code) ?? { opens: 0, allOpens: 0 };
    c.opens += l.proxy_excluded_opens ?? l.opens;
    c.allOpens += l.opens;
    byCountry.set(code, c);
  }

  return {
    email: {
      id: campaign.id,
      title: text(campaign.settings.title),
      subject: text(campaign.settings.subject_line),
      previewText: text(campaign.settings.preview_text),
      fromName: text(campaign.settings.from_name),
      replyTo: text(campaign.settings.reply_to),
      sentAt: campaign.send_time || report.send_time || null,
      audience: text(campaign.recipients.list_name),
      segment: text(campaign.recipients.segment_text?.replace(/<[^>]*>/g, '')), // Mailchimp puts HTML in it
      webVersionUrl: text(campaign.long_archive_url),
    },
    sent: report.emails_sent,
    delivered: Math.max(0, report.emails_sent - bounced),
    bounces: { hard: report.bounces.hard_bounces, soft: report.bounces.soft_bounces + report.bounces.syntax_errors },
    unsubscribed: report.unsubscribed,
    spamReports: report.abuse_reports,
    forwards: report.forwards.forwards_count,
    opens: {
      people: report.opens.proxy_excluded_unique_opens ?? report.opens.unique_opens,
      rate: report.opens.proxy_excluded_open_rate ?? report.opens.open_rate,
      allPeople: report.opens.unique_opens,
      allRate: report.opens.open_rate,
      total: report.opens.opens_total,
      last: report.opens.last_open || null,
    },
    clicks: {
      people: report.clicks.unique_subscriber_clicks,
      rate: report.clicks.click_rate,
      total: report.clicks.clicks_total,
      last: report.clicks.last_click || null,
    },
    audienceAverage: list
      ? {
          openRate: percentToFraction(list.proxy_excluded_open_rate ?? list.open_rate),
          clickRate: percentToFraction(list.click_rate),
        }
      : null,
    industryAverage:
      industry && (industry.open_rate !== undefined || industry.click_rate !== undefined)
        ? { name: text(industry.type), openRate: fraction(industry.open_rate), clickRate: fraction(industry.click_rate) }
        : null,
    hourly: (report.timeseries ?? []).map((t) => ({
      at: t.timestamp,
      opens: t.proxy_excluded_unique_opens ?? t.unique_opens,
      allOpens: t.unique_opens,
      clicks: t.recipients_clicks,
    })),
    links: clicks.urls_clicked
      .map((u) => ({
        url: u.url,
        clicks: u.total_clicks,
        uniqueClicks: u.unique_clicks,
        share: u.click_percentage,
        last: u.last_click || null,
      }))
      .sort((a, b) => b.clicks - a.clicks || a.url.localeCompare(b.url)),
    countries: [...byCountry]
      .map(([code, c]) => ({ code, name: countryNames.get(code) ?? null, ...c }))
      .sort((a, b) => b.opens - a.opens || b.allOpens - a.allOpens || a.code.localeCompare(b.code)),
    domains: domains.domains
      .map((d) => ({
        domain: d.domain,
        sent: d.emails_sent,
        delivered: d.delivered,
        bounces: d.bounces,
        opens: d.opens,
        clicks: d.clicks,
        unsubscribed: d.unsubs,
      }))
      .sort((a, b) => b.sent - a.sent || a.domain.localeCompare(b.domain)),
  };
}

// ---------- the list page: one line per campaign ----------
export interface McReportsPage {
  reports: (Pick<McReport, 'id' | 'emails_sent' | 'send_time' | 'unsubscribed'> & {
    campaign_title?: string;
    subject_line?: string;
    opens: Pick<McReport['opens'], 'open_rate' | 'proxy_excluded_open_rate'>;
    clicks: Pick<McReport['clicks'], 'click_rate'>;
  })[];
}

export interface EmailSummary {
  id: string;
  title: string | null;
  subject: string | null;
  sentAt: string | null;
  sent: number;
  openRate: number; // without Apple Mail's automatic opens
  clickRate: number;
  unsubscribed: number;
}

export function toSummaries(page: McReportsPage): EmailSummary[] {
  return page.reports.map((r) => ({
    id: r.id,
    title: text(r.campaign_title),
    subject: text(r.subject_line),
    sentAt: r.send_time || null,
    sent: r.emails_sent,
    openRate: r.opens.proxy_excluded_open_rate ?? r.opens.open_rate,
    clickRate: r.clicks.click_rate,
    unsubscribed: r.unsubscribed,
  }));
}

// The fields asked for, so Mailchimp sends less
export const REPORT_LIST_FIELDS = [
  'reports.id',
  'reports.campaign_title',
  'reports.subject_line',
  'reports.send_time',
  'reports.emails_sent',
  'reports.unsubscribed',
  'reports.opens.open_rate',
  'reports.opens.proxy_excluded_open_rate',
  'reports.clicks.click_rate',
].join(',');

export const CAMPAIGN_FIELDS = [
  'id',
  'status',
  'send_time',
  'emails_sent',
  'long_archive_url',
  'recipients.list_name',
  'recipients.segment_text',
  'recipients.recipient_count',
  'settings.subject_line',
  'settings.preview_text',
  'settings.title',
  'settings.from_name',
  'settings.reply_to',
].join(',');
