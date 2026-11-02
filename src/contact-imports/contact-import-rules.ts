import type { CONSENT_CHANNELS, CONTACT_TYPES, LIFECYCLE_STAGES, MARKETS } from '../db/schema/index.js';
import { formatPhone, initialStage, marketForCountry, matchKey, stageAfterTypeChange } from '../guests/guest-rules.js';
import { findCountry, normaliseHeading, splitName } from '../stays/imports/booking-import-rules.js';

type ContactType = (typeof CONTACT_TYPES)[number];
type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
type Market = (typeof MARKETS)[number];
type Channel = (typeof CONSENT_CHANNELS)[number];
type Kind = 'email' | 'phone';
export type Choice = 'opted_in' | 'opted_out';

// =====================================================================
// CONTACT IMPORT – the rules, without the database (Module 9).
// The service loads what the CRM already has for the file's emails and
// phones, and planContactImport() decides what each row does, given the
// admin's Ignore / Add / Update choices. The review, the confirm step and the
// import itself all run the same plan, so what the admin confirms is what is
// saved.
// =====================================================================

// ---------- the CRM fields a file column can be matched to ----------
// The labels are the template's headings, so the template matches itself.
// `headings` are other titles recognised automatically (compared lower-case,
// letters and digits only).
export const CONTACT_IMPORT_FIELDS = [
  { key: 'firstName', label: 'First name', headings: ['first name', 'firstname', 'given name', 'forename', 'first'] },
  { key: 'lastName', label: 'Last name', headings: ['last name', 'lastname', 'surname', 'family name', 'last'] },
  {
    key: 'fullName',
    label: 'Name',
    hint: 'A single name column, split into first and last name. Ignored if First name or Last name is matched',
    headings: ['full name', 'guest name', 'contact name', 'contact', 'guest', 'customer', 'customer name', 'person'],
  },
  {
    key: 'contactType',
    label: 'Type',
    hint: 'Guest, Prospect, Agent contact or Influencer. Blank: Prospect for a new contact',
    headings: ['contact type', 'category'],
  },
  { key: 'email', label: 'Email', hint: 'Becomes the primary email', headings: ['e mail', 'email address', 'e mail address', 'mail', 'primary email', 'emailaddress'] },
  { key: 'otherEmails', label: 'Other emails', hint: 'Separated by ;', headings: ['other email', 'email 2', 'second email', 'alternative email'] },
  {
    key: 'phone',
    label: 'Phone',
    hint: 'With the country code; becomes the primary phone',
    headings: ['mobile', 'telephone', 'tel', 'phone number', 'mobile number', 'contact number', 'whatsapp', 'primary phone'],
  },
  { key: 'otherPhones', label: 'Other phones', hint: 'Separated by ;', headings: ['other phone', 'phone 2', 'second phone', 'landline'] },
  {
    key: 'sharedEmail',
    label: 'Shared email',
    hint: 'Agent office or family address: never used for matching or marketing',
    headings: ['office email', 'agency email', 'family email'],
  },
  { key: 'sharedPhone', label: 'Shared phone', hint: 'As above', headings: ['office phone', 'agency phone', 'family phone'] },
  { key: 'country', label: 'Country', hint: 'As the CRM lists it, or the 2-letter code (GB)', headings: ['nationality', 'country of residence', 'residence'] },
  { key: 'market', label: 'Market', hint: 'Local, Foreign or Unknown. Blank: worked out from the country', headings: ['market segment'] },
  { key: 'company', label: 'Company', hint: 'Matched to Companies by name; a new name creates a company', headings: ['agency', 'travel agent', 'organisation', 'organization', 'company name'] },
  { key: 'jobTitle', label: 'Job title', headings: ['designation', 'title', 'position', 'role'] },
  { key: 'vipReason', label: 'VIP reason', hint: 'Also adds the VIP / industry tag', headings: ['vip', 'vip industry'] },
  { key: 'tags', label: 'Tags', hint: 'Separated by ;, existing tags only', headings: ['tag', 'labels'] },
  { key: 'hotels', label: 'Hotels stayed at', hint: 'Separated by ;, as the CRM lists them', headings: ['hotels', 'hotel', 'properties', 'stayed at'] },
  { key: 'emailMarketing', label: 'Email marketing', hint: 'Yes, No or blank', headings: ['email consent', 'email opt in', 'newsletter', 'marketing'] },
  { key: 'whatsappMarketing', label: 'WhatsApp marketing', hint: 'Yes, No or blank', headings: ['whatsapp consent', 'whatsapp opt in'] },
  { key: 'likes', label: 'Likes', headings: ['like', 'preferences'] },
  { key: 'dislikes', label: 'Dislikes', headings: ['dislike'] },
  { key: 'notes', label: 'Notes', headings: ['note', 'remarks', 'comments'] },
] as const satisfies readonly { key: string; label: string; hint?: string; headings: readonly string[] }[];

export type ContactImportField = (typeof CONTACT_IMPORT_FIELDS)[number]['key'];
export const CONTACT_IMPORT_FIELD_KEYS = CONTACT_IMPORT_FIELDS.map((f) => f.key) as [ContactImportField, ...ContactImportField[]];

// One file row with its matched columns as text.
export type RawContact = Partial<Record<ContactImportField, string>>;

// ---------- what the parser needs to look names up ----------
export interface ContactLookups {
  countries: { code: string; name: string }[];
  properties: { id: string; name: string }[];
  tags: { id: number; name: string }[]; // active tags only
  companies: { id: number; name: string }[];
  vipTagId: number | null; // the "VIP / industry" tag, if it exists
}

export interface ParsedContact {
  firstName: string | null;
  lastName: string | null;
  contactType: ContactType | null; // null: blank
  countryCode: string | null;
  market: Market | null;
  company: { id: number | null; name: string } | null; // id null: a company this import creates
  designation: string | null;
  vipReason: string | null;
  primaryEmail: string | null; // the Email column, lower-case
  primaryPhone: string | null; // the Phone column, '+94 77 123 4567'
  emails: string[]; // personal: Email, then Other emails
  phones: string[];
  sharedEmails: string[];
  sharedPhones: string[];
  consent: Partial<Record<Channel, Choice>>;
  tagIds: number[]; // with the VIP tag when there's a VIP reason
  hotelIds: string[];
  likes: string | null;
  dislikes: string | null;
  notes: string | null;
}

export interface ParsedContactRow {
  index: number; // position in the file's rows, from 0
  values: ParsedContact;
  errors: string[];
}

// =====================================================================
// Reading cells
// =====================================================================
const clean = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
const key = (v: string) => normaliseHeading(v);
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;

// "a@x.com; b@y.com", one per line, or comma separated: emails and phones never hold ; or ,
const splitList = (v: string | undefined) =>
  (v ?? '')
    .split(/[;,\n]/)
    .map((s) => clean(s))
    .filter(Boolean);
// tags and hotels are separated by ; (or one per line), since a name can hold a comma
const splitNames = (v: string | undefined) =>
  (v ?? '')
    .split(/[;\n]/)
    .map((s) => clean(s))
    .filter(Boolean);

const TYPE_WORDS: Record<string, ContactType> = {
  guest: 'guest',
  prospect: 'lead',
  lead: 'lead',
  'agent contact': 'agent_contact',
  agent: 'agent_contact',
  'travel agent': 'agent_contact',
  influencer: 'influencer',
};

const MARKET_WORDS: Record<string, Market> = {
  local: 'local',
  foreign: 'foreign',
  unknown: 'unknown',
  'market unknown': 'unknown',
};

const YES = ['yes', 'y', 'true', '1', 'opted in', 'opt in', 'subscribed'];
const NO = ['no', 'n', 'false', '0', 'opted out', 'opt out', 'unsubscribed'];

// undefined: blank; null: not Yes or No
export function parseYesNo(text: string | undefined): Choice | null | undefined {
  const t = clean(text).toLowerCase();
  if (!t) return undefined;
  if (YES.includes(t)) return 'opted_in';
  if (NO.includes(t)) return 'opted_out';
  return null;
}

// Phone numbers with their country code (+44 7911 123456, 0044…, or 447911123456
// where Excel dropped the +), or Sri Lankan numbers starting with 0. A number
// Excel turned into 9.47712E+10 or rounded to …00000 is refused: the real
// digits are lost.
export function parseImportPhone(text: string): { phone: string | null; error: string | null } {
  const t = clean(text);
  const digits = t.replace(/\D/g, '');
  if (/\d[.,]?\d*e\+?\d+$/i.test(t) || (digits.length >= 8 && /0{5}$/.test(digits))) {
    return { phone: null, error: `Phone "${t}" looks rounded by Excel; format the column as text and type it again` };
  }
  let phone: string | null = null;
  if (t.startsWith('+')) phone = formatPhone(t);
  else if (digits.startsWith('00')) phone = formatPhone(`+${digits.slice(2)}`);
  else if (digits.startsWith('0')) phone = formatPhone(digits, 'LK');
  else if (/^[\d\s\-().]+$/.test(t) && digits.length >= 8) phone = formatPhone(`+${digits}`);
  return phone ? { phone, error: null } : { phone: null, error: `Phone "${t}" isn't a phone number with its country code` };
}

const byKey = <T extends { name: string }>(list: T[], text: string) => list.find((item) => key(item.name) === key(text));

// =====================================================================
// One file row → a contact, with the reasons it can't be imported
// =====================================================================
export function parseContact(raw: RawContact, index: number, lookups: ContactLookups): ParsedContactRow {
  const errors: string[] = [];

  // name: First name / Last name when matched, else the single Name column
  const name =
    raw.firstName !== undefined || raw.lastName !== undefined
      ? { firstName: clean(raw.firstName) || null, lastName: clean(raw.lastName) || null }
      : splitName(raw.fullName);

  let contactType: ContactType | null = null;
  const typeText = clean(raw.contactType);
  if (typeText) {
    contactType = TYPE_WORDS[key(typeText)] ?? (TYPE_WORDS[key(typeText).replace(/s$/, '')] || null);
    if (!contactType) errors.push(`Type "${typeText}" isn't Guest, Prospect, Agent contact or Influencer`);
  }

  let countryCode: string | null = null;
  const countryText = clean(raw.country);
  if (countryText) {
    countryCode = findCountry(lookups.countries, countryText) ?? null;
    if (!countryCode) errors.push(`Country "${countryText}" isn't one the CRM lists`);
  }

  let market: Market | null = null;
  const marketText = clean(raw.market);
  if (marketText) {
    market = MARKET_WORDS[key(marketText)] ?? null;
    if (!market) errors.push(`Market "${marketText}" isn't Local, Foreign or Unknown`);
  }

  let company: ParsedContact['company'] = null;
  const companyText = clean(raw.company);
  if (companyText) {
    const found = byKey(lookups.companies, companyText);
    company = found ? { id: found.id, name: found.name } : { id: null, name: companyText };
  }

  // ---- emails and phones; the same one twice in a row counts once ----
  const seen = new Set<string>();
  const once = (kind: Kind, value: string) => {
    const k = `${kind}|${matchKey(kind, value)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const readEmails = (text: string | undefined) => {
    const out: string[] = [];
    for (const v of splitList(text)) {
      const email = v.toLowerCase().replace(/^mailto:/, '');
      if (!EMAIL.test(email)) errors.push(`Email "${v}" isn't a valid address`);
      else if (once('email', email)) out.push(email);
    }
    return out;
  };
  const readPhones = (text: string | undefined) => {
    const out: string[] = [];
    for (const v of splitList(text)) {
      const { phone, error } = parseImportPhone(v);
      if (error) errors.push(error);
      else if (phone && once('phone', phone)) out.push(phone);
    }
    return out;
  };
  const emailCell = readEmails(raw.email);
  const phoneCell = readPhones(raw.phone);
  if (emailCell.length > 1) errors.push('Put one address in Email and the rest in Other emails');
  if (phoneCell.length > 1) errors.push('Put one number in Phone and the rest in Other phones');
  const emails = [...emailCell, ...readEmails(raw.otherEmails)];
  const phones = [...phoneCell, ...readPhones(raw.otherPhones)];
  const sharedEmails = readEmails(raw.sharedEmail);
  const sharedPhones = readPhones(raw.sharedPhone);

  // ---- every row needs a name, and an email or a phone ----
  const agencyName = contactType === 'agent_contact' && company;
  if (!name.firstName && !name.lastName && !agencyName) errors.push('Needs a name');
  if (!emails.length && !phones.length && !sharedEmails.length && !sharedPhones.length && !errors.some((e) => /^(Email|Phone) "/.test(e))) {
    errors.push('Needs an email or a phone');
  }

  // ---- consent ----
  const consent: ParsedContact['consent'] = {};
  for (const [channel, text, label] of [
    ['email', raw.emailMarketing, 'Email marketing'],
    ['whatsapp', raw.whatsappMarketing, 'WhatsApp marketing'],
  ] as const) {
    const choice = parseYesNo(text);
    if (choice === null) errors.push(`${label} "${clean(text)}" should be Yes, No or empty`);
    else if (choice) consent[channel] = choice;
  }

  // ---- tags and hotels: only what the CRM lists ----
  const tagIds: number[] = [];
  for (const t of splitNames(raw.tags)) {
    const tag = byKey(lookups.tags, t);
    if (!tag) errors.push(`Tag "${t}" isn't one of the CRM's tags`);
    else if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
  }
  const vipReason = clean(raw.vipReason) || null;
  if (vipReason && lookups.vipTagId && !tagIds.includes(lookups.vipTagId)) tagIds.push(lookups.vipTagId);

  const hotelIds: string[] = [];
  for (const h of splitNames(raw.hotels)) {
    const hotel = lookups.properties.find((p) => p.id.toLowerCase() === h.toLowerCase() || key(p.name) === key(h));
    if (!hotel) errors.push(`Hotel "${h}" isn't one of the CRM's hotels`);
    else if (!hotelIds.includes(hotel.id)) hotelIds.push(hotel.id);
  }

  const text = (v: string | undefined) => (v ?? '').trim() || null;
  return {
    index,
    errors,
    values: {
      ...name,
      contactType,
      countryCode,
      market,
      company,
      designation: clean(raw.jobTitle) || null,
      vipReason,
      primaryEmail: emailCell[0] ?? null,
      primaryPhone: phoneCell[0] ?? null,
      emails,
      phones,
      sharedEmails,
      sharedPhones,
      consent,
      tagIds,
      hotelIds,
      likes: text(raw.likes),
      dislikes: text(raw.dislikes),
      notes: text(raw.notes),
    },
  };
}

// =====================================================================
// What the CRM already has, loaded by the service for the file's rows
// =====================================================================
export interface ExistingMethod {
  value: string;
  isPrimary: boolean;
  isShared: boolean;
}

export interface ExistingContact {
  id: number;
  firstName: string | null;
  lastName: string | null;
  contactType: ContactType;
  lifecycleStage: LifecycleStage;
  market: Market;
  countryCode: string | null;
  companyId: number | null;
  companyName: string | null;
  designation: string | null;
  vipReason: string | null;
  doNotContact: boolean;
  emails: ExistingMethod[];
  phones: ExistingMethod[];
  consent: Record<Channel, string>; // status; 'unknown' without a row
  tagIds: number[];
  likes: string[]; // the text of every like, dislike and note
  dislikes: string[];
  notes: string[];
  hotelIds: string[]; // hotels with a live stay of any status
  checkedOutStays: number;
}

export interface ExistingContacts {
  // matchable (not shared) emails and phones → contacts that have them, oldest first
  byEmail: Map<string, number[]>;
  byPhone: Map<string, number[]>;
  contacts: Map<number, ExistingContact>;
}

// =====================================================================
// The plan
// =====================================================================
export type RowGroup = 'new' | 'existing' | 'error' | 'repeated';
export type Decision = 'ignore' | 'add' | 'update';
export type RowOutcome = 'new' | 'updated' | 'added_again' | 'ignored' | 'error';

export interface RowChoice {
  decision: Decision;
  contactId?: number; // which matched contact to update, when there are two
}

// The fields of the change log and the side-by-side comparison.
export const CHANGE_FIELDS = [
  'contact', // created: 'new' or 'added_again'
  'firstName',
  'lastName',
  'contactType',
  'lifecycleStage',
  'countryCode',
  'market',
  'company',
  'designation',
  'vipReason',
  'primaryEmail',
  'primaryPhone',
  'email', // an email added (not primary)
  'phone',
  'sharedEmail',
  'sharedPhone',
  'emailConsent',
  'whatsappConsent',
  'tag',
  'hotel', // a checked-out stay without dates
  'like',
  'dislike',
  'note',
] as const;
export type ChangeField = (typeof CHANGE_FIELDS)[number];

export interface FieldChange {
  field: ChangeField;
  old: string | null;
  new: string | null;
}

// One line of the side-by-side comparison: the CRM's value, the file's, and
// whether Update would change it. Lists (tags, hotels …) show what is added.
export interface Comparison {
  field: ChangeField;
  crm: string | null;
  file: string | null;
  changes: boolean;
}

export interface ContactMatch {
  contactId: number;
  name: string;
  by: Kind[]; // matched by email, phone or both
  doNotContact: boolean;
  comparison: Comparison[];
}

export interface PlannedContactRow {
  index: number;
  group: RowGroup;
  outcome: RowOutcome;
  errors: string[];
  warnings: string[];
  summary: { name: string; email: string | null; phone: string | null };
  matches: ContactMatch[]; // 'existing' rows only; the email match first
  decision: Decision | null; // 'existing' rows only
  contactId: number | null; // the contact updated or ignored for
}

export type CompanyRef = { id: number } | { newKey: number };

export interface MethodWrite {
  kind: Kind;
  value: string;
  isPrimary: boolean;
  isShared: boolean;
}

export interface ContactCreate {
  index: number;
  addedAgain: boolean;
  name: string;
  contact: {
    firstName: string | null;
    lastName: string | null;
    contactType: ContactType;
    lifecycleStage: LifecycleStage;
    market: Market;
    countryCode: string | null;
    designation: string | null;
    vipReason: string | null;
  };
  company: CompanyRef | null;
  methods: MethodWrite[];
  consent: { channel: Channel; status: Choice }[];
  tagIds: number[];
  hotelIds: string[];
  preferences: { kind: 'like' | 'dislike'; body: string }[];
  notes: string[];
}

export interface ContactUpdate {
  index: number;
  contactId: number;
  name: string;
  set: Partial<ContactCreate['contact']>;
  company: CompanyRef | undefined; // undefined: unchanged
  // the value that becomes primary; onFile: already one of the contact's emails or phones
  primary: { kind: Kind; value: string; onFile: boolean }[];
  methods: MethodWrite[]; // added, never primary
  consent: { channel: Channel; status: Choice }[];
  tagIds: number[];
  hotelIds: string[];
  preferences: { kind: 'like' | 'dislike'; body: string }[];
  notes: string[];
  changes: FieldChange[];
}

export interface ContactImportSummary {
  rows: number;
  groups: Record<RowGroup, number>;
  outcomes: Record<RowOutcome, number>;
  // what the confirm step warns about
  changedContacts: number; // existing contacts that will change
  primaryChanges: number; // existing contacts whose primary email or phone moves
  optedBackIn: Record<Channel, number>; // opted out in the CRM, Yes in the file
  optedOut: Record<Channel, number>; // opted in in the CRM, No in the file
  doNotContactOptIns: number; // Yes for a do-not-contact guest: recorded, still blocked
  newCompanies: string[];
}

export interface ContactImportPlan {
  rows: PlannedContactRow[];
  creates: ContactCreate[];
  updates: ContactUpdate[];
  newCompanies: { key: number; name: string }[];
  doNotContact: number[]; // existing do-not-contact guests the file opts in
  summary: ContactImportSummary;
}

const displayName = (p: { firstName: string | null; lastName: string | null }, fallback: string) =>
  [p.firstName, p.lastName].filter(Boolean).join(' ') || fallback;

const textKey = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();

// Rows are planned in file order. `choices` holds the admin's decision for
// rows already in the CRM, by row index; without one a row is ignored, so no
// existing contact changes unless the admin chooses it.
export function planContactImport(
  parsed: ParsedContactRow[],
  existing: ExistingContacts,
  lookups: ContactLookups,
  choices: ReadonlyMap<number, RowChoice> = new Map(),
): ContactImportPlan {
  const plan: ContactImportPlan = {
    rows: [],
    creates: [],
    updates: [],
    newCompanies: [],
    doNotContact: [],
    summary: {
      rows: parsed.length,
      groups: { new: 0, existing: 0, error: 0, repeated: 0 },
      outcomes: { new: 0, updated: 0, added_again: 0, ignored: 0, error: 0 },
      changedContacts: 0,
      primaryChanges: 0,
      optedBackIn: { email: 0, whatsapp: 0 },
      optedOut: { email: 0, whatsapp: 0 },
      doNotContactOptIns: 0,
      newCompanies: [],
    },
  };
  const firstRowWith = new Map<string, number>(); // `${kind}|${key}` → first row number in the file
  const updatedBy = new Map<number, number>(); // contact id → the row that updates it
  const newCompanyByName = new Map<string, number>(); // lower-case name → key
  const hotelName = (id: string) => lookups.properties.find((p) => p.id === id)?.name ?? id;
  const tagName = (id: number) => lookups.tags.find((t) => t.id === id)?.name ?? `#${id}`;

  const companyRef = (company: ParsedContact['company']): CompanyRef | null => {
    if (!company) return null;
    if (company.id !== null) return { id: company.id };
    const k = company.name.toLowerCase();
    let newKey = newCompanyByName.get(k);
    if (newKey === undefined) {
      newKey = plan.newCompanies.length;
      plan.newCompanies.push({ key: newKey, name: company.name });
      newCompanyByName.set(k, newKey);
    }
    return { newKey };
  };

  for (const row of parsed) {
    const v = row.values;
    const planned: PlannedContactRow = {
      index: row.index,
      group: 'error',
      outcome: 'error',
      errors: [...row.errors],
      warnings: [],
      summary: {
        name: displayName(v, v.company?.name ?? ''),
        email: v.emails[0] ?? v.sharedEmails[0] ?? null,
        phone: v.phones[0] ?? v.sharedPhones[0] ?? null,
      },
      matches: [],
      decision: null,
      contactId: null,
    };
    plan.rows.push(planned);

    // ---- repeated in this file: a personal email or phone on an earlier row ----
    const keys = [
      ...v.emails.map((e) => ['email', matchKey('email', e)] as const),
      ...v.phones.map((p) => ['phone', matchKey('phone', p)] as const),
    ];
    const repeats: string[] = [];
    for (const [kind, k] of keys) {
      const first = firstRowWith.get(`${kind}|${k}`);
      if (first !== undefined) repeats.push(`Same ${kind} as row ${first}`);
      else firstRowWith.set(`${kind}|${k}`, row.index + 1);
    }
    if (planned.errors.length) {
      plan.summary.groups.error++;
      continue;
    }
    if (repeats.length) {
      planned.group = 'repeated';
      planned.errors.push(...new Set(repeats));
      plan.summary.groups.repeated++;
      continue;
    }

    // ---- find the contact: email, then phone; never by name, never shared ----
    const byEmail = [...new Set(v.emails.flatMap((e) => existing.byEmail.get(matchKey('email', e)) ?? []))];
    const byPhone = [...new Set(v.phones.flatMap((p) => existing.byPhone.get(matchKey('phone', p)) ?? []))];
    const matchIds = [...new Set([...byEmail, ...byPhone])].filter((id) => existing.contacts.has(id));

    if (!matchIds.length) {
      planned.group = 'new';
      planned.outcome = 'new';
      plan.summary.groups.new++;
      plan.creates.push(createFor(row, v, false, companyRef));
      continue;
    }

    planned.group = 'existing';
    plan.summary.groups.existing++;
    planned.matches = matchIds.map((id) => {
      const c = existing.contacts.get(id)!;
      const by: Kind[] = [];
      if (byEmail.includes(id)) by.push('email');
      if (byPhone.includes(id)) by.push('phone');
      return {
        contactId: id,
        name: displayName(c, c.companyName ?? `Contact #${id}`),
        by,
        doNotContact: c.doNotContact,
        comparison: compare(c, v, hotelName, tagName),
      };
    });
    if (byEmail.length && byPhone.length && byPhone.some((id) => !byEmail.includes(id))) {
      planned.warnings.push('The email belongs to one contact and the phone to another: choose which to update');
    } else if (matchIds.length > 1) {
      planned.warnings.push(`${matchIds.length} contacts have this ${byEmail.length > 1 ? 'email' : 'phone'}`);
    }

    const choice = choices.get(row.index) ?? { decision: 'ignore' as const };
    planned.decision = choice.decision;
    if (choice.decision === 'ignore') {
      planned.outcome = 'ignored';
      planned.contactId = matchIds[0];
      continue;
    }
    if (choice.decision === 'add') {
      planned.outcome = 'added_again';
      plan.creates.push(createFor(row, v, true, companyRef));
      continue;
    }

    // ---- update: the file has priority ----
    const targetId = choice.contactId !== undefined && matchIds.includes(choice.contactId) ? choice.contactId : matchIds[0];
    planned.contactId = targetId;
    const earlier = updatedBy.get(targetId);
    if (earlier !== undefined) {
      planned.decision = 'ignore';
      planned.outcome = 'ignored';
      planned.warnings.push(`Row ${earlier} already updates this contact; this row is ignored. Merge the two rows in the file`);
      continue;
    }
    updatedBy.set(targetId, row.index + 1);
    const contact = existing.contacts.get(targetId)!;
    const update = updateFor(row, v, contact, companyRef, hotelName, tagName);
    planned.outcome = 'updated';
    if (!update.changes.length) planned.warnings.push('Nothing to change: the CRM already has these values');
    if (update.consent.some((c) => c.status === 'opted_in') && contact.doNotContact) {
      planned.warnings.push('On do not contact: the opt-in is recorded, but they stay blocked');
      plan.doNotContact.push(targetId);
    }
    plan.updates.push(update);
  }

  // ---- the numbers for the confirm step ----
  const s = plan.summary;
  for (const r of plan.rows) s.outcomes[r.outcome]++;
  for (const u of plan.updates) {
    if (u.changes.length) s.changedContacts++;
    if (u.primary.length) s.primaryChanges++;
    for (const c of u.changes) {
      const channel = c.field === 'emailConsent' ? 'email' : c.field === 'whatsappConsent' ? 'whatsapp' : null;
      if (!channel) continue;
      if (c.new === 'opted_in' && c.old === 'opted_out') s.optedBackIn[channel]++;
      if (c.new === 'opted_out' && c.old === 'opted_in') s.optedOut[channel]++;
    }
  }
  s.doNotContactOptIns = plan.doNotContact.length;
  s.newCompanies = plan.newCompanies.map((c) => c.name);
  return plan;
}

// A new contact from the row, as one added in the app would be: the first
// email and phone primary (a shared one only if there's no personal one),
// stage from the type, market from the country unless given.
function createFor(
  row: ParsedContactRow,
  v: ParsedContact,
  addedAgain: boolean,
  companyRef: (c: ParsedContact['company']) => CompanyRef | null,
): ContactCreate {
  const contactType = v.contactType ?? 'lead';
  const methods: MethodWrite[] = [];
  for (const [kind, personal, shared] of [
    ['email', v.emails, v.sharedEmails],
    ['phone', v.phones, v.sharedPhones],
  ] as const) {
    for (const value of personal) methods.push({ kind, value, isPrimary: !methods.some((m) => m.kind === kind), isShared: false });
    for (const value of shared) methods.push({ kind, value, isPrimary: !methods.some((m) => m.kind === kind), isShared: true });
  }
  return {
    index: row.index,
    addedAgain,
    name: displayName(v, v.company?.name ?? v.emails[0] ?? v.phones[0] ?? 'New contact'),
    contact: {
      firstName: v.firstName,
      lastName: v.lastName,
      contactType,
      lifecycleStage: initialStage(contactType),
      market: v.market ?? marketForCountry(v.countryCode),
      countryCode: v.countryCode,
      designation: v.designation,
      vipReason: v.vipReason,
    },
    company: companyRef(v.company),
    methods,
    consent: Object.entries(v.consent).map(([channel, status]) => ({ channel: channel as Channel, status })),
    tagIds: v.tagIds,
    hotelIds: v.hotelIds,
    preferences: [
      ...(v.likes ? [{ kind: 'like' as const, body: v.likes }] : []),
      ...(v.dislikes ? [{ kind: 'dislike' as const, body: v.dislikes }] : []),
    ],
    notes: v.notes ? [v.notes] : [],
  };
}

// Update: every filled cell replaces the CRM's value; empty cells change
// nothing. The file's email and phone become primary and the old ones stay as
// extras. Consent follows the file. Tags, hotels, likes, dislikes and notes
// are added when new. Every change is listed with its old value.
function updateFor(
  row: ParsedContactRow,
  v: ParsedContact,
  c: ExistingContact,
  companyRef: (company: ParsedContact['company']) => CompanyRef | null,
  hotelName: (id: string) => string,
  tagName: (id: number) => string,
): ContactUpdate {
  const u: ContactUpdate = {
    index: row.index,
    contactId: c.id,
    name: displayName(c, c.companyName ?? `Contact #${c.id}`),
    set: {},
    company: undefined,
    primary: [],
    methods: [],
    consent: [],
    tagIds: [],
    hotelIds: [],
    preferences: [],
    notes: [],
    changes: [],
  };
  const change = (field: ChangeField, old: string | null, value: string | null) => u.changes.push({ field, old, new: value });

  for (const field of ['firstName', 'lastName', 'designation', 'vipReason', 'countryCode'] as const) {
    if (v[field] && v[field] !== c[field]) {
      u.set[field] = v[field];
      change(field, c[field], v[field]);
    }
  }
  // market as given, else following a new country (as the guest form does)
  const market = v.market ?? (u.set.countryCode ? marketForCountry(u.set.countryCode) : null);
  if (market && market !== c.market) {
    u.set.market = market;
    change('market', c.market, market);
  }
  if (v.contactType && v.contactType !== c.contactType) {
    u.set.contactType = v.contactType;
    change('contactType', c.contactType, v.contactType);
    const stage = stageAfterTypeChange(c.lifecycleStage, v.contactType, c.checkedOutStays);
    if (stage) {
      u.set.lifecycleStage = stage;
      change('lifecycleStage', c.lifecycleStage, stage);
    }
  }
  if (v.company && (v.company.id === null || v.company.id !== c.companyId)) {
    u.company = companyRef(v.company)!;
    change('company', c.companyName, v.company.name);
  }

  // ---- emails and phones ----
  for (const [kind, primaryValue, personal, shared, onFile] of [
    ['email', v.primaryEmail, v.emails, v.sharedEmails, c.emails],
    ['phone', v.primaryPhone, v.phones, v.sharedPhones, c.phones],
  ] as const) {
    const known = new Set(onFile.map((m) => matchKey(kind, m.value)));
    const current = onFile.find((m) => m.isPrimary) ?? null;
    if (primaryValue && (!current || matchKey(kind, current.value) !== matchKey(kind, primaryValue))) {
      u.primary.push({ kind, value: primaryValue, onFile: known.has(matchKey(kind, primaryValue)) });
      change(kind === 'email' ? 'primaryEmail' : 'primaryPhone', current?.value ?? null, primaryValue);
      known.add(matchKey(kind, primaryValue));
    }
    for (const [values, isShared] of [
      [personal, false],
      [shared, true],
    ] as const) {
      for (const value of values) {
        if (known.has(matchKey(kind, value))) continue;
        known.add(matchKey(kind, value));
        u.methods.push({ kind, value, isPrimary: false, isShared });
        change(isShared ? (kind === 'email' ? 'sharedEmail' : 'sharedPhone') : kind, null, value);
      }
    }
  }

  // ---- consent follows the file; the same choice changes nothing ----
  for (const [channel, status] of Object.entries(v.consent) as [Channel, Choice][]) {
    if (c.consent[channel] === status) continue;
    u.consent.push({ channel, status });
    change(channel === 'email' ? 'emailConsent' : 'whatsappConsent', c.consent[channel], status);
  }

  // ---- added, never removed ----
  for (const id of v.tagIds) {
    if (c.tagIds.includes(id)) continue;
    u.tagIds.push(id);
    change('tag', null, tagName(id));
  }
  for (const id of v.hotelIds) {
    if (c.hotelIds.includes(id)) continue;
    u.hotelIds.push(id);
    change('hotel', null, hotelName(id));
  }
  for (const [kind, text, onFile] of [
    ['like', v.likes, c.likes],
    ['dislike', v.dislikes, c.dislikes],
  ] as const) {
    if (!text || onFile.some((t) => textKey(t) === textKey(text))) continue;
    u.preferences.push({ kind, body: text });
    change(kind, null, text);
  }
  if (v.notes && !c.notes.some((t) => textKey(t) === textKey(v.notes!))) {
    u.notes.push(v.notes);
    change('note', null, v.notes);
  }
  return u;
}

// The side-by-side comparison for one matched contact: every field the row
// fills, with the CRM's value, and whether Update would change it.
function compare(
  c: ExistingContact,
  v: ParsedContact,
  hotelName: (id: string) => string,
  tagName: (id: number) => string,
): Comparison[] {
  const update = updateFor({ index: 0, values: v, errors: [] }, v, c, () => ({ newKey: -1 }), hotelName, tagName);
  const changed = new Set(update.changes.map((ch) => ch.field));
  const list = (values: string[]) => values.join('; ') || null;
  const primary = (methods: ExistingMethod[]) => methods.find((m) => m.isPrimary)?.value ?? null;
  const others = (methods: ExistingMethod[], shared: boolean) =>
    list(methods.filter((m) => !m.isPrimary && m.isShared === shared).map((m) => m.value));

  const lines: [ChangeField, string | null, string | null][] = [
    ['firstName', c.firstName, v.firstName],
    ['lastName', c.lastName, v.lastName],
    ['contactType', c.contactType, v.contactType],
    ['lifecycleStage', c.lifecycleStage, update.set.lifecycleStage ?? null],
    ['countryCode', c.countryCode, v.countryCode],
    ['market', c.market, update.set.market ?? v.market],
    ['company', c.companyName, v.company?.name ?? null],
    ['designation', c.designation, v.designation],
    ['vipReason', c.vipReason, v.vipReason],
    ['primaryEmail', primary(c.emails), v.primaryEmail],
    ['primaryPhone', primary(c.phones), v.primaryPhone],
    ['email', others(c.emails, false), list(v.emails.filter((e) => e !== v.primaryEmail))],
    ['phone', others(c.phones, false), list(v.phones.filter((p) => p !== v.primaryPhone))],
    ['sharedEmail', others(c.emails, true), list(v.sharedEmails)],
    ['sharedPhone', others(c.phones, true), list(v.sharedPhones)],
    ['emailConsent', c.consent.email, v.consent.email ?? null],
    ['whatsappConsent', c.consent.whatsapp, v.consent.whatsapp ?? null],
    ['tag', list(c.tagIds.map(tagName)), list(v.tagIds.map(tagName))],
    ['hotel', list(c.hotelIds.map(hotelName)), list(v.hotelIds.map(hotelName))],
    ['like', list(c.likes), v.likes],
    ['dislike', list(c.dislikes), v.dislikes],
    ['note', null, v.notes],
  ];
  // what the file fills, plus the name so there is always something to compare
  return lines
    .filter(([field, , file]) => file !== null || field === 'firstName' || field === 'lastName')
    .map(([field, crm, file]) => ({ field, crm, file, changes: changed.has(field) }));
}

// What each outcome is called in the result file and the history.
export const OUTCOME_TEXT: Record<RowOutcome, string> = {
  new: 'New contact',
  updated: 'Updated',
  added_again: 'Added again',
  ignored: 'Ignored',
  error: 'Not imported',
};
