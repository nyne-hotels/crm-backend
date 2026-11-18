import { dataCentreOf, problemFor } from '../mailchimp/mailchimp.client.js';
import { toReport, toSummaries, type McCampaign, type McReport } from './mailchimp-report.js';

const campaign: McCampaign = {
  id: 'd610b94234',
  status: 'sent',
  send_time: '2026-11-17T11:30:00+00:00',
  emails_sent: 2513,
  long_archive_url: 'https://mailchi.mp/x/table',
  recipients: { list_name: 'Nyne Hotels', segment_text: '<p>All subscribers</p>' },
  settings: { subject_line: ' Dinner at Table ', preview_text: '', title: 'Table by Nyne', from_name: 'Nyne Hotels' },
};

const report: McReport = {
  id: 'd610b94234',
  emails_sent: 2513,
  abuse_reports: 1,
  unsubscribed: 36,
  send_time: '2026-11-17T11:30:00+00:00',
  bounces: { hard_bounces: 2, soft_bounces: 40, syntax_errors: 1 },
  forwards: { forwards_count: 3 },
  opens: {
    opens_total: 1237,
    unique_opens: 925,
    open_rate: 0.374,
    proxy_excluded_unique_opens: 362,
    proxy_excluded_open_rate: 0.146,
    last_open: '2026-11-18T09:37:57+00:00',
  },
  clicks: { clicks_total: 93, unique_subscriber_clicks: 30, click_rate: 0.012, last_click: '' },
  list_stats: { open_rate: 42.47, proxy_excluded_open_rate: 18.03, click_rate: 1.8 },
  timeseries: [{ timestamp: '2026-11-17T11:00:00+00:00', unique_opens: 33, proxy_excluded_unique_opens: 23, recipients_clicks: 5 }],
};

describe('a campaign’s Mailchimp report', () => {
  const r = toReport(
    campaign,
    report,
    {
      urls_clicked: [
        { url: 'https://a.example/', total_clicks: 15, unique_clicks: 12, click_percentage: 0.16 },
        { url: 'https://b.example/', total_clicks: 17, unique_clicks: 13, click_percentage: 0.18 },
      ],
    },
    {
      locations: [
        { country_code: 'US', opens: 315, proxy_excluded_opens: 1 },
        { country_code: 'US', opens: 233, proxy_excluded_opens: 233 },
        { country_code: 'lk', opens: 50 },
        { country_code: '', opens: 9 },
      ],
    },
    { domains: [{ domain: 'gmail.com', emails_sent: 1421, delivered: 1413, bounces: 8, opens: 457, clicks: 9, unsubs: 11 }] },
    new Map([['US', 'United States'], ['LK', 'Sri Lanka']]),
  );

  it('leads with opens without Apple Mail’s automatic ones, and keeps the all-in figures', () => {
    expect(r.opens).toEqual({ people: 362, rate: 0.146, allPeople: 925, allRate: 0.374, total: 1237, last: '2026-11-18T09:37:57+00:00' });
    expect(r.clicks).toEqual({ people: 30, rate: 0.012, total: 93, last: null });
  });

  it('turns the audience average from percentages into fractions', () => {
    expect(r.audienceAverage?.openRate).toBeCloseTo(0.1803);
    expect(r.audienceAverage?.clickRate).toBeCloseTo(0.018);
    expect(r.industryAverage).toBeNull();
  });

  it('counts delivered as sent less every bounce', () => {
    expect(r.delivered).toBe(2513 - 43);
    expect(r.bounces).toEqual({ hard: 2, soft: 41 });
  });

  it('tidies the email’s details', () => {
    expect(r.email.subject).toBe('Dinner at Table');
    expect(r.email.previewText).toBeNull();
    expect(r.email.segment).toBe('All subscribers');
  });

  it('adds regions up into countries, by opens', () => {
    expect(r.countries).toEqual([
      { code: 'US', name: 'United States', opens: 234, allOpens: 548 },
      { code: 'LK', name: 'Sri Lanka', opens: 50, allOpens: 50 },
    ]);
  });

  it('puts the most clicked links first', () => {
    expect(r.links.map((l) => l.url)).toEqual(['https://b.example/', 'https://a.example/']);
  });
});

describe('the campaign list’s figures', () => {
  it('uses the open rate without Apple Mail’s opens when Mailchimp has it', () => {
    const [a, b] = toSummaries({
      reports: [
        { id: 'a', emails_sent: 10, send_time: '', unsubscribed: 0, opens: { open_rate: 0.4, proxy_excluded_open_rate: 0.2 }, clicks: { click_rate: 0.01 } },
        { id: 'b', emails_sent: 10, send_time: '', unsubscribed: 0, opens: { open_rate: 0.4 }, clicks: { click_rate: 0.01 } },
      ],
    });
    expect(a.openRate).toBe(0.2);
    expect(b.openRate).toBe(0.4);
    expect(a.sentAt).toBeNull();
  });
});

describe('Mailchimp problems', () => {
  it('treats 401 and 403 as the key (an expired key answers 401)', () => {
    expect(problemFor(401)).toBe('mailchimp_key_rejected');
    expect(problemFor(403)).toBe('mailchimp_key_rejected');
    expect(problemFor(404)).toBe('mailchimp_not_found');
    expect(problemFor(429)).toBe('mailchimp_busy');
    expect(problemFor(500)).toBe('mailchimp_unavailable');
  });

  it('finds the data centre at the end of the key', () => {
    // built, not written out: a literal that looks like a real key trips GitHub's secret scanning
    expect(dataCentreOf(`${'x'.repeat(32)}-us3`)).toBe('us3');
    expect(dataCentreOf('0123456789abcdef')).toBeNull();
  });
});
