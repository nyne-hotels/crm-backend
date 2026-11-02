import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { oneOf, notDeleted } from './_helpers.js';
import { auditColumns, createdColumns, id, properties, staffUsers } from './core.js';
import { contacts } from './contacts.js';
import { companies, occasions } from './reference.js';
import { feedback, stays } from './stays.js';

// =====================================================================
// 16. LEADS – each time someone shows interest, from first message to booked or lost
// =====================================================================
export const LEAD_SOURCES = [
  'website_form',
  'whatsapp',
  'instagram',
  'phone',
  'email',
  'agent',
  'walk_in',
  'ota_message',
  'other',
] as const;
export const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'booked', 'lost'] as const;
// New, contacted and quoted are being worked: they need an owner and a follow-up date.
export const OPEN_LEAD_STATUSES = ['new', 'contacted', 'quoted'] as const;
export const LEAD_LOST_REASONS = [
  'price',
  'dates_unavailable',
  'went_elsewhere',
  'no_response',
  'plans_changed',
  'other',
] as const;

export const leads = pgTable(
  'leads',
  {
    id: id(),
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    source: text('source', { enum: LEAD_SOURCES }).notNull(),
    propertyId: text('property_id').references(() => properties.id),
    checkIn: date('check_in'),
    checkOut: date('check_out'),
    adults: smallint('adults'),
    children: smallint('children'),
    occasionId: bigint('occasion_id', { mode: 'number' }).references(() => occasions.id),
    status: text('status', { enum: LEAD_STATUSES }).notNull().default('new'),
    lostReason: text('lost_reason', { enum: LEAD_LOST_REASONS }),
    quotedValue: numeric('quoted_value', { precision: 12, scale: 2 }),
    currency: char('currency', { length: 3 }),
    ownerId: bigint('owner_id', { mode: 'number' }).references(() => staffUsers.id), // who is following it up
    // a day, not a time: "due today" and "snooze to tomorrow" count days in Colombo (migration 0013)
    followUpOn: date('follow_up_on'),
    // set when the lead converts; a lead marked booked by hand before the stay is
    // entered has none yet, and shows "stay to link"
    stayId: bigint('stay_id', { mode: 'number' }).references(() => stays.id),
    ...auditColumns(),
  },
  (t) => [
    check('leads_source_check', oneOf(t.source, LEAD_SOURCES)),
    check('leads_status_check', oneOf(t.status, LEAD_STATUSES)),
    check('leads_lost_reason_check', oneOf(t.lostReason, LEAD_LOST_REASONS)),
    check('leads_lost_needs_reason_check', sql`${t.status} <> 'lost' OR ${t.lostReason} IS NOT NULL`),
    check(
      'leads_open_needs_owner_check',
      sql`${t.status} NOT IN ('new', 'contacted', 'quoted') OR (${t.ownerId} IS NOT NULL AND ${t.followUpOn} IS NOT NULL)`,
    ),
    check('leads_quote_currency_check', sql`${t.quotedValue} IS NULL OR ${t.currency} IS NOT NULL`),
    check('leads_dates_check', sql`${t.checkOut} IS NULL OR ${t.checkIn} IS NULL OR ${t.checkOut} >= ${t.checkIn}`),
    index('leads_status_idx').on(t.status, t.followUpOn).where(notDeleted(t.deletedAt)),
    // My follow-ups
    index('leads_owner_idx').on(t.ownerId, t.followUpOn).where(notDeleted(t.deletedAt)),
    index('leads_contact_idx').on(t.contactId),
    index('leads_stay_idx').on(t.stayId),
  ],
);

// =====================================================================
// 16b. LEAD STATUS CHANGES – every move of a lead, for its timeline (Module 7).
//      Written by the leads service, never changed. from_status is NULL when
//      the lead was created. automatic = moved by a booking arriving.
//      created_by = who moved it (NULL: the system), created_at = when.
// =====================================================================
export const leadStatusChanges = pgTable(
  'lead_status_changes',
  {
    id: id(),
    leadId: bigint('lead_id', { mode: 'number' })
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status', { enum: LEAD_STATUSES }),
    toStatus: text('to_status', { enum: LEAD_STATUSES }).notNull(),
    lostReason: text('lost_reason', { enum: LEAD_LOST_REASONS }),
    stayId: bigint('stay_id', { mode: 'number' }).references(() => stays.id, { onDelete: 'set null' }),
    automatic: boolean('automatic').notNull().default(false),
    ...createdColumns(),
  },
  (t) => [
    check('lead_status_changes_from_check', oneOf(t.fromStatus, LEAD_STATUSES)),
    check('lead_status_changes_to_check', oneOf(t.toStatus, LEAD_STATUSES)),
    check('lead_status_changes_lost_reason_check', oneOf(t.lostReason, LEAD_LOST_REASONS)),
    index('lead_status_changes_lead_idx').on(t.leadId, t.createdAt.desc()),
  ],
);

// =====================================================================
// 17. INTERACTIONS – emails, WhatsApps, calls, visits, DMs
//     staff_id = who spoke to the guest; created_by = who logged it.
// =====================================================================
export const INTERACTION_KINDS = ['email', 'whatsapp', 'call', 'meeting', 'visit', 'instagram_dm'] as const;
export const INTERACTION_DIRECTIONS = ['inbound', 'outbound'] as const;

export const interactions = pgTable(
  'interactions',
  {
    id: id(),
    contactId: bigint('contact_id', { mode: 'number' }).references(() => contacts.id, { onDelete: 'cascade' }),
    companyId: bigint('company_id', { mode: 'number' }).references(() => companies.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: INTERACTION_KINDS }).notNull(),
    direction: text('direction', { enum: INTERACTION_DIRECTIONS }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    staffId: bigint('staff_id', { mode: 'number' }).references(() => staffUsers.id),
    leadId: bigint('lead_id', { mode: 'number' }).references(() => leads.id, { onDelete: 'set null' }),
    // the feedback this call or message followed up (Module 8)
    feedbackId: bigint('feedback_id', { mode: 'number' }).references(() => feedback.id, { onDelete: 'set null' }),
    summary: text('summary'),
    ...auditColumns(),
  },
  (t) => [
    check('interactions_kind_check', oneOf(t.kind, INTERACTION_KINDS)),
    check('interactions_direction_check', oneOf(t.direction, INTERACTION_DIRECTIONS)),
    check('interactions_target_check', sql`${t.contactId} IS NOT NULL OR ${t.companyId} IS NOT NULL`),
    index('interactions_contact_idx').on(t.contactId, t.occurredAt.desc()),
    index('interactions_company_idx').on(t.companyId, t.occurredAt.desc()),
    index('interactions_lead_idx').on(t.leadId),
    index('interactions_feedback_idx').on(t.feedbackId),
  ],
);

// =====================================================================
// 18. NOTES – every staff remark, one row per note.
//     Always about a person or a company; can also point to a stay or lead.
//     If only a stay or lead is given, the notes_fill_contact() trigger fills in the guest.
// =====================================================================
export const notes = pgTable(
  'notes',
  {
    id: id(),
    body: text('body').notNull(),
    contactId: bigint('contact_id', { mode: 'number' }).references(() => contacts.id, { onDelete: 'cascade' }),
    companyId: bigint('company_id', { mode: 'number' }).references(() => companies.id, { onDelete: 'cascade' }),
    stayId: bigint('stay_id', { mode: 'number' }).references(() => stays.id, { onDelete: 'set null' }),
    leadId: bigint('lead_id', { mode: 'number' }).references(() => leads.id, { onDelete: 'set null' }),
    // set by the service when the text changes, so the note shows "edited"
    // (updated_at also moves on merges and deletes, so it can't tell)
    editedAt: timestamp('edited_at', { withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    check('notes_target_check', sql`${t.contactId} IS NOT NULL OR ${t.companyId} IS NOT NULL`),
    index('notes_contact_idx').on(t.contactId, t.createdAt.desc()),
    index('notes_company_idx').on(t.companyId, t.createdAt.desc()),
    index('notes_stay_idx').on(t.stayId),
    index('notes_lead_idx').on(t.leadId),
  ],
);
