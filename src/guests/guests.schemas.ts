import { z } from 'zod';
import { anyOf, countryCodes, filterCount, filterDay, ids, rangesInOrder, yesNo } from '../common/filters.js';
import { CONSENT_STATUSES, CONTACT_METHOD_STATUSES, CONTACT_TYPES, LIFECYCLE_STAGES, MARKETS } from '../db/schema/index.js';

const trimmed = z.string().trim();
const optionalText = trimmed.transform((v) => v || null).nullish();
const countryCode = trimmed
  .toUpperCase()
  .regex(/^([A-Z]{2})?$/, 'Choose a country from the list')
  .transform((v) => v || null)
  .nullish();

export const emailValue = trimmed.toLowerCase().pipe(z.email('Enter a valid email'));
const phoneValue = trimmed.min(1, 'Enter a phone number').max(40);

// ---------- guest ----------
const guestFields = {
  firstName: trimmed.min(1, 'Enter a first name').max(100),
  lastName: optionalText,
  contactType: z.enum(CONTACT_TYPES),
  countryCode,
  market: z.enum(MARKETS).optional(), // left out: follows the country
  designation: optionalText, // job title
  vipReason: optionalText,
  companyId: z.number().int().positive().nullish(), // the travel agent or company they work for (Module 7)
};

// When adding a guest, one email or phone is entered on the same form.
export const createGuestSchema = z
  .object({
    ...guestFields,
    contactType: guestFields.contactType.default('guest'),
    email: z.object({ value: emailValue, isShared: z.boolean().default(false) }).nullish(),
    phone: z
      .object({
        value: phoneValue,
        country: countryCode, // the picked country code; defaults to the guest's country
        isShared: z.boolean().default(false),
        isWhatsapp: z.boolean().nullish(),
      })
      .nullish(),
  })
  .refine((v) => v.email || v.phone, { path: ['email'], message: 'Enter an email or a phone number' });
export type CreateGuest = z.infer<typeof createGuestSchema>;

// Imported guests may have no first name; they keep it empty until someone fills it in.
export const updateGuestSchema = z
  .object({ ...guestFields, firstName: optionalText })
  .partial()
  .refine((v) => !(v.lastName && v.firstName === null), {
    path: ['firstName'],
    message: 'Enter a first name',
  });
export type UpdateGuest = z.infer<typeof updateGuestSchema>;

// ---------- guest list ----------
// Stage filter offers the guest stages; agent contacts and influencers are found by type.
export const GUEST_LIST_PAGE_SIZE = 50;

export const listGuestsSchema = z
  .object({
    q: trimmed.max(100).optional(),
    // a filter with several values matches any of them
    type: anyOf(z.enum(CONTACT_TYPES)),
    stage: anyOf(z.enum(LIFECYCLE_STAGES)),
    market: anyOf(z.enum(MARKETS)),
    country: countryCodes,
    propertyId: anyOf(trimmed.max(10)), // hotel stayed at
    tagId: ids,
    // ---- More filters ----
    company: anyOf(z.union([z.enum(['any', 'none']), z.coerce.number().int().positive()])), // works for a company
    emailConsent: anyOf(z.enum(CONSENT_STATUSES)),
    whatsappConsent: anyOf(z.enum(CONSENT_STATUSES)),
    doNotContact: yesNo,
    canEmail: yesNo, // on the marketing email list
    hasEmail: yesNo,
    hasPhone: yesNo,
    hasWhatsapp: yesNo, // a phone known to be on WhatsApp
    emailStatus: anyOf(z.enum(CONTACT_METHOD_STATUSES)), // of the primary email
    vip: yesNo, // has a VIP / industry reason
    staysMin: filterCount, // checked-out stays
    staysMax: filterCount,
    lastStayFrom: filterDay,
    lastStayTo: filterDay,
    addedFrom: filterDay, // added to the CRM, a day in Colombo
    addedTo: filterDay,
    upcomingStay: yesNo, // booked to come, or in house now
    openLead: yesNo,
    feedback: z.enum(['given', 'low', 'none']).optional(), // low = a 1 or 2 star rating
    birthdayMonth: anyOf(z.coerce.number().int().min(1).max(12)),
    specialDates: yesNo, // any birthday, anniversary or other date on file
    preferences: yesNo, // any likes or dislikes noted
    sort: z.enum(['name', 'lastStay', 'stays']).default('name'),
    order: z.enum(['asc', 'desc']).optional(), // default: A–Z for name, newest / most first otherwise
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(GUEST_LIST_PAGE_SIZE),
  })
  .superRefine(rangesInOrder(['staysMin', 'staysMax'], ['lastStayFrom', 'lastStayTo'], ['addedFrom', 'addedTo']));
export type ListGuests = z.infer<typeof listGuestsSchema>;

// ---------- "This email belongs to Ahmed Daoud" ----------
export const findMatchesSchema = z
  .object({
    email: trimmed.optional(),
    phone: trimmed.optional(),
    phoneCountry: countryCode,
    excludeId: z.coerce.number().int().optional(), // the guest being edited
  })
  .refine((v) => !!v.email !== !!v.phone, { message: 'Give an email or a phone' });
export type FindMatches = z.infer<typeof findMatchesSchema>;

// ---------- emails and phones ----------
const methodFlags = {
  isPrimary: z.boolean().optional(),
  isShared: z.boolean().optional(),
  status: z.enum(CONTACT_METHOD_STATUSES).optional(),
};

export const createContactMethodSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email'),
    value: emailValue,
    ...methodFlags,
  }),
  z.object({
    kind: z.literal('phone'),
    value: phoneValue,
    country: countryCode,
    isWhatsapp: z.boolean().nullish(), // null = not yet known
    ...methodFlags,
    status: z.enum(CONTACT_METHOD_STATUSES).exclude(['bounced'], 'A phone number can be wrong, not bounced').optional(),
  }),
]);
export type CreateContactMethod = z.infer<typeof createContactMethodSchema>;

// The kind can't change; value is checked against the existing row's kind.
export const updateContactMethodSchema = z.object({
  value: trimmed.min(1, 'Enter an email or phone number').max(320).optional(),
  country: countryCode,
  isWhatsapp: z.boolean().nullish(),
  ...methodFlags,
});
export type UpdateContactMethod = z.infer<typeof updateContactMethodSchema>;
