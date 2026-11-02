import {
  canMoveLead,
  followUpState,
  matchLeadsToStays,
  moveProblem,
  pickLeadForStay,
  statusAfterInteraction,
  statusAfterQuote,
  type ConvertibleLead,
  type LeadAfterMove,
} from './lead-rules.js';

describe('lead moves', () => {
  it('goes forward, skips steps, and drops to lost from any open status', () => {
    expect(canMoveLead('new', 'contacted')).toBe(true);
    expect(canMoveLead('new', 'booked')).toBe(true); // a walk-in
    expect(canMoveLead('contacted', 'lost')).toBe(true);
    expect(canMoveLead('quoted', 'lost')).toBe(true);
  });

  it('reopens a lost lead to an open status, never straight to booked', () => {
    expect(canMoveLead('lost', 'new')).toBe(true);
    expect(canMoveLead('lost', 'quoted')).toBe(true);
    expect(canMoveLead('lost', 'booked')).toBe(false);
  });

  it('is not a move to stay put', () => {
    expect(canMoveLead('quoted', 'quoted')).toBe(false);
  });
});

describe('what a move needs', () => {
  const base: LeadAfterMove = {
    status: 'new',
    lostReason: null,
    ownerId: 1,
    followUpOn: '2026-10-27',
    quotedValue: null,
    currency: null,
    stayId: null,
    stayToLink: false,
  };

  it('refuses lost without a reason', () => {
    expect(moveProblem({ ...base, status: 'lost' })).toMatch(/why/);
    expect(moveProblem({ ...base, status: 'lost', lostReason: 'price' })).toBeNull();
  });

  it('needs an owner and a follow-up date while open', () => {
    expect(moveProblem({ ...base, ownerId: null })).toMatch(/following/);
    expect(moveProblem({ ...base, status: 'contacted', followUpOn: null })).toMatch(/follow-up/);
    // a lost lead has nothing to follow up
    expect(moveProblem({ ...base, status: 'lost', lostReason: 'other', followUpOn: null })).toBeNull();
  });

  it('needs the amount and currency for quoted', () => {
    expect(moveProblem({ ...base, status: 'quoted', quotedValue: 1200 })).toMatch(/quoted amount/);
    expect(moveProblem({ ...base, status: 'quoted', quotedValue: 1200, currency: 'USD' })).toBeNull();
  });

  it('needs a stay for booked, unless it is still to link', () => {
    expect(moveProblem({ ...base, status: 'booked' })).toMatch(/Link the stay/);
    expect(moveProblem({ ...base, status: 'booked', stayId: 9 })).toBeNull();
    expect(moveProblem({ ...base, status: 'booked', stayToLink: true })).toBeNull();
  });
});

describe('working the lead', () => {
  it('moves a new lead to contacted on the first reply, not on an inbound message', () => {
    expect(statusAfterInteraction('new', 'outbound')).toBe('contacted');
    expect(statusAfterInteraction('new', null)).toBe('contacted');
    expect(statusAfterInteraction('new', 'inbound')).toBeNull();
    expect(statusAfterInteraction('quoted', 'outbound')).toBeNull();
  });

  it('moves new and contacted leads to quoted when a quote is entered', () => {
    expect(statusAfterQuote('new')).toBe('quoted');
    expect(statusAfterQuote('contacted')).toBe('quoted');
    expect(statusAfterQuote('quoted')).toBeNull();
    expect(statusAfterQuote('lost')).toBeNull();
  });
});

describe('follow-ups', () => {
  it('is overdue before today, due today, or later – for open leads only', () => {
    expect(followUpState('new', '2026-10-25', '2026-10-26')).toBe('overdue');
    expect(followUpState('contacted', '2026-10-26', '2026-10-26')).toBe('today');
    expect(followUpState('quoted', '2026-10-30', '2026-10-26')).toBe('later');
    expect(followUpState('booked', '2026-10-25', '2026-10-26')).toBeNull();
  });
});

describe('automatic conversion', () => {
  const lead = (id: number, extra: Partial<ConvertibleLead> = {}): ConvertibleLead => ({
    id,
    contactId: 1,
    status: 'quoted',
    propertyId: 'P01',
    checkIn: null,
    stayId: null,
    createdAt: new Date(`2026-10-0${id}T10:00:00Z`),
    ...extra,
  });
  const stay = { id: 50, contactId: 1, propertyId: 'P01', arrivalDate: '2026-12-20' };

  it('takes an open lead at the same hotel, or with no hotel', () => {
    expect(pickLeadForStay([lead(1)], stay)?.id).toBe(1);
    expect(pickLeadForStay([lead(1, { propertyId: null })], stay)?.id).toBe(1);
    expect(pickLeadForStay([lead(1, { propertyId: 'P02' })], stay)).toBeNull();
  });

  it("leaves other people's leads, lost leads and leads already booked with a stay", () => {
    expect(pickLeadForStay([lead(1, { contactId: 2 })], stay)).toBeNull();
    expect(pickLeadForStay([lead(1, { status: 'lost' })], stay)).toBeNull();
    expect(pickLeadForStay([lead(1, { status: 'booked', stayId: 7 })], stay)).toBeNull();
  });

  it('links a lead marked booked with its stay still to link', () => {
    expect(pickLeadForStay([lead(1, { status: 'booked' })], stay)?.id).toBe(1);
  });

  it('chooses the closest dates, then undated, then the newest', () => {
    const leads = [
      lead(1, { checkIn: '2026-11-01' }),
      lead(2, { checkIn: '2026-12-18' }),
      lead(3),
      lead(4),
    ];
    expect(pickLeadForStay(leads, stay)?.id).toBe(2);
    expect(pickLeadForStay([lead(3), lead(4)], stay)?.id).toBe(4);
    expect(pickLeadForStay([lead(4), lead(1, { checkIn: '2027-06-01' })], stay)?.id).toBe(1);
  });

  it('gives each lead one stay, earliest arrival first', () => {
    const pairs = matchLeadsToStays(
      [lead(1, { checkIn: '2026-12-01' }), lead(2, { checkIn: '2027-03-01' })],
      [
        { ...stay, id: 61, arrivalDate: '2027-03-02' },
        { ...stay, id: 60, arrivalDate: '2026-12-02' },
        { ...stay, id: 62, arrivalDate: '2027-05-01' },
      ],
    );
    expect(pairs.map((p) => [p.stay.id, p.lead.id])).toEqual([
      [60, 1],
      [61, 2],
    ]);
  });
});
