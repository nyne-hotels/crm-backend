import { bigint, boolean, char, date, integer, numeric, pgView, smallint, text, timestamp } from 'drizzle-orm/pg-core';
import { CONSENT_STATUSES, CONTACT_TYPES, LIFECYCLE_STAGES, MARKETS, SPECIAL_DATE_OCCASIONS } from './contacts.js';
import { DEPARTMENTS } from './reference.js';

// =====================================================================
// VIEWS – defined in SQL (drizzle/0001_functions_triggers_views.sql and later
// custom migrations). Declared here with .existing() only so queries are
// typed; drizzle-kit leaves them alone. All of them hide deleted rows.
// =====================================================================

// One line per person: stage, primary email and phone, hotels, stays, last stay.
export const contactOverview = pgView('contact_overview', {
  id: bigint('id', { mode: 'number' }).notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  contactType: text('contact_type', { enum: CONTACT_TYPES }).notNull(),
  lifecycleStage: text('lifecycle_stage', { enum: LIFECYCLE_STAGES }).notNull(),
  market: text('market', { enum: MARKETS }).notNull(),
  country: text('country'), // country name
  company: text('company'),
  email: text('email'), // primary email
  phone: text('phone'), // primary phone
  hotels: text('hotels'), // 'Mayur Lodge, Rock Villa'
  stayRows: bigint('stay_rows', { mode: 'number' }).notNull(),
  lastStay: date('last_stay'),
  emailConsent: text('email_consent', { enum: CONSENT_STATUSES }),
  tags: text('tags'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  countryCode: char('country_code', { length: 2 }), // added in 0004
}).existing();

// Who may receive marketing email right now: active (not do-not-contact), not
// deleted, email opted in, and a primary email that is personal, not bounced
// and not invalid. Exports read from this view only. Columns after
// lifecycleStage added in 0010; hotels and last stay count checked-out stays.
export const marketingEmailList = pgView('marketing_email_list', {
  id: bigint('id', { mode: 'number' }).notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email').notNull(),
  market: text('market', { enum: MARKETS }).notNull(),
  country: text('country'), // country name
  lifecycleStage: text('lifecycle_stage', { enum: LIFECYCLE_STAGES }).notNull(),
  countryCode: char('country_code', { length: 2 }),
  hotels: text('hotels'), // 'Mayur Lodge, Rock Villa'
  lastStay: date('last_stay'),
  lastHotel: text('last_hotel'), // hotel of the last stay
}).existing();

// Birthdays and anniversaries in the next 60 days, soonest first ("today" is
// the date in Colombo). Active guests only; columns after emailConsent added in 0008.
export const upcomingSpecialDates = pgView('upcoming_special_dates', {
  nextDate: date('next_date').notNull(),
  daysAway: integer('days_away').notNull(),
  occasion: text('occasion', { enum: SPECIAL_DATE_OCCASIONS }).notNull(),
  label: text('label'),
  turningOrYears: integer('turning_or_years'), // age turning or years married; null without a year
  contactId: bigint('contact_id', { mode: 'number' }).notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  lifecycleStage: text('lifecycle_stage', { enum: LIFECYCLE_STAGES }).notNull(),
  emailConsent: text('email_consent', { enum: CONSENT_STATUSES }),
  specialDateId: bigint('special_date_id', { mode: 'number' }).notNull(),
  year: smallint('year'),
  canEmail: boolean('can_email').notNull(), // on marketing_email_list
  nextStayId: bigint('next_stay_id', { mode: 'number' }),
  nextStayArrival: date('next_stay_arrival'),
  nextStayPropertyId: text('next_stay_property_id'),
  nextStayHotel: text('next_stay_hotel'),
  lastStayPropertyId: text('last_stay_property_id'),
  lastStayHotel: text('last_stay_hotel'),
}).existing();

// Pairs of guests that may be the same person (Module 6): same name, or the
// same personal email or phone (phones by their digits). contact_a is the
// lower id. Pairs marked "Not a duplicate" are left out. Columns after
// reason added in 0012.
export const possibleDuplicates = pgView('possible_duplicates', {
  contactA: bigint('contact_a', { mode: 'number' }).notNull(),
  nameA: text('name_a').notNull(),
  contactB: bigint('contact_b', { mode: 'number' }).notNull(),
  nameB: text('name_b').notNull(),
  reason: text('reason').notNull(), // 'same email, same name'
  sameName: boolean('same_name').notNull(),
  sameEmail: boolean('same_email').notNull(),
  samePhone: boolean('same_phone').notNull(),
}).existing();

// Each hotel's responses and average rating, overall and for the last 90
// days (Module 8). Feedback of deleted stays and guests is left out. Columns
// after lastResponse added in 0016. Averages are numeric (strings from pg).
export const propertyRatings = pgView('property_ratings', {
  id: text('id').notNull(),
  name: text('name').notNull(),
  responses: bigint('responses', { mode: 'number' }).notNull(),
  avgRating: numeric('avg_rating'),
  lowRatings: bigint('low_ratings', { mode: 'number' }).notNull(), // 1 or 2
  avgRating90Days: numeric('avg_rating_90_days'),
  lastResponse: timestamp('last_response', { withTimezone: true }),
  responses90Days: bigint('responses_90_days', { mode: 'number' }).notNull(),
  needsFollowUp: bigint('needs_follow_up', { mode: 'number' }).notNull(),
}).existing();

// Each employee's praise and criticism counts, overall and for the last 90
// days, from live feedback only. propertyId and isActive added in 0016.
export const employeeFeedbackSummary = pgView('employee_feedback_summary', {
  id: bigint('id', { mode: 'number' }).notNull(),
  employee: text('employee').notNull(),
  hotel: text('hotel'),
  department: text('department', { enum: DEPARTMENTS }).notNull(),
  jobTitle: text('job_title'),
  positive: bigint('positive', { mode: 'number' }).notNull(),
  negative: bigint('negative', { mode: 'number' }).notNull(),
  positive90Days: bigint('positive_90_days', { mode: 'number' }).notNull(),
  negative90Days: bigint('negative_90_days', { mode: 'number' }).notNull(),
  lastMentioned: timestamp('last_mentioned', { withTimezone: true }),
  propertyId: text('property_id'),
  isActive: boolean('is_active').notNull(),
}).existing();
