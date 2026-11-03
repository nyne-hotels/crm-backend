import { z } from 'zod';
import { anyOf, countryCodes, filterCount, ids, fieldFilters, rangesInOrder, yesNo } from '../common/filters.js';
import { CONSENT_CHANNELS, CONTACT_TYPES, LIFECYCLE_STAGES, MARKETS } from '../db/schema/index.js';
import { CHOICE_SOURCES } from './consent-rules.js';

const trimmed = z.string().trim();
const day = trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date');

// ---------- consent on a guest ----------
export const consentChannelSchema = z.enum(CONSENT_CHANNELS);

// A yes or no the guest gave. The date is checked by givenOnError() in the
// service, so the message can say what is wrong with it.
export const changeConsentSchema = z.object({
  status: z.enum(['opted_in', 'opted_out']),
  source: z.enum(CHOICE_SOURCES),
  givenOn: day, // 'YYYY-MM-DD'
  evidence: trimmed
    .max(2000)
    .transform((v) => v || null)
    .nullish(), // the wording agreed to
});
export type ChangeConsent = z.infer<typeof changeConsentSchema>;

// ---------- Marketing → Email list ----------
export const EMAIL_LIST_PAGE_SIZE = 50;

// "Filled in" / "Missing": everyone on the list has an email, so these are for
// personalising (a first name for "Dear …") and targeting.
export const EMAIL_LIST_FIELDS = ['firstName', 'lastName', 'country', 'birthday'] as const;

export const emailListFilterSchema = z
  .object({
    // a filter with several values matches any of them
    market: anyOf(z.enum(MARKETS)),
    country: countryCodes,
    propertyId: anyOf(trimmed.max(10)), // hotels stayed at
    stage: anyOf(z.enum(LIFECYCLE_STAGES)),
    lastStayFrom: day.optional(), // last stay on or after
    lastStayTo: day.optional(), // last stay on or before
    tagId: ids,
    // ---- More filters ----
    contactType: anyOf(z.enum(CONTACT_TYPES)),
    lastHotelId: anyOf(trimmed.max(10)), // hotel of the last stay
    staysMin: filterCount, // checked-out stays
    staysMax: filterCount,
    birthdayMonth: anyOf(z.coerce.number().int().min(1).max(12)),
    optedInFrom: day.optional(), // when they opted in to email, a day in Colombo
    optedInTo: day.optional(),
    addedFrom: day.optional(), // added to the CRM
    addedTo: day.optional(),
    upcomingStay: yesNo, // booked to come, or in house now
    lowRating: yesNo, // ever gave a 1 or 2 star rating
    ...fieldFilters(EMAIL_LIST_FIELDS),
  })
  .refine((v) => !(v.lastStayFrom && v.lastStayTo && v.lastStayFrom > v.lastStayTo), {
    path: ['lastStayTo'],
    message: 'The "to" date is before the "from" date',
  })
  .superRefine(rangesInOrder(['staysMin', 'staysMax'], ['optedInFrom', 'optedInTo'], ['addedFrom', 'addedTo']));
export type EmailListFilter = z.infer<typeof emailListFilterSchema>;

export const listEmailListSchema = z.intersection(
  emailListFilterSchema,
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(EMAIL_LIST_PAGE_SIZE),
  }),
);
export type ListEmailList = z.infer<typeof listEmailListSchema>;

// ---------- Marketing → Upload unsubscribes or bounces ----------
// The app reads the file and sends the email column.
export const UPLOAD_KINDS = ['unsubscribes', 'bounces'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

const uploadFields = {
  kind: z.enum(UPLOAD_KINDS),
  emails: z.array(z.string().max(320)).min(1, 'The file has no email addresses').max(50_000, 'Upload up to 50,000 emails at a time'),
};

export const previewUploadSchema = z.object(uploadFields);
export type PreviewUpload = z.infer<typeof previewUploadSchema>;

export const commitUploadSchema = z.object({ ...uploadFields, fileName: trimmed.min(1).max(255) });
export type CommitUpload = z.infer<typeof commitUploadSchema>;
