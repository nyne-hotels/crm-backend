import type { STAY_STATUSES } from '../db/schema/index.js';

export type StayStatus = (typeof STAY_STATUSES)[number];

// ---------------------------------------------------------------------
// The hotels are all in Sri Lanka, so "today" (arriving today, in house,
// departing today) is the date in Colombo, whatever the server's timezone.
// ---------------------------------------------------------------------
export const HOTEL_TIME_ZONE = 'Asia/Colombo';

// 'YYYY-MM-DD'
export function hotelToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: HOTEL_TIME_ZONE }).format(now);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Status changes staff can make on the stay detail. Each status lists where
// it can go next; the reverse steps undo a click made by mistake.
//   booked      → checked in, no-show, cancelled
//   checked in  → checked out, back to booked (undo check-in), cancelled
//   checked out → back to checked in (undo check-out), cancelled
//   cancelled / no-show → back to booked (reinstate)
// Only checked-out stays count towards the guest's stage; the lifecycle
// trigger moves the stage both ways as stays enter and leave checked out.
// ---------------------------------------------------------------------
export const STATUS_CHANGES: Record<StayStatus, readonly StayStatus[]> = {
  booked: ['checked_in', 'no_show', 'cancelled'],
  checked_in: ['checked_out', 'booked', 'cancelled'],
  checked_out: ['checked_in', 'cancelled'],
  cancelled: ['booked'],
  no_show: ['booked'],
};

export const STATUS_LABELS: Record<StayStatus, string> = {
  booked: 'Booked',
  checked_in: 'Checked in',
  checked_out: 'Checked out',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

export function canChangeStatus(from: StayStatus, to: StayStatus): boolean {
  return STATUS_CHANGES[from].includes(to);
}

// A stay can be entered by hand as already in house or already over (a
// walk-in, or a stay recorded after the fact), but not as cancelled.
export const NEW_STAY_STATUSES = ['booked', 'checked_in', 'checked_out'] as const satisfies readonly StayStatus[];

// ---------------------------------------------------------------------
// A re-imported booking's status. The booking system is the source of truth
// for cancellations and no-shows, but it often lags behind the front desk,
// so a file still saying "booked" never undoes a check-in or check-out made
// in the CRM, and never brings back a stay staff cancelled.
// Returns the status to save, and a note for the preview when the file is ignored.
// ---------------------------------------------------------------------
export function statusOnReimport(
  current: StayStatus,
  fromFile: StayStatus | undefined,
): { status: StayStatus; note?: string } {
  if (!fromFile || fromFile === current) return { status: current };
  if (fromFile === 'cancelled' || fromFile === 'no_show') return { status: fromFile };
  if (current === 'cancelled' || current === 'no_show') {
    return {
      status: current,
      note: `${STATUS_LABELS[current]} in the CRM but ${STATUS_LABELS[fromFile].toLowerCase()} in the file; left ${STATUS_LABELS[current].toLowerCase()}`,
    };
  }
  const order: StayStatus[] = ['booked', 'checked_in', 'checked_out'];
  if (order.indexOf(fromFile) < order.indexOf(current)) return { status: current };
  return { status: fromFile };
}
