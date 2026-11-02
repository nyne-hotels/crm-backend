import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { CONTACT_TYPES, LIFECYCLE_STAGES, MARKETS } from '../db/schema/index.js';

type ContactType = (typeof CONTACT_TYPES)[number];
type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
type Market = (typeof MARKETS)[number];

// ---------------------------------------------------------------------
// Phones are saved in the international form, e.g. +94 77 123 4567 – the
// same form as the imported guest list – so one number always looks the same.
// `country` is the country code picked next to the number; a number typed
// with its own +code ignores it. Returns null for something that can't be a
// phone number.
// ---------------------------------------------------------------------
export function formatPhone(value: string, country?: string | null): string | null {
  const defaultCountry = country && isSupportedCountry(country) ? (country as CountryCode) : undefined;
  const parsed = parsePhoneNumberFromString(value.trim(), defaultCountry);
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.formatInternational();
}

// What duplicate matching compares: case and spaces don't count. The database's
// contact_method_key() does the same for possible_duplicates and merges.
export function matchKey(kind: 'email' | 'phone', value: string): string {
  return kind === 'email' ? value.replace(/\s+/g, '').toLowerCase() : value.replace(/\D/g, '');
}

// Stage names as staff see them, for text the API writes (export log, merge preview).
// The 'lead' stage shows as Not enquired, so it isn't confused with the Leads tab.
export const STAGE_LABELS: Record<LifecycleStage, string> = {
  lead: 'Not enquired',
  enquired: 'Enquired',
  booked: 'Booked',
  stayed: 'Stayed',
  repeat_guest: 'Repeat guest',
  stayed_hotel_unknown: 'Hotel unknown',
  agent_contact: 'Agent contact',
  influencer: 'Influencer',
};

// Sri Lanka is local, any other country foreign, no country unknown.
// Staff can override it (an expat living in Colombo).
export function marketForCountry(countryCode: string | null | undefined): Market {
  if (!countryCode) return 'unknown';
  return countryCode.toUpperCase() === 'LK' ? 'local' : 'foreign';
}

// ---------------------------------------------------------------------
// Stage is never edited directly; stays and leads move it (Modules 3 and 7).
// Agent contacts and influencers have a stage of their own, so changing the
// type is the one place it moves here.
// ---------------------------------------------------------------------
const OWN_STAGE_TYPES: readonly ContactType[] = ['agent_contact', 'influencer'];

export function initialStage(type: ContactType): LifecycleStage {
  return OWN_STAGE_TYPES.includes(type) ? (type as LifecycleStage) : 'lead';
}

// The stage after a type change, or undefined when it stays as it is.
// Turning an agent contact back into a guest takes the stage from their
// stays, the way the lifecycle trigger counts them.
export function stageAfterTypeChange(
  current: LifecycleStage,
  newType: ContactType,
  stayCount: number,
): LifecycleStage | undefined {
  if (OWN_STAGE_TYPES.includes(newType)) return newType === current ? undefined : (newType as LifecycleStage);
  if (current !== 'agent_contact' && current !== 'influencer') return undefined;
  return stayCount >= 2 ? 'repeat_guest' : stayCount === 1 ? 'stayed' : 'lead';
}

// ---------------------------------------------------------------------
// Guest search: every word must appear in the name ("daoud", "ahmed dao",
// "daoud ahmed"), or the whole text in an email, or – when it looks like a
// phone number – its digits in a phone ("+966 54", "077 123"). A local number
// typed with its leading 0 also matches the saved international form.
// ---------------------------------------------------------------------
export interface SearchTerms {
  text: string;
  words: string[];
  phoneDigits: string[]; // empty when the text doesn't look like a phone number
}

export function searchTerms(q: string): SearchTerms {
  const text = q.trim().replace(/\s+/g, ' ');
  const words = text.split(' ').filter(Boolean);
  const phoneDigits: string[] = [];
  if (/^[+\d][\d\s\-().]*$/.test(text)) {
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 3) phoneDigits.push(digits);
    const withoutTrunk = digits.replace(/^0+/, '');
    if (!text.startsWith('+') && withoutTrunk !== digits && withoutTrunk.length >= 3) phoneDigits.push(withoutTrunk);
  }
  return { text, words, phoneDigits };
}
