import { parsePhoneNumberFromString } from 'libphonenumber-js';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import { formatPhone, matchKey } from '../../guests/guest-rules.js';
import { splitName } from '../../stays/imports/booking-import-rules.js';
import type {
  COMPANY_STATUSES,
  COMPANY_TYPES,
  CONSENT_STATUSES,
  CONTACT_TYPES,
  LIFECYCLE_STAGES,
  MARKETS,
  STAY_CHANNELS,
} from '../schema/index.js';
import { COUNTRIES } from './countries.js';

// =====================================================================
// MASTER GUEST LIST – "Nyne Master Database.xlsx" read into CRM rows.
// No database here: master-import.ts loads what the CRM has, calls
// planMasterImport() and saves the plan in one transaction.
//
// The workbook's own total of 7,289 contacts is three tabs:
//   Master - Everything     one row per person: guests, website contacts,
//                           B2B agents and influencers, duplicates merged
//   Travel Agents (SL)      one row per Sri Lankan agency or DMC
//   Foreign Tour Operators  one row per overseas tour operator
// The other tabs are slices of the Master (mailable, foreign, repeat …), apart
// from Needs Checking, whose unusable emails become data issues.
// =====================================================================

type ContactType = (typeof CONTACT_TYPES)[number];
type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
type Market = (typeof MARKETS)[number];
type ConsentStatus = (typeof CONSENT_STATUSES)[number];
type Channel = (typeof STAY_CHANNELS)[number];
type CompanyType = (typeof COMPANY_TYPES)[number];
type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const MASTER_TAB = 'Master - Everything';
export const AGENTS_TAB = 'Travel Agents (SL)';
export const OPERATORS_TAB = 'Foreign Tour Operators';
export const CHECKS_TAB = 'Needs Checking';

export interface SourceRow {
  tab: string;
  row: number; // the row number Excel shows
}

export interface Problem {
  problem: string;
  value: string | null;
}

export interface PlannedMethod {
  kind: 'email' | 'phone';
  value: string; // email lower-case, phone in the international form
  isPrimary: boolean;
  isShared: boolean;
}

export interface PlannedStay {
  propertyId: string;
  arrivalDate: string | null; // 'YYYY-MM-DD', only for the stay a 2018 guest log dates
  channel: Channel;
  inGuestLog: boolean; // the stay the 2018 guest log describes (its likes and dislikes)
}

export interface PlannedContact {
  source: SourceRow;
  name: string | null; // as listed, for the report
  firstName: string | null;
  lastName: string | null;
  contactType: ContactType;
  lifecycleStage: LifecycleStage;
  market: Market;
  countryCode: string | null;
  designation: string | null;
  vipReason: string | null;
  companyKey: string | null;
  methods: PlannedMethod[];
  emailConsent: {
    status: ConsentStatus;
    source: 'wix';
    evidence: string;
  } | null; // null: unknown
  stays: PlannedStay[];
  preferences: {
    kind: 'like' | 'dislike';
    body: string;
    onLoggedStay: boolean;
  }[];
  notes: string[];
  tags: string[]; // tag names
  dataIssues: {
    field: 'email' | 'phone';
    rawValue: string;
    issue: string;
    suggestedFix: string | null;
  }[];
  problems: Problem[]; // for the report; the contact is loaded anyway
}

export interface PlannedCompany {
  key: string; // companyKey(name)
  source: SourceRow;
  name: string;
  companyType: CompanyType;
  countryCode: string | null;
  address: string | null;
  status: CompanyStatus;
  notes: string[];
}

// A row that didn't become a contact, with its own cells for the report.
export interface SkippedRow {
  source: SourceRow;
  name: string | null;
  email: string | null;
  phone: string | null;
  reason: string;
  details: string | null;
}

export interface MasterPlan {
  contacts: PlannedContact[];
  companies: PlannedCompany[];
  skipped: SkippedRow[];
}

export interface PlanLookups {
  properties: { id: string; name: string }[];
  countryCodes: ReadonlySet<string>;
}

// =====================================================================
// Reading cells
// =====================================================================
type Cells = Record<string, unknown>;

export function text(v: unknown): string | null {
  if (v == null) return null;
  const t = (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

// 'a@x.com; b@y.com' → ['a@x.com', 'b@y.com']
const list = (v: unknown) =>
  (text(v) ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

const MASTER_COLUMNS = [
  'Name',
  'Email',
  'Other emails',
  'Phone',
  'Other phones',
  'Category',
  'Market',
  'Market basis',
  'Channel',
  'Channel (as logged)',
  'Properties',
  'Repeat / multi-property',
  'Last stay (2018 logs)',
  'Trade / VIP',
  'Company',
  'Designation',
  'Likes',
  'Dislikes',
  'Notes',
  'Address',
  'Shared email (agent / office / family)',
  'Shared phone (agent / office)',
  'Phone issues',
  'Wix subscriber status',
  'Sources',
  'Source rows',
];
const AGENT_COLUMNS = [
  'Company',
  'Grade',
  'Location',
  'Address',
  'Email',
  'Other emails',
  'Phone',
  'Other phones',
  'Seasons ticked',
  'Latest season ticked',
  'Also in B2B Agents (contacts)',
  'Issues / to check',
];
const OPERATOR_COLUMNS = [
  'Company',
  'Country',
  'Contact person',
  'Email',
  'Other emails',
  'Phone',
  'Other phones',
  'Address',
  'Category % (as listed)',
  'Wellness list',
  'Also in B2B Agents (contacts)',
  'Issues / to check',
];
const CHECK_COLUMNS = [
  'Name',
  'Logged as',
  'Status',
  'Note / suggested fix',
  'Used',
  'Source',
];

// Rows of a tab as heading → cell, with the row number Excel shows. Blank rows are left out.
export function readTab(
  wb: XLSX.WorkBook,
  tab: string,
  columns: string[],
): { row: number; cells: Cells }[] {
  const ws = wb.Sheets[tab];
  if (!ws?.['!ref']) throw new Error(`The workbook has no "${tab}" tab`);
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    blankrows: true,
    raw: true,
  });
  const firstRow = XLSX.utils.decode_range(ws['!ref']).s.r + 1;
  const headings = (grid[0] ?? []).map((h) => text(h) ?? '');
  const missing = columns.filter((c) => !headings.includes(c));
  if (missing.length)
    throw new Error(
      `The "${tab}" tab has no ${missing.map((c) => `"${c}"`).join(', ')} column`,
    );
  return grid.slice(1).flatMap((values, i) => {
    if (!values.some((v) => text(v))) return [];
    return [
      {
        row: firstRow + 1 + i,
        cells: Object.fromEntries(headings.map((h, j) => [h, values[j]])),
      },
    ];
  });
}

// =====================================================================
// Hotels and stays
// =====================================================================
// The PMS sheet calls Mayur Lodge "Mayur".
const HOTEL_ALIASES: Record<string, string> = { Mayur: 'Mayur Lodge' };

// Entries in the Properties column that don't name a hotel. Guests with only
// these get the 'stayed_hotel_unknown' stage, and the entry goes in a note.
const NOT_A_HOTEL: Record<string, string> = {
  'Taru Villas':
    'On the Taru Villas (Divan) guest list, which does not say which hotel',
  'Unnamed property – Bentota area (Guest_Log.xlsx)':
    'Stayed at an unnamed hotel in the Bentota area (2018 guest log Guest_Log.xlsx)',
  'Unnamed property (Guest_Log_-_December.xlsx)':
    'Stayed at an unnamed 4-room hotel (2018 guest log Guest_Log_-_December.xlsx)',
};

// Each 2018 guest log was kept at one hotel (as the Properties column names it).
// The log's last-stay date and booking channel belong to that hotel's stay.
const GUEST_LOG_HOTELS: Record<string, string> = {
  'Guest_Log_RV.xlsx': 'Rock Villa',
  'Guest_Log_December_.xlsx': 'Rock Villa',
  '1._Lake_Lodge.xlsx': 'Lake Lodge',
  'Guest_Log_December.xlsx': 'The Long House',
  'Guest_Log_December_1.xlsx': 'Taru Villas Yala',
  'Guest_Log.xlsx': 'Unnamed property – Bentota area (Guest_Log.xlsx)',
  'Guest_Log_-_December.xlsx': 'Unnamed property (Guest_Log_-_December.xlsx)',
};

// The one hotel the person's 2018 guest logs were kept at; null when there are none, or several.
// 'Guest_Log_RV.xlsx › Sheet1 › row 39 ; Data Base – October 26.xlsx › …' → 'Rock Villa'
export function guestLogHotel(sourceRows: string | null): string | null {
  const files = (sourceRows ?? '')
    .split(';')
    .map((s) => s.split('›')[0].trim());
  const hotels = new Set(files.map((f) => GUEST_LOG_HOTELS[f]).filter(Boolean));
  return hotels.size === 1 ? [...hotels][0] : null;
}

const CHANNELS: Record<string, Channel> = {
  'Direct / FIT': 'direct',
  'Travel agent': 'travel_agent',
  OTA: 'ota',
  "Owner's guest / friends & family": 'owner_guest',
  'Online – source unclear': 'online_unclear',
};

// The Channel column (2018 guest logs only) → the stay's channel. 'OTA + Direct / FIT' is mixed.
export function stayChannel(v: string | null): Channel {
  if (!v) return 'unknown';
  if (v.includes(' + ')) return 'mixed';
  return CHANNELS[v] ?? 'unknown';
}

// "Channel (as logged)" without the entries that only say which list the row came from.
// 'PMS export | Jetwing travels' → 'Jetwing travels'
export function loggedChannel(v: string | null): string | null {
  const parts = (v ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(
      (s) =>
        s && s !== 'PMS export' && s !== 'Locals list' && !s.startsWith('Wix:'),
    );
  return parts.join('; ') || null;
}

const formatDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

// =====================================================================
// Country and market
// =====================================================================
const COUNTRY_NAMES = new Map(
  COUNTRIES.map(([code, name]) => [name.toLowerCase(), code]),
);
// Spellings in the workbook that differ from the CRM's country names, and
// what the 2018 guest logs say about where someone is from.
const COUNTRY_ALIASES: Record<string, string> = {
  uk: 'GB',
  usa: 'US',
  uae: 'AE',
  'hong kong': 'HK',
  'india (cochin)': 'IN',
  'russian federation': 'RU',
  myanmar: 'MM',
  'korea, republic of': 'KR',
  'taiwan, province of china': 'TW',
  'viet nam': 'VN',
  macao: 'MO',
  england: 'GB',
  british: 'GB',
  australian: 'AU',
  australi: 'AU',
  canadian: 'CA',
  indian: 'IN',
  czech: 'CZ',
  'outbound travel agent in belgium': 'BE',
  'lives in mumbai': 'IN',
  'lives in dubai': 'AE',
  'work and lives in dubai': 'AE',
  'lives in singapoore': 'SG',
};
const KNOWN_DOMAINS: Record<string, string> = { 'btinternet.com': 'GB' };

export const countryByName = (name: string) => {
  const key = name.trim().toLowerCase();
  return COUNTRY_ALIASES[key] ?? COUNTRY_NAMES.get(key) ?? null;
};

// 'btinternet.com – UK' → GB, '.uk' → GB, 'gmx.de' → DE
function countryFromDomain(v: string): string | null {
  const dash = /\s–\s(.+)$/.exec(v);
  if (dash) return countryByName(dash[1]);
  if (KNOWN_DOMAINS[v]) return KNOWN_DOMAINS[v];
  const tld = v.split('.').pop()!.toLowerCase();
  if (tld.length !== 2) return null;
  return tld === 'uk' ? 'GB' : tld.toUpperCase();
}

// The country from the "Market basis" column, which says how the market was
// worked out. Guesses from a name ("likely – not confirmed") give no country.
// The Locals sheet marks residents, so a foreign phone there is an expat's
// home country and the market stays local.
export function countryFromBasis(
  basis: string | null,
  phoneCountry: string | null,
): string | null {
  if (!basis) return phoneCountry;
  let m = /^Phone country code \((.+)\)$/.exec(basis);
  if (m) return countryByName(m[1]) ?? phoneCountry;
  if (basis === "Listed on the 'Locals' sheet") return phoneCountry ?? 'LK';
  if (basis === 'Sri Lanka-based agency') return 'LK';
  m = /^Address country \((.+)\)$/.exec(basis);
  if (m) return countryByName(m[1]);
  m = /^Stated in guest log \("(.+)"\)$/.exec(basis);
  if (m) return countryByName(m[1]);
  m = /^Email domain \((.+)\)$/.exec(basis);
  if (m) return countryFromDomain(m[1]);
  return null;
}

const MARKETS_BY_LABEL: Record<string, Market> = {
  Local: 'local',
  Foreign: 'foreign',
  Unknown: 'unknown',
};

// =====================================================================
// Contact details
// =====================================================================
const emailSchema = z.email();

// A guest's address at a travel agency is the agent's (info@, or a colleague's
// name), unless it carries the guest's own name: bandula@jetwing.lk for Bandula Withana.
export function isOwnAddress(email: string, name: string | null): boolean {
  const local = email.split('@')[0].toLowerCase();
  return (name ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((word) => word.length >= 3 && local.includes(word));
}

export function cleanEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return emailSchema.safeParse(value).success ? value : null;
}

// Emails and phones for one person: no repeats (ignoring case and spacing),
// and the first of each kind is primary, so personal ones go in first.
class ContactDetails {
  readonly methods: PlannedMethod[] = [];
  readonly problems: Problem[] = [];

  constructor(private readonly defaultCountry?: string) {}

  add(kind: 'email' | 'phone', raw: string, isShared: boolean) {
    const value =
      kind === 'email'
        ? cleanEmail(raw)
        : formatPhone(raw, this.defaultCountry);
    if (!value) {
      this.problems.push({
        problem:
          kind === 'email'
            ? 'Not a valid email – left out'
            : 'Not a valid phone number – left out',
        value: raw,
      });
      return;
    }
    const same = this.methods.find(
      (m) =>
        m.kind === kind && matchKey(kind, m.value) === matchKey(kind, value),
    );
    if (same) {
      same.isShared ||= isShared;
      return;
    }
    this.methods.push({
      kind,
      value,
      isShared,
      isPrimary: !this.methods.some((m) => m.kind === kind),
    });
  }

  get phoneCountry(): string | null {
    const phone = this.methods.find((m) => m.kind === 'phone');
    return (phone && parsePhoneNumberFromString(phone.value)?.country) ?? null;
  }
}

// '"+62 2035640799" – not a valid number in any format tried; "…" – …' → each number and what was wrong
export function phoneIssues(
  v: string | null,
): { rawValue: string; issue: string }[] {
  return [...(v ?? '').matchAll(/"([^"]*)"\s*–\s*([^;]+)/g)].map((m) => ({
    rawValue: m[1],
    issue: m[2].trim(),
  }));
}

// =====================================================================
// Master rows
// =====================================================================
const CATEGORY_TYPES: Record<string, ContactType> = {
  Guest: 'guest',
  'Website contact': 'lead',
  'B2B agent': 'agent_contact',
  Influencer: 'influencer',
};

// "Trade / VIP" → the VIP reason, leaving out what other fields already say.
export function vipReason(v: string | null): string | null {
  if (!v) return null;
  if (v.startsWith('B2B –')) return null; // company and designation
  if (v.startsWith('Only email on file is shared')) return null; // the email is marked shared
  if (v.startsWith('Influencer / creator')) return null; // the contact type, and a note
  return v;
}

const WIX_CONSENT: Record<string, ConsentStatus> = {
  Subscribed: 'opted_in',
  Unsubscribed: 'opted_out',
  'Never subscribed': 'not_opted_in',
};

// Room blocks and groups entered as guests, for staff to check (Module 2: delete junk records).
const LOOKS_LIKE_A_BLOCK = /\b(blocked for|block by|meeting)\b|\bgroup$/i;

export const companyKey = (name: string) =>
  name.replace(/\s+/g, ' ').trim().toLowerCase();

export function planMasterImport(
  wb: XLSX.WorkBook,
  lookups: PlanLookups,
): MasterPlan {
  const master = readTab(wb, MASTER_TAB, MASTER_COLUMNS);
  const agencies = readTab(wb, AGENTS_TAB, AGENT_COLUMNS);
  const operators = readTab(wb, OPERATORS_TAB, OPERATOR_COLUMNS);
  const checks = readTab(wb, CHECKS_TAB, CHECK_COLUMNS);

  const contacts: PlannedContact[] = [];
  const skipped: SkippedRow[] = [];
  const companies = new Map<string, PlannedCompany>();

  const hotelIds = new Map(
    lookups.properties.map((p) => [p.name.toLowerCase(), p.id]),
  );
  const hotelId = (name: string) =>
    hotelIds.get((HOTEL_ALIASES[name] ?? name).toLowerCase()) ?? null;
  const country = (code: string | null) =>
    code && lookups.countryCodes.has(code) ? code : null;

  // ---------- companies from the travel trade tabs ----------
  // One company per name; a second row with the same name adds its notes.
  function addCompany(c: Omit<PlannedCompany, 'key'>): PlannedCompany {
    const key = companyKey(c.name);
    const existing = companies.get(key);
    if (!existing) {
      const company = { ...c, key };
      companies.set(key, company);
      return company;
    }
    existing.address ??= c.address;
    existing.countryCode ??= c.countryCode;
    existing.notes.push(...c.notes);
    return existing;
  }

  // B2B agents (Master rows) the trade tabs name as working at one of their companies.
  const companyOfB2bPerson = new Map<string, string>();
  // Agency emails, to spot guests whose only email is their agent's.
  const agencyEmails = new Map<string, string>();

  function tradeCompany(
    tab: string,
    row: number,
    cells: Cells,
    init: Pick<
      PlannedCompany,
      'companyType' | 'countryCode' | 'address' | 'status'
    >,
    notes: (string | null)[],
  ) {
    const company = addCompany({
      source: { tab, row },
      name: text(cells.Company)!,
      ...init,
      notes: [],
    });
    const lines = notes.filter((n): n is string => !!n);
    if (lines.length)
      company.notes.push(
        `From the TA & TO database (${tab} tab):\n${lines.map((l) => `• ${l}`).join('\n')}`,
      );
    for (const person of (
      text(cells['Also in B2B Agents (contacts)']) ?? ''
    ).split(',')) {
      if (person.trim())
        companyOfB2bPerson.set(person.trim().toLowerCase(), company.key);
    }
    for (const email of [text(cells.Email), ...list(cells['Other emails'])]) {
      const value = email && cleanEmail(email);
      if (value && !agencyEmails.has(value))
        agencyEmails.set(value, company.name);
    }
    return company;
  }

  const agencyCompanies = agencies.map(({ row, cells }) => {
    if (!text(cells.Company)) return null;
    const address = text(cells.Address);
    const location = text(cells.Location);
    const issues = text(cells['Issues / to check']);
    return tradeCompany(
      AGENTS_TAB,
      row,
      cells,
      {
        companyType: 'travel_agent',
        countryCode: 'LK',
        address: address ?? location,
        // a contract season ticked (all of them run to 24 S) means they work with us
        status: text(cells['Latest season ticked']) ? 'active' : 'prospect',
      },
      [
        text(cells.Grade) && `Grade ${text(cells.Grade)}`,
        address && location && `Location: ${location}`,
        `Contract seasons ticked: ${text(cells['Seasons ticked']) ?? 'None'}`,
        issues && `To check: ${issues}`,
      ],
    );
  });

  const operatorCompanies = operators.map(({ row, cells }) => {
    if (!text(cells.Company)) return null;
    const share = cells['Category % (as listed)'];
    const issues = text(cells['Issues / to check']);
    return tradeCompany(
      OPERATORS_TAB,
      row,
      cells,
      {
        companyType: 'outbound_agent',
        countryCode: country(countryByName(text(cells.Country) ?? '')),
        address: text(cells.Address),
        status: 'active',
      },
      [
        text(cells['Wellness list']) === 'Yes'
          ? 'On the Wellness FTOs list'
          : null,
        typeof share === 'number'
          ? `Category: ${Math.round(share * 100)}%`
          : text(share) && `Category: ${text(share)}`,
        issues && `To check: ${issues}`,
      ],
    );
  });

  // ---------- Needs Checking: unusable emails, by the source row they came from ----------
  // Unusable phones are in the Master's own "Phone issues" column.
  const emailChecks = checks.filter(
    ({ cells }) => text(cells.Status) !== 'Phone unusable',
  );
  const contactBySourceRow = new Map<string, PlannedContact>();
  const skippedBySourceRow = new Map<string, SkippedRow>();

  // ---------- Master - Everything ----------
  for (const { row, cells } of master) {
    const source = { tab: MASTER_TAB, row };
    const name = text(cells.Name);
    const category = text(cells.Category) ?? '';
    const contactType = CATEGORY_TYPES[category];
    const skip = (reason: string) =>
      skipped.push({
        source,
        name,
        email: text(cells.Email),
        phone: text(cells.Phone),
        reason,
        details:
          [text(cells.Category), text(cells.Properties), text(cells.Sources)]
            .filter(Boolean)
            .join(' · ') || null,
      });
    if (!contactType) {
      skip(`Unknown category "${category}"`);
      continue;
    }
    const isAgent = contactType === 'agent_contact';
    const problems: Problem[] = [];

    // agents' details are their office's: never matched to bookings, never marketed (Module 2: shared)
    const details = new ContactDetails();
    for (const email of [text(cells.Email), ...list(cells['Other emails'])]) {
      if (!email) continue;
      const agency = !isAgent
        ? agencyEmails.get(cleanEmail(email) ?? '')
        : undefined;
      const agentsAddress = !!agency && !isOwnAddress(email, name);
      if (agency) {
        problems.push({
          problem: agentsAddress
            ? `Email is the travel agent ${agency}'s address – marked shared`
            : `Email is also listed for the travel agent ${agency}, but carries their name – kept as their own`,
          value: email,
        });
      }
      details.add('email', email, isAgent || agentsAddress);
    }
    for (const email of list(cells['Shared email (agent / office / family)']))
      details.add('email', email, true);
    for (const phone of [text(cells.Phone), ...list(cells['Other phones'])])
      if (phone) details.add('phone', phone, isAgent);
    for (const phone of list(cells['Shared phone (agent / office)']))
      details.add('phone', phone, true);
    problems.push(...details.problems);

    if (!name && !details.methods.length) {
      skip('No name, email or phone – nothing to tell who this is');
      for (const s of (text(cells['Source rows']) ?? '').split(';'))
        skippedBySourceRow.set(s.trim(), skipped.at(-1)!);
      continue;
    }

    const notes: string[] = [];
    const listNote: string[] = []; // "From the master guest list" lines

    // ---------- stays ----------
    const stays: PlannedStay[] = [];
    if (contactType === 'guest') {
      const logHotel = guestLogHotel(text(cells['Source rows']));
      const lastStay = text(cells['Last stay (2018 logs)']);
      const lastStayDate =
        lastStay && /^\d{4}-\d{2}-\d{2}$/.test(lastStay) ? lastStay : null;
      if (lastStay && !lastStayDate)
        problems.push({
          problem: 'Last stay date not understood – left out',
          value: lastStay,
        });
      const channelLabel = text(cells.Channel);
      const channel = stayChannel(channelLabel);
      const notHotels: string[] = [];
      for (const hotel of list(cells.Properties)) {
        const propertyId = hotelId(hotel);
        if (!propertyId) {
          if (NOT_A_HOTEL[hotel]) notHotels.push(hotel);
          else {
            problems.push({
              problem: 'Hotel is not in the CRM – kept in a note',
              value: hotel,
            });
            listNote.push(`Stayed at ${hotel}`);
          }
          continue;
        }
        const inGuestLog = hotel === logHotel;
        const same = stays.find((s) => s.propertyId === propertyId);
        if (same) {
          same.inGuestLog ||= inGuestLog;
          continue;
        }
        stays.push({
          propertyId,
          inGuestLog,
          arrivalDate: inGuestLog ? lastStayDate : null,
          channel: inGuestLog ? channel : 'unknown',
        });
      }
      // the Divan list adds nothing when a hotel is known; an unnamed hotel is a stay of its own
      for (const hotel of notHotels) {
        if (
          hotel !== 'Taru Villas' ||
          (!stays.length && notHotels.length === 1)
        )
          listNote.push(NOT_A_HOTEL[hotel]);
      }
      if (!stays.some((s) => s.inGuestLog)) {
        const where =
          logHotel && NOT_A_HOTEL[logHotel] ? ' (the unnamed hotel)' : '';
        if (lastStayDate)
          listNote.push(
            `Last stay in the 2018 guest logs: ${formatDay(lastStayDate)}${where}`,
          );
        if (channel !== 'unknown')
          listNote.push(
            `Booking channel in the 2018 guest logs: ${channelLabel}${where}`,
          );
      }
    }
    const asLogged = loggedChannel(text(cells['Channel (as logged)']));
    if (asLogged)
      listNote.push(`How they booked, as written in the log: ${asLogged}`);
    if (text(cells['Trade / VIP'])?.startsWith('Influencer / creator')) {
      listNote.push(
        'Contact details were found online – check them before reaching out',
      );
    }

    const repeat = text(cells['Repeat / multi-property']) === 'Yes';
    const lifecycleStage: LifecycleStage =
      contactType === 'guest'
        ? repeat || stays.length >= 2
          ? 'repeat_guest'
          : stays.length === 1
            ? 'stayed'
            : 'stayed_hotel_unknown'
        : contactType === 'lead'
          ? 'lead'
          : contactType;

    // ---------- market and country ----------
    const market = MARKETS_BY_LABEL[text(cells.Market) ?? ''] ?? 'unknown';
    const countryCode = country(
      countryFromBasis(text(cells['Market basis']), details.phoneCountry),
    );

    // ---------- company (B2B agents) ----------
    let companyKeyOfContact: string | null = null;
    if (isAgent) {
      const listed = name
        ? companyOfB2bPerson.get(name.toLowerCase())
        : undefined;
      const companyName = text(cells.Company);
      if (listed) {
        companyKeyOfContact = listed;
        companies.get(listed)!.address ??= text(cells.Address);
      } else if (companyName) {
        companyKeyOfContact = addCompany({
          source,
          name: companyName,
          companyType: 'travel_agent',
          countryCode: 'LK',
          address: text(cells.Address),
          status: 'active',
          notes: [],
        }).key;
      }
    }

    // ---------- knowledge ----------
    const preferences: PlannedContact['preferences'] = [];
    const likes = text(cells.Likes);
    if (likes)
      preferences.push({ kind: 'like', body: likes, onLoggedStay: true });
    const dislikes = text(cells.Dislikes);
    if (dislikes && dislikes !== 'N/A')
      preferences.push({ kind: 'dislike', body: dislikes, onLoggedStay: true });
    const remark = text(cells.Notes);
    if (remark) notes.push(remark);
    if (listNote.length)
      notes.push(
        `From the master guest list:\n${listNote.map((l) => `• ${l}`).join('\n')}`,
      );

    const vip = vipReason(text(cells['Trade / VIP']));
    const tags = [
      ...(vip ? ['VIP / industry'] : []),
      ...(text(cells.Channel) === "Owner's guest / friends & family"
        ? ['Friends & family']
        : []),
    ];

    const wix = text(cells['Wix subscriber status']);
    const consentStatus = wix ? WIX_CONSENT[wix] : undefined;
    if (wix && !consentStatus)
      problems.push({
        problem: 'Wix subscriber status not understood – consent left unknown',
        value: wix,
      });

    const dataIssues: PlannedContact['dataIssues'] = phoneIssues(
      text(cells['Phone issues']),
    ).map((p) => {
      problems.push({
        problem: `Phone left out by the master list: ${p.issue}`,
        value: p.rawValue,
      });
      return {
        field: 'phone',
        rawValue: p.rawValue,
        issue: p.issue,
        suggestedFix: null,
      };
    });

    if (name && LOOKS_LIKE_A_BLOCK.test(name)) {
      problems.push({
        problem:
          'Looks like a room block or group, not a person – check and delete if so',
        value: name,
      });
    }

    const { firstName, lastName } = splitName(name ?? undefined);
    const contact: PlannedContact = {
      source,
      name,
      firstName,
      lastName,
      contactType,
      lifecycleStage,
      market,
      countryCode,
      designation: text(cells.Designation),
      vipReason: vip,
      companyKey: companyKeyOfContact,
      methods: details.methods,
      emailConsent: consentStatus
        ? {
            status: consentStatus,
            source: 'wix',
            evidence: `Wix website contacts: ${wix}`,
          }
        : null,
      stays,
      preferences,
      notes,
      tags,
      dataIssues,
      problems,
    };
    contacts.push(contact);
    for (const s of (text(cells['Source rows']) ?? '').split(';'))
      contactBySourceRow.set(s.trim(), contact);
  }

  // ---------- unusable emails from Needs Checking ----------
  const contactsByName = new Map<string, PlannedContact[]>();
  for (const c of contacts)
    if (c.name)
      contactsByName.set(c.name.toLowerCase(), [
        ...(contactsByName.get(c.name.toLowerCase()) ?? []),
        c,
      ]);
  for (const { row, cells } of emailChecks) {
    const byName = contactsByName.get(text(cells.Name)?.toLowerCase() ?? '');
    const contact =
      contactBySourceRow.get(text(cells.Source) ?? '') ??
      (byName?.length === 1 ? byName[0] : undefined);
    const rawValue = text(cells['Logged as']) ?? '';
    const issue =
      `${text(cells.Status)}: ${text(cells['Note / suggested fix']) ?? ''}`.replace(
        /:\s*$/,
        '',
      );
    const used = text(cells.Used);
    if (!contact) {
      // usually the reason a Master row was left with nothing to load
      const emptyRow = skippedBySourceRow.get(text(cells.Source) ?? '');
      if (emptyRow)
        emptyRow.details = [
          emptyRow.details,
          `Needs Checking: ${rawValue} – ${issue}`,
        ]
          .filter(Boolean)
          .join(' · ');
      else {
        skipped.push({
          source: { tab: CHECKS_TAB, row },
          name: text(cells.Name),
          email: rawValue,
          phone: null,
          reason: 'Needs Checking entry matches no contact – not recorded',
          details: issue,
        });
      }
      continue;
    }
    contact.dataIssues.push({
      field: 'email',
      rawValue,
      issue,
      suggestedFix: used && used !== '—' ? used : null,
    });
    contact.problems.push({
      problem: `Email from the Needs Checking tab – ${issue}`,
      value: rawValue,
    });
  }

  // ---------- Travel Agents (SL) and Foreign Tour Operators: one contact per company ----------
  // The agency's general emails and phones, on a contact with no name (the
  // tabs name no one, apart from the tour operators' contact person).
  function tradeContact(
    tab: string,
    row: number,
    cells: Cells,
    company: PlannedCompany | null,
    personName: string | null,
    defaultCountry?: string,
  ) {
    const source = { tab, row };
    const skip = (reason: string) =>
      skipped.push({
        source,
        name: text(cells.Company),
        email: text(cells.Email),
        phone: text(cells.Phone),
        reason,
        details: personName,
      });
    if (!company) {
      skip('No company name');
      return;
    }
    const details = new ContactDetails(defaultCountry);
    for (const email of [text(cells.Email), ...list(cells['Other emails'])])
      if (email) details.add('email', email, true);
    for (const phone of [text(cells.Phone), ...list(cells['Other phones'])])
      if (phone) details.add('phone', phone, true);
    if (!details.methods.length && !personName) {
      skip(
        'No email or phone – the company was added to Companies, but there is no contact to add',
      );
      return;
    }
    const issues = text(cells['Issues / to check']);
    const { firstName, lastName } = splitName(personName ?? undefined);
    contacts.push({
      source,
      name: personName ? `${personName} (${company.name})` : company.name,
      firstName,
      lastName,
      contactType: 'agent_contact',
      lifecycleStage: 'agent_contact',
      market: company.countryCode === 'LK' ? 'local' : 'foreign',
      countryCode: company.countryCode,
      designation: null,
      vipReason: null,
      companyKey: company.key,
      methods: details.methods,
      emailConsent: null,
      stays: [],
      preferences: [],
      notes: [],
      tags: [],
      dataIssues: [],
      problems: [
        ...details.problems,
        ...(issues
          ? [
              {
                problem: `Flagged in the TA & TO database: ${issues}`,
                value: null,
              },
            ]
          : []),
      ],
    });
  }

  agencies.forEach(({ row, cells }, i) =>
    tradeContact(AGENTS_TAB, row, cells, agencyCompanies[i], null, 'LK'),
  );
  operators.forEach(({ row, cells }, i) =>
    tradeContact(
      OPERATORS_TAB,
      row,
      cells,
      operatorCompanies[i],
      text(cells['Contact person']),
    ),
  );

  return { contacts, companies: [...companies.values()], skipped };
}
