import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { notDeleted, oneOf } from './_helpers.js';
import { auditColumns, id, properties, staffUsers } from './core.js';
import { contacts } from './contacts.js';
import { companies, employees, occasions } from './reference.js';

// =====================================================================
// 10. STAYS – one row per visit
// =====================================================================
export const STAY_CHANNELS = [
  'direct',
  'travel_agent',
  'ota',
  'owner_guest',
  'website',
  'walk_in',
  'online_unclear',
  'mixed',
  'unknown',
] as const;
// Booked → checked in → checked out, or cancelled / no-show.
// Only checked-out stays count towards stayed and repeat guest (see the lifecycle trigger).
export const STAY_STATUSES = ['booked', 'checked_in', 'checked_out', 'cancelled', 'no_show'] as const;

export const stays = pgTable(
  'stays',
  {
    id: id(),
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id),
    arrivalDate: date('arrival_date'),
    departureDate: date('departure_date'),
    nights: integer('nights').generatedAlwaysAs(sql`departure_date - arrival_date`),
    bookingReference: text('booking_reference'), // reference from the booking system; one per hotel
    roomType: text('room_type'), // as given by the booking system
    adults: smallint('adults'),
    children: smallint('children'),
    roomRevenue: numeric('room_revenue', { precision: 12, scale: 2 }),
    currency: char('currency', { length: 3 }),
    channel: text('channel', { enum: STAY_CHANNELS }).notNull().default('unknown'),
    // agent or OTA that made the booking
    bookingCompanyId: bigint('booking_company_id', { mode: 'number' }).references(() => companies.id),
    occasionId: bigint('occasion_id', { mode: 'number' }).references(() => occasions.id),
    // stays loaded before statuses existed were all past visits, so migration 0005 makes them checked out
    status: text('status', { enum: STAY_STATUSES }).notNull().default('booked'),
    cancellationReason: text('cancellation_reason'), // why it was cancelled, by staff or the import
    bookingRemarks: text('booking_remarks'), // special requests from the booking system; re-imports overwrite them
    ...auditColumns(),
  },
  (t) => [
    check('stays_channel_check', oneOf(t.channel, STAY_CHANNELS)),
    check('stays_status_check', oneOf(t.status, STAY_STATUSES)),
    check(
      'stays_dates_check',
      sql`${t.departureDate} IS NULL OR ${t.arrivalDate} IS NULL OR ${t.departureDate} >= ${t.arrivalDate}`,
    ),
    index('stays_contact_idx').on(t.contactId),
    index('stays_property_idx').on(t.propertyId, t.arrivalDate).where(notDeleted(t.deletedAt)),
    // the stays list: arriving, in house and departing
    index('stays_arrival_idx').on(t.arrivalDate).where(notDeleted(t.deletedAt)),
    index('stays_departure_idx').on(t.departureDate).where(notDeleted(t.deletedAt)),
    // stays booked through an agent, for the company profile (Module 7)
    index('stays_company_idx').on(t.bookingCompanyId, t.arrivalDate).where(notDeleted(t.deletedAt)),
    // the same booking can never be loaded twice
    uniqueIndex('stays_booking_ref_uq')
      .on(t.propertyId, t.bookingReference)
      .where(sql`${t.bookingReference} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

// =====================================================================
// 11. FEEDBACK – the guest's answer to the post-stay feedback form (one per stay)
//     Ratings of 1 or 2 need follow-up until a manager marks them followed
//     up with an outcome (Module 8).
// =====================================================================
export const feedback = pgTable(
  'feedback',
  {
    id: id(),
    stayId: bigint('stay_id', { mode: 'number' })
      .notNull()
      .references(() => stays.id, { onDelete: 'cascade' }),
    rating: smallint('rating'), // 1 = poor … 5 = excellent
    review: text('review'), // the guest's written comments
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    followedUpAt: timestamp('followed_up_at', { withTimezone: true }), // when a manager marked it followed up
    followedUpBy: bigint('followed_up_by', { mode: 'number' }).references(() => staffUsers.id),
    followUpOutcome: text('follow_up_outcome'), // what came of it, in a line or two
    ...auditColumns(),
  },
  (t) => [
    check('feedback_rating_check', sql`${t.rating} BETWEEN 1 AND 5`),
    // an empty form is not feedback
    check('feedback_not_empty_check', sql`${t.rating} IS NOT NULL OR nullif(trim(${t.review}), '') IS NOT NULL`),
    // followed up always comes with an outcome
    check(
      'feedback_follow_up_check',
      sql`${t.followedUpAt} IS NULL OR nullif(trim(${t.followUpOutcome}), '') IS NOT NULL`,
    ),
    uniqueIndex('feedback_one_per_stay').on(t.stayId).where(notDeleted(t.deletedAt)),
    index('feedback_submitted_idx').on(t.submittedAt.desc()).where(notDeleted(t.deletedAt)),
    // the Needs follow-up tab
    index('feedback_follow_up_idx')
      .on(t.submittedAt.desc())
      .where(sql`${t.rating} <= 2 AND ${t.followedUpAt} IS NULL AND ${t.deletedAt} IS NULL`),
  ],
);

// =====================================================================
// 12. EMPLOYEE MENTIONS – a guest praising or criticising a specific employee.
//     If staff can't tell who the guest meant, keep the name as written.
// =====================================================================
export const SENTIMENTS = ['positive', 'negative'] as const;

export const employeeMentions = pgTable(
  'employee_mentions',
  {
    id: id(),
    feedbackId: bigint('feedback_id', { mode: 'number' })
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    employeeId: bigint('employee_id', { mode: 'number' }).references(() => employees.id),
    nameAsWritten: text('name_as_written'), // what the guest wrote, e.g. 'Kamal the driver'
    sentiment: text('sentiment', { enum: SENTIMENTS }).notNull(),
    comment: text('comment'), // what the guest said about them
    ...auditColumns(),
  },
  (t) => [
    check('employee_mentions_sentiment_check', oneOf(t.sentiment, SENTIMENTS)),
    check(
      'employee_mentions_who_check',
      sql`${t.employeeId} IS NOT NULL OR nullif(trim(${t.nameAsWritten}), '') IS NOT NULL`,
    ),
    index('employee_mentions_employee_idx').on(t.employeeId).where(notDeleted(t.deletedAt)),
    index('employee_mentions_feedback_idx').on(t.feedbackId),
    uniqueIndex('employee_mentions_once')
      .on(t.feedbackId, t.employeeId)
      .where(sql`${t.employeeId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);
