import type { CONSENT_CHANNELS, CONSENT_STATUSES, LIFECYCLE_STAGES } from '../db/schema/index.js';
import { STAGE_LABELS } from '../guests/guest-rules.js';

type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
type ConsentStatus = (typeof CONSENT_STATUSES)[number];
type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

// ---------------------------------------------------------------------
// The merge itself is merge_contacts() in the database (migration 0012).
// These are the rules around it: which reasons a pair was flagged for,
// which profile to suggest keeping, and the preview in plain words.
// ---------------------------------------------------------------------

export const DUPLICATE_REASONS = ['email', 'phone', 'name'] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

// A pair is stored and looked up lowest id first.
export const pairOf = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

// ---------- which one to keep ----------
// "Usually the one with more history": more stays, then more notes,
// preferences, dates and leads, then more emails and phones, then the older
// profile. Staff can always pick the other.
export interface HistorySize {
  id: number;
  stays: number; // not cancelled, not deleted
  knowledge: number; // notes, preferences, special dates, leads
  details: number; // emails and phones
}

export function suggestKeep(a: HistorySize, b: HistorySize): number {
  const order = [b.stays - a.stays, b.knowledge - a.knowledge, b.details - a.details, a.id - b.id];
  const first = order.find((d) => d !== 0) ?? 0;
  return first > 0 ? b.id : a.id;
}

// ---------- what was filled in ----------
// Empty fields on the kept profile are filled from the other one, never
// overwritten. Compares the kept profile before and after the merge.
export interface FillableFields {
  firstName: string | null;
  lastName: string | null;
  countryCode: string | null;
  companyId: number | null;
  designation: string | null;
  vipReason: string | null;
}

const FILLABLE: [keyof FillableFields, string][] = [
  ['countryCode', 'country'],
  ['companyId', 'company'],
  ['designation', 'job title'],
  ['vipReason', 'VIP reason'],
];

export function filledFields(before: FillableFields, after: FillableFields): string[] {
  const filled: string[] = [];
  if (!before.firstName && !before.lastName && (after.firstName || after.lastName)) filled.push('name');
  else if (!before.lastName && after.lastName) filled.push('surname');
  for (const [key, label] of FILLABLE) if (before[key] == null && after[key] != null) filled.push(label);
  return filled;
}

// ---------- the preview in plain words ----------
// "Avee Raam will have 2 emails, 2 phones, 1 stay (both profiles had the same
// Rock Villa stay), consent unknown."
export interface MergeOutcome {
  keptName: string;
  removedName: string;
  emails: number;
  phones: number;
  stays: number; // checked out, as counted for the stage
  upcoming: number; // booked or checked in
  sharedStayHotels: string[]; // a stay both had, kept once
  consent: Record<ConsentChannel, ConsentStatus>;
  stageBefore: LifecycleStage; // the kept profile's
  stage: LifecycleStage;
  moved: { notes: number; preferences: number; specialDates: number; leads: number; interactions: number };
  tagsAdded: string[];
  filled: string[]; // from filledFields()
  doNotContactCarried: boolean; // the removed profile had it and the kept one didn't
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const listInWords = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const CONSENT_WORDS: Record<ConsentStatus, string> = {
  opted_in: 'opted in',
  opted_out: 'opted out',
  not_opted_in: 'not opted in',
  unknown: 'unknown',
};

function consentInWords(consent: Record<ConsentChannel, ConsentStatus>): string {
  const { email, whatsapp } = consent;
  if (email === whatsapp) {
    if (email === 'opted_in') return 'opted in to email and WhatsApp';
    if (email === 'opted_out') return 'opted out of email and WhatsApp';
    return `consent ${CONSENT_WORDS[email]}`;
  }
  return `email ${CONSENT_WORDS[email]}, WhatsApp ${CONSENT_WORDS[whatsapp]}`;
}

export function mergePreview(o: MergeOutcome): string[] {
  const sentences: string[] = [];
  // two "Avee Raam"s: the name alone wouldn't say which one
  const other = o.keptName.toLowerCase() === o.removedName.toLowerCase() ? 'the other profile' : o.removedName;

  let stays = count(o.stays, 'stay');
  if (o.sharedStayHotels.length) {
    const hotels = [...new Set(o.sharedStayHotels)];
    const same = o.sharedStayHotels.length === 1 ? 'stay' : 'stays';
    stays += ` (both profiles had the same ${listInWords(hotels)} ${same})`;
  }
  if (o.upcoming) stays += `, ${count(o.upcoming, 'upcoming booking')}`;
  sentences.push(
    `${o.keptName} will have ${count(o.emails, 'email')}, ${count(o.phones, 'phone')}, ${stays}, ${consentInWords(o.consent)}.`,
  );

  sentences.push(
    o.stage === o.stageBefore ? `Stage stays ${STAGE_LABELS[o.stage]}.` : `Stage becomes ${STAGE_LABELS[o.stage]}.`,
  );

  const moved = [
    o.moved.notes && count(o.moved.notes, 'note'),
    o.moved.preferences && count(o.moved.preferences, 'like or dislike', 'likes and dislikes'),
    o.moved.specialDates && count(o.moved.specialDates, 'special date'),
    o.moved.leads && count(o.moved.leads, 'lead'),
    o.moved.interactions && count(o.moved.interactions, 'interaction'),
  ].filter((m): m is string => !!m);
  if (moved.length) sentences.push(`Moves across from ${other}: ${listInWords(moved)}.`);

  if (o.tagsAdded.length) {
    sentences.push(`Adds the ${o.tagsAdded.length === 1 ? 'tag' : 'tags'} ${listInWords(o.tagsAdded)}.`);
  }
  if (o.filled.length) sentences.push(`Fills in the ${listInWords(o.filled)} from ${other}.`);
  if (o.doNotContactCarried) sentences.push(`Do not contact carries over from ${other}.`);
  sentences.push(
    `${other === o.removedName ? `${other}'s profile` : 'The other profile'} is removed; a full copy is kept in the merge history.`,
  );
  return sentences;
}
