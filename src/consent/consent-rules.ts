import type {
  CONSENT_CHANNELS,
  CONSENT_SOURCES,
  CONSENT_STATUSES,
  CONTACT_METHOD_STATUSES,
  MarketingExportFilters,
  MARKETS,
} from '../db/schema/index.js';
import { STAGE_LABELS } from '../guests/guest-rules.js';
import { hotelToday } from '../stays/stay-rules.js';

export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

// ---------------------------------------------------------------------
// The latest explicit choice wins; silence changes nothing.
// A choice is a yes or a no the guest gave somewhere (a ticked box, a reply,
// an unsubscribe link). It replaces what is on file unless the choice on
// file was given later: recording last month's "yes" never undoes this
// week's "no". An unticked box or a form without one is not a choice, so
// callers never record one. recordConsentChoices() applies the same rule in SQL.
// ---------------------------------------------------------------------
export type ConsentChoiceStatus = Extract<ConsentStatus, 'opted_in' | 'opted_out'>;

// Sources staff can pick; 'do_not_contact' is set by the database only.
export const CHOICE_SOURCES = [
  'check_in_form',
  'booking_form',
  'website_form',
  'whatsapp',
  'in_person',
  'email_unsubscribe',
  'wix',
  'other',
] as const satisfies readonly ConsentSource[];

export function choiceIsLatest(onFile: { givenAt: Date | null } | null | undefined, givenAt: Date): boolean {
  return !onFile?.givenAt || onFile.givenAt <= givenAt;
}

// One choice per guest and channel – the latest – when a batch has several.
export function latestChoices<T extends { contactId: number; channel: ConsentChannel; givenAt: Date }>(choices: T[]): T[] {
  const latest = new Map<string, T>();
  for (const c of choices) {
    const key = `${c.contactId}|${c.channel}`;
    if (choiceIsLatest(latest.get(key), c.givenAt)) latest.set(key, c);
  }
  return [...latest.values()];
}

// ---------------------------------------------------------------------
// The date a choice was given. Staff pick a day (today by default); today
// means now, so it counts as later than anything recorded earlier today. An
// earlier day is taken as the start of that day in Colombo (UTC+5:30, no
// daylight saving).
// ---------------------------------------------------------------------
export function givenOnError(day: string, now = new Date()): string | null {
  // the round trip catches 30 February, which Date would roll over into March
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return 'Enter a valid date';
  if (day > hotelToday(now)) return "The date can't be in the future";
  if (day < '2000-01-01') return 'Enter a date from 2000';
  return null;
}

export function givenAtFor(day: string, now = new Date()): Date {
  return day === hotelToday(now) ? now : new Date(`${day}T00:00:00+05:30`);
}

// ---------------------------------------------------------------------
// The marketing email list. A guest is on it when all five hold: not
// deleted, not do-not-contact, email opted in, and a primary email that is
// personal (not shared), not bounced and not marked wrong. The
// marketing_email_list view decides who is exported; this says why someone
// isn't on it, for the line under the Consent panel. Deleted guests have no
// profile, so they never get here.
// ---------------------------------------------------------------------
export const NOT_ON_LIST_REASONS = [
  'do_not_contact',
  'no_opt_in',
  'no_personal_email',
  'email_bounced',
  'email_invalid',
] as const;
export type NotOnListReason = (typeof NOT_ON_LIST_REASONS)[number];

type MethodStatus = (typeof CONTACT_METHOD_STATUSES)[number];

export function notOnListReasons(guest: {
  doNotContact: boolean;
  emailConsent: ConsentStatus | null; // null: no consent row yet
  primaryEmail: { isShared: boolean; status: MethodStatus } | null;
}): NotOnListReason[] {
  const reasons: NotOnListReason[] = [];
  if (guest.doNotContact) reasons.push('do_not_contact');
  if (guest.emailConsent !== 'opted_in') reasons.push('no_opt_in');
  const email = guest.primaryEmail;
  if (!email || email.isShared) reasons.push('no_personal_email');
  else if (email.status === 'bounced') reasons.push('email_bounced');
  else if (email.status === 'invalid') reasons.push('email_invalid');
  return reasons;
}

// ---------------------------------------------------------------------
// Unsubscribe and bounce files: the email addresses, cleaned and once each.
// ---------------------------------------------------------------------
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;

export function cleanEmails(values: readonly string[]): { emails: string[]; invalid: string[] } {
  const emails = new Set<string>();
  const invalid = new Set<string>();
  for (const value of values) {
    const email = value.trim().toLowerCase().replace(/^mailto:/, '');
    if (!email) continue;
    (EMAIL.test(email) ? emails : invalid).add(email);
  }
  return { emails: [...emails], invalid: [...invalid] };
}

// ---------------------------------------------------------------------
// The filters of an export in words, for the export log:
// "Foreign · United Kingdom · Stayed at Rock Villa · Last stay from 1 Jan 2025".
// ---------------------------------------------------------------------
const MARKET_LABELS: Record<(typeof MARKETS)[number], string> = {
  local: 'Local',
  foreign: 'Foreign',
  unknown: 'Market unknown',
};

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const formatDay = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));

const CONTACT_TYPE_LABELS: Record<string, string> = {
  guest: 'Guests',
  lead: 'Prospects',
  agent_contact: 'Agent contacts',
  influencer: 'Influencers',
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "Last stay 1 Jan 2025 – 31 Dec 2025", "Last stay from 1 Jan 2025", "Last stay up to 31 Dec 2025"
function dayRange(label: string, from: string | undefined, to: string | undefined) {
  if (from && to) return `${label} ${formatDay(from)} – ${formatDay(to)}`;
  if (from) return `${label} from ${formatDay(from)}`;
  return to && `${label} up to ${formatDay(to)}`;
}

// "2–5 stays", "At least 2 stays", "Up to 1 stay"
function countRange(min: number | undefined, max: number | undefined) {
  const stays = (n: number) => (n === 1 ? 'stay' : 'stays');
  if (min !== undefined && max !== undefined) return min === max ? `${min} ${stays(min)}` : `${min}–${max} stays`;
  if (min !== undefined) return `At least ${min} ${stays(min)}`;
  return max !== undefined && `Up to ${max} ${stays(max)}`;
}

// "Local", "Local or Foreign", "Rock Villa, Lake Lodge or Mayur Lodge"
function anyOf<T extends string | number>(values: T[] | undefined, label: (value: T) => string) {
  if (!values?.length) return undefined;
  const words = values.map(label);
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

// Names for the ids in the filters: countries by code, hotels by id, tags by id.
export interface ExportNames {
  countries?: Record<string, string>;
  hotels?: Record<string, string>;
  tags?: Record<number, string>;
}

export function exportSummary(filter: MarketingExportFilters, names: ExportNames): string {
  const hotel = (id: string) => names.hotels?.[id] ?? id;
  const stayedAt = anyOf(filter.propertyId, hotel);
  const tagged = anyOf(filter.tagId, (id) => names.tags?.[id] ?? `#${id}`);
  const lastAt = anyOf(filter.lastHotelId, hotel);
  const born = anyOf(filter.birthdayMonth, (m) => MONTH_NAMES[m - 1]);
  const parts = [
    anyOf(filter.market, (m) => MARKET_LABELS[m as keyof typeof MARKET_LABELS] ?? m),
    anyOf(filter.country, (code) => names.countries?.[code] ?? code),
    stayedAt && `Stayed at ${stayedAt}`,
    anyOf(filter.stage, (s) => STAGE_LABELS[s as keyof typeof STAGE_LABELS] ?? s),
    dayRange('Last stay', filter.lastStayFrom, filter.lastStayTo),
    tagged && `Tagged ${tagged}`,
    anyOf(filter.contactType, (t) => CONTACT_TYPE_LABELS[t] ?? t),
    lastAt && `Last stay at ${lastAt}`,
    countRange(filter.staysMin, filter.staysMax),
    born && `Birthday in ${born}`,
    dayRange('Opted in', filter.optedInFrom, filter.optedInTo),
    dayRange('Added', filter.addedFrom, filter.addedTo),
    filter.upcomingStay && (filter.upcomingStay === 'yes' ? 'Booked to come' : 'No booking to come'),
    filter.lowRating && (filter.lowRating === 'yes' ? 'Gave a low rating' : 'No low ratings'),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Whole list';
}
