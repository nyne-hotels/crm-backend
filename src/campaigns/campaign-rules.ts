import type { ConsentStatus } from '../consent/consent-rules.js';

// ---------------------------------------------------------------------
// A campaign's form lives at /<slug> on the campaign site. The slug is made
// from the name once, when the campaign is added: "Halloween 2026" →
// halloween-2026; renaming keeps it, though it can be changed by hand. Accents are dropped (Café → cafe) and anything that isn't a
// letter or digit becomes one dash. A name with neither becomes "campaign".
// ---------------------------------------------------------------------
export const SLUG_LENGTH = 60;

export function slugFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || 'campaign';
}

// The slug, or the first of slug-2, slug-3 … not yet used. Slugs of closed
// and deleted campaigns count, since their emails may still be in inboxes.
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------
// The opt-in box. Its wording is kept here and sent to the form, so the
// consent evidence is exactly what the guest saw. Only a ticked box is a
// choice (see consent-rules.ts); it opts in someone who hasn't decided, but
// never overrules a no or do not contact: anyone can type any email into a
// public form, so those are left for staff to confirm with the guest. So is
// a person found by phone alone: the email they typed isn't on their record.
// ---------------------------------------------------------------------
export const OPT_IN_WORDING = 'Send me offers and news from Nyne Hotels by email';

export type OptInOutcome =
  | 'not_ticked'
  | 'opted_in' // recorded
  | 'already_opted_in' // nothing to change; the original source is kept
  | 'opted_out' // ticked, but they said no before: left for staff
  | 'do_not_contact' // ticked, but they asked not to be contacted
  | 'phone_match'; // ticked, but found by phone, with another email: left for staff

export function optInOutcome(
  ticked: boolean,
  emailConsent: ConsentStatus | null, // null: no consent row yet
  doNotContact: boolean,
  matchedBy: 'new' | 'email' | 'phone',
): OptInOutcome {
  if (!ticked) return 'not_ticked';
  if (doNotContact) return 'do_not_contact';
  if (emailConsent === 'opted_in') return 'already_opted_in';
  if (emailConsent === 'opted_out') return 'opted_out';
  if (matchedBy === 'phone') return 'phone_match';
  return 'opted_in';
}

export const optInEvidence = (campaignName: string) => `${campaignName} form: "${OPT_IN_WORDING}"`;

// ---------------------------------------------------------------------
// The note on the lead: what the guest typed (the form never changes a
// person already in the CRM, so this is where it's kept) and what happened
// to the opt-in.
// ---------------------------------------------------------------------
export interface FormNote {
  campaignName: string;
  again: boolean; // a second form on a lead that's still open
  matchedBy: 'new' | 'email' | 'phone';
  firstName: string;
  lastName: string | null;
  email: string;
  phone: string | null;
  comments: string | null; // the form's "Comments" box
  optIn: OptInOutcome;
  optedOutOn: string | null; // '12 Mar 2026', when optIn is 'opted_out'
}

const OPT_IN_LINES: Record<OptInOutcome, (n: FormNote) => string> = {
  not_ticked: () => "Didn't tick the marketing email opt-in.",
  opted_in: () => 'Opted in to marketing emails.',
  already_opted_in: () => 'Ticked the marketing email opt-in (already opted in).',
  opted_out: (n) =>
    `Ticked the marketing email opt-in, but opted out${n.optedOutOn ? ` on ${n.optedOutOn}` : ''}. ` +
    'Check with them before changing it.',
  do_not_contact: () => 'Ticked the marketing email opt-in, but is marked do not contact. Left as it is.',
  phone_match: () =>
    'Ticked the marketing email opt-in. Not recorded, since only the phone matched: ' +
    'add the email and record the opt-in if this is them.',
};

export function formNote(n: FormNote): string {
  const name = [n.firstName, n.lastName].filter(Boolean).join(' ');
  const lines = [
    `${n.again ? 'Sent the form again' : 'Sent the form'} for ${n.campaignName}.`,
    `Name: ${name}`,
    `Email: ${n.email}`,
    ...(n.phone ? [`Phone: ${n.phone}`] : []),
    ...(n.comments ? [`Comments: ${n.comments}`] : []),
    ...(n.matchedBy === 'phone' ? ['Matched by phone: this email isn’t on their record.'] : []),
    OPT_IN_LINES[n.optIn](n),
  ];
  return lines.join('\n');
}
