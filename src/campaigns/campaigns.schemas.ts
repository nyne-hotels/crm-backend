import { z } from 'zod';
import { emailValue } from '../guests/guests.schemas.js';
import { SLUG_LENGTH } from './campaign-rules.js';

const trimmed = z.string().trim();
const name = trimmed.min(1, 'Enter a name').max(80);
const id = z.number().int().positive();

// ---------- in the CRM ----------
// The slug is made from the name; renaming keeps it, so sent links still work.
export const createCampaignSchema = z.object({ name, ownerId: id });
export type CreateCampaign = z.infer<typeof createCampaignSchema>;

// the form's address, /<slug>, when someone types it in
const slug = trimmed
  .toLowerCase()
  .min(1, 'Enter the link')
  .max(SLUG_LENGTH, `Keep the link to ${SLUG_LENGTH} characters or fewer`)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use only letters, numbers and single dashes, e.g. halloween-2026');

// rename, change the link (links already sent then stop working), hand the
// leads to someone else, or close / reopen with isActive
export const updateCampaignSchema = z.object({ name, slug, ownerId: id, isActive: z.boolean() }).partial();
export type UpdateCampaign = z.infer<typeof updateCampaignSchema>;

// ---------- the public form ----------
export const campaignSlugSchema = trimmed.toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Campaign not found').max(80);

// What a guest sends from campaigns/. The phone needs its country code: the
// form doesn't ask for a country. `website` is a field people never see;
// bots that fill every field fill it in (see CampaignFormService.submit()).
// `turnstileToken` is from the Cloudflare bot check (see turnstile.ts).
export const campaignResponseSchema = z.object({
  firstName: trimmed.min(1, 'Enter your first name').max(100),
  lastName: trimmed.max(100).transform((v) => v || null).nullish(),
  email: emailValue,
  phone: trimmed.max(40).transform((v) => v || null).nullish(),
  comments: trimmed.max(2000, 'Keep your comments under 2,000 characters').transform((v) => v || null).nullish(),
  optIn: z.boolean().default(false),
  website: z.string().max(200).optional(),
  turnstileToken: z.string().max(2048).optional(),
});
export type CampaignResponse = z.infer<typeof campaignResponseSchema>;
