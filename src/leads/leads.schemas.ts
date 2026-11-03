import { z } from 'zod';
import { anyOf, countryCodes, filterAmount, filterDay, ids, fieldFilters, rangesInOrder, yesNo } from '../common/filters.js';
import {
  INTERACTION_DIRECTIONS,
  INTERACTION_KINDS,
  LEAD_LOST_REASONS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  MARKETS,
} from '../db/schema/index.js';
import { createGuestSchema } from '../guests/guests.schemas.js';

const trimmed = z.string().trim();
const date = z.iso.date('Enter a date');
const count = z.number().int().min(0, 'Enter 0 or more').max(99).nullish();
const id = z.number().int().positive();
const currency = trimmed
  .toUpperCase()
  .regex(/^([A-Z]{3})?$/, 'Use a 3-letter code such as USD or LKR')
  .transform((v) => v || null)
  .nullish();
const amount = z.number().nonnegative('Enter 0 or more').max(9_999_999_999).nullish();

const datesInOrder = (v: { checkIn?: string | null; checkOut?: string | null }) =>
  !v.checkIn || !v.checkOut || v.checkOut >= v.checkIn;
const quoteHasCurrency = (v: { quotedValue?: number | null; currency?: string | null }) =>
  v.quotedValue == null || !!v.currency;

// ---------- the request ----------
// 'campaign' is set only by a campaign's public form, with the campaign.
const requestFields = {
  source: z.enum(LEAD_SOURCES).exclude(['campaign'], 'Choose where the lead came from'),
  propertyId: trimmed.max(10).transform((v) => v || null).nullish(), // no hotel yet
  checkIn: date.nullish(),
  checkOut: date.nullish(),
  adults: count,
  children: count,
  occasionId: id.nullish(),
};

// New lead: the person is picked (contactId) or added on the same form
// (newPerson, who becomes a contact of type lead). The owner defaults to
// whoever creates it; the first note is optional.
export const createLeadSchema = z
  .object({
    ...requestFields,
    contactId: id.optional(),
    newPerson: createGuestSchema.optional(),
    ownerId: id.optional(),
    followUpOn: date,
    note: trimmed.max(5000).transform((v) => v || null).nullish(),
  })
  .refine((v) => !!v.contactId !== !!v.newPerson, { path: ['contactId'], message: 'Choose a person or add a new one' })
  .refine(datesInOrder, { path: ['checkOut'], message: 'Check-out cannot be before check-in' });
export type CreateLead = z.infer<typeof createLeadSchema>;

// Editing the request, the owner, the follow-up and the quote. The status
// has its own route. Entering a quote on a new or contacted lead moves it to
// quoted. Dates and the quote are checked against the saved lead too.
export const updateLeadSchema = z
  .object({
    ...requestFields,
    ownerId: id,
    followUpOn: date,
    quotedValue: amount,
    currency,
  })
  .partial()
  .refine(datesInOrder, { path: ['checkOut'], message: 'Check-out cannot be before check-in' })
  .refine(quoteHasCurrency, { path: ['currency'], message: 'The quote needs a currency' });
export type UpdateLead = z.infer<typeof updateLeadSchema>;

// Change status, from the board or the lead. Whatever the new status needs
// can come with it: the reason for lost, the quote for quoted, the stay (or
// "stay to link") for booked, the owner and follow-up for reopening. An
// optional note is saved on the lead.
export const changeLeadStatusSchema = z
  .object({
    status: z.enum(LEAD_STATUSES),
    lostReason: z.enum(LEAD_LOST_REASONS).nullish(),
    quotedValue: amount,
    currency,
    stayId: id.nullish(),
    stayToLink: z.boolean().default(false),
    ownerId: id.nullish(),
    followUpOn: date.nullish(),
    note: trimmed.max(5000).transform((v) => v || null).nullish(),
  })
  .refine(quoteHasCurrency, { path: ['currency'], message: 'The quote needs a currency' });
export type ChangeLeadStatus = z.infer<typeof changeLeadStatusSchema>;

export const linkStaySchema = z.object({ stayId: id });
export type LinkStay = z.infer<typeof linkStaySchema>;

// ---------- lists ----------
export const FOLLOW_UP_FILTERS = ['overdue', 'today', 'due', 'week'] as const; // due = today or overdue

export const LEADS_PAGE_SIZE = 50;

// "Filled in" / "Missing" on the request, and the person's details for reaching them.
export const LEAD_FIELDS = [
  'hotel',
  'checkIn',
  'checkOut',
  'party',
  'occasion',
  'personName',
  'personEmail',
  'personPhone',
] as const;

const ownerFilter = anyOf(z.union([z.literal('me'), z.literal('none'), z.coerce.number().int().positive()]));

const leadFilters = {
  q: trimmed.max(100).optional(), // the person's name, email or phone
  // a filter with several values matches any of them
  owner: ownerFilter, // staff ids, 'me', or 'none'
  propertyId: anyOf(trimmed.max(10)),
  source: anyOf(z.enum(LEAD_SOURCES)),
  campaignId: ids, // the campaign whose form they sent
  // ---- More filters ----
  occasionId: ids,
  checkInFrom: filterDay, // the check-in they asked for
  checkInTo: filterDay,
  createdFrom: filterDay, // when the lead came in, a day in Colombo
  createdTo: filterDay,
  currency: anyOf(trimmed.toUpperCase().length(3)),
  quoteMin: filterAmount, // the quote, in its own currency
  quoteMax: filterAmount,
  contacted: yesNo, // any conversation logged on the lead
  stayToLink: yesNo, // booked, with the stay still to link
  market: anyOf(z.enum(MARKETS)), // the person's market
  country: countryCodes, // the person's country
  ...fieldFilters(LEAD_FIELDS),
};
const leadRanges = rangesInOrder(['checkInFrom', 'checkInTo'], ['createdFrom', 'createdTo'], ['quoteMin', 'quoteMax']);

export const listLeadsSchema = z
  .object({
    ...leadFilters,
    status: anyOf(z.union([z.enum(LEAD_STATUSES), z.literal('open')])), // open = new, contacted or quoted
    followUp: z.enum(FOLLOW_UP_FILTERS).optional(),
    lostReason: anyOf(z.enum(LEAD_LOST_REASONS)), // lost leads only
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(LEADS_PAGE_SIZE),
  })
  .superRefine(leadRanges);
export type ListLeads = z.infer<typeof listLeadsSchema>;

// The board shows every open lead; booked and lost only from the last `days` days.
export const BOARD_CLOSED_DAYS = 30;

export const boardSchema = z.object(leadFilters).superRefine(leadRanges);
export type BoardFilter = z.infer<typeof boardSchema>;

// ---------- interactions ----------
// A call, WhatsApp, email, meeting, visit or Instagram DM with a person, a
// company, or both, and optionally on a lead (which gives the person).
// staffId = who had the conversation; it defaults to whoever logs it.
const interactionFields = {
  kind: z.enum(INTERACTION_KINDS),
  direction: z.enum(INTERACTION_DIRECTIONS).nullish(),
  occurredAt: z.iso.datetime({ offset: true, message: 'Enter when it happened' }).optional(),
  staffId: id.nullish(),
  summary: trimmed.min(1, 'Write a short summary').max(2000),
};

// On an open lead, the next follow-up date can be set in the same step.
// On a feedback response (Module 8), the response gives the guest.
export const createInteractionSchema = z
  .object({
    ...interactionFields,
    contactId: id.nullish(),
    companyId: id.nullish(),
    leadId: id.nullish(),
    feedbackId: id.nullish(),
    followUpOn: date.optional(),
  })
  .refine((v) => v.contactId || v.companyId || v.leadId || v.feedbackId, {
    path: ['contactId'],
    message: 'Choose who the conversation was with',
  });
export type CreateInteraction = z.infer<typeof createInteractionSchema>;

export const updateInteractionSchema = z.object(interactionFields).partial();
export type UpdateInteraction = z.infer<typeof updateInteractionSchema>;

export const leadNoteSchema = z.object({ body: trimmed.min(1, 'Write the note').max(5000) });
export type LeadNote = z.infer<typeof leadNoteSchema>;
