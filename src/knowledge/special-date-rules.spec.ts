import { daysBetween, nextOccurrence, specialDateError, upcoming, yearsOn } from './special-date-rules.js';

describe('specialDateError', () => {
  it('refuses impossible dates with a clear message', () => {
    expect(specialDateError(31, 4, null, 2026)).toBe('April has only 30 days');
    expect(specialDateError(30, 2, null, 2026)).toBe('February has only 29 days');
    expect(specialDateError(0, 5, null, 2026)).toBe('Enter a day between 1 and 31');
    expect(specialDateError(5, 13, null, 2026)).toBe('Choose a month');
  });

  it('accepts a day and month with no year', () => {
    expect(specialDateError(3, 11, null, 2026)).toBeNull();
    expect(specialDateError(31, 12, null, 2026)).toBeNull();
  });

  it('allows 29 February without a year or in a leap year only', () => {
    expect(specialDateError(29, 2, null, 2026)).toBeNull();
    expect(specialDateError(29, 2, 2016, 2026)).toBeNull();
    expect(specialDateError(29, 2, 2000, 2026)).toBeNull();
    expect(specialDateError(29, 2, 2015, 2026)).toBe("2015 wasn't a leap year, so it had no 29 February");
    expect(specialDateError(29, 2, 1900, 2026)).toBe("1900 wasn't a leap year, so it had no 29 February");
  });

  it('keeps the year between 1900 and this year', () => {
    expect(specialDateError(3, 11, 2015, 2026)).toBeNull();
    expect(specialDateError(3, 11, 2026, 2026)).toBeNull();
    expect(specialDateError(3, 11, 2027, 2026)).toBe("The year can't be in the future");
    expect(specialDateError(3, 11, 1899, 2026)).toBe('Enter a year from 1900, or leave it blank');
  });
});

describe('nextOccurrence', () => {
  it('is later this year, today, or next year', () => {
    expect(nextOccurrence(11, 3, '2026-10-20')).toBe('2026-11-03');
    expect(nextOccurrence(10, 20, '2026-10-20')).toBe('2026-10-20');
    expect(nextOccurrence(1, 5, '2026-10-20')).toBe('2027-01-05');
  });

  it('puts 29 February on 1 March in other years', () => {
    expect(nextOccurrence(2, 29, '2026-01-10')).toBe('2026-03-01');
    expect(nextOccurrence(2, 29, '2027-12-01')).toBe('2028-02-29');
  });
});

describe('upcoming', () => {
  it('counts days across the year end', () => {
    expect(daysBetween('2026-12-25', '2027-01-04')).toBe(10);
  });

  it('says "11 years" for a 2015 wedding anniversary 14 days away', () => {
    expect(upcoming(11, 3, 2015, '2026-10-20')).toEqual({ nextDate: '2026-11-03', daysAway: 14, soon: true, years: 11 });
  });

  it('is not soon beyond 60 days, and has no years without a year', () => {
    expect(upcoming(3, 1, null, '2026-10-20')).toMatchObject({ daysAway: 132, soon: false, years: null });
    expect(yearsOn('2027-01-05', 1980)).toBe(47);
  });
});
