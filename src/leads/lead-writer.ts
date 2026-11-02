import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { chunks } from '../common/sql.js';
import { contacts, leads, leadStatusChanges, OPEN_LEAD_STATUSES } from '../db/schema/index.js';
import type { Transaction } from '../db/with-staff.js';
import { matchLeadsToStays, type ArrivingStay, type LeadStatus, type LostReason } from './lead-rules.js';

// ---------------------------------------------------------------------
// Every change of a lead's status is logged in lead_status_changes, which the
// lead's timeline reads. Run inside withActingStaff(): created_by is who
// moved it. A row with from = to = booked records a stay linked later.
// ---------------------------------------------------------------------
export interface StatusChange {
  leadId: number;
  from: LeadStatus | null; // null: the lead was created
  to: LeadStatus;
  lostReason?: LostReason | null;
  stayId?: number | null;
  automatic?: boolean;
}

export async function logStatusChanges(tx: Transaction, changes: StatusChange[]) {
  for (const part of chunks(changes)) {
    await tx.insert(leadStatusChanges).values(
      part.map((c) => ({
        leadId: c.leadId,
        fromStatus: c.from,
        toStatus: c.to,
        lostReason: c.lostReason ?? null,
        stayId: c.stayId ?? null,
        automatic: c.automatic ?? false,
      })),
    );
  }
}

// ---------------------------------------------------------------------
// Automatic conversion (Module 7): new bookings – imported, or added on the
// stay form – mark the guest's matching lead booked and link it to the stay.
// The matching is pickLeadForStay() in lead-rules.ts. Cancelled and no-show
// stays never convert. Returns the leads that were booked.
// ---------------------------------------------------------------------
export async function convertLeadsForStays(tx: Transaction, stays: (ArrivingStay & { status: string })[]) {
  const arriving = stays.filter((s) => s.status !== 'cancelled' && s.status !== 'no_show');
  if (!arriving.length) return [];
  const contactIds = [...new Set(arriving.map((s) => s.contactId))];

  const candidates = [];
  for (const part of chunks(contactIds)) {
    candidates.push(
      ...(await tx
        .select({
          id: leads.id,
          contactId: leads.contactId,
          status: leads.status,
          propertyId: leads.propertyId,
          checkIn: leads.checkIn,
          stayId: leads.stayId,
          createdAt: leads.createdAt,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
        })
        .from(leads)
        .innerJoin(contacts, eq(contacts.id, leads.contactId))
        .where(
          and(
            inArray(leads.contactId, part),
            isNull(leads.deletedAt),
            or(inArray(leads.status, [...OPEN_LEAD_STATUSES]), and(eq(leads.status, 'booked'), isNull(leads.stayId))),
          ),
        )
        // two bookings arriving at once can't both take the same lead
        .for('update', { of: leads })),
    );
  }
  if (!candidates.length) return [];

  const pairs = matchLeadsToStays(candidates, arriving);
  for (const { lead, stay } of pairs) {
    await tx.update(leads).set({ status: 'booked', stayId: stay.id, lostReason: null }).where(eq(leads.id, lead.id));
  }
  await logStatusChanges(
    tx,
    pairs.map(({ lead, stay }) => ({ leadId: lead.id, from: lead.status, to: 'booked', stayId: stay.id, automatic: true })),
  );
  return pairs.map(({ lead, stay }) => ({
    leadId: lead.id,
    stayId: stay.id,
    name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || `Lead #${lead.id}`,
  }));
}

// Is this stay already the booking of another lead? A stay belongs to one lead.
export async function stayTakenBy(tx: Transaction, stayId: number, exceptLeadId: number): Promise<number | null> {
  const [row] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.stayId, stayId), isNull(leads.deletedAt), sql`${leads.id} <> ${exceptLeadId}`));
  return row?.id ?? null;
}
