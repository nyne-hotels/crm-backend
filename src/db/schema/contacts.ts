import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { notDeleted, oneOf } from './_helpers.js';
import { auditColumns, createdColumns, id, staffRef } from './core.js';
import { companies, countries, tags } from './reference.js';
import { stays } from './stays.js';

// =====================================================================
// 7. CONTACTS – one row per person (guests, leads, agent contacts, influencers)
// =====================================================================
export const CONTACT_TYPES = ['guest', 'lead', 'agent_contact', 'influencer'] as const;
export const LIFECYCLE_STAGES = [
  'lead',
  'enquired',
  'booked',
  'stayed',
  'repeat_guest',
  'stayed_hotel_unknown',
  'agent_contact',
  'influencer',
] as const;
export const MARKETS = ['local', 'foreign', 'unknown'] as const;
export const CONTACT_STATUSES = ['active', 'do_not_contact'] as const;

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    firstName: text('first_name'),
    lastName: text('last_name'), // everything after the first word, e.g. 'De Silva'
    contactType: text('contact_type', { enum: CONTACT_TYPES }).notNull(),
    lifecycleStage: text('lifecycle_stage', { enum: LIFECYCLE_STAGES }).notNull().default('lead'),
    market: text('market', { enum: MARKETS }).notNull().default('unknown'),
    countryCode: char('country_code', { length: 2 }).references(() => countries.code),
    companyId: bigint('company_id', { mode: 'number' }).references(() => companies.id, {
      onDelete: 'set null',
    }),
    designation: text('designation'),
    vipReason: text('vip_reason'), // why they are VIP / industry
    status: text('status', { enum: CONTACT_STATUSES }).notNull().default('active'),
    // when and by whom do-not-contact was set; stamped and cleared by the
    // t_contacts_dnc_stamp trigger as the status changes (migration 0010)
    doNotContactAt: timestamp('do_not_contact_at', { withTimezone: true }),
    doNotContactBy: staffRef('do_not_contact_by'),
    ...auditColumns(),
  },
  (t) => [
    check('contacts_contact_type_check', oneOf(t.contactType, CONTACT_TYPES)),
    check('contacts_lifecycle_stage_check', oneOf(t.lifecycleStage, LIFECYCLE_STAGES)),
    check('contacts_market_check', oneOf(t.market, MARKETS)),
    check('contacts_status_check', oneOf(t.status, CONTACT_STATUSES)),
    index('contacts_stage_idx').on(t.lifecycleStage).where(notDeleted(t.deletedAt)),
    index('contacts_market_idx').on(t.market, t.countryCode).where(notDeleted(t.deletedAt)),
    index('contacts_name_idx').on(sql`lower(${t.lastName})`, sql`lower(${t.firstName})`),
    index('contacts_company_idx').on(t.companyId),
  ],
);

// =====================================================================
// 8. CONTACT METHODS – emails and phones (several per person)
// =====================================================================
export const CONTACT_METHOD_KINDS = ['email', 'phone'] as const;
export const CONTACT_METHOD_STATUSES = ['valid', 'unverified', 'bounced', 'invalid'] as const;

export const contactMethods = pgTable(
  'contact_methods',
  {
    id: id(),
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: CONTACT_METHOD_KINDS }).notNull(),
    value: text('value').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    isShared: boolean('is_shared').notNull().default(false), // agent/office/family address: never market, never match on
    isWhatsapp: boolean('is_whatsapp'), // NULL = not yet known
    status: text('status', { enum: CONTACT_METHOD_STATUSES }).notNull().default('unverified'),
    ...auditColumns(),
  },
  (t) => [
    check('contact_methods_kind_check', oneOf(t.kind, CONTACT_METHOD_KINDS)),
    check('contact_methods_status_check', oneOf(t.status, CONTACT_METHOD_STATUSES)),
    uniqueIndex('contact_methods_uq').on(t.contactId, t.kind, t.value).where(notDeleted(t.deletedAt)),
    uniqueIndex('contact_methods_one_primary')
      .on(t.contactId, t.kind)
      .where(sql`${t.isPrimary} AND ${t.deletedAt} IS NULL`),
    index('contact_methods_value_idx').on(sql`lower(${t.value})`), // duplicate check on new imports
  ],
);

// =====================================================================
// 9. SPECIAL DATES – birthdays, anniversaries and other occasions
//    Stored as month + day (+ optional year).
// =====================================================================
export const SPECIAL_DATE_OCCASIONS = [
  'birthday',
  'wedding_anniversary',
  'partner_birthday',
  'child_birthday',
  'other',
] as const;

export const specialDates = pgTable(
  'special_dates',
  {
    id: id(),
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    occasion: text('occasion', { enum: SPECIAL_DATE_OCCASIONS }).notNull(),
    label: text('label'), // e.g. partner's or child's name, or what "other" is
    month: smallint('month').notNull(),
    day: smallint('day').notNull(),
    year: smallint('year'), // blank if unknown
    ...auditColumns(),
  },
  (t) => [
    check('special_dates_occasion_check', oneOf(t.occasion, SPECIAL_DATE_OCCASIONS)),
    check('special_dates_month_check', sql`${t.month} BETWEEN 1 AND 12`),
    check('special_dates_day_check', sql`${t.day} BETWEEN 1 AND 31`),
    check('special_dates_year_check', sql`${t.year} BETWEEN 1900 AND 2100`),
    // rejects impossible dates such as 31 April (2000 is a leap year, so 29 Feb is allowed)
    check(
      'special_dates_valid_date_check',
      sql`make_date(coalesce(${t.year}, 2000), ${t.month}, ${t.day}) IS NOT NULL`,
    ),
    index('special_dates_contact_idx').on(t.contactId),
    index('special_dates_md_idx').on(t.month, t.day).where(notDeleted(t.deletedAt)),
  ],
);

// =====================================================================
// 13. PREFERENCES – likes and dislikes (created_by = who noted it)
// =====================================================================
export const PREFERENCE_KINDS = ['like', 'dislike'] as const;
export const PREFERENCE_CATEGORIES = [
  'food_drink',
  'dietary_health',
  'room',
  'activity',
  'occasion',
  'background',
  'other',
] as const;

export const preferences = pgTable(
  'preferences',
  {
    id: id(),
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: PREFERENCE_KINDS }).notNull(),
    category: text('category', { enum: PREFERENCE_CATEGORIES }),
    body: text('body').notNull(),
    // the stay also tells you the hotel
    stayId: bigint('stay_id', { mode: 'number' }).references(() => stays.id, { onDelete: 'set null' }),
    ...auditColumns(),
  },
  (t) => [
    check('preferences_kind_check', oneOf(t.kind, PREFERENCE_KINDS)),
    check('preferences_category_check', oneOf(t.category, PREFERENCE_CATEGORIES)),
    index('preferences_contact_idx').on(t.contactId),
  ],
);

// =====================================================================
// 14. CONSENTS – marketing permission per person per channel
// =====================================================================
export const CONSENT_CHANNELS = ['email', 'whatsapp'] as const;
export const CONSENT_STATUSES = ['opted_in', 'opted_out', 'not_opted_in', 'unknown'] as const;
// Where permission was given or withdrawn (Module 5). 'do_not_contact' is set
// only by the database, when a guest is marked do not contact; 'contact_import'
// only by Settings → Import contacts (Module 9); 'campaign_form' only by a
// campaign's public form, when the guest ticks the opt-in box.
export const CONSENT_SOURCES = [
  'wix',
  'website_form',
  'booking_form',
  'check_in_form',
  'whatsapp',
  'in_person',
  'email_unsubscribe',
  'do_not_contact',
  'contact_import',
  'campaign_form',
  'other',
] as const;

export const consents = pgTable(
  'consents',
  {
    id: id(),
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: CONSENT_CHANNELS }).notNull(),
    status: text('status', { enum: CONSENT_STATUSES }).notNull().default('unknown'),
    source: text('source', { enum: CONSENT_SOURCES }), // where permission was given: 'wix', 'check_in_form' …
    evidence: text('evidence'), // wording shown / original value
    givenAt: timestamp('given_at', { withTimezone: true }), // when permission was given or withdrawn
    ...auditColumns(),
  },
  (t) => [
    check('consents_channel_check', oneOf(t.channel, CONSENT_CHANNELS)),
    check('consents_status_check', oneOf(t.status, CONSENT_STATUSES)),
    check('consents_source_check', oneOf(t.source, CONSENT_SOURCES)),
    uniqueIndex('consents_uq').on(t.contactId, t.channel).where(notDeleted(t.deletedAt)),
  ],
);

// A link between a person and a tag. Removing a tag deletes the link,
// so this table only records who added it and when.
export const contactTags = pgTable(
  'contact_tags',
  {
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    tagId: bigint('tag_id', { mode: 'number' })
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    ...createdColumns(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.tagId] }), index('contact_tags_tag_idx').on(t.tagId)],
);

// =====================================================================
// 20. CONTACT MERGES – permanent log of duplicates combined by merge_contacts()
//     created_by = who merged, created_at = when.
// =====================================================================
export const contactMerges = pgTable(
  'contact_merges',
  {
    id: id(),
    keptContactId: bigint('kept_contact_id', { mode: 'number' }).references(() => contacts.id, {
      onDelete: 'set null',
    }),
    removedContactId: bigint('removed_contact_id', { mode: 'number' }).notNull(), // no FK: that contact no longer exists
    removedSnapshot: jsonb('removed_snapshot').notNull(), // the deleted contact + its emails, phones, consents, tags
    movedRows: jsonb('moved_rows').$type<Record<string, number[]>>().notNull(), // {"stays":[ids], …}
    note: text('note'),
    ...createdColumns(),
  },
  (t) => [index('contact_merges_kept_idx').on(t.keptContactId)],
);

// =====================================================================
// 24. NOT DUPLICATES – pairs staff marked "Not a duplicate" (Module 6), so
//     they never return to the possible-duplicates queue. contact_a is the
//     lower id. A merge moves the removed guest's pairs to the kept guest.
//     created_by = who decided, created_at = when.
// =====================================================================
export const notDuplicates = pgTable(
  'not_duplicates',
  {
    contactA: bigint('contact_a', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    contactB: bigint('contact_b', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    ...createdColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.contactA, t.contactB] }),
    check('not_duplicates_order_check', sql`${t.contactA} < ${t.contactB}`),
    index('not_duplicates_b_idx').on(t.contactB),
  ],
);
