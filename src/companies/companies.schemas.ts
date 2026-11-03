import { z } from 'zod';
import { anyOf, countryCodes, fieldFilters, yesNo } from '../common/filters.js';
import { COMPANY_STATUSES, COMPANY_TYPES } from '../db/schema/index.js';
import { createGuestSchema } from '../guests/guests.schemas.js';

const trimmed = z.string().trim();
const optionalText = trimmed.transform((v) => v || null).nullish();
const id = z.number().int().positive();
const countryCode = trimmed
  .toUpperCase()
  .regex(/^([A-Z]{2})?$/, 'Choose a country from the list')
  .transform((v) => v || null)
  .nullish();

// ---------- a company ----------
const companyFields = {
  name: trimmed.min(1, 'Enter a name').max(200),
  companyType: z.enum(COMPANY_TYPES),
  countryCode,
  address: optionalText,
  website: optionalText,
  commissionNotes: trimmed.max(5000).transform((v) => v || null).nullish(), // commission terms
  accountOwnerId: id.nullish(),
  status: z.enum(COMPANY_STATUSES),
};

export const createCompanySchema = z.object({
  ...companyFields,
  companyType: companyFields.companyType.default('travel_agent'),
  status: companyFields.status.default('active'),
});
export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = z.object(companyFields).partial();
export type UpdateCompany = z.infer<typeof updateCompanySchema>;

// ---------- the list ----------
export const listCompaniesSchema = z.object({
  q: trimmed.max(100).optional(), // the name
  // a filter with several values matches any of them
  type: anyOf(z.enum(COMPANY_TYPES)),
  status: anyOf(z.enum(COMPANY_STATUSES)),
  owner: anyOf(z.union([z.literal('none'), z.coerce.number().int().positive()])), // account owners, and 'none'
  country: countryCodes,
  // ---- More filters ----
  people: yesNo, // has people in the CRM
  bookedLastYear: yesNo, // stays in the last 12 months (arrived since, or still to come)
  lastContact: z.enum(['30', '90', 'over_90', 'never']).optional(), // the last conversation with it or its people
  openLeads: yesNo, // its people have open leads
  ...fieldFilters(['country', 'address', 'website', 'commissionNotes']),
});
export type ListCompanies = z.infer<typeof listCompaniesSchema>;

// ---------- people ----------
// Add person: link someone already in the CRM, or add them as a new agent contact.
export const addPersonSchema = z
  .object({
    contactId: id.optional(),
    newPerson: createGuestSchema.optional(),
  })
  .refine((v) => !!v.contactId !== !!v.newPerson, { path: ['contactId'], message: 'Choose a person or add a new one' });
export type AddPerson = z.infer<typeof addPersonSchema>;

export const COMPANY_STAYS_PAGE_SIZE = 25;

export const companyStaysSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(COMPANY_STAYS_PAGE_SIZE),
});
export type CompanyStays = z.infer<typeof companyStaysSchema>;

export const companyNoteSchema = z.object({ body: trimmed.min(1, 'Write the note').max(5000) });
export type CompanyNote = z.infer<typeof companyNoteSchema>;
