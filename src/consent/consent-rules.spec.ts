import {
  choiceIsLatest,
  cleanEmails,
  exportSummary,
  givenAtFor,
  givenOnError,
  latestChoices,
  notOnListReasons,
} from './consent-rules.js';

describe('the latest explicit choice wins', () => {
  const at = (iso: string) => new Date(iso);

  it('replaces a choice given earlier, or one with no date', () => {
    expect(choiceIsLatest(null, at('2026-10-21T10:00:00Z'))).toBe(true);
    expect(choiceIsLatest({ givenAt: null }, at('2026-10-21T10:00:00Z'))).toBe(true);
    expect(choiceIsLatest({ givenAt: at('2026-10-01T00:00:00Z') }, at('2026-10-21T10:00:00Z'))).toBe(true);
    expect(choiceIsLatest({ givenAt: at('2026-10-21T10:00:00Z') }, at('2026-10-21T10:00:00Z'))).toBe(true);
  });

  it('never lets an older choice undo a newer one', () => {
    // opted out on 21 Oct; a booking tick from 1 Oct is imported afterwards
    expect(choiceIsLatest({ givenAt: at('2026-10-21T10:00:00Z') }, at('2026-10-01T00:00:00Z'))).toBe(false);
  });

  it('keeps one choice per guest and channel in a batch: the latest', () => {
    const choices = [
      { contactId: 1, channel: 'email' as const, givenAt: at('2026-01-01T00:00:00Z'), tag: 'a' },
      { contactId: 1, channel: 'email' as const, givenAt: at('2026-03-01T00:00:00Z'), tag: 'b' },
      { contactId: 1, channel: 'email' as const, givenAt: at('2026-02-01T00:00:00Z'), tag: 'c' },
      { contactId: 1, channel: 'whatsapp' as const, givenAt: at('2026-01-01T00:00:00Z'), tag: 'd' },
      { contactId: 2, channel: 'email' as const, givenAt: at('2026-01-01T00:00:00Z'), tag: 'e' },
    ];
    expect(latestChoices(choices).map((c) => c.tag)).toEqual(['b', 'd', 'e']);
  });
});

describe('the date a choice was given', () => {
  // 26 Oct 2026, 15:00 in Colombo
  const now = new Date('2026-10-26T09:30:00Z');

  it('takes today as now, so it beats anything recorded earlier today', () => {
    expect(givenAtFor('2026-10-26', now)).toEqual(now);
  });

  it('takes an earlier day as the start of that day in Colombo', () => {
    expect(givenAtFor('2026-10-21', now).toISOString()).toBe('2026-10-20T18:30:00.000Z');
  });

  it('refuses future and impossible dates', () => {
    expect(givenOnError('2026-10-26', now)).toBeNull();
    expect(givenOnError('2026-10-27', now)).toBe("The date can't be in the future");
    expect(givenOnError('2026-02-30', now)).toBe('Enter a valid date');
    expect(givenOnError('1999-12-31', now)).toBe('Enter a date from 2000');
  });

  it('uses the date in Colombo, not the server', () => {
    // 23:00 UTC on the 26th is already the 27th in Colombo
    expect(givenOnError('2026-10-27', new Date('2026-10-26T23:00:00Z'))).toBeNull();
  });
});

describe('why a guest is not on the marketing email list', () => {
  const listed = {
    doNotContact: false,
    emailConsent: 'opted_in' as const,
    primaryEmail: { isShared: false, status: 'valid' as const },
  };

  it('lists a guest only when every condition holds', () => {
    expect(notOnListReasons(listed)).toEqual([]);
    expect(notOnListReasons({ ...listed, primaryEmail: { isShared: false, status: 'unverified' } })).toEqual([]);
  });

  it('gives every reason that applies', () => {
    expect(notOnListReasons({ ...listed, doNotContact: true })).toEqual(['do_not_contact']);
    expect(notOnListReasons({ ...listed, emailConsent: 'unknown' })).toEqual(['no_opt_in']);
    expect(notOnListReasons({ ...listed, emailConsent: 'not_opted_in' })).toEqual(['no_opt_in']);
    expect(notOnListReasons({ ...listed, emailConsent: null })).toEqual(['no_opt_in']);
    expect(notOnListReasons({ ...listed, primaryEmail: null })).toEqual(['no_personal_email']);
    expect(notOnListReasons({ ...listed, primaryEmail: { isShared: true, status: 'valid' } })).toEqual(['no_personal_email']);
    expect(notOnListReasons({ ...listed, primaryEmail: { isShared: false, status: 'bounced' } })).toEqual(['email_bounced']);
    expect(notOnListReasons({ ...listed, primaryEmail: { isShared: false, status: 'invalid' } })).toEqual(['email_invalid']);
    expect(notOnListReasons({ doNotContact: true, emailConsent: 'opted_out', primaryEmail: null })).toEqual([
      'do_not_contact',
      'no_opt_in',
      'no_personal_email',
    ]);
  });
});

describe('emails from an unsubscribe or bounce file', () => {
  it('cleans, lowercases and de-duplicates them, and sets aside anything else', () => {
    expect(cleanEmails([' Ahmed@Example.com', 'ahmed@example.com', 'mailto:nisha@example.lk', '', 'not an email', 'a@b'])).toEqual({
      emails: ['ahmed@example.com', 'nisha@example.lk'],
      invalid: ['not an email', 'a@b'],
    });
  });
});

describe('the export log summary', () => {
  it('puts the filters in words', () => {
    expect(exportSummary({}, {})).toBe('Whole list');
    expect(
      exportSummary(
        { market: ['foreign'], country: ['GB'], propertyId: ['P02'], stage: ['repeat_guest'], lastStayFrom: '2025-01-01', tagId: [3] },
        { countries: { GB: 'United Kingdom' }, hotels: { P02: 'Rock Villa' }, tags: { 3: 'VIP / industry' } },
      ),
    ).toBe('Foreign · United Kingdom · Stayed at Rock Villa · Repeat guest · Last stay from 1 Jan 2025 · Tagged VIP / industry');
    expect(exportSummary({ lastStayFrom: '2025-01-01', lastStayTo: '2025-12-31' }, {})).toBe(
      'Last stay 1 Jan 2025 – 31 Dec 2025',
    );
    expect(exportSummary({ lastStayTo: '2025-12-31' }, {})).toBe('Last stay up to 31 Dec 2025');
  });

  it('describes the "More filters" too', () => {
    expect(
      exportSummary(
        {
          contactType: ['guest'],
          lastHotelId: ['P02'],
          staysMin: 2,
          birthdayMonth: [3],
          optedInFrom: '2026-01-01',
          addedTo: '2026-06-30',
          upcomingStay: 'no',
          lowRating: 'no',
        },
        { hotels: { P02: 'Rock Villa' } },
      ),
    ).toBe(
      'Guests · Last stay at Rock Villa · At least 2 stays · Birthday in March · Opted in from 1 Jan 2026 · Added up to 30 Jun 2026 · No booking to come · No low ratings',
    );
    expect(exportSummary({ staysMin: 1, staysMax: 1 }, {})).toBe('1 stay');
    expect(exportSummary({ staysMin: 0, staysMax: 3 }, {})).toBe('0–3 stays');
    expect(exportSummary({ staysMax: 1, upcomingStay: 'yes', lowRating: 'yes' }, {})).toBe(
      'Up to 1 stay · Booked to come · Gave a low rating',
    );
  });

  it('names the fields filled in and missing, with "and" when all of them must be', () => {
    expect(exportSummary({ filled: ['firstName', 'country'], filledMatch: 'all', missing: ['birthday'] }, {})).toBe(
      'Has first name and country · Missing birthday',
    );
    expect(exportSummary({ filled: ['lastName', 'country'] }, {})).toBe('Has last name or country');
    expect(exportSummary({ missing: ['firstName'] }, {})).toBe('Missing first name');
    expect(exportSummary({ missing: ['firstName', 'country'] }, {})).toBe('Missing first name or country');
    expect(exportSummary({ missing: ['firstName', 'lastName', 'birthday'], missingMatch: 'all' }, {})).toBe(
      'Missing first name, last name and birthday',
    );
  });

  it('joins several values of a filter with "or"', () => {
    const hotels = { P01: 'Mayur Lodge', P02: 'Rock Villa', P03: 'Lake Lodge' };
    expect(
      exportSummary(
        { market: ['local', 'foreign'], propertyId: ['P01', 'P02', 'P03'], tagId: [3, 9], birthdayMonth: [12, 1] },
        { hotels, tags: { 3: 'VIP / industry' } },
      ),
    ).toBe(
      'Local or Foreign · Stayed at Mayur Lodge, Rock Villa or Lake Lodge · Tagged VIP / industry or #9 · Birthday in December or January',
    );
  });
});
