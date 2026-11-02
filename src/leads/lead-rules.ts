import type {
  INTERACTION_DIRECTIONS,
  INTERACTION_KINDS,
  LEAD_LOST_REASONS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from '../db/schema/index.js';
import { OPEN_LEAD_STATUSES } from '../db/schema/index.js';

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadSource = (typeof LEAD_SOURCES)[number];
export type LostReason = (typeof LEAD_LOST_REASONS)[number];
export type InteractionKind = (typeof INTERACTION_KINDS)[number];
export type InteractionDirection = (typeof INTERACTION_DIRECTIONS)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  quoted: 'Quoted',
  booked: 'Booked',
  lost: 'Lost',
};

export const LOST_REASON_LABELS: Record<LostReason, string> = {
  price: 'Price',
  dates_unavailable: 'Dates unavailable',
  went_elsewhere: 'Went elsewhere',
  no_response: 'No response',
  plans_changed: 'Plans changed',
  other: 'Other',
};

// New, contacted and quoted are still being worked.
export const isOpen = (status: LeadStatus) => (OPEN_LEAD_STATUSES as readonly LeadStatus[]).includes(status);

// ---------------------------------------------------------------------
// Where a lead can move. New → contacted → quoted → booked, skipping steps
// as needed (a walk-in goes straight to booked), and to lost from any open
// status. A lost lead is reopened to new, contacted or quoted when the person
// comes back – not straight to booked. A booked lead can be reopened or
// marked lost, so a mistake (or a booking that fell through) can be put right.
// ---------------------------------------------------------------------
export function canMoveLead(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return false;
  if (from === 'lost') return isOpen(to);
  return true;
}

// What a move needs, checked against the lead after the change. Returns what
// is missing in words, or null when the move can go ahead.
export interface LeadAfterMove {
  status: LeadStatus;
  lostReason: LostReason | null;
  ownerId: number | null;
  followUpOn: string | null;
  quotedValue: number | null;
  currency: string | null;
  stayId: number | null;
  stayToLink: boolean; // marked booked by hand while the stay is still being entered
}

export function moveProblem(lead: LeadAfterMove): string | null {
  if (lead.status === 'lost' && !lead.lostReason) return 'Choose why the lead was lost';
  if (isOpen(lead.status)) {
    if (!lead.ownerId) return 'Choose who is following the lead up';
    if (!lead.followUpOn) return 'Choose a follow-up date';
  }
  if (lead.status === 'quoted' && (lead.quotedValue == null || !lead.currency)) {
    return 'Enter the quoted amount and currency';
  }
  if (lead.status === 'booked' && !lead.stayId && !lead.stayToLink) {
    return 'Link the stay, or mark it booked with the stay still to link';
  }
  return null;
}

// ---------------------------------------------------------------------
// Moves made by working the lead: the first reply (an outbound call, message
// or meeting) moves a new lead to contacted; entering a quote moves a new or
// contacted lead to quoted. Returns the new status, or null to leave it.
// ---------------------------------------------------------------------
export function statusAfterInteraction(status: LeadStatus, direction: InteractionDirection | null): LeadStatus | null {
  return status === 'new' && direction !== 'inbound' ? 'contacted' : null;
}

export function statusAfterQuote(status: LeadStatus): LeadStatus | null {
  return status === 'new' || status === 'contacted' ? 'quoted' : null;
}

// ---------------------------------------------------------------------
// Follow-up dates. Open leads only: a booked or lost lead has nothing to follow up.
// ---------------------------------------------------------------------
export type FollowUpState = 'overdue' | 'today' | 'later';

export function followUpState(status: LeadStatus, followUpOn: string | null, today: string): FollowUpState | null {
  if (!isOpen(status) || !followUpOn) return null;
  return followUpOn < today ? 'overdue' : followUpOn === today ? 'today' : 'later';
}

// ---------------------------------------------------------------------
// Automatic conversion. When a booking arrives (import or the stay form) for
// a person with an open lead at the same hotel, or with no hotel, that lead
// becomes booked and is linked to the stay. A lead already marked booked with
// its stay still to link is linked the same way. With several, the one whose
// requested check-in is closest to the arrival wins (undated leads last;
// then the newest). Each lead takes one stay, and each stay one lead.
// ---------------------------------------------------------------------
export interface ConvertibleLead {
  id: number;
  contactId: number;
  status: LeadStatus;
  propertyId: string | null;
  checkIn: string | null;
  stayId: number | null;
  createdAt: Date;
}

export interface ArrivingStay {
  id: number;
  contactId: number;
  propertyId: string;
  arrivalDate: string | null;
}

export const canConvert = (lead: Pick<ConvertibleLead, 'status' | 'stayId'>) =>
  isOpen(lead.status) || (lead.status === 'booked' && lead.stayId === null);

const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00Z`) - Date.parse(`${b}T00:00Z`)) / 86_400_000;

export function pickLeadForStay<L extends ConvertibleLead>(leads: L[], stay: ArrivingStay): L | null {
  const candidates = leads.filter(
    (l) => l.contactId === stay.contactId && canConvert(l) && (l.propertyId === null || l.propertyId === stay.propertyId),
  );
  const distance = (l: L) => (l.checkIn && stay.arrivalDate ? daysApart(l.checkIn, stay.arrivalDate) : Infinity);
  candidates.sort(
    (a, b) => distance(a) - distance(b) || b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id,
  );
  return candidates[0] ?? null;
}

// The pairs for a batch of new stays, soonest arrival first so an earlier
// booking takes the lead asking about earlier dates.
export function matchLeadsToStays<L extends ConvertibleLead>(leads: L[], stays: ArrivingStay[]) {
  const left = [...leads];
  const pairs: { lead: L; stay: ArrivingStay }[] = [];
  const ordered = [...stays].sort(
    (a, b) => (a.arrivalDate ?? '9999').localeCompare(b.arrivalDate ?? '9999') || a.id - b.id,
  );
  for (const stay of ordered) {
    const lead = pickLeadForStay(left, stay);
    if (!lead) continue;
    pairs.push({ lead, stay });
    left.splice(left.indexOf(lead), 1);
  }
  return pairs;
}
