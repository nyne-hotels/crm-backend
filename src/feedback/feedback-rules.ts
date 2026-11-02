import type { DEPARTMENTS } from '../db/schema/index.js';
import { normaliseHeading, parseDate, parseDateTime, splitName } from '../stays/imports/booking-import-rules.js';
import { STATUS_LABELS, type StayStatus } from '../stays/stay-rules.js';

export type Department = (typeof DEPARTMENTS)[number];

// =====================================================================
// GUEST FEEDBACK – the rules, without the database (Module 8).
// =====================================================================

// Ratings of 1 or 2 need a manager to follow up, until someone marks them
// followed up with an outcome.
export const LOW_RATING = 2;

export const needsFollowUp = (f: { rating: number | null; followedUpAt: Date | string | null }) =>
  f.rating !== null && f.rating <= LOW_RATING && !f.followedUpAt;

// Feedback can only be added to a stay that is over. Stays loaded before
// statuses existed were all made checked out (migration 0005).
export const canHaveFeedback = (status: StayStatus) => status === 'checked_out';

export const STAY_NOT_OVER = 'Feedback can only be added to a checked-out stay';

const clean = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------
// A rating as form tools write it: '4', '4.0', '4/5', '4 out of 5',
// '4 stars', '★★★★☆'. A whole number from 1 to 5; anything else (8/10,
// 4.5) is refused rather than guessed. Empty is null (a review only).
// ---------------------------------------------------------------------
export function parseRating(text: string | undefined): { rating: number | null } | { error: string } {
  const t = clean(text).toLowerCase();
  if (!t) return { rating: null };
  const stars = [...t].filter((c) => c === '★' || c === '⭐').length;
  if (stars && /^[★⭐☆\s]+$/.test(t)) return stars <= 5 ? { rating: stars } : { error: `"${clean(text)}" isn't a rating from 1 to 5` };
  const m = /^(\d+)(?:\.0+)?\s*(?:(?:\/|out of|of)\s*5)?\s*(?:stars?)?$/.exec(t);
  const n = m ? Number(m[1]) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= 5) return { rating: n };
  return { error: `"${clean(text)}" isn't a rating from 1 to 5` };
}

// ---------------------------------------------------------------------
// UPLOADING RESPONSES – a file exported from the form tool. Each row is
// matched to its stay by booking reference (and hotel, since a reference is
// unique only within a hotel), or failing that by the guest's email (and
// arrival date when they have more than one stay).
// ---------------------------------------------------------------------
export const UPLOAD_FIELDS = [
  'bookingReference',
  'hotel',
  'email',
  'arrivalDate',
  'rating',
  'review',
  'submittedAt',
] as const;
export type UploadField = (typeof UPLOAD_FIELDS)[number];
export type UploadRow = Partial<Record<UploadField, string>>;

// What the service loads for the rows: stays by booking reference and by
// guest email, and the hotels.
export interface CandidateStay {
  id: number;
  contactId: number;
  firstName: string | null;
  lastName: string | null;
  propertyId: string;
  hotel: string;
  bookingReference: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  status: StayStatus;
  feedbackId: number | null; // the response it already has
}

export interface UploadLookups {
  byReference: Map<string, CandidateStay[]>; // key: lower-case reference
  byEmail: Map<string, CandidateStay[]>; // key: lower-case email
  hotels: { id: string; name: string }[];
  now: Date;
}

export type UploadOutcome = 'new' | 'exists' | 'unmatched' | 'error';

export interface PlannedResponse {
  row: number; // 1-based, as in the preview
  outcome: UploadOutcome;
  problem: string | null; // why it won't be saved
  stay: CandidateStay | null;
  rating: number | null;
  review: string | null;
  submittedAt: Date | null;
  raw: UploadRow;
}

export const referenceKey = (v: string) => clean(v).toLowerCase();
export const emailKey = (v: string) => clean(v).toLowerCase();

// 'Rock Villa', 'rock villa', 'P03' → the hotel's id
export function findHotel(text: string | undefined, hotels: { id: string; name: string }[]): string | null | undefined {
  const t = normaliseHeading(clean(text));
  if (!t) return null;
  const hit = hotels.find((h) => normaliseHeading(h.name) === t || h.id.toLowerCase() === t);
  return hit ? hit.id : undefined; // undefined: named but not recognised
}

const guestOf = (s: CandidateStay) => [s.firstName, s.lastName].filter(Boolean).join(' ') || 'the guest';

function matchStay(raw: UploadRow, lookups: UploadLookups, hotelId: string | null): { stay: CandidateStay } | { problem: string } {
  const reference = clean(raw.bookingReference);
  const email = clean(raw.email);
  const atHotel = (list: CandidateStay[]) => (hotelId ? list.filter((s) => s.propertyId === hotelId) : list);

  if (reference) {
    const found = atHotel(lookups.byReference.get(referenceKey(reference)) ?? []);
    if (found.length === 1) return { stay: found[0] };
    if (found.length > 1) return { problem: `Booking reference ${reference} is at more than one hotel; add a Hotel column` };
    if (!email) return { problem: `No stay with booking reference ${reference}${hotelId ? ' at that hotel' : ''}` };
  }
  if (email) {
    let found = atHotel(lookups.byEmail.get(emailKey(email)) ?? []);
    const arrival = parseDate(raw.arrivalDate);
    if (clean(raw.arrivalDate) && !arrival) return { problem: `Arrival "${clean(raw.arrivalDate)}" isn't a date` };
    if (arrival) found = found.filter((s) => s.arrivalDate === arrival);
    else {
      // without a date, only a stay that is over can be the one
      const over = found.filter((s) => canHaveFeedback(s.status));
      if (over.length) found = over;
    }
    if (found.length === 1) return { stay: found[0] };
    if (found.length > 1) {
      return { problem: `${email} has ${found.length} stays${hotelId ? ' at that hotel' : ''}; add the arrival date or booking reference` };
    }
    return { problem: `No stay found for ${email}${arrival ? ` arriving ${arrival}` : ''}${hotelId ? ' at that hotel' : ''}` };
  }
  return { problem: 'No booking reference or email to find the stay' };
}

// What each row of the file does. The preview and the upload run the same
// plan, so what staff see is what is saved.
export function planUpload(rows: UploadRow[], lookups: UploadLookups): PlannedResponse[] {
  const claimed = new Map<number, number>(); // stay id → the row that took it
  return rows.map((raw, i) => {
    const row = i + 1;
    const plan = (outcome: UploadOutcome, problem: string | null, extra: Partial<PlannedResponse> = {}): PlannedResponse => ({
      row,
      outcome,
      problem,
      stay: null,
      rating: null,
      review: null,
      submittedAt: null,
      raw,
      ...extra,
    });

    const hotelId = findHotel(raw.hotel, lookups.hotels);
    if (hotelId === undefined) return plan('unmatched', `Hotel "${clean(raw.hotel)}" isn't one of ours`);
    const match = matchStay(raw, lookups, hotelId);
    if ('problem' in match) return plan('unmatched', match.problem);
    const { stay } = match;

    const rated = parseRating(raw.rating);
    const review = (raw.review ?? '').trim() || null;
    // the stay's existing response is the reason it's skipped, whatever this row holds
    if (stay.feedbackId) {
      return plan('exists', 'This stay already has a response', {
        stay,
        review,
        rating: 'rating' in rated ? rated.rating : null,
        submittedAt: parseDateTime(raw.submittedAt),
      });
    }
    if ('error' in rated) return plan('error', rated.error, { stay });
    if (rated.rating === null && !review) return plan('error', 'No rating or review', { stay });
    let submittedAt = lookups.now;
    if (clean(raw.submittedAt)) {
      const at = parseDateTime(raw.submittedAt);
      if (!at) return plan('error', `Date received "${clean(raw.submittedAt)}" isn't a date`, { stay });
      if (at.getTime() > lookups.now.getTime()) return plan('error', 'Date received is in the future', { stay });
      submittedAt = at;
    }
    const values = { stay, rating: rated.rating, review, submittedAt };

    if (!canHaveFeedback(stay.status)) {
      return plan('error', `The stay is ${STATUS_LABELS[stay.status].toLowerCase()}, not checked out`, values);
    }
    const earlier = claimed.get(stay.id);
    if (earlier) return plan('error', `Row ${earlier} is for the same stay (${guestOf(stay)}, ${stay.hotel})`, values);
    claimed.set(stay.id, row);
    return plan('new', null, values);
  });
}

// =====================================================================
// EMPLOYEES – loading a hotel's staff list.
// =====================================================================
export const DEPARTMENT_LABELS: Record<Department, string> = {
  front_office: 'Front office',
  housekeeping: 'Housekeeping',
  food_beverage: 'Food and beverage',
  kitchen: 'Kitchen',
  spa: 'Spa',
  transport: 'Transport',
  activities: 'Activities',
  maintenance: 'Maintenance',
  management: 'Management',
  other: 'Other',
};

// Words hotels use for each department, compared lower-case with letters and digits only.
const DEPARTMENT_WORDS: [Department, string[]][] = [
  ['front_office', ['front office', 'front desk', 'reception', 'guest relations', 'concierge', 'reservations', 'fo']],
  ['housekeeping', ['housekeeping', 'house keeping', 'hk', 'laundry', 'rooms']],
  ['food_beverage', ['food and beverage', 'food beverage', 'f b', 'fnb', 'f and b', 'restaurant', 'bar', 'service', 'dining']],
  ['kitchen', ['kitchen', 'culinary', 'chef', 'chefs']],
  ['spa', ['spa', 'wellness', 'ayurveda']],
  ['transport', ['transport', 'transportation', 'drivers', 'driver', 'transfers', 'chauffeur']],
  ['activities', ['activities', 'excursions', 'naturalist', 'naturalists', 'recreation', 'guides']],
  ['maintenance', ['maintenance', 'engineering', 'technical', 'gardening', 'garden']],
  ['management', ['management', 'admin', 'administration', 'executive', 'finance', 'hr', 'human resources', 'accounts']],
  ['other', ['other']],
];

export function parseDepartment(text: string | undefined): { department: Department; recognised: boolean } {
  const t = normaliseHeading(clean(text).replace(/&/g, ' and '));
  if (!t) return { department: 'other', recognised: true };
  for (const [department, words] of DEPARTMENT_WORDS) {
    if (normaliseHeading(DEPARTMENT_LABELS[department]) === t || words.includes(t)) return { department, recognised: true };
  }
  return { department: 'other', recognised: false };
}

export interface StaffListRow {
  name?: string; // full name, or
  firstName?: string;
  lastName?: string;
  department?: string;
  jobTitle?: string;
}

export interface PlannedEmployee {
  row: number;
  outcome: 'new' | 'exists' | 'error';
  problem: string | null;
  note: string | null; // e.g. a department that wasn't recognised
  firstName: string | null;
  lastName: string | null;
  department: Department;
  jobTitle: string | null;
}

export const employeeKey = (firstName: string | null, lastName: string | null) =>
  normaliseHeading(`${firstName ?? ''} ${lastName ?? ''}`);

// Each row of a hotel's staff list. Someone already on that hotel's list
// (same name, ignoring case) is left as they are.
export function planStaffList(rows: StaffListRow[], existing: Set<string>): PlannedEmployee[] {
  const seen = new Map<string, number>();
  return rows.map((raw, i) => {
    const row = i + 1;
    const split = clean(raw.firstName) || clean(raw.lastName)
      ? { firstName: clean(raw.firstName) || null, lastName: clean(raw.lastName) || null }
      : splitName(raw.name);
    // a single name is a first name
    const firstName = split.firstName ?? split.lastName;
    const lastName = split.firstName ? split.lastName : null;
    const { department, recognised } = parseDepartment(raw.department);
    const base = {
      row,
      firstName,
      lastName,
      department,
      jobTitle: clean(raw.jobTitle) || null,
      note: recognised ? null : `Department "${clean(raw.department)}" not recognised; saved as Other`,
    };
    if (!firstName) return { ...base, outcome: 'error' as const, problem: 'No name' };
    const key = employeeKey(firstName, lastName);
    if (existing.has(key)) return { ...base, outcome: 'exists' as const, problem: 'Already on the list' };
    const earlier = seen.get(key);
    if (earlier) return { ...base, outcome: 'exists' as const, problem: `Same name as row ${earlier}` };
    seen.set(key, row);
    return { ...base, outcome: 'new' as const, problem: null };
  });
}
