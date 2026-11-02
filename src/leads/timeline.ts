import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { createdInfo, creator, joinCreator } from '../common/audit.js';
import type { Database } from '../db/drizzle.module.js';
import {
  companies,
  contacts,
  interactions,
  leadStatusChanges,
  notes,
  properties,
  staffUsers,
  stays,
} from '../db/schema/index.js';

// ---------------------------------------------------------------------
// The timelines on a lead, a company and a guest: logged conversations,
// notes and (on a lead) status changes, newest first. Each item has a
// `type` and `at`, so the app draws them in one list.
// ---------------------------------------------------------------------
const talker = alias(staffUsers, 'talker'); // who had the conversation
const staffName = (t: typeof talker) => sql<string | null>`nullif(concat_ws(' ', ${t.firstName}, ${t.lastName}), '')`;
const personName = sql<string | null>`nullif(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}), '')`;

export async function interactionItems(db: Database, condition: SQL, limit = 200) {
  const rows = await db
    .select({
      id: interactions.id,
      kind: interactions.kind,
      direction: interactions.direction,
      at: interactions.occurredAt,
      summary: interactions.summary,
      staffId: interactions.staffId,
      staffName: staffName(talker),
      leadId: interactions.leadId,
      feedbackId: interactions.feedbackId, // following up a feedback response (Module 8)
      contactId: interactions.contactId,
      person: personName,
      companyId: interactions.companyId,
      company: companies.name,
      authorId: interactions.createdBy, // who logged it; may differ from who spoke
      logged: createdInfo(interactions),
    })
    .from(interactions)
    .leftJoin(talker, eq(talker.id, interactions.staffId))
    .leftJoin(contacts, eq(contacts.id, interactions.contactId))
    .leftJoin(companies, eq(companies.id, interactions.companyId))
    .leftJoin(creator, joinCreator(interactions))
    .where(and(condition, isNull(interactions.deletedAt)))
    .orderBy(desc(interactions.occurredAt), desc(interactions.id))
    .limit(limit);
  return rows.map((r) => ({ type: 'interaction' as const, ...r }));
}

export async function noteItems(db: Database, condition: SQL, limit = 200) {
  const rows = await db
    .select({
      id: notes.id,
      at: notes.createdAt,
      body: notes.body,
      contactId: notes.contactId,
      leadId: notes.leadId,
      authorId: notes.createdBy,
      created: createdInfo(notes),
      editedAt: notes.editedAt,
    })
    .from(notes)
    .leftJoin(creator, joinCreator(notes))
    .where(and(condition, isNull(notes.deletedAt)))
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .limit(limit);
  return rows.map((r) => ({ type: 'note' as const, ...r }));
}

export async function statusItems(db: Database, leadId: number) {
  const rows = await db
    .select({
      id: leadStatusChanges.id,
      at: leadStatusChanges.createdAt,
      from: leadStatusChanges.fromStatus,
      to: leadStatusChanges.toStatus,
      lostReason: leadStatusChanges.lostReason,
      automatic: leadStatusChanges.automatic,
      stayId: stays.id,
      stayHotel: properties.name,
      stayArrival: stays.arrivalDate,
      by: sql<string | null>`nullif(concat_ws(' ', ${creator.firstName}, ${creator.lastName}), '')`,
    })
    .from(leadStatusChanges)
    .leftJoin(stays, and(eq(stays.id, leadStatusChanges.stayId), isNull(stays.deletedAt)))
    .leftJoin(properties, eq(properties.id, stays.propertyId))
    .leftJoin(creator, joinCreator(leadStatusChanges))
    .where(eq(leadStatusChanges.leadId, leadId))
    .orderBy(desc(leadStatusChanges.createdAt), desc(leadStatusChanges.id));
  return rows.map(({ stayId, stayHotel, stayArrival, ...r }) => ({
    type: 'status' as const,
    ...r,
    stay: stayId ? { id: stayId, hotel: stayHotel!, arrivalDate: stayArrival } : null,
  }));
}

// Newest first. For the same moment, a status change shows above the reply
// that caused it, and "Lead created" below the first note saved with it.
const ORDER = { status: 0, interaction: 1, note: 2 } as const;
const rank = (i: { type: keyof typeof ORDER; from?: unknown }) => (i.type === 'status' && i.from === null ? 3 : ORDER[i.type]);
export function newestFirst<T extends { type: keyof typeof ORDER; at: Date; id: number; from?: unknown }>(items: T[]): T[] {
  return items.sort((a, b) => b.at.getTime() - a.at.getTime() || rank(a) - rank(b) || b.id - a.id);
}
