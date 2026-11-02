import { z } from 'zod';
import { anyOf, countryCodes, filterAmount, filterCount, filterDay, ids, rangesInOrder, yesNo } from '../common/filters.js';
import { LIFECYCLE_STAGES, MARKETS, STAY_CHANNELS, STAY_STATUSES } from '../db/schema/index.js';
import { createGuestSchema } from '../guests/guests.schemas.js';
import { NEW_STAY_STATUSES } from './stay-rules.js';

const trimmed = z.string().trim();
const optionalText = trimmed.transform((v) => v || null).nullish();
const date = z.iso.date('Enter a date');
const count = z.number().int().min(0, 'Enter 0 or more').max(99).nullish();
const id = z.number().int().positive();

// ---------- add / edit a stay ----------
const stayFields = {
  propertyId: trimmed.min(1, 'Choose a hotel').max(10),
  arrivalDate: date,
  departureDate: date,
  bookingReference: optionalText, // optional for walk-ins; a later import can fill it in
  roomType: optionalText,
  adults: count,
  children: count,
  roomRevenue: z.number().nonnegative('Enter 0 or more').max(9_999_999_999).nullish(),
  currency: trimmed
    .toUpperCase()
    .regex(/^([A-Z]{3})?$/, 'Use a 3-letter code such as USD or LKR')
    .transform((v) => v || null)
    .nullish(),
  channel: z.enum(STAY_CHANNELS),
  bookingCompanyId: id.nullish(), // agent or OTA
  occasionId: id.nullish(),
  bookingRemarks: optionalText,
};

const datesInOrder = (v: { arrivalDate?: string; departureDate?: string }) =>
  !v.arrivalDate || !v.departureDate || v.departureDate >= v.arrivalDate;
const revenueHasCurrency = (v: { roomRevenue?: number | null; currency?: string | null }) =>
  v.roomRevenue == null || !!v.currency;

// The guest is picked (contactId) or created on the same form (newGuest).
export const createStaySchema = z
  .object({
    ...stayFields,
    channel: stayFields.channel.default('unknown'),
    contactId: id.optional(),
    newGuest: createGuestSchema.optional(),
    status: z.enum(NEW_STAY_STATUSES).default('booked'),
  })
  .refine((v) => !!v.contactId !== !!v.newGuest, { path: ['contactId'], message: 'Choose a guest or add a new one' })
  .refine(datesInOrder, { path: ['departureDate'], message: 'Departure cannot be before arrival' })
  .refine(revenueHasCurrency, { path: ['currency'], message: 'Room revenue needs a currency' });
export type CreateStay = z.infer<typeof createStaySchema>;

// The status changes with its own buttons (check in, cancel …), not here.
// The dates and currency are checked against the saved stay in the service.
export const updateStaySchema = z
  .object({ ...stayFields, contactId: id })
  .partial()
  .refine(datesInOrder, { path: ['departureDate'], message: 'Departure cannot be before arrival' });
export type UpdateStay = z.infer<typeof updateStaySchema>;

export const changeStatusSchema = z
  .object({ status: z.enum(STAY_STATUSES), reason: optionalText })
  .refine((v) => v.status !== 'cancelled' || !!v.reason, { path: ['reason'], message: 'Give a reason for cancelling' });
export type ChangeStatus = z.infer<typeof changeStatusSchema>;

// ---------- stays list ----------
export const QUICK_VIEWS = ['arriving_today', 'in_house', 'departing_today', 'arriving_week'] as const;
export type QuickView = (typeof QUICK_VIEWS)[number];

export const STAYS_PAGE_SIZE = 50;

export const listStaysSchema = z
  .object({
    q: trimmed.max(100).optional(), // guest name or booking reference
    view: z.enum(QUICK_VIEWS).optional(),
    // a filter with several values matches any of them
    propertyId: anyOf(trimmed.max(10)),
    status: anyOf(z.enum(STAY_STATUSES)),
    arrivalFrom: date.optional(),
    arrivalTo: date.optional(),
    channel: anyOf(z.enum(STAY_CHANNELS)),
    occasionId: ids,
    companyId: ids, // agent or OTA
    // ---- More filters ----
    departureFrom: filterDay,
    departureTo: filterDay,
    nightsMin: filterCount,
    nightsMax: filterCount,
    guestsMin: filterCount, // adults + children
    guestsMax: filterCount,
    children: yesNo, // travelling with children
    roomType: trimmed.max(100).optional(), // part of the room type
    currency: anyOf(trimmed.toUpperCase().length(3)),
    revenueMin: filterAmount, // room revenue, in the stay's own currency
    revenueMax: filterAmount,
    remarks: yesNo, // has special requests from the booking system
    feedback: z.enum(['given', 'low', 'none']).optional(), // low = a 1 or 2 star rating
    fromLead: yesNo, // a lead converted into this stay
    guestStage: anyOf(z.enum(LIFECYCLE_STAGES)),
    market: anyOf(z.enum(MARKETS)), // the guest's market
    country: countryCodes, // the guest's country
    sort: z.enum(['arrival', 'departure']).optional(), // default depends on the quick view
    order: z.enum(['asc', 'desc']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(STAYS_PAGE_SIZE),
  })
  .superRefine(
    rangesInOrder(
      ['arrivalFrom', 'arrivalTo'],
      ['departureFrom', 'departureTo'],
      ['nightsMin', 'nightsMax'],
      ['guestsMin', 'guestsMax'],
      ['revenueMin', 'revenueMax'],
    ),
  );
export type ListStays = z.infer<typeof listStaysSchema>;
