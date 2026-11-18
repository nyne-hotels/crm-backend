import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { likePattern } from '../common/sql.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { campaigns, mailchimpSyncs } from '../db/schema/index.js';
import { HOTEL_TIME_ZONE } from '../stays/stay-rules.js';
import { BOOKING_WINDOW_DAYS } from './mailchimp-sync-rules.js';
import type { PeopleQuery } from './campaigns.schemas.js';

export const PEOPLE_PAGE_SIZE = 50;

// Raw queries give Postgres's text ('2026-11-17 11:30:00+00'); the app gets ISO.
const iso = (value: string | Date | null) => (value === null ? null : new Date(typeof value === 'string' ? value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00') : value).toISOString());
const WINDOW = sql.raw(`interval '${BOOKING_WINDOW_DAYS} days'`);
// the day a moment falls on in Colombo, to compare with a stay's arrival
const localDay = (at: SQL) => sql`(${at} at time zone ${HOTEL_TIME_ZONE})::date`;

// ---------------------------------------------------------------------
// What the sync brought in (CampaignSyncService), for the campaign's page:
// the recipients matched to the CRM, how many it added, the bookings that
// followed, and the people list. Per person, opens include Apple Mail's
// automatic ones: Mailchimp can't tell them apart for one person.
//
// Bookings within 30 days (stays not cancelled, by when they were added to
// the CRM, since stays don't record when they were booked):
//   from people who clicked – after the guest's first click
//   from everyone who got it – after the email was sent
// A stay that arrives before then is left out whenever it was added: a
// booking file with past stays (or the master list) adds old visits that
// the email can't have brought.
// ---------------------------------------------------------------------
@Injectable()
export class CampaignPeopleService {
  constructor(@InjectDb() private readonly db: Database) {}

  // the sync's state, for the email the campaign is linked to now
  private async syncOf(campaignId: number) {
    const [row] = await this.db
      .select({
        mailchimpId: campaigns.mailchimpCampaignId,
        syncedFor: mailchimpSyncs.mailchimpCampaignId,
        sentAt: mailchimpSyncs.sentAt,
        recipientsSyncedAt: mailchimpSyncs.recipientsSyncedAt,
        lastSyncedAt: mailchimpSyncs.lastSyncedAt,
        lastError: mailchimpSyncs.lastError,
        lastErrorAt: mailchimpSyncs.lastErrorAt,
      })
      .from(campaigns)
      .leftJoin(mailchimpSyncs, eq(mailchimpSyncs.campaignId, campaigns.id))
      .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
    if (!row) throw new NotFoundException('Campaign not found');
    return row.mailchimpId && row.syncedFor === row.mailchimpId ? row : null;
  }

  async results(campaignId: number) {
    const sync = await this.syncOf(campaignId);
    const status = sync && {
      lastSyncedAt: sync.lastSyncedAt,
      lastError: sync.lastError,
      lastErrorAt: sync.lastErrorAt,
    };
    if (!sync?.recipientsSyncedAt) return { sync: status, recipients: null, bookings: null, windowDays: BOOKING_WINDOW_DAYS };

    const [recipients] = (
      await this.db.execute<{ total: number; in_crm: number; added: number; shared_only: number }>(sql`
        select count(*)::int as total,
               count(*) filter (where r.contact_id is not null)::int as in_crm,
               count(*) filter (where c.added_via = 'mailchimp' and c.added_via_campaign_id = ${campaignId})::int as added,
               count(*) filter (where r.contact_id is null)::int as shared_only
          from mailchimp_recipients r
          left join contacts c on c.id = r.contact_id
         where r.campaign_id = ${campaignId}`)
    ).rows;

    const { rows } = await this.db.execute<{
      contact_id: string;
      room_revenue: string | null;
      currency: string | null;
      after_click: boolean;
      after_send: boolean;
    }>(sql`
      with rc as (
        select r.contact_id, min(a.at) filter (where a.action = 'click') as first_click
          from mailchimp_recipients r
          join contacts c on c.id = r.contact_id and c.deleted_at is null
          left join mailchimp_activity a on a.recipient_id = r.id
         where r.campaign_id = ${campaignId}
         group by r.contact_id
      )
      , b as (
        select s.contact_id, s.room_revenue, s.currency,
               coalesce(s.created_at >= rc.first_click and s.created_at < rc.first_click + ${WINDOW}
                        and s.arrival_date >= ${localDay(sql`rc.first_click`)}, false) as after_click,
               coalesce(s.created_at >= ${sync.sentAt} and s.created_at < ${sync.sentAt}::timestamptz + ${WINDOW}
                        and s.arrival_date >= ${localDay(sql`${sync.sentAt}::timestamptz`)}, false) as after_send
          from stays s
          join rc on rc.contact_id = s.contact_id
         where s.deleted_at is null and s.status <> 'cancelled'
      )
      select * from b where after_click or after_send`);

    const tally = (keep: (r: (typeof rows)[number]) => boolean) => {
      const kept = rows.filter(keep);
      const revenue = new Map<string, number>();
      for (const r of kept) {
        if (r.room_revenue === null) continue;
        const currency = r.currency ?? '';
        revenue.set(currency, (revenue.get(currency) ?? 0) + Number(r.room_revenue));
      }
      return {
        stays: kept.length,
        guests: new Set(kept.map((r) => r.contact_id)).size,
        revenue: [...revenue].map(([currency, amount]) => ({ currency: currency || null, amount })).sort((a, b) => b.amount - a.amount),
      };
    };

    return {
      sync: status,
      windowDays: BOOKING_WINDOW_DAYS,
      recipients: {
        total: recipients.total,
        inCrm: recipients.in_crm - recipients.added,
        added: recipients.added,
        sharedOnly: recipients.shared_only,
      },
      bookings: {
        fromClickers: tally((r) => r.after_click),
        fromRecipients: tally((r) => r.after_send),
      },
    };
  }

  // The people list: one row per recipient, filtered, most engaged first.
  async people(campaignId: number, query: PeopleQuery) {
    const sync = await this.syncOf(campaignId);
    const empty = { rows: [], total: 0, page: 1, pageSize: PEOPLE_PAGE_SIZE, counts: null };
    if (!sync?.recipientsSyncedAt) return empty;
    const sentAt = sync.sentAt;

    const filters: Record<PeopleQuery['show'], SQL> = {
      all: sql`true`,
      opened: sql`p.opens > 0`,
      clicked: sql`p.clicks > 0`,
      not_opened: sql`p.opens = 0 and p.delivery = 'sent'`,
      unsubscribed: sql`p.unsubscribed_at is not null`,
      bounced: sql`p.delivery <> 'sent'`,
      added: sql`p.added`,
      booked: sql`p.booked`,
    };
    const search = query.q
      ? sql`(p.email ilike ${likePattern(query.q)} or concat_ws(' ', p.first_name, p.last_name) ilike ${likePattern(query.q)})`
      : sql`true`;

    const people = sql`
      with p as (
        select r.id, r.email, r.delivery, r.unsubscribed_at, r.unsubscribe_reason,
               c.id as contact_id, c.first_name, c.last_name, c.lifecycle_stage, c.vip_reason,
               coalesce(c.added_via = 'mailchimp' and c.added_via_campaign_id = ${campaignId}, false) as added,
               count(a.id) filter (where a.action = 'open')::int as opens,
               max(a.at) filter (where a.action = 'open') as last_open,
               count(a.id) filter (where a.action = 'click')::int as clicks,
               max(a.at) filter (where a.action = 'click') as last_click,
               min(a.at) filter (where a.action = 'click') as first_click,
               exists (
                 select 1 from stays s
                  cross join lateral (
                    select min(x.at) as first_click from mailchimp_activity x where x.recipient_id = r.id and x.action = 'click'
                  ) fc
                  where s.contact_id = c.id and s.deleted_at is null and s.status <> 'cancelled'
                    and ((s.created_at >= ${sentAt} and s.created_at < ${sentAt}::timestamptz + ${WINDOW}
                          and s.arrival_date >= ${localDay(sql`${sentAt}::timestamptz`)})
                      or (s.created_at >= fc.first_click and s.created_at < fc.first_click + ${WINDOW}
                          and s.arrival_date >= ${localDay(sql`fc.first_click`)}))
               ) as booked
          from mailchimp_recipients r
          left join contacts c on c.id = r.contact_id and c.deleted_at is null
          left join mailchimp_activity a on a.recipient_id = r.id
         where r.campaign_id = ${campaignId}
         group by r.id, c.id
      )`;

    const page = query.page;
    const [{ rows }, { rows: countRows }] = await Promise.all([
      this.db.execute<PersonRow>(sql`${people}
        select * from p
         where ${filters[query.show]} and ${search}
         order by p.clicks desc, p.opens desc, greatest(p.last_click, p.last_open) desc nulls last, p.email
         limit ${PEOPLE_PAGE_SIZE} offset ${(page - 1) * PEOPLE_PAGE_SIZE}`),
      this.db.execute<Record<string, number>>(sql`${people}
        select ${sql.join(
          Object.entries(filters).map(([key, where]) => sql`count(*) filter (where ${where} and ${search})::int as ${sql.identifier(key)}`),
          sql`, `,
        )} from p`),
    ]);
    const counts = countRows[0] as Record<PeopleQuery['show'], number>;
    return {
      rows: rows.map((r) => ({
        id: Number(r.id),
        email: r.email,
        delivery: r.delivery,
        unsubscribedAt: iso(r.unsubscribed_at),
        unsubscribeReason: r.unsubscribe_reason,
        contact: r.contact_id
          ? {
              id: Number(r.contact_id),
              firstName: r.first_name,
              lastName: r.last_name,
              lifecycleStage: r.lifecycle_stage,
              vipReason: r.vip_reason,
            }
          : null,
        addedByThisEmail: r.added,
        opens: r.opens,
        lastOpen: iso(r.last_open),
        clicks: r.clicks,
        lastClick: iso(r.last_click),
        booked: r.booked,
      })),
      total: counts[query.show],
      page,
      pageSize: PEOPLE_PAGE_SIZE,
      counts,
    };
  }

  // A guest's campaign emails, newest first: what they did with each.
  async forContact(contactId: number) {
    const { rows } = await this.db.execute<{
      campaign_id: string;
      name: string;
      sent_at: string | null;
      delivery: string;
      unsubscribed_at: string | null;
      opens: number;
      last_open: string | null;
      clicks: number;
      links: string[] | null;
    }>(sql`
      select camp.id as campaign_id, camp.name, s.sent_at, r.delivery, r.unsubscribed_at,
             count(a.id) filter (where a.action = 'open')::int as opens,
             max(a.at) filter (where a.action = 'open') as last_open,
             count(a.id) filter (where a.action = 'click')::int as clicks,
             array_agg(distinct a.url) filter (where a.action = 'click') as links
        from mailchimp_recipients r
        join campaigns camp on camp.id = r.campaign_id and camp.deleted_at is null
        left join mailchimp_syncs s on s.campaign_id = camp.id
        left join mailchimp_activity a on a.recipient_id = r.id
       where r.contact_id = ${contactId}
       group by camp.id, s.sent_at, r.id
       order by s.sent_at desc nulls last, camp.id desc`);
    return rows.map((r) => ({
      campaign: { id: Number(r.campaign_id), name: r.name },
      sentAt: iso(r.sent_at),
      delivery: r.delivery,
      unsubscribedAt: iso(r.unsubscribed_at),
      opens: r.opens,
      lastOpen: iso(r.last_open),
      clicks: r.clicks,
      links: r.links ?? [],
    }));
  }
}

interface PersonRow extends Record<string, unknown> {
  id: string;
  email: string;
  delivery: string;
  unsubscribed_at: string | null;
  unsubscribe_reason: string | null;
  contact_id: string | null;
  first_name: string | null;
  last_name: string | null;
  lifecycle_stage: string | null;
  vip_reason: string | null;
  added: boolean;
  opens: number;
  last_open: string | null;
  clicks: number;
  last_click: string | null;
  booked: boolean;
}
