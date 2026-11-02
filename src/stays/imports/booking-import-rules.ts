import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { STAY_CHANNELS } from '../../db/schema/index.js';
import { formatPhone, marketForCountry, matchKey } from '../../guests/guest-rules.js';
import { statusOnReimport, type StayStatus } from '../stay-rules.js';

type Channel = (typeof STAY_CHANNELS)[number];
type Market = ReturnType<typeof marketForCountry>;

// =====================================================================
// BOOKING FILE IMPORT – the rules, without the database.
// The service loads what the CRM already has (stays by booking reference,
// guests by email and phone), and planImport() decides what each row does.
// The preview and the real import run the same plan, so what staff see in
// step 3 is what step 4 saves.
// =====================================================================

// ---------- the CRM fields a file column can be matched to ----------
// `headings` are column titles recognised automatically in step 2 (compared
// lower-case, letters and digits only), so "Check-in Date" finds arrivalDate.
export const IMPORT_FIELDS = [
  {
    key: 'bookingReference',
    label: 'Booking reference',
    required: true,
    headings: ['booking reference', 'booking ref', 'reference', 'ref', 'ref no', 'reservation', 'reservation no',
      'reservation number', 'reservation id', 'res no', 'confirmation', 'confirmation no', 'confirmation number',
      'conf no', 'booking no', 'booking number', 'booking id', 'folio', 'folio no'],
  },
  {
    key: 'hotel',
    label: 'Hotel',
    hint: 'Not needed if you pick the hotel in step 1',
    headings: ['hotel', 'hotel name', 'property', 'property name', 'property code'],
  },
  {
    key: 'arrivalDate',
    label: 'Arrival date',
    required: true,
    headings: ['arrival', 'arrival date', 'check in', 'check in date', 'checkin', 'checkin date', 'date from', 'arr', 'from'],
  },
  {
    key: 'departureDate',
    label: 'Departure date',
    required: true,
    headings: ['departure', 'departure date', 'check out', 'check out date', 'checkout', 'checkout date', 'date to', 'dep', 'to'],
  },
  {
    key: 'guestName',
    label: 'Guest name (full)',
    hint: 'Or match First name and Last name separately',
    headings: ['guest', 'guest name', 'name', 'full name', 'customer', 'customer name', 'booker', 'booker name',
      'lead guest', 'main guest'],
  },
  { key: 'firstName', label: 'First name', headings: ['first name', 'firstname', 'given name', 'forename', 'first'] },
  { key: 'lastName', label: 'Last name', headings: ['last name', 'lastname', 'surname', 'family name', 'last'] },
  { key: 'email', label: 'Email', headings: ['email', 'e mail', 'email address', 'guest email', 'emailaddress'] },
  {
    key: 'phone',
    label: 'Phone',
    headings: ['phone', 'telephone', 'tel', 'mobile', 'mobile number', 'phone number', 'contact number', 'contact no',
      'cell', 'whatsapp', 'guest phone'],
  },
  { key: 'country', label: 'Country', headings: ['country', 'nationality', 'country of residence', 'residence', 'guest country'] },
  { key: 'adults', label: 'Adults', headings: ['adults', 'adult', 'no of adults', 'number of adults', 'pax adults'] },
  { key: 'children', label: 'Children', headings: ['children', 'child', 'kids', 'no of children', 'number of children'] },
  {
    key: 'roomType',
    label: 'Room type',
    headings: ['room type', 'room', 'room category', 'category', 'accommodation', 'unit type', 'room name'],
  },
  {
    key: 'roomRevenue',
    label: 'Room revenue',
    hint: 'A currency in the same cell, like "USD 450", is understood',
    headings: ['room revenue', 'revenue', 'amount', 'total', 'total amount', 'price', 'room charges', 'total price',
      'room rate total', 'booking amount'],
  },
  { key: 'currency', label: 'Currency', headings: ['currency', 'curr', 'ccy', 'currency code'] },
  {
    key: 'channel',
    label: 'Channel',
    hint: 'Direct, travel agent, OTA, owner, website or walk-in',
    headings: ['channel', 'source', 'booking source', 'booking channel', 'market segment', 'segment', 'origin'],
  },
  {
    key: 'agent',
    label: 'Agent or OTA',
    hint: 'Matched by name to the CRM\'s companies',
    headings: ['agent', 'travel agent', 'agency', 'company', 'ota', 'booked via', 'tour operator', 'agent name'],
  },
  { key: 'occasion', label: 'Occasion', headings: ['occasion', 'purpose', 'purpose of visit', 'reason', 'trip reason'] },
  {
    key: 'status',
    label: 'Booking status',
    hint: 'Confirmed, cancelled, no-show, checked in or checked out',
    headings: ['status', 'booking status', 'reservation status'],
  },
  {
    key: 'marketingConsent',
    label: 'Marketing tick box',
    hint: 'Ticked opts the guest in to email; unticked changes nothing',
    headings: ['marketing', 'marketing consent', 'newsletter', 'opt in', 'marketing opt in', 'subscribe',
      'email marketing', 'promotions', 'marketing emails'],
  },
  {
    key: 'specialRequests',
    label: 'Special requests',
    hint: 'Saved on the stay as booking remarks; a re-import replaces them',
    headings: ['special requests', 'special request', 'requests', 'remarks', 'comments', 'guest remarks', 'booking remarks'],
  },
  {
    key: 'bookedAt',
    label: 'Booking date',
    hint: 'When the booking was made; used as the date of a marketing opt-in',
    headings: ['booking date', 'booked on', 'booked at', 'date booked', 'reservation date', 'booking created', 'created'],
  },
] as const satisfies readonly { key: string; label: string; required?: boolean; hint?: string; headings: readonly string[] }[];

export type ImportField = (typeof IMPORT_FIELDS)[number]['key'];
export const IMPORT_FIELD_KEYS = IMPORT_FIELDS.map((f) => f.key) as [ImportField, ...ImportField[]];

// One file row with its matched columns as text. A field that is present but
// empty was matched to a column and is blank in this row; a missing field
// wasn't matched at all, so an update leaves that part of the stay alone.
export type RawBooking = Partial<Record<ImportField, string>>;

// ---------- what the parser needs to look names up ----------
export interface ImportLookups {
  pickedPropertyId: string | null; // the hotel picked in step 1 for a one-hotel file
  properties: { id: string; name: string }[];
  occasions: { id: number; name: string }[];
  companies: { id: number; name: string }[];
  countries: { code: string; name: string }[];
}

// Stay columns an import can write, beyond reference, hotel and dates.
export const STAY_IMPORT_COLUMNS = [
  'roomType',
  'adults',
  'children',
  'roomRevenue',
  'currency',
  'channel',
  'bookingCompanyId',
  'occasionId',
  'bookingRemarks',
] as const;
export type StayImportColumn = (typeof STAY_IMPORT_COLUMNS)[number];

export interface ParsedBooking {
  bookingReference: string | null;
  propertyId: string | null;
  propertyName: string | null;
  arrivalDate: string | null; // 'YYYY-MM-DD'
  departureDate: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null; // lower-case
  phone: string | null; // international form, '+94 77 123 4567'
  countryCode: string | null; // from the country column, or the phone's dialling code
  roomType: string | null;
  adults: number | null;
  children: number | null;
  roomRevenue: string | null; // '1200.50'
  currency: string | null; // 'USD'
  channel: Channel;
  bookingCompanyId: number | null;
  occasionId: number | null;
  bookingRemarks: string | null;
  status: StayStatus | undefined; // undefined: no status column, or blank
  marketingConsent: boolean;
  bookedAt: Date | null;
}

export interface ParsedRow {
  index: number; // position in the file's rows, from 0
  values: ParsedBooking;
  errors: string[];
  warnings: string[];
}

// =====================================================================
// Reading cells
// =====================================================================
const clean = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();
// "Check-in Date" → "check in date"
export const normaliseHeading = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null; // 31 April, 29 Feb 2027
  return date.toISOString().slice(0, 10);
}

// Dates as booking systems write them. Numbers are read day first
// (21/10/2026, as in Sri Lanka), unless the second number can only be a day
// (10/21/2026). Spreadsheet date cells arrive as 2026-10-21 from the app.
export function parseDate(text: string | undefined): string | null {
  const t = clean(text);
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(t);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?: .*)?$/.exec(t);
  if (m) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    return b > 12 && a <= 12 ? isoDate(y, a, b) : isoDate(y, b, a);
  }
  // 21 Oct 2026, 21-Oct-26, 21 October 2026
  m = /^(\d{1,2})[\s-]+([a-z]{3,})\.?[\s-]+(\d{2}|\d{4})$/i.exec(t);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    return month ? isoDate(+m[3], month, +m[1]) : null;
  }
  // Oct 21, 2026
  m = /^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(t);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    return month ? isoDate(+m[3], month, +m[2]) : null;
  }
  // a spreadsheet serial day number that wasn't converted (46316 = 21 Oct 2026)
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const days = Math.floor(Number(t));
    if (days > 20000 && days < 80000) return new Date(Date.UTC(1899, 11, 30) + days * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

// A booking date may carry a time: '2026-10-01 14:20' or '01/10/2026 14:20'.
export function parseDateTime(text: string | undefined): Date | null {
  const t = clean(text);
  if (!t) return null;
  const day = parseDate(t);
  if (!day) return null;
  const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(t);
  // times in the file are hotel time (UTC+05:30)
  return new Date(`${day}T${time ? `${time[1].padStart(2, '0')}:${time[2]}:${time[3] ?? '00'}` : '00:00:00'}+05:30`);
}

// 'Mr John Smith' → John / Smith; 'Smith, John' → John / Smith;
// 'Mr & Mrs J. De Silva' → J. / De Silva. The first word is the first name.
const TITLES = /^((mr|mrs|ms|miss|mx|dr|prof|sir|dame|rev|master)\.?\s+((&|and)\s+(mr|mrs|ms|miss|dr)\.?\s+)?)+/i;

export function splitName(full: string | undefined): { firstName: string | null; lastName: string | null } {
  let t = clean(full);
  const comma = /^([^,]+),\s*(.+)$/.exec(t);
  if (comma) t = `${comma[2]} ${comma[1]}`;
  t = t.replace(TITLES, '').trim();
  if (!t) return { firstName: null, lastName: null };
  const [first, ...rest] = t.split(' ');
  return { firstName: first, lastName: rest.join(' ') || null };
}

// 'USD 1,200.50', '1200.5 LKR', '$450', '45,000' → amount and the currency
// given in the same cell, if any.
export function parseMoney(text: string | undefined): { amount: string | null; currency: string | null } | null {
  let t = clean(text).replace(/^(rs\.?|\$|€|£)\s*/i, '');
  if (!t) return { amount: null, currency: null };
  let currency: string | null = null;
  const code = /^([a-z]{3})\s*(.+)$/i.exec(t) ?? /^(.+?)\s*([a-z]{3})$/i.exec(t);
  if (code) {
    const [a, b] = [code[1], code[2]];
    if (/^[a-z]{3}$/i.test(a)) [currency, t] = [a.toUpperCase(), b];
    else [currency, t] = [b.toUpperCase(), a];
  }
  t = t.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return { amount: Number(t).toFixed(2), currency };
}

function parseCount(text: string | undefined): number | null | undefined {
  const t = clean(text);
  if (!t) return null;
  if (!/^\d+(\.0+)?$/.test(t)) return undefined;
  const n = Number(t);
  return n <= 99 ? n : undefined;
}

const CHANNEL_WORDS: [Channel, string[]][] = [
  ['direct', ['direct', 'phone', 'telephone', 'email', 'direct booking', 'reservations', 'repeat']],
  ['travel_agent', ['travel agent', 'agent', 'ta', 'dmc', 'tour operator', 'wholesaler', 'agency', 'inbound']],
  ['ota', ['ota', 'online travel agent', 'booking com', 'booking', 'expedia', 'agoda', 'airbnb', 'hotels com',
    'trip com', 'tripadvisor', 'hotelbeds', 'trivago', 'makemytrip', 'goibibo', 'secret escapes', 'mr and mrs smith']],
  ['owner_guest', ['owner', 'owner guest', 'owners guest', 'owner s guest', 'house use', 'complimentary', 'comp']],
  ['website', ['website', 'web', 'online', 'booking engine', 'ibe', 'direct online', 'web booking', 'internet']],
  ['walk_in', ['walk in', 'walkin', 'walk']],
];

// What the booking system calls the channel → the CRM's channel. Unknown words map to 'unknown'.
export function parseChannel(text: string | undefined): { channel: Channel; recognised: boolean } {
  const t = normaliseHeading(clean(text)).replace(/_/g, ' ');
  if (!t) return { channel: 'unknown', recognised: true };
  for (const [channel, words] of CHANNEL_WORDS) {
    if (words.includes(t) || t === channel.replace('_', ' ')) return { channel, recognised: true };
  }
  if (t === 'unknown' || t === 'online unclear' || t === 'mixed') return { channel: t.replace(' ', '_') as Channel, recognised: true };
  return { channel: 'unknown', recognised: false };
}

const STATUS_WORDS: [StayStatus, string[]][] = [
  ['booked', ['booked', 'confirmed', 'reserved', 'new', 'tentative', 'provisional', 'modified', 'amended', 'guaranteed',
    'definite', 'pending', 'ok', 'active']],
  ['checked_in', ['checked in', 'check in', 'in house', 'inhouse', 'arrived', 'checkedin', 'staying']],
  ['checked_out', ['checked out', 'check out', 'departed', 'checkedout', 'completed', 'stayed', 'closed']],
  ['cancelled', ['cancelled', 'canceled', 'cancellation', 'cancel', 'void', 'cxl', 'cnx', 'xl']],
  ['no_show', ['no show', 'noshow', 'ns']],
];

// undefined: blank; null: not a status the CRM knows
export function parseStatus(text: string | undefined): StayStatus | null | undefined {
  const t = normaliseHeading(clean(text)).replace(/_/g, ' ');
  if (!t) return undefined;
  for (const [status, words] of STATUS_WORDS) if (words.includes(t)) return status;
  return null;
}

const TICKED = ['yes', 'y', 'true', '1', 'x', '✓', '✔', 'ticked', 'checked', 'opted in', 'opt in', 'agree', 'agreed',
  'on', 'subscribed', 'subscribe'];

// Only an explicit tick opts in; blank, "no" or anything else changes nothing.
export const isTicked = (text: string | undefined) => TICKED.includes(clean(text).toLowerCase());

const COUNTRY_ALIASES: Record<string, string> = {
  uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', britain: 'GB', 'united kingdom': 'GB',
  usa: 'US', 'u s a': 'US', america: 'US', 'united states of america': 'US', uae: 'AE', emirates: 'AE',
  holland: 'NL', 'the netherlands': 'NL', 'russian federation': 'RU', korea: 'KR', 'republic of korea': 'KR',
  'czech republic': 'CZ', 'viet nam': 'VN', ceylon: 'LK', srilanka: 'LK',
};

// ---------- name look-ups: exact (case and spacing ignored) ----------
const key = (v: string) => normaliseHeading(v);

function findByName<T extends { name: string }>(list: T[], text: string): T | undefined {
  const k = key(text);
  return list.find((item) => key(item.name) === k);
}

function findHotel(lookups: ImportLookups, text: string) {
  const k = key(text);
  const exact = lookups.properties.find((p) => p.id.toLowerCase() === text.toLowerCase() || key(p.name) === k);
  if (exact) return exact;
  // "Nyne Hotels – Rock Villa", "Rock Villa Bentota": only if exactly one hotel fits
  const partial = lookups.properties.filter((p) => k.includes(key(p.name)) || (k.length >= 4 && key(p.name).includes(k)));
  return partial.length === 1 ? partial[0] : undefined;
}

// A country by name, 2-letter code or a common alias (UK, USA, Holland …).
// Also used by the contact import (Module 9).
export function findCountry(countries: { code: string; name: string }[], text: string): string | undefined {
  if (/^[a-z]{2}$/i.test(text)) {
    const code = text.toUpperCase();
    if (code === 'UK') return 'GB';
    return countries.some((c) => c.code === code) ? code : undefined;
  }
  return findByName(countries, text)?.code ?? COUNTRY_ALIASES[key(text)];
}

function phoneCountry(phone: string): string | null {
  return parsePhoneNumberFromString(phone)?.country ?? null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// =====================================================================
// One file row → a booking, with the reasons it can't be imported (errors)
// and the things staff should know (warnings).
// =====================================================================
export function parseBooking(raw: RawBooking, index: number, lookups: ImportLookups): ParsedRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const bookingReference = clean(raw.bookingReference) || null;
  if (!bookingReference) errors.push('No booking reference');

  // hotel: the row's own column, else the hotel picked for the whole file
  let propertyId: string | null = null;
  let propertyName: string | null = null;
  const hotelText = clean(raw.hotel);
  if (hotelText) {
    const hotel = findHotel(lookups, hotelText);
    if (hotel) [propertyId, propertyName] = [hotel.id, hotel.name];
    else errors.push(`Hotel "${hotelText}" isn't one of the CRM's hotels`);
  } else if (lookups.pickedPropertyId) {
    const hotel = lookups.properties.find((p) => p.id === lookups.pickedPropertyId);
    if (hotel) [propertyId, propertyName] = [hotel.id, hotel.name];
  }
  if (!propertyId && !hotelText) errors.push('No hotel: pick one in step 1 or match the Hotel column');

  const arrivalDate = parseDate(raw.arrivalDate);
  const departureDate = parseDate(raw.departureDate);
  if (!clean(raw.arrivalDate)) errors.push('No arrival date');
  else if (!arrivalDate) errors.push(`Arrival "${clean(raw.arrivalDate)}" isn't a date`);
  if (!clean(raw.departureDate)) errors.push('No departure date');
  else if (!departureDate) errors.push(`Departure "${clean(raw.departureDate)}" isn't a date`);
  if (arrivalDate && departureDate && departureDate < arrivalDate) errors.push('Departure is before arrival');

  // guest
  const name =
    raw.firstName !== undefined || raw.lastName !== undefined
      ? { firstName: clean(raw.firstName) || null, lastName: clean(raw.lastName) || null }
      : splitName(raw.guestName);

  let email: string | null = clean(raw.email).toLowerCase() || null;
  if (email && !EMAIL.test(email)) {
    warnings.push(`Email "${email}" isn't valid, so it was left out`);
    email = null;
  }

  let countryCode: string | null = null;
  const countryText = clean(raw.country);
  if (countryText) {
    countryCode = findCountry(lookups.countries, countryText) ?? null;
    if (!countryCode) warnings.push(`Country "${countryText}" not recognised, so it was left blank`);
  }

  let phone: string | null = null;
  const phoneText = clean(raw.phone);
  if (phoneText) {
    const country = countryCode && isSupportedCountry(countryCode) ? (countryCode as CountryCode) : undefined;
    // a number typed without its country code is read as from the guest's country, else Sri Lanka
    phone = formatPhone(phoneText, country ?? 'LK');
    if (!phone) warnings.push(`Phone "${phoneText}" isn't a complete number, so it was left out`);
    else if (!countryCode) countryCode = phoneCountry(phone);
  }

  // room and guests
  const roomType = clean(raw.roomType) || null;
  const adults = parseCount(raw.adults);
  const children = parseCount(raw.children);
  if (adults === undefined) errors.push(`Adults "${clean(raw.adults)}" isn't a number of people`);
  if (children === undefined) errors.push(`Children "${clean(raw.children)}" isn't a number of people`);

  // money: the revenue needs a currency, from its own column or the same cell
  const money = parseMoney(raw.roomRevenue);
  let currency = clean(raw.currency).toUpperCase() || null;
  if (!money) errors.push(`Room revenue "${clean(raw.roomRevenue)}" isn't an amount`);
  else if (money.currency && !currency) currency = money.currency;
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    errors.push(`Currency "${currency}" should be a 3-letter code such as USD or LKR`);
  } else if (money?.amount && !currency) {
    errors.push('Room revenue needs a currency');
  }

  const channelResult = parseChannel(raw.channel);
  if (!channelResult.recognised) warnings.push(`Channel "${clean(raw.channel)}" not recognised; saved as unknown`);

  let bookingCompanyId: number | null = null;
  const agentText = clean(raw.agent);
  if (agentText) {
    bookingCompanyId = findByName(lookups.companies, agentText)?.id ?? null;
    if (!bookingCompanyId) warnings.push(`Agent "${agentText}" isn't in the CRM's companies yet, so it was left blank`);
  }

  let occasionId: number | null = null;
  const occasionText = clean(raw.occasion);
  if (occasionText) {
    occasionId = findByName(lookups.occasions, occasionText)?.id ?? null;
    if (!occasionId) warnings.push(`Occasion "${occasionText}" isn't on the occasions list, so it was left blank`);
  }

  const status = parseStatus(raw.status);
  if (status === null) errors.push(`Status "${clean(raw.status)}" not recognised`);

  const bookedAt = parseDateTime(raw.bookedAt);
  if (clean(raw.bookedAt) && !bookedAt) warnings.push(`Booking date "${clean(raw.bookedAt)}" isn't a date, so it was ignored`);

  return {
    index,
    errors,
    warnings,
    values: {
      bookingReference,
      propertyId,
      propertyName,
      arrivalDate,
      departureDate,
      ...name,
      email,
      phone,
      countryCode,
      roomType,
      adults: adults ?? null,
      children: children ?? null,
      roomRevenue: money?.amount ?? null,
      currency,
      channel: channelResult.channel,
      bookingCompanyId,
      occasionId,
      bookingRemarks: (raw.specialRequests ?? '').trim() || null,
      status: status ?? undefined,
      marketingConsent: isTicked(raw.marketingConsent),
      bookedAt,
    },
  };
}

// Which stay columns the file provides, from the fields matched in step 2.
// Columns not in the file are left as they are when a booking is updated.
export function providedColumns(fields: readonly ImportField[]): StayImportColumn[] {
  const has = (f: ImportField) => fields.includes(f);
  const columns: StayImportColumn[] = [];
  if (has('roomType')) columns.push('roomType');
  if (has('adults')) columns.push('adults');
  if (has('children')) columns.push('children');
  if (has('roomRevenue')) columns.push('roomRevenue', 'currency');
  else if (has('currency')) columns.push('currency');
  if (has('channel')) columns.push('channel');
  if (has('agent')) columns.push('bookingCompanyId');
  if (has('occasion')) columns.push('occasionId');
  if (has('specialRequests')) columns.push('bookingRemarks');
  return columns;
}

// =====================================================================
// What the CRM already has, loaded by the service for the file's rows
// =====================================================================
export interface ExistingStay {
  id: number;
  contactId: number;
  propertyId: string;
  propertyName: string;
  bookingReference: string;
  status: StayStatus;
  cancellationReason: string | null;
}

export interface KnownContact {
  id: number;
  firstName: string | null;
  lastName: string | null;
  doNotContact: boolean;
  emails: string[]; // match keys of every email on file
  phones: string[]; // digits of every phone on file
}

export interface ExistingData {
  staysByKey: Map<string, ExistingStay>; // stayKey(hotel, reference)
  staysByReference: Map<string, ExistingStay[]>; // the same reference at any hotel, for moved bookings
  // matchable (not shared) emails and phones → guests that have them, oldest first
  contactsByEmail: Map<string, number[]>;
  contactsByPhone: Map<string, number[]>;
  contacts: Map<number, KnownContact>;
}

export const stayKey = (propertyId: string, reference: string) => `${propertyId}|${reference}`;

// =====================================================================
// The plan: what each row does, and everything the import will write
// =====================================================================
export type RowOutcome = 'new_guest' | 'existing_guest' | 'update' | 'error' | 'skipped';

export type GuestRef = { id: number } | { newKey: number };

export interface PlannedRow {
  index: number;
  outcome: RowOutcome;
  errors: string[];
  warnings: string[];
  // id null: a guest this import creates; rows with the same newKey create one guest together
  guest: { id: number | null; newKey: number | null; name: string } | null;
  stayId: number | null; // the stay an update changes
  summary: {
    reference: string | null;
    hotel: string | null;
    arrival: string | null;
    departure: string | null;
    guest: string; // name as in the file
    email: string | null;
    phone: string | null;
    status: StayStatus | null;
  };
}

export interface NewGuest {
  key: number;
  firstRow: number; // row number in the file that created them, from 1
  firstName: string | null;
  lastName: string | null;
  countryCode: string | null;
  market: Market;
  methods: { kind: 'email' | 'phone'; value: string; isPrimary: boolean }[];
}

export interface StayWrite {
  index: number;
  existingId: number | null;
  guest: GuestRef;
  booking: ParsedBooking;
  status: StayStatus;
  cancellationReason: string | null;
}

export interface ConsentTick {
  guest: GuestRef;
  givenAt: Date;
  evidence: string;
}

export interface ImportPlan {
  rows: PlannedRow[];
  newGuests: NewGuest[];
  methodsToAdd: { contactId: number; kind: 'email' | 'phone'; value: string; isPrimary: boolean }[];
  consents: ConsentTick[]; // one per guest: the latest tick in the file
  doNotContact: number[]; // existing guests on do-not-contact who ticked the box
  stayWrites: StayWrite[];
  moves: { stayId: number; reason: string }[]; // stays at the old hotel of a moved booking, to cancel
}

const displayName = (p: { firstName: string | null; lastName: string | null }, fallback: string) =>
  [p.firstName, p.lastName].filter(Boolean).join(' ') || fallback;

const refKey = (g: GuestRef) => ('id' in g ? `c${g.id}` : `n${g.newKey}`);

// Rows are planned in file order, so a guest with two bookings in the same
// file is created once: the second row finds the guest the first row made.
export function planImport(
  parsed: ParsedRow[],
  existing: ExistingData,
  options: { skip?: ReadonlySet<number>; fileName: string; now?: Date },
): ImportPlan {
  const now = options.now ?? new Date();
  const plan: ImportPlan = { rows: [], newGuests: [], methodsToAdd: [], consents: [], doNotContact: [], stayWrites: [], moves: [] };
  const firstRowFor = new Map<string, number>(); // stay key → first row number in the file
  const newByEmail = new Map<string, NewGuest>();
  const newByPhone = new Map<string, NewGuest>();
  const queued = new Set<string>(); // `${contactId}|${kind}|${key}` already being added
  const consents = new Map<string, ConsentTick>();
  const dnc = new Set<number>();

  const tick = (guest: GuestRef, booking: ParsedBooking) => {
    if (!booking.marketingConsent) return;
    const givenAt = booking.bookedAt ?? now;
    const k = refKey(guest);
    const previous = consents.get(k);
    if (!previous || previous.givenAt <= givenAt) {
      consents.set(k, {
        guest,
        givenAt,
        evidence: `Ticked the marketing box on booking ${booking.bookingReference} (${options.fileName})`,
      });
    }
    if ('id' in guest && existing.contacts.get(guest.id)?.doNotContact) dnc.add(guest.id);
  };

  for (const row of parsed) {
    const v = row.values;
    const planned: PlannedRow = {
      index: row.index,
      outcome: 'error',
      errors: [...row.errors],
      warnings: [...row.warnings],
      guest: null,
      stayId: null,
      summary: {
        reference: v.bookingReference,
        hotel: v.propertyName,
        arrival: v.arrivalDate,
        departure: v.departureDate,
        guest: displayName(v, ''),
        email: v.email,
        phone: v.phone,
        status: v.status ?? null,
      },
    };
    plan.rows.push(planned);

    const key = v.propertyId && v.bookingReference ? stayKey(v.propertyId, v.bookingReference) : null;
    if (key) {
      const first = firstRowFor.get(key);
      if (first !== undefined) planned.errors.push(`Same booking reference and hotel as row ${first}`);
      else firstRowFor.set(key, row.index + 1);
    }
    if (options.skip?.has(row.index)) {
      planned.outcome = 'skipped';
      continue;
    }
    if (planned.errors.length || !key) continue;

    // ---- 1. a booking the CRM already has: update it; the guest isn't re-matched ----
    const stay = existing.staysByKey.get(key);
    if (stay) {
      const { status, note } = statusOnReimport(stay.status, v.status);
      if (note) planned.warnings.push(note);
      const contact = existing.contacts.get(stay.contactId);
      planned.outcome = 'update';
      planned.stayId = stay.id;
      planned.guest = {
        id: stay.contactId,
        newKey: null,
        name: contact ? displayName(contact, `Guest #${stay.contactId}`) : `Guest #${stay.contactId}`,
      };
      plan.stayWrites.push({
        index: row.index,
        existingId: stay.id,
        guest: { id: stay.contactId },
        booking: v,
        status,
        cancellationReason:
          status === 'cancelled' && stay.status !== 'cancelled' ? 'Cancelled in the booking system' : stay.cancellationReason,
      });
      tick({ id: stay.contactId }, v);
      continue;
    }

    // ---- 2. a new stay: find the guest by email, then phone; never by name ----
    if (!v.email && !v.phone && !v.firstName && !v.lastName) {
      planned.errors.push('No guest name, email or phone');
      continue;
    }
    const emailKey = v.email ? matchKey('email', v.email) : null;
    const phoneKey = v.phone ? matchKey('phone', v.phone) : null;
    let contactId: number | undefined;
    let fresh: NewGuest | undefined;

    const byEmail = emailKey ? existing.contactsByEmail.get(emailKey) : undefined;
    const byPhone = phoneKey ? existing.contactsByPhone.get(phoneKey) : undefined;
    if (byEmail?.length) {
      contactId = byEmail[0];
      if (byEmail.length > 1) planned.warnings.push(`${byEmail.length} guests have this email; it went to the oldest record`);
    } else if (emailKey && newByEmail.has(emailKey)) {
      fresh = newByEmail.get(emailKey);
    } else if (byPhone?.length) {
      contactId = byPhone[0];
      if (byPhone.length > 1) planned.warnings.push(`${byPhone.length} guests have this phone; it went to the oldest record`);
    } else if (phoneKey && newByPhone.has(phoneKey)) {
      fresh = newByPhone.get(phoneKey);
    }

    let guest: GuestRef;
    if (contactId !== undefined) {
      // existing guest: add any new email or phone, but never change their name or primaries
      const contact = existing.contacts.get(contactId)!;
      for (const [kind, value, k, onFile] of [
        ['email', v.email, emailKey, contact.emails],
        ['phone', v.phone, phoneKey, contact.phones],
      ] as const) {
        if (!value || !k || onFile.includes(k) || queued.has(`${contactId}|${kind}|${k}`)) continue;
        const firstOfKind = onFile.length === 0 && !plan.methodsToAdd.some((m) => m.contactId === contactId && m.kind === kind);
        plan.methodsToAdd.push({ contactId, kind, value, isPrimary: firstOfKind });
        queued.add(`${contactId}|${kind}|${k}`);
        planned.warnings.push(`Adds ${kind === 'email' ? 'the email' : 'the phone'} ${value} to this guest`);
      }
      guest = { id: contactId };
      planned.outcome = 'existing_guest';
      planned.guest = { id: contactId, newKey: null, name: displayName(contact, v.email ?? v.phone ?? `Guest #${contactId}`) };

      // a booking moved to another hotel: cancel the stay at the old one
      const moved = existing.staysByReference
        .get(v.bookingReference!)
        ?.find((s) => s.propertyId !== v.propertyId && s.contactId === contactId && s.status === 'booked');
      if (moved) {
        plan.moves.push({ stayId: moved.id, reason: `Moved to ${v.propertyName}` });
        planned.warnings.push(`Moved from ${moved.propertyName}: the stay there will be cancelled`);
      }
    } else {
      if (!fresh) {
        fresh = {
          key: plan.newGuests.length,
          firstRow: row.index + 1,
          firstName: v.firstName,
          lastName: v.lastName,
          countryCode: v.countryCode,
          market: marketForCountry(v.countryCode),
          methods: [],
        };
        plan.newGuests.push(fresh);
        if (!v.email && !v.phone) planned.warnings.push('No email or phone, so this guest can only be told apart by name');
      } else {
        planned.warnings.push(`Same new guest as row ${fresh.firstRow}`);
      }
      for (const [kind, value, k, index] of [
        ['email', v.email, emailKey, newByEmail],
        ['phone', v.phone, phoneKey, newByPhone],
      ] as const) {
        if (!value || !k || index.has(k)) continue;
        fresh.methods.push({ kind, value, isPrimary: !fresh.methods.some((m) => m.kind === kind) });
        index.set(k, fresh);
      }
      guest = { newKey: fresh.key };
      planned.outcome = 'new_guest';
      planned.guest = { id: null, newKey: fresh.key, name: displayName(fresh, v.email ?? v.phone ?? 'New guest') };
    }

    plan.stayWrites.push({
      index: row.index,
      existingId: null,
      guest,
      booking: v,
      status: v.status ?? 'booked',
      cancellationReason: v.status === 'cancelled' ? 'Cancelled in the booking system' : null,
    });
    tick(guest, v);
  }

  plan.consents = [...consents.values()];
  plan.doNotContact = [...dnc];
  return plan;
}
