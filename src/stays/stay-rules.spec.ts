import { addDays, canChangeStatus, hotelToday, statusOnReimport } from './stay-rules.js';

describe('hotelToday', () => {
  it('is the date in Colombo, not on the server', () => {
    // 20:00 UTC on 21 Oct is 01:30 on 22 Oct in Colombo
    expect(hotelToday(new Date('2026-10-21T20:00:00Z'))).toBe('2026-10-22');
    expect(hotelToday(new Date('2026-10-21T10:00:00Z'))).toBe('2026-10-21');
  });

  it('adds days across months', () => {
    expect(addDays('2026-10-29', 6)).toBe('2026-11-04');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('status changes', () => {
  it('follows booked → checked in → checked out, with cancel and no-show', () => {
    expect(canChangeStatus('booked', 'checked_in')).toBe(true);
    expect(canChangeStatus('checked_in', 'checked_out')).toBe(true);
    expect(canChangeStatus('booked', 'no_show')).toBe(true);
    expect(canChangeStatus('booked', 'cancelled')).toBe(true);
    expect(canChangeStatus('checked_out', 'cancelled')).toBe(true);
  });

  it('can undo a click and reinstate, but not skip steps', () => {
    expect(canChangeStatus('checked_in', 'booked')).toBe(true);
    expect(canChangeStatus('checked_out', 'checked_in')).toBe(true);
    expect(canChangeStatus('cancelled', 'booked')).toBe(true);
    expect(canChangeStatus('booked', 'checked_out')).toBe(false);
    expect(canChangeStatus('cancelled', 'checked_out')).toBe(false);
    expect(canChangeStatus('no_show', 'checked_in')).toBe(false);
  });
});

describe('statusOnReimport', () => {
  it('keeps the stay as it is when the file has no status', () => {
    expect(statusOnReimport('checked_out', undefined)).toEqual({ status: 'checked_out' });
  });

  it('takes cancellations and no-shows from the booking system', () => {
    expect(statusOnReimport('booked', 'cancelled')).toEqual({ status: 'cancelled' });
    expect(statusOnReimport('checked_out', 'cancelled')).toEqual({ status: 'cancelled' });
    expect(statusOnReimport('booked', 'no_show')).toEqual({ status: 'no_show' });
  });

  it('never undoes a check-in or check-out made at the front desk', () => {
    expect(statusOnReimport('checked_in', 'booked')).toEqual({ status: 'checked_in' });
    expect(statusOnReimport('checked_out', 'booked')).toEqual({ status: 'checked_out' });
    expect(statusOnReimport('checked_out', 'checked_in')).toEqual({ status: 'checked_out' });
    expect(statusOnReimport('booked', 'checked_out')).toEqual({ status: 'checked_out' });
  });

  it('never brings back a cancelled stay, and says so', () => {
    const result = statusOnReimport('cancelled', 'booked');
    expect(result.status).toBe('cancelled');
    expect(result.note).toMatch(/left cancelled/);
  });
});
