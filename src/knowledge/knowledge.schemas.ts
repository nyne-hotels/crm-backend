import { z } from 'zod';
import { anyOf, yesNo } from '../common/filters.js';
import { LIFECYCLE_STAGES, PREFERENCE_CATEGORIES, PREFERENCE_KINDS, SPECIAL_DATE_OCCASIONS } from '../db/schema/index.js';

const trimmed = z.string().trim();
const optionalText = trimmed.transform((v) => v || null).nullish();
const id = z.number().int().positive();

// ---------- preferences ----------
// Kind is Like or Dislike only; the category is optional but encouraged.
const preferenceFields = {
  kind: z.enum(PREFERENCE_KINDS),
  category: z.enum(PREFERENCE_CATEGORIES).nullish(),
  body: trimmed.min(1, 'Describe the like or dislike').max(500),
  stayId: id.nullish(), // the stay it was noticed on, which also tells the hotel
};

export const createPreferenceSchema = z.object(preferenceFields);
export type CreatePreference = z.infer<typeof createPreferenceSchema>;

export const updatePreferenceSchema = z.object(preferenceFields).partial();
export type UpdatePreference = z.infer<typeof updatePreferenceSchema>;

// ---------- notes ----------
const noteBody = trimmed.min(1, 'Write the note').max(5000);

// On the profile the stay is optional; on a stay it is the stay.
export const createNoteSchema = z.object({ body: noteBody, stayId: id.nullish() });
export type CreateNote = z.infer<typeof createNoteSchema>;

export const updateNoteSchema = z.object({ body: noteBody, stayId: id.nullish() }).partial();
export type UpdateNote = z.infer<typeof updateNoteSchema>;

// ---------- special dates ----------
// The date itself is checked by specialDateError() in the service, so the
// message can name the month ("April has only 30 days").
const specialDateFields = {
  occasion: z.enum(SPECIAL_DATE_OCCASIONS),
  label: optionalText, // the partner's or child's name, or what "other" is
  month: z.number().int(),
  day: z.number().int(),
  year: z.number().int().nullish(),
};

export const createSpecialDateSchema = z.object(specialDateFields);
export type CreateSpecialDate = z.infer<typeof createSpecialDateSchema>;

export const updateSpecialDateSchema = z.object(specialDateFields).partial();
export type UpdateSpecialDate = z.infer<typeof updateSpecialDateSchema>;

// ---------- tags on a guest ----------
export const addTagSchema = z.object({ tagId: id });
export type AddTag = z.infer<typeof addTagSchema>;

// ---------- Upcoming occasions ----------
export const listUpcomingSchema = z.object({
  // a filter with several values matches any of them
  occasion: anyOf(z.enum(SPECIAL_DATE_OCCASIONS)),
  propertyId: anyOf(trimmed.max(10)), // hotel of their next or last stay
  canEmail: z.enum(['yes', 'no']).optional(),
  // ---- More filters ----
  within: z.coerce.number().int().min(0).max(60).optional(), // days from today
  nextStay: yesNo, // booked to come
  stage: anyOf(z.enum(LIFECYCLE_STAGES)),
  milestone: yesNo, // a round number: 5th, 10th, 40th …
  yearKnown: yesNo, // so the age or years married can be shown
});
export type ListUpcoming = z.infer<typeof listUpcomingSchema>;
