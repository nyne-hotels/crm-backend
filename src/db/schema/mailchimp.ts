import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { oneOf } from './_helpers.js';
import { createdColumns, id } from './core.js';
import { contacts } from './contacts.js';
import { campaigns } from './marketing.js';

// =====================================================================
// 27. MAILCHIMP RECIPIENTS – who a campaign's Mailchimp email went to, one
//     row per address, synced from Mailchimp's report (CampaignSyncService).
//     contact_id: the CRM contact with that personal email (oldest first, as
//     everywhere), or one added by the sync (added_via 'mailchimp'). NULL only
//     for an address the CRM has as shared (an agent's office), which never
//     matches a person and isn't added again. merge_contacts() moves them.
//     delivery: Mailchimp's 'sent', or a soft or hard bounce.
//     unsubscribed_at: they unsubscribed from this email.
// =====================================================================
export const MAILCHIMP_DELIVERY = ['sent', 'soft_bounce', 'hard_bounce'] as const;

export const mailchimpRecipients = pgTable(
  'mailchimp_recipients',
  {
    id: id(),
    campaignId: bigint('campaign_id', { mode: 'number' })
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    contactId: bigint('contact_id', { mode: 'number' }).references(() => contacts.id),
    email: text('email').notNull(), // lower case, as Mailchimp sent to it
    delivery: text('delivery', { enum: MAILCHIMP_DELIVERY }).notNull().default('sent'),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    unsubscribeReason: text('unsubscribe_reason'), // Mailchimp's, e.g. 'No longer interested'
    ...createdColumns(),
  },
  (t) => [
    check('mailchimp_recipients_delivery_check', oneOf(t.delivery, MAILCHIMP_DELIVERY)),
    uniqueIndex('mailchimp_recipients_uq').on(t.campaignId, t.email),
    index('mailchimp_recipients_contact_idx').on(t.contactId),
  ],
);

// =====================================================================
// 28. MAILCHIMP ACTIVITY – each open, click and bounce of a recipient, as
//     Mailchimp reports it. Opens include Apple Mail's automatic ones: per
//     person, Mailchimp can't tell them apart. url: the link clicked ('' for
//     an open or bounce). Unique, so syncing the same stretch twice adds nothing.
// =====================================================================
export const MAILCHIMP_ACTIONS = ['open', 'click', 'bounce'] as const;

export const mailchimpActivity = pgTable(
  'mailchimp_activity',
  {
    id: id(),
    recipientId: bigint('recipient_id', { mode: 'number' })
      .notNull()
      .references(() => mailchimpRecipients.id, { onDelete: 'cascade' }),
    action: text('action', { enum: MAILCHIMP_ACTIONS }).notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    url: text('url').notNull().default(''),
  },
  (t) => [
    check('mailchimp_activity_action_check', oneOf(t.action, MAILCHIMP_ACTIONS)),
    uniqueIndex('mailchimp_activity_uq').on(t.recipientId, t.action, t.at, t.url),
  ],
);

// =====================================================================
// 29. MAILCHIMP SYNCS – how far each campaign's sync has got. One row per
//     campaign, for the email it's linked to; linking another email starts
//     again. activity_until: activity is in up to here (the next sync asks
//     from a little before, and the unique index drops what it already has).
// =====================================================================
export const mailchimpSyncs = pgTable('mailchimp_syncs', {
  campaignId: bigint('campaign_id', { mode: 'number' })
    .primaryKey()
    .references(() => campaigns.id, { onDelete: 'cascade' }),
  mailchimpCampaignId: text('mailchimp_campaign_id').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }), // the email's send time
  recipientsSyncedAt: timestamp('recipients_synced_at', { withTimezone: true }),
  activityUntil: timestamp('activity_until', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'), // the MailchimpProblem code, or a message
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
});
// =====================================================================
// 30. MAILCHIMP AUDIENCE EVENTS – unsubscribes and cleaned (bounced)
//     addresses from the Mailchimp audience, whichever email they came from,
//     as its webhook sends them and the daily check finds them
//     (MailchimpAudienceService). Unique, so one heard both ways counts once.
//     opted_out / bounced: guests changed; opted_in_later: guests left opted
//     in because they opted in again in the CRM after unsubscribing.
// =====================================================================
export const AUDIENCE_EVENT_KINDS = ['unsubscribe', 'cleaned'] as const;
export const AUDIENCE_EVENT_VIA = ['webhook', 'check'] as const;

export const mailchimpAudienceEvents = pgTable(
  'mailchimp_audience_events',
  {
    id: id(),
    email: text('email').notNull(), // lower case
    kind: text('kind', { enum: AUDIENCE_EVENT_KINDS }).notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(), // when it happened in Mailchimp
    reason: text('reason'), // Mailchimp's: 'No longer interested', 'hard', 'abuse' …
    via: text('via', { enum: AUDIENCE_EVENT_VIA }).notNull(),
    optedOut: integer('opted_out').notNull().default(0),
    bounced: integer('bounced').notNull().default(0),
    optedInLater: bigint('opted_in_later', { mode: 'number' }).array().notNull().default(sql`'{}'`), // contact ids
    ...createdColumns(),
  },
  (t) => [
    check('mailchimp_audience_events_kind_check', oneOf(t.kind, AUDIENCE_EVENT_KINDS)),
    check('mailchimp_audience_events_via_check', oneOf(t.via, AUDIENCE_EVENT_VIA)),
    uniqueIndex('mailchimp_audience_events_uq').on(t.email, t.kind, t.at),
    index('mailchimp_audience_events_at_idx').on(t.at.desc()),
  ],
);

// =====================================================================
// 31. MAILCHIMP AUDIENCE SYNCS – the daily check, per audience (Nyne has
//     one). changed_until: unsubscribes and cleaned addresses are in up to
//     here; the next check asks Mailchimp for those changed since.
// =====================================================================
export const mailchimpAudienceSyncs = pgTable('mailchimp_audience_syncs', {
  listId: text('list_id').primaryKey(),
  listName: text('list_name'),
  changedUntil: timestamp('changed_until', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }), // so the page can say the webhook works
});
