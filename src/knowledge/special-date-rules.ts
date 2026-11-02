import type { SPECIAL_DATE_OCCASIONS } from '../db/schema/index.js';

export type SpecialDateOccasion = (typeof SPECIAL_DATE_OCCASIONS)[number];

// How far ahead "in 12 days" is shown on the profile, and the window of the
// Upcoming occasions page (the upcoming_special_dates view uses the same 60).
export const UPCOMING_DAYS = 60;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function daysInMonth(month: number, year: number | null): number {
  if (month === 2) return year == null || isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// ---------------------------------------------------------------------
// Day and month are required, the year is optional. Impossible dates
// (31 April) are refused; 29 February is fine without a year, or in a leap
// year. Returns the message to show, or null when the date is fine.
// The database checks the same with special_dates_valid_date_check.
// ---------------------------------------------------------------------
export function specialDateError(day: number, month: number, year: number | null, thisYear: number): string | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return 'Choose a month';
  if (!Number.isInteger(day) || day < 1 || day > 31) return 'Enter a day between 1 and 31';
  if (year != null) {
    if (!Number.isInteger(year) || year < 1900) return 'Enter a year from 1900, or leave it blank';
    if (year > thisYear) return "The year can't be in the future";
  }
  const days = daysInMonth(month, year);
  if (day > days) {
    if (month === 2 && day === 29) return `${year} wasn't a leap year, so it had no 29 February`;
    return `${MONTH_NAMES[month - 1]} has only ${days} days`;
  }
  return null;
}

// ---------------------------------------------------------------------
// When the date next comes round, on or after `today` ('YYYY-MM-DD').
// 29 February falls on 1 March in other years, as in upcoming_special_dates.
// ---------------------------------------------------------------------
export function nextOccurrence(month: number, day: number, today: string): string {
  const thisYear = Number(today.slice(0, 4));
  const on = (year: number) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  const candidate = on(thisYear);
  return candidate >= today ? candidate : on(thisYear + 1);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// Age turning, or years married, on the next occurrence; null without a year.
export function yearsOn(nextDate: string, year: number | null): number | null {
  return year == null ? null : Number(nextDate.slice(0, 4)) - year;
}

// Everything the Special dates panel shows about when a date comes round.
export function upcoming(month: number, day: number, year: number | null, today: string) {
  const nextDate = nextOccurrence(month, day, today);
  const daysAway = daysBetween(today, nextDate);
  return { nextDate, daysAway, soon: daysAway <= UPCOMING_DAYS, years: yearsOn(nextDate, year) };
}
