import {
  isTicked,
  parseBooking,
  parseChannel,
  parseDate,
  parseMoney,
  parseStatus,
  planImport,
  providedColumns,
  splitName,
  stayKey,
  type ExistingData,
  type ImportLookups,
  type RawBooking,
} from './booking-import-rules.js';

const lookups: ImportLookups = {
  pickedPropertyId: null,
  properties: [
    { id: 'P02', name: 'Rock Villa' },
    { id: 'P04', name: 'Mayur Lodge' },
  ],
  occasions: [{ id: 1, name: 'Honeymoon' }],
  companies: [{ id: 7, name: 'Relax Lanka Tours' }],
  countries: [
    { code: 'GB', name: 'United Kingdom' },
    { code: 'LK', name: 'Sri Lanka' },
    { code: 'SA', name: 'Saudi Arabia' },
  ],
};

const booking = (overrides: RawBooking = {}): RawBooking => ({
  bookingReference: 'RV-1001',
  hotel: 'Rock Villa',
  arrivalDate: '2027-03-01',
  departureDate: '2027-03-04',
  guestName: 'Ahmed Daoud',
  email: 'ahmeddaoud.1985@gmail.com',
  phone: '+966 54 148 8817',
  ...overrides,
});

const empty = (): ExistingData => ({
  staysByKey: new Map(),
  staysByReference: new Map(),
  contactsByEmail: new Map(),
  contactsByPhone: new Map(),
  contacts: new Map(),
});

// Ahmed Daoud is already in the CRM (guest 42)
const withAhmed = (): ExistingData => {
  const data = empty();
  data.contactsByEmail.set('ahmeddaoud.1985@gmail.com', [42]);
  data.contacts.set(42, {
    id: 42,
    firstName: 'Ahmed',
    lastName: 'Daoud',
    doNotContact: false,
    emails: ['ahmeddaoud.1985@gmail.com'],
    phones: [],
  });
  return data;
};

const plan = (rows: RawBooking[], data = empty(), skip?: Set<number>) =>
  planImport(
    rows.map((r, i) => parseBooking(r, i, lookups)),
    data,
    { fileName: 'bookings.xlsx', skip, now: new Date('2026-10-26T08:00:00Z') },
  );

describe('reading cells', () => {
  it('reads dates day first, the way Sri Lanka writes them', () => {
    expect(parseDate('2026-10-21')).toBe('2026-10-21');
    expect(parseDate('2026-10-21 14:00:00')).toBe('2026-10-21');
    expect(parseDate('03/04/2027')).toBe('2027-04-03');
    expect(parseDate('21.10.26')).toBe('2026-10-21');
    expect(parseDate('10/21/2026')).toBe('2026-10-21'); // only the second number can be a day
    expect(parseDate('21 Oct 2026')).toBe('2026-10-21');
    expect(parseDate('21-Oct-26')).toBe('2026-10-21');
    expect(parseDate('Oct 21, 2026')).toBe('2026-10-21');
    expect(parseDate('46316')).toBe('2026-10-21'); // spreadsheet day number
  });

  it('refuses dates that do not exist', () => {
    expect(parseDate('31/04/2027')).toBeNull();
    expect(parseDate('29/02/2027')).toBeNull();
    expect(parseDate('next tuesday')).toBeNull();
    expect(parseDate('')).toBeNull();
  });

  it('splits names, dropping titles', () => {
    expect(splitName('Ahmed Daoud')).toEqual({ firstName: 'Ahmed', lastName: 'Daoud' });
    expect(splitName('Mr. Nimal De Silva')).toEqual({ firstName: 'Nimal', lastName: 'De Silva' });
    expect(splitName('Mr & Mrs John Smith')).toEqual({ firstName: 'John', lastName: 'Smith' });
    expect(splitName('Smith, John')).toEqual({ firstName: 'John', lastName: 'Smith' });
    expect(splitName('Madonna')).toEqual({ firstName: 'Madonna', lastName: null });
    expect(splitName('  ')).toEqual({ firstName: null, lastName: null });
  });

  it('reads amounts with or without a currency in the cell', () => {
    expect(parseMoney('USD 1,200.50')).toEqual({ amount: '1200.50', currency: 'USD' });
    expect(parseMoney('45000 lkr')).toEqual({ amount: '45000.00', currency: 'LKR' });
    expect(parseMoney('$450')).toEqual({ amount: '450.00', currency: null });
    expect(parseMoney('')).toEqual({ amount: null, currency: null });
    expect(parseMoney('free')).toBeNull();
  });

  it('maps channels and statuses from the booking system', () => {
    expect(parseChannel('Booking.com').channel).toBe('ota');
    expect(parseChannel('Travel Agent').channel).toBe('travel_agent');
    expect(parseChannel('Walk-in').channel).toBe('walk_in');
    expect(parseChannel('walk_in').channel).toBe('walk_in');
    expect(parseChannel('carrier pigeon')).toEqual({ channel: 'unknown', recognised: false });
    expect(parseStatus('Confirmed')).toBe('booked');
    expect(parseStatus('CANCELED')).toBe('cancelled');
    expect(parseStatus('No-Show')).toBe('no_show');
    expect(parseStatus('In house')).toBe('checked_in');
    expect(parseStatus('')).toBeUndefined();
    expect(parseStatus('maybe')).toBeNull();
  });

  it('only counts an explicit tick as opting in', () => {
    expect(isTicked('Yes')).toBe(true);
    expect(isTicked('✓')).toBe(true);
    expect(isTicked('TRUE')).toBe(true);
    expect(isTicked('No')).toBe(false);
    expect(isTicked('')).toBe(false);
    expect(isTicked(undefined)).toBe(false);
  });
});

describe('parseBooking', () => {
  it('reads a full row', () => {
    const { values, errors, warnings } = parseBooking(
      booking({ country: 'Saudi Arabia', adults: '2', roomRevenue: 'USD 900', occasion: 'honeymoon', agent: 'relax lanka tours', status: 'Confirmed', marketingConsent: 'yes' }),
      0,
      lookups,
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(values).toMatchObject({
      bookingReference: 'RV-1001',
      propertyId: 'P02',
      firstName: 'Ahmed',
      lastName: 'Daoud',
      countryCode: 'SA',
      adults: 2,
      roomRevenue: '900.00',
      currency: 'USD',
      occasionId: 1,
      bookingCompanyId: 7,
      status: 'booked',
      marketingConsent: true,
    });
  });

  it('uses the hotel picked for the file when there is no hotel column', () => {
    const { values, errors } = parseBooking(booking({ hotel: undefined }), 0, { ...lookups, pickedPropertyId: 'P04' });
    expect(errors).toEqual([]);
    expect(values.propertyId).toBe('P04');
  });

  it('finds the hotel inside a longer name', () => {
    expect(parseBooking(booking({ hotel: 'Nyne Hotels - Mayur Lodge' }), 0, lookups).values.propertyId).toBe('P04');
  });

  it('reports what is missing or wrong', () => {
    const { errors } = parseBooking(
      { bookingReference: '', arrivalDate: '2027-03-05', departureDate: '2027-03-01', adults: 'two', roomRevenue: '500' },
      0,
      lookups,
    );
    expect(errors).toEqual([
      'No booking reference',
      'No hotel: pick one in step 1 or match the Hotel column',
      'Departure is before arrival',
      'Adults "two" isn\'t a number of people',
      'Room revenue needs a currency',
    ]);
  });

  it('leaves out a bad email or phone with a warning instead of failing the row', () => {
    const { values, errors, warnings } = parseBooking(booking({ email: 'not-an-email', phone: '12' }), 0, lookups);
    expect(errors).toEqual([]);
    expect(values.email).toBeNull();
    expect(values.phone).toBeNull();
    expect(warnings).toHaveLength(2);
  });

  it('reads a local number as Sri Lankan and takes the country from the phone', () => {
    const { values } = parseBooking(booking({ phone: '077 123 4567', email: '' }), 0, lookups);
    expect(values.phone).toBe('+94 77 123 4567');
    expect(values.countryCode).toBe('LK');
  });
});

describe('planImport', () => {
  it('lands a booking with a known email on the existing guest', () => {
    const result = plan([booking()], withAhmed());
    expect(result.rows[0].outcome).toBe('existing_guest');
    expect(result.rows[0].guest).toEqual({ id: 42, newKey: null, name: 'Ahmed Daoud' });
    expect(result.newGuests).toEqual([]);
    // the new phone is added, not made primary-over-nothing
    expect(result.methodsToAdd).toEqual([{ contactId: 42, kind: 'phone', value: '+966 54 148 8817', isPrimary: true }]);
  });

  it('matches on phone when the email is new, and never on name alone', () => {
    const data = empty();
    data.contactsByPhone.set('966541488817', [9]);
    data.contacts.set(9, { id: 9, firstName: 'A.', lastName: 'Daoud', doNotContact: false, emails: [], phones: ['966541488817'] });
    const byPhone = plan([booking({ email: 'new@example.com' })], data);
    expect(byPhone.rows[0].guest?.id).toBe(9);

    const nameOnly = plan([booking({ email: '', phone: '' })], withAhmed());
    expect(nameOnly.rows[0].outcome).toBe('new_guest');
  });

  it('creates a new guest with the email and phone as primary', () => {
    const result = plan([booking({ guestName: 'Mr Nimal Perera', email: 'nimal@example.com', phone: '0771234567' })]);
    expect(result.rows[0].outcome).toBe('new_guest');
    expect(result.newGuests).toEqual([
      {
        key: 0,
        firstRow: 1,
        firstName: 'Nimal',
        lastName: 'Perera',
        countryCode: 'LK',
        market: 'local',
        methods: [
          { kind: 'email', value: 'nimal@example.com', isPrimary: true },
          { kind: 'phone', value: '+94 77 123 4567', isPrimary: true },
        ],
      },
    ]);
  });

  it('creates a guest once when they have two bookings in the same file', () => {
    const result = plan([
      booking({ bookingReference: 'A', email: 'sam@example.com', phone: '' }),
      booking({ bookingReference: 'B', email: '', phone: '+44 7935 493395' }),
      booking({ bookingReference: 'C', email: 'sam@example.com', phone: '+44 7935 493395' }),
    ]);
    expect(result.newGuests).toHaveLength(2);
    expect(result.stayWrites.map((w) => w.guest)).toEqual([{ newKey: 0 }, { newKey: 1 }, { newKey: 0 }]);
    // the third row brings sam's phone, but it already belongs to the second new guest
    expect(result.newGuests[0].methods).toHaveLength(1);
    expect(result.rows[2].warnings).toContain('Same new guest as row 1');
  });

  it('updates a booking the CRM already has, without re-matching the guest', () => {
    const data = withAhmed();
    const stay = { id: 500, contactId: 77, propertyId: 'P02', propertyName: 'Rock Villa', bookingReference: 'RV-1001', status: 'checked_in' as const, cancellationReason: null };
    data.staysByKey.set(stayKey('P02', 'RV-1001'), stay);
    data.staysByReference.set('RV-1001', [stay]);
    const result = plan([booking({ status: 'Confirmed' })], data);
    expect(result.rows[0].outcome).toBe('update');
    expect(result.rows[0].stayId).toBe(500);
    expect(result.stayWrites[0]).toMatchObject({ existingId: 500, guest: { id: 77 }, status: 'checked_in' });
    expect(result.methodsToAdd).toEqual([]);
  });

  it('cancels from the file with a reason', () => {
    const data = empty();
    const stay = { id: 500, contactId: 77, propertyId: 'P02', propertyName: 'Rock Villa', bookingReference: 'RV-1001', status: 'booked' as const, cancellationReason: null };
    data.staysByKey.set(stayKey('P02', 'RV-1001'), stay);
    const result = plan([booking({ status: 'Cancelled' })], data);
    expect(result.stayWrites[0]).toMatchObject({ status: 'cancelled', cancellationReason: 'Cancelled in the booking system' });
  });

  it('treats a booking moved to another hotel as a cancellation there and a new stay here', () => {
    const data = withAhmed();
    const old = { id: 300, contactId: 42, propertyId: 'P04', propertyName: 'Mayur Lodge', bookingReference: 'RV-1001', status: 'booked' as const, cancellationReason: null };
    data.staysByKey.set(stayKey('P04', 'RV-1001'), old);
    data.staysByReference.set('RV-1001', [old]);
    const result = plan([booking()], data);
    expect(result.rows[0].outcome).toBe('existing_guest');
    expect(result.moves).toEqual([{ stayId: 300, reason: 'Moved to Rock Villa' }]);
  });

  it('refuses the same booking twice in one file', () => {
    const result = plan([booking(), booking()]);
    expect(result.rows.map((r) => r.outcome)).toEqual(['new_guest', 'error']);
    expect(result.rows[1].errors).toEqual(['Same booking reference and hotel as row 1']);
  });

  it('leaves out rows staff skipped', () => {
    const result = plan([booking(), booking({ bookingReference: 'X' })], empty(), new Set([0]));
    expect(result.rows.map((r) => r.outcome)).toEqual(['skipped', 'new_guest']);
    expect(result.stayWrites).toHaveLength(1);
  });

  it('records a ticked box once per guest, with the latest booking date, and flags do-not-contact', () => {
    const data = withAhmed();
    data.contacts.get(42)!.doNotContact = true;
    const result = plan(
      [
        booking({ bookingReference: 'A', marketingConsent: 'yes', bookedAt: '2026-01-05' }),
        booking({ bookingReference: 'B', marketingConsent: 'yes', bookedAt: '2026-06-05' }),
        booking({ bookingReference: 'C', marketingConsent: 'no', email: 'other@example.com', phone: '' }),
      ],
      data,
    );
    expect(result.consents).toHaveLength(1);
    expect(result.consents[0].guest).toEqual({ id: 42 });
    expect(result.consents[0].givenAt.toISOString()).toBe('2026-06-04T18:30:00.000Z'); // midnight in Colombo
    expect(result.consents[0].evidence).toBe('Ticked the marketing box on booking B (bookings.xlsx)');
    expect(result.doNotContact).toEqual([42]);
  });
});

describe('providedColumns', () => {
  it('only updates what the file has', () => {
    expect(providedColumns(['bookingReference', 'arrivalDate', 'roomType', 'specialRequests'])).toEqual([
      'roomType',
      'bookingRemarks',
    ]);
    expect(providedColumns(['roomRevenue'])).toEqual(['roomRevenue', 'currency']);
  });
});
