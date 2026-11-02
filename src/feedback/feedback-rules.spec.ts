import {
  needsFollowUp,
  parseDepartment,
  parseRating,
  planStaffList,
  planUpload,
  type CandidateStay,
  type UploadLookups,
} from './feedback-rules.js';

describe('parseRating', () => {
  it('reads the ways form tools write a rating', () => {
    for (const [text, rating] of [
      ['4', 4],
      ['4.0', 4],
      ['2/5', 2],
      ['5 out of 5', 5],
      ['1 star', 1],
      ['3 stars', 3],
      ['★★★★☆', 4],
      ['', null],
      [undefined, null],
    ] as const) {
      expect(parseRating(text)).toEqual({ rating });
    }
  });

  it('refuses anything that is not a whole number from 1 to 5', () => {
    for (const text of ['0', '6', '4.5', '8/10', 'Excellent', '★★★★★★']) {
      expect(parseRating(text)).toHaveProperty('error');
    }
  });
});

describe('needsFollowUp', () => {
  it('is a rating of 1 or 2 not yet followed up', () => {
    expect(needsFollowUp({ rating: 2, followedUpAt: null })).toBe(true);
    expect(needsFollowUp({ rating: 1, followedUpAt: null })).toBe(true);
    expect(needsFollowUp({ rating: 3, followedUpAt: null })).toBe(false);
    expect(needsFollowUp({ rating: null, followedUpAt: null })).toBe(false);
    expect(needsFollowUp({ rating: 2, followedUpAt: new Date() })).toBe(false);
  });
});

describe('planUpload', () => {
  const stay = (over: Partial<CandidateStay>): CandidateStay => ({
    id: 1,
    contactId: 10,
    firstName: 'Ahmed',
    lastName: 'Daoud',
    propertyId: 'P01',
    hotel: 'Mayur Lodge',
    bookingReference: 'ML-100',
    arrivalDate: '2026-10-01',
    departureDate: '2026-10-04',
    status: 'checked_out',
    feedbackId: null,
    ...over,
  });
  const now = new Date('2026-10-27T06:00:00Z');
  const lookups = (stays: CandidateStay[], emails: Record<string, CandidateStay[]> = {}): UploadLookups => {
    const byReference = new Map<string, CandidateStay[]>();
    for (const s of stays) {
      const key = s.bookingReference!.toLowerCase();
      byReference.set(key, [...(byReference.get(key) ?? []), s]);
    }
    return {
      byReference,
      byEmail: new Map(Object.entries(emails)),
      hotels: [
        { id: 'P01', name: 'Mayur Lodge' },
        { id: 'P02', name: 'Rock Villa' },
      ],
      now,
    };
  };

  it('matches by booking reference and reads the rating, review and date', () => {
    const [row] = planUpload(
      [{ bookingReference: 'ml-100', rating: '2', review: 'Room was noisy', submittedAt: '2026-10-05 09:30' }],
      lookups([stay({})]),
    );
    expect(row).toMatchObject({ outcome: 'new', rating: 2, review: 'Room was noisy', problem: null });
    expect(row.stay?.id).toBe(1);
    expect(row.submittedAt?.toISOString()).toBe('2026-10-05T04:00:00.000Z'); // 09:30 in Colombo
  });

  it('uses the hotel to tell apart the same reference at two hotels', () => {
    const both = lookups([stay({}), stay({ id: 2, propertyId: 'P02', hotel: 'Rock Villa' })]);
    expect(planUpload([{ bookingReference: 'ML-100', rating: '5' }], both)[0]).toMatchObject({ outcome: 'unmatched' });
    expect(planUpload([{ bookingReference: 'ML-100', hotel: 'rock villa', rating: '5' }], both)[0].stay?.id).toBe(2);
    expect(planUpload([{ bookingReference: 'ML-100', hotel: 'Nowhere', rating: '5' }], both)[0].problem).toMatch(/isn't one of ours/);
  });

  it('falls back to the email, using the arrival date when the guest has several stays', () => {
    const a = stay({ id: 1, bookingReference: null });
    const b = stay({ id: 2, bookingReference: null, arrivalDate: '2026-06-01' });
    const l = lookups([], { 'ahmed@example.com': [a, b] });
    expect(planUpload([{ email: 'Ahmed@example.com', rating: '4' }], l)[0].problem).toMatch(/has 2 stays/);
    expect(planUpload([{ email: 'ahmed@example.com', arrivalDate: '01/06/2026', rating: '4' }], l)[0].stay?.id).toBe(2);
    // a future booking can't be the one when no date is given
    const upcoming = stay({ id: 3, bookingReference: null, status: 'booked', arrivalDate: '2026-12-01' });
    const one = lookups([], { 'ahmed@example.com': [a, upcoming] });
    expect(planUpload([{ email: 'ahmed@example.com', rating: '4' }], one)[0].stay?.id).toBe(1);
  });

  it('skips a stay that already has a response, or is not over, or appears twice', () => {
    const l = lookups([
      stay({ id: 1, feedbackId: 77 }),
      stay({ id: 2, bookingReference: 'ML-200', status: 'checked_in' }),
      stay({ id: 3, bookingReference: 'ML-300' }),
    ]);
    const rows = planUpload(
      [
        { bookingReference: 'ML-100', rating: '5' },
        { bookingReference: 'ML-200', rating: '5' },
        { bookingReference: 'ML-300', rating: '5' },
        { bookingReference: 'ML-300', review: 'Again' },
      ],
      l,
    );
    expect(rows.map((r) => r.outcome)).toEqual(['exists', 'error', 'new', 'error']);
    expect(rows[1].problem).toMatch(/checked in, not checked out/);
    expect(rows[3].problem).toMatch(/Row 3 is for the same stay/);
    // the existing response is the reason given, even when the row is faulty too
    expect(planUpload([{ bookingReference: 'ML-100', rating: '9' }], l)[0]).toMatchObject({ outcome: 'exists' });
  });

  it('refuses empty responses, bad ratings and dates in the future', () => {
    const l = lookups([stay({})]);
    expect(planUpload([{ bookingReference: 'ML-100' }], l)[0].problem).toBe('No rating or review');
    expect(planUpload([{ bookingReference: 'ML-100', rating: '9' }], l)[0].outcome).toBe('error');
    expect(planUpload([{ bookingReference: 'ML-100', rating: '3', submittedAt: '2027-01-01' }], l)[0].problem).toMatch(/future/);
    // a review alone is fine, dated now
    expect(planUpload([{ bookingReference: 'ML-100', review: 'Lovely' }], l)[0]).toMatchObject({ outcome: 'new', rating: null, submittedAt: now });
  });

  it('says why a row has no stay', () => {
    expect(planUpload([{ rating: '4' }], lookups([]))[0].problem).toMatch(/No booking reference or email/);
    expect(planUpload([{ bookingReference: 'X1', rating: '4' }], lookups([]))[0].problem).toMatch(/No stay with booking reference X1/);
  });
});

describe('parseDepartment', () => {
  it('recognises the words hotels use', () => {
    expect(parseDepartment('F&B')).toEqual({ department: 'food_beverage', recognised: true });
    expect(parseDepartment('Food & Beverage')).toEqual({ department: 'food_beverage', recognised: true });
    expect(parseDepartment('Front Desk')).toEqual({ department: 'front_office', recognised: true });
    expect(parseDepartment('Drivers')).toEqual({ department: 'transport', recognised: true });
    expect(parseDepartment('')).toEqual({ department: 'other', recognised: true });
    expect(parseDepartment('Butlers')).toEqual({ department: 'other', recognised: false });
  });
});

describe('planStaffList', () => {
  it('splits names, keeps single names as first names and skips people already listed', () => {
    const rows = planStaffList(
      [
        { name: 'Kamal Perera', department: 'Transport', jobTitle: 'Driver' },
        { name: 'Nimali' },
        { firstName: 'Sunil', lastName: 'Fernando', department: 'Butlers' },
        { name: 'kamal perera' },
        { name: '' },
        { name: 'Ruwan Silva' },
      ],
      new Set(['ruwan silva']),
    );
    expect(rows[0]).toMatchObject({ outcome: 'new', firstName: 'Kamal', lastName: 'Perera', department: 'transport', jobTitle: 'Driver' });
    expect(rows[1]).toMatchObject({ outcome: 'new', firstName: 'Nimali', lastName: null });
    expect(rows[2]).toMatchObject({ outcome: 'new', department: 'other' });
    expect(rows[2].note).toMatch(/not recognised/);
    expect(rows[3]).toMatchObject({ outcome: 'exists', problem: 'Same name as row 1' });
    expect(rows[4]).toMatchObject({ outcome: 'error', problem: 'No name' });
    expect(rows[5]).toMatchObject({ outcome: 'exists', problem: 'Already on the list' });
  });
});
