import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { SignedInStaff } from '../auth/signed-in-staff.js';
import { createdInfo, creator, joinCreator, joinUpdater, lastUpdated, softDelete, updater } from '../common/audit.js';
import { between, betweenDays, betweenTimes, blank, inList, noMethod, whenFields, whenYesNo } from '../common/filters.js';
import { likePattern } from '../common/sql.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  campaigns,
  contactMethods,
  contacts,
  interactions,
  leads,
  notes,
  occasions,
  OPEN_LEAD_STATUSES,
  properties,
  staffUsers,
  stays,
} from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { searchTerms } from '../guests/guest-rules.js';
import { insertGuest } from '../guests/guests.service.js';
import { addDays, hotelToday } from '../stays/stay-rules.js';
import { canMoveLead, isOpen, LEAD_STATUS_LABELS, moveProblem, statusAfterQuote, type LeadStatus } from './lead-rules.js';
import { logStatusChanges, stayTakenBy } from './lead-writer.js';
import {
  BOARD_CLOSED_DAYS,
  type BoardFilter,
  type ChangeLeadStatus,
  type CreateLead,
  type ListLeads,
  type UpdateLead,
} from './leads.schemas.js';
import { newestFirst, interactionItems, noteItems, statusItems } from './timeline.js';

const owner = alias(staffUsers, 'owner');
const linkedStay = alias(stays, 'linked_stay');
const linkedStayHotel = alias(properties, 'linked_stay_hotel');
const OPEN = [...OPEN_LEAD_STATUSES];
// numeric comes back from Postgres as a string; the app wants a number
const quoted = sql<number | null>`${leads.quotedValue}::float8`;
const phoneDigits = sql`regexp_replace(${contactMethods.value}, '[^0-9]', '', 'g')`;
const personName = sql<string>`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})`;

// Leads: each enquiry, from the first message to booked or lost. Leads of
// deleted guests are hidden with them. Status changes go through
// changeStatus() (or the automatic conversion in lead-writer.ts), which logs
// each move for the lead's timeline.
@Injectable()
export class LeadsService {
  constructor(@InjectDb() private readonly db: Database) {}

  // ---------- the list ----------
  async list(filter: ListLeads, staff: SignedInStaff) {
    const today = hotelToday();
    const conditions = this.filterConditions(filter, staff);
    if (filter.status) {
      const statuses = filter.status.flatMap((s) => (s === 'open' ? OPEN : [s]));
      conditions.push(inArray(leads.status, statuses));
    }
    if (filter.lostReason) conditions.push(eq(leads.status, 'lost'), inArray(leads.lostReason, filter.lostReason));
    if (filter.followUp) {
      conditions.push(inArray(leads.status, OPEN));
      const due = {
        overdue: sql`${leads.followUpOn} < ${today}`,
        today: eq(leads.followUpOn, today),
        due: lte(leads.followUpOn, today),
        week: and(gte(leads.followUpOn, today), lte(leads.followUpOn, addDays(today, 6)))!,
      }[filter.followUp];
      conditions.push(due);
    }
    const where = and(...conditions);
    // with a follow-up filter, the oldest follow-up first; otherwise newest leads first
    const orderBy = filter.followUp
      ? [asc(leads.followUpOn), asc(leads.createdAt), asc(leads.id)]
      : [desc(leads.createdAt), desc(leads.id)];

    const [rows, [{ total }]] = await Promise.all([
      this.cards()
        .where(where)
        .orderBy(...orderBy)
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize),
      this.db
        .select({ total: count() })
        .from(leads)
        .innerJoin(contacts, eq(contacts.id, leads.contactId))
        .where(where),
    ]);
    return { rows, total, page: filter.page, pageSize: filter.pageSize, today };
  }

  // ---------- the board ----------
  // Every open lead, oldest follow-up first; booked and lost from the last 30 days, latest first.
  async board(filter: BoardFilter, staff: SignedInStaff) {
    const today = hotelToday();
    const conditions = this.filterConditions(filter, staff);
    const since = new Date(Date.now() - BOARD_CLOSED_DAYS * 86_400_000);
    const [open, closed] = await Promise.all([
      this.cards()
        .where(and(...conditions, inArray(leads.status, OPEN)))
        .orderBy(asc(leads.followUpOn), asc(leads.createdAt), asc(leads.id))
        .limit(1000),
      this.cards()
        .where(and(...conditions, inArray(leads.status, ['booked', 'lost']), gte(leads.updatedAt, since)))
        .orderBy(desc(leads.updatedAt), desc(leads.id))
        .limit(500),
    ]);
    const columns: Record<LeadStatus, typeof open> = { new: [], contacted: [], quoted: [], booked: [], lost: [] };
    for (const lead of [...open, ...closed]) columns[lead.status].push(lead);
    return { today, closedDays: BOARD_CLOSED_DAYS, columns };
  }

  // ---------- My follow-ups ----------
  // The signed-in person's open leads due today or overdue, oldest first.
  async followUps(staff: SignedInStaff) {
    const today = hotelToday();
    const rows = await this.cards()
      .where(
        and(
          isNull(leads.deletedAt),
          isNull(contacts.deletedAt),
          eq(leads.ownerId, staff.id),
          inArray(leads.status, OPEN),
          lte(leads.followUpOn, today),
        ),
      )
      .orderBy(asc(leads.followUpOn), asc(leads.createdAt), asc(leads.id))
      .limit(500);
    return { today, rows };
  }

  // ---------- one lead ----------
  async get(id: number) {
    const [lead] = await this.db
      .select({
        ...this.cardColumns(),
        person: {
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          lifecycleStage: contacts.lifecycleStage,
          email: sql<string | null>`(select value from ${contactMethods} m where m.contact_id = ${contacts.id}
            and m.kind = 'email' and m.is_primary and m.deleted_at is null)`,
          phone: sql<string | null>`(select value from ${contactMethods} m where m.contact_id = ${contacts.id}
            and m.kind = 'phone' and m.is_primary and m.deleted_at is null)`,
        },
        occasionId: leads.occasionId,
        created: createdInfo(leads),
        lastUpdated: lastUpdated(leads),
      })
      .from(leads)
      .innerJoin(contacts, eq(contacts.id, leads.contactId))
      .leftJoin(properties, eq(properties.id, leads.propertyId))
      .leftJoin(occasions, eq(occasions.id, leads.occasionId))
      .leftJoin(owner, eq(owner.id, leads.ownerId))
      .leftJoin(linkedStay, and(eq(linkedStay.id, leads.stayId), isNull(linkedStay.deletedAt)))
      .leftJoin(linkedStayHotel, eq(linkedStayHotel.id, linkedStay.propertyId))
      .leftJoin(creator, joinCreator(leads))
      .leftJoin(updater, joinUpdater(leads))
      .where(and(eq(leads.id, id), isNull(leads.deletedAt), isNull(contacts.deletedAt)));
    if (!lead) throw new NotFoundException('Lead not found');
    return { ...lead, today: hotelToday() };
  }

  // Logged conversations, notes and status changes on the lead, newest first.
  async timeline(id: number) {
    await this.get(id);
    const [talks, leadNotes, changes] = await Promise.all([
      interactionItems(this.db, eq(interactions.leadId, id)),
      noteItems(this.db, eq(notes.leadId, id)),
      statusItems(this.db, id),
    ]);
    return newestFirst([...talks, ...leadNotes, ...changes]);
  }

  // The Leads panel on the guest profile, newest first.
  async forGuest(contactId: number) {
    const [guest] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)));
    if (!guest) throw new NotFoundException('Guest not found');
    const rows = await this.cards()
      .where(and(eq(leads.contactId, contactId), isNull(leads.deletedAt)))
      .orderBy(desc(leads.createdAt), desc(leads.id));
    return { today: hotelToday(), rows };
  }

  // Staff who can own leads (admin and management), for the owner pickers.
  // Deactivated staff are listed too, so their leads can be found and handed on.
  owners() {
    return this.db
      .select({ id: staffUsers.id, firstName: staffUsers.firstName, lastName: staffUsers.lastName, isActive: staffUsers.isActive })
      .from(staffUsers)
      .where(and(inArray(staffUsers.role, ['admin', 'management']), isNull(staffUsers.deletedAt)))
      .orderBy(asc(sql`lower(${staffUsers.firstName})`), asc(sql`lower(${staffUsers.lastName})`));
  }

  // ---------- new lead ----------
  // A new person is added as a contact of type lead; the database then moves
  // anyone at stage "lead" to "enquired" (t_leads_enquired). Guests further
  // along keep their stage.
  async create(input: CreateLead, staff: SignedInStaff) {
    const id = await withActingStaff(this.db, async (tx) => {
      const contactId = input.newPerson
        ? await insertGuest(tx, { ...input.newPerson, contactType: 'lead' })
        : await this.assertPerson(tx, input.contactId!);
      const ownerId = input.ownerId ?? staff.id;
      await this.assertOwner(tx, ownerId);
      const [row] = await tx
        .insert(leads)
        .values({
          contactId,
          source: input.source,
          propertyId: input.propertyId,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          adults: input.adults,
          children: input.children,
          occasionId: input.occasionId,
          ownerId,
          followUpOn: input.followUpOn,
          status: 'new',
        })
        .returning({ id: leads.id });
      await logStatusChanges(tx, [{ leadId: row.id, from: null, to: 'new' }]);
      if (input.note) await tx.insert(notes).values({ leadId: row.id, contactId, body: input.note });
      return row.id;
    });
    return this.get(id);
  }

  // ---------- edit ----------
  async update(id: number, input: UpdateLead) {
    const current = await this.get(id);
    const { quotedValue, ...rest } = input;
    const changes: Partial<typeof leads.$inferInsert> = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    if (quotedValue !== undefined) changes.quotedValue = quotedValue?.toFixed(2) ?? null;

    // checked against the saved lead, since only some fields may be sent
    if (current.source === 'campaign' && input.source) {
      throw new BadRequestException('This lead came from a campaign form, so its source stays Campaign');
    }
    const checkIn = input.checkIn !== undefined ? input.checkIn : current.checkIn;
    const checkOut = input.checkOut !== undefined ? input.checkOut : current.checkOut;
    if (checkIn && checkOut && checkOut < checkIn) throw new BadRequestException('Check-out cannot be before check-in');
    const amount = quotedValue !== undefined ? quotedValue : current.quotedValue;
    const currency = input.currency !== undefined ? input.currency : current.currency;
    if (amount != null && !currency) throw new BadRequestException('The quote needs a currency');
    if (current.status === 'quoted' && amount == null) {
      throw new BadRequestException('A quoted lead keeps its quote; change the status to remove it');
    }
    // entering a quote on a new or contacted lead moves it to quoted
    const next = quotedValue != null ? statusAfterQuote(current.status) : null;
    if (next) changes.status = next;
    if (!Object.keys(changes).length) return current;

    await withActingStaff(this.db, async (tx) => {
      if (input.ownerId && input.ownerId !== current.owner?.id) await this.assertOwner(tx, input.ownerId);
      await tx.update(leads).set(changes).where(eq(leads.id, id));
      if (next) await logStatusChanges(tx, [{ leadId: id, from: current.status, to: next }]);
    });
    return this.get(id);
  }

  // ---------- status ----------
  // From the board (drag) or the lead's Change status, Mark lost and reopen.
  // Leaving booked unlinks the stay; leaving lost clears the reason.
  async changeStatus(id: number, input: ChangeLeadStatus) {
    const current = await this.get(id);
    const to = input.status;
    if (!canMoveLead(current.status, to)) {
      throw new BadRequestException(
        current.status === to
          ? `The lead is already ${LEAD_STATUS_LABELS[to].toLowerCase()}`
          : `A lost lead can be reopened to new, contacted or quoted, not ${LEAD_STATUS_LABELS[to].toLowerCase()}`,
      );
    }
    const quotedValue = input.quotedValue !== undefined ? input.quotedValue : current.quotedValue;
    const after = {
      status: to,
      lostReason: to === 'lost' ? (input.lostReason ?? null) : null,
      ownerId: input.ownerId ?? current.owner?.id ?? null,
      followUpOn: input.followUpOn ?? current.followUpOn,
      quotedValue,
      currency: input.currency !== undefined ? input.currency : current.currency,
      stayId: to === 'booked' ? (input.stayId ?? null) : null,
      stayToLink: input.stayToLink,
    };
    const problem = moveProblem(after);
    if (problem) throw new BadRequestException(problem);
    if (after.quotedValue != null && !after.currency) throw new BadRequestException('The quote needs a currency');

    await withActingStaff(this.db, async (tx) => {
      if (after.stayId) await this.assertStayFor(tx, id, current.person.id, after.stayId);
      if (input.ownerId && input.ownerId !== current.owner?.id) await this.assertOwner(tx, input.ownerId);
      await tx
        .update(leads)
        .set({
          status: to,
          lostReason: after.lostReason,
          ownerId: after.ownerId,
          followUpOn: after.followUpOn,
          quotedValue: after.quotedValue?.toFixed(2) ?? null,
          currency: after.currency,
          stayId: after.stayId,
        })
        .where(eq(leads.id, id));
      await logStatusChanges(tx, [
        { leadId: id, from: current.status, to, lostReason: after.lostReason, stayId: after.stayId },
      ]);
      if (input.note) await tx.insert(notes).values({ leadId: id, contactId: current.person.id, body: input.note });
    });
    return this.get(id);
  }

  // Link stay: one of the person's stays becomes the lead's booking. An open
  // lead (or one booked with its stay still to link) becomes booked; a booked
  // lead's link is replaced. A lost lead is reopened first.
  async linkStay(id: number, stayId: number) {
    const current = await this.get(id);
    if (current.status === 'lost') throw new BadRequestException('Reopen the lead before linking a stay');
    if (current.stay?.id === stayId) return current;
    await withActingStaff(this.db, async (tx) => {
      await this.assertStayFor(tx, id, current.person.id, stayId);
      await tx.update(leads).set({ status: 'booked', stayId }).where(eq(leads.id, id));
      await logStatusChanges(tx, [{ leadId: id, from: current.status, to: 'booked', stayId }]);
    });
    return this.get(id);
  }

  // "Snooze to tomorrow" on My follow-ups.
  async snooze(id: number) {
    const current = await this.get(id);
    if (!isOpen(current.status)) throw new BadRequestException('Only open leads have a follow-up');
    await withActingStaff(this.db, (tx) =>
      tx.update(leads).set({ followUpOn: addDays(hotelToday(), 1) }).where(eq(leads.id, id)),
    );
    return this.get(id);
  }

  async remove(id: number) {
    await this.get(id);
    await withActingStaff(this.db, (tx) => softDelete(tx, leads, id));
  }

  async addNote(id: number, body: string) {
    const lead = await this.get(id);
    await withActingStaff(this.db, (tx) => tx.insert(notes).values({ leadId: id, contactId: lead.person.id, body }));
    return this.timeline(id);
  }

  // =====================================================================
  // helpers
  // =====================================================================
  private cardColumns() {
    return {
      id: leads.id,
      status: leads.status,
      source: leads.source,
      campaign: sql<{ id: number; name: string } | null>`(select json_build_object('id', c.id, 'name', c.name)
        from ${campaigns} c where c.id = ${leads.campaignId})`,
      contactId: leads.contactId,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      propertyId: leads.propertyId,
      hotel: properties.name,
      checkIn: leads.checkIn,
      checkOut: leads.checkOut,
      adults: leads.adults,
      children: leads.children,
      occasion: occasions.name,
      owner: sql<{ id: number; name: string } | null>`case when ${owner.id} is null then null
        else json_build_object('id', ${owner.id}, 'name', concat_ws(' ', ${owner.firstName}, ${owner.lastName})) end`,
      followUpOn: leads.followUpOn,
      quotedValue: quoted,
      currency: leads.currency,
      lostReason: leads.lostReason,
      // its status too, so a booking that was cancelled after the lead booked shows
      stay: sql<{ id: number; hotel: string; arrivalDate: string | null; status: string } | null>`case when ${linkedStay.id} is null
        then null else json_build_object('id', ${linkedStay.id}, 'hotel', ${linkedStayHotel.name},
          'arrivalDate', ${linkedStay.arrivalDate}, 'status', ${linkedStay.status}) end`,
      createdAt: leads.createdAt,
      updatedAt: leads.updatedAt,
    };
  }

  // Lead cards for the board, the list, My follow-ups and the profile panel.
  private cards() {
    return this.db
      .select(this.cardColumns())
      .from(leads)
      .innerJoin(contacts, eq(contacts.id, leads.contactId))
      .leftJoin(properties, eq(properties.id, leads.propertyId))
      .leftJoin(occasions, eq(occasions.id, leads.occasionId))
      .leftJoin(owner, eq(owner.id, leads.ownerId))
      .leftJoin(linkedStay, and(eq(linkedStay.id, leads.stayId), isNull(linkedStay.deletedAt)))
      .leftJoin(linkedStayHotel, eq(linkedStayHotel.id, linkedStay.propertyId))
      .$dynamic();
  }

  private filterConditions(filter: BoardFilter, staff: SignedInStaff): (SQL | undefined)[] {
    const conditions: (SQL | undefined)[] = [isNull(leads.deletedAt), isNull(contacts.deletedAt)];
    if (filter.owner) {
      // any of: staff ids, 'me' (the signed-in person) and 'none' (no owner)
      const ownerIds = filter.owner.map((o) => (o === 'me' ? staff.id : o)).filter((o) => o !== 'none');
      conditions.push(
        or(inList(leads.ownerId, ownerIds), filter.owner.includes('none') ? isNull(leads.ownerId) : undefined),
      );
    }
    conditions.push(
      inList(leads.propertyId, filter.propertyId),
      inList(leads.source, filter.source),
      inList(leads.campaignId, filter.campaignId),
    );
    if (filter.q) conditions.push(this.searchCondition(filter.q));
    // the "More filters" panel
    conditions.push(inList(leads.occasionId, filter.occasionId));
    conditions.push(
      betweenDays(leads.checkIn, filter.checkInFrom, filter.checkInTo),
      betweenTimes(leads.createdAt, filter.createdFrom, filter.createdTo),
      between(leads.quotedValue, filter.quoteMin, filter.quoteMax),
      whenYesNo(
        filter.contacted,
        sql`exists (select 1 from ${interactions} i where i.lead_id = ${leads.id} and i.deleted_at is null)`,
      ),
      whenYesNo(filter.stayToLink, and(eq(leads.status, 'booked'), isNull(leads.stayId))!),
    );
    conditions.push(
      inList(leads.currency, filter.currency),
      inList(contacts.market, filter.market),
      inList(contacts.countryCode, filter.country),
      whenFields(filter, {
        hotel: isNull(leads.propertyId),
        checkIn: isNull(leads.checkIn),
        checkOut: isNull(leads.checkOut),
        party: and(isNull(leads.adults), isNull(leads.children))!,
        occasion: isNull(leads.occasionId),
        personName: and(blank(contacts.firstName), blank(contacts.lastName))!,
        personEmail: noMethod(leads.contactId, 'email'),
        personPhone: noMethod(leads.contactId, 'phone'),
      }),
    );
    return conditions;
  }

  // every word in the person's name, or the text in an email, or the digits in a phone
  private searchCondition(q: string): SQL {
    const { text, words, phoneDigits: digits } = searchTerms(q);
    const methodMatches: SQL[] = [ilike(contactMethods.value, likePattern(text))];
    for (const d of digits) methodMatches.push(and(eq(contactMethods.kind, 'phone'), sql`${phoneDigits} like ${likePattern(d)}`)!);
    const byMethod = this.db
      .select({ id: contactMethods.contactId })
      .from(contactMethods)
      .where(and(isNull(contactMethods.deletedAt), or(...methodMatches)));
    return or(and(...words.map((w) => ilike(personName, likePattern(w)))), inArray(leads.contactId, byMethod))!;
  }

  private async assertPerson(tx: Transaction, contactId: number) {
    const [person] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)));
    if (!person) throw new BadRequestException('That person no longer exists');
    return person.id;
  }

  private async assertOwner(tx: Transaction, ownerId: number) {
    const [row] = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(
        and(
          eq(staffUsers.id, ownerId),
          eq(staffUsers.isActive, true),
          inArray(staffUsers.role, ['admin', 'management']),
          isNull(staffUsers.deletedAt),
        ),
      );
    if (!row) throw new BadRequestException('Choose an active admin or management user as the owner');
  }

  // The stay must be the person's own, and not already another lead's booking.
  private async assertStayFor(tx: Transaction, leadId: number, contactId: number, stayId: number) {
    const [stay] = await tx
      .select({ id: stays.id })
      .from(stays)
      .where(and(eq(stays.id, stayId), eq(stays.contactId, contactId), isNull(stays.deletedAt)));
    if (!stay) throw new BadRequestException("That stay isn't one of this person's");
    const other = await stayTakenBy(tx, stayId, leadId);
    if (other) throw new BadRequestException(`That stay is already the booking for lead #${other}`);
  }
}
