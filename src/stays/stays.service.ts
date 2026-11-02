import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, not, or, sql, type SQL } from 'drizzle-orm';
import { createdInfo, creator, joinCreator, joinUpdater, lastUpdated, restore, softDelete, updater } from '../common/audit.js';
import { between, betweenDays, inList, whenYesNo } from '../common/filters.js';
import { likePattern } from '../common/sql.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { companies, contactOverview, contacts, feedback, leads, occasions, properties, stays } from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { LOW_RATING } from '../feedback/feedback-rules.js';
import { insertGuest } from '../guests/guests.service.js';
import { convertLeadsForStays } from '../leads/lead-writer.js';
import { addDays, canChangeStatus, hotelToday, STATUS_LABELS, type StayStatus } from './stay-rules.js';
import type { ChangeStatus, CreateStay, ListStays, QuickView, UpdateStay } from './stays.schemas.js';

const guestName = sql<string>`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})`;
// numeric comes back from Postgres as a string; the app wants a number
const revenue = sql<number | null>`${stays.roomRevenue}::float8`;

// "Upcoming" covers stays that are still to happen or happening now.
const LIVE: StayStatus[] = ['booked', 'checked_in'];

// Stays: one row per visit to one of the hotels. Every list hides deleted
// stays and stays of deleted guests. Only checked-out stays count towards a
// guest's stage; the lifecycle trigger moves the stage as the status changes.
@Injectable()
export class StaysService {
  constructor(@InjectDb() private readonly db: Database) {}

  // ---------- the stays list ----------
  async list(filter: ListStays) {
    const today = hotelToday();
    const conditions: (SQL | undefined)[] = [isNull(stays.deletedAt), isNull(contacts.deletedAt)];
    if (filter.view) conditions.push(this.viewCondition(filter.view, today));
    if (filter.q) conditions.push(this.searchCondition(filter.q));
    conditions.push(inList(stays.propertyId, filter.propertyId), inList(stays.status, filter.status));
    if (filter.arrivalFrom) conditions.push(gte(stays.arrivalDate, filter.arrivalFrom));
    if (filter.arrivalTo) conditions.push(lte(stays.arrivalDate, filter.arrivalTo));
    conditions.push(
      inList(stays.channel, filter.channel),
      inList(stays.occasionId, filter.occasionId),
      inList(stays.bookingCompanyId, filter.companyId),
    );
    conditions.push(...this.moreConditions(filter));
    const where = and(...conditions);

    // arrivals and departures are worked through soonest first; the full list newest first
    const sort = filter.sort ?? (filter.view === 'in_house' || filter.view === 'departing_today' ? 'departure' : 'arrival');
    const order = filter.order ?? (filter.view ? 'asc' : 'desc');
    const column = sort === 'departure' ? stays.departureDate : stays.arrivalDate;
    const dir = order === 'asc' ? asc : desc;

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: stays.id,
          contactId: stays.contactId,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          propertyId: stays.propertyId,
          hotel: properties.name,
          status: stays.status,
          arrivalDate: stays.arrivalDate,
          departureDate: stays.departureDate,
          nights: stays.nights,
          roomType: stays.roomType,
          adults: stays.adults,
          children: stays.children,
          channel: stays.channel,
          agent: companies.name,
          occasion: occasions.name,
          bookingReference: stays.bookingReference,
        })
        .from(stays)
        .innerJoin(contacts, eq(contacts.id, stays.contactId))
        .innerJoin(properties, eq(properties.id, stays.propertyId))
        .leftJoin(companies, eq(companies.id, stays.bookingCompanyId))
        .leftJoin(occasions, eq(occasions.id, stays.occasionId))
        .where(where)
        .orderBy(sql`${column} ${sql.raw(order)} nulls last`, lower(contacts.lastName), dir(stays.id))
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize),
      this.db
        .select({ total: count() })
        .from(stays)
        .innerJoin(contacts, eq(contacts.id, stays.contactId))
        .where(where),
    ]);
    return { rows, total, page: filter.page, pageSize: filter.pageSize, today };
  }

  // How many stays each quick filter shows, for the buttons across the top.
  async quickCounts() {
    const today = hotelToday();
    const counted = (view: QuickView) => sql<number>`count(*) filter (where ${this.viewCondition(view, today)})::int`;
    const [row] = await this.db
      .select({
        arriving_today: counted('arriving_today'),
        in_house: counted('in_house'),
        departing_today: counted('departing_today'),
        arriving_week: counted('arriving_week'),
      })
      .from(stays)
      .innerJoin(contacts, eq(contacts.id, stays.contactId))
      .where(
        and(
          isNull(stays.deletedAt),
          isNull(contacts.deletedAt),
          // only stays near today can be in any of them
          or(gte(stays.departureDate, addDays(today, -1)), eq(stays.status, 'checked_in')),
        ),
      );
    return { ...row, today };
  }

  // ---------- one stay ----------
  async get(id: number) {
    const [stay] = await this.db
      .select({
        id: stays.id,
        guest: {
          id: stays.contactId,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          lifecycleStage: contacts.lifecycleStage,
          email: contactOverview.email,
          phone: contactOverview.phone,
        },
        propertyId: stays.propertyId,
        hotel: properties.name,
        status: stays.status,
        cancellationReason: stays.cancellationReason,
        arrivalDate: stays.arrivalDate,
        departureDate: stays.departureDate,
        nights: stays.nights,
        bookingReference: stays.bookingReference,
        roomType: stays.roomType,
        adults: stays.adults,
        children: stays.children,
        roomRevenue: revenue,
        currency: stays.currency,
        channel: stays.channel,
        bookingCompanyId: stays.bookingCompanyId,
        agent: companies.name,
        occasionId: stays.occasionId,
        occasion: occasions.name,
        bookingRemarks: stays.bookingRemarks,
        // the lead this stay booked (Module 7)
        leadId: sql<number | null>`(select l.id from ${leads} l where l.stay_id = ${stays.id} and l.deleted_at is null
          order by l.id limit 1)`,
        // its feedback response (Module 8)
        feedbackId: sql<number | null>`(select f.id from ${feedback} f where f.stay_id = ${stays.id} and f.deleted_at is null)`,
        created: createdInfo(stays),
        lastUpdated: lastUpdated(stays),
      })
      .from(stays)
      .innerJoin(contacts, eq(contacts.id, stays.contactId))
      .innerJoin(properties, eq(properties.id, stays.propertyId))
      .leftJoin(contactOverview, eq(contactOverview.id, stays.contactId))
      .leftJoin(companies, eq(companies.id, stays.bookingCompanyId))
      .leftJoin(occasions, eq(occasions.id, stays.occasionId))
      .leftJoin(creator, joinCreator(stays))
      .leftJoin(updater, joinUpdater(stays))
      .where(and(eq(stays.id, id), isNull(stays.deletedAt), isNull(contacts.deletedAt)));
    if (!stay) throw new NotFoundException('Stay not found');
    return stay;
  }

  // ---------- a guest's stays, for the Stays panel on the profile ----------
  // Every stay newest first, cancelled ones included (shown struck through).
  // The totals count checked-out stays only, like the guest's stage.
  async forGuest(contactId: number) {
    const [guest] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)));
    if (!guest) throw new NotFoundException('Guest not found');

    const rows = await this.db
      .select({
        id: stays.id,
        propertyId: stays.propertyId,
        hotel: properties.name,
        status: stays.status,
        cancellationReason: stays.cancellationReason,
        arrivalDate: stays.arrivalDate,
        departureDate: stays.departureDate,
        nights: stays.nights,
        roomType: stays.roomType,
        adults: stays.adults,
        children: stays.children,
        occasion: occasions.name,
        bookingReference: stays.bookingReference,
      })
      .from(stays)
      .innerJoin(properties, eq(properties.id, stays.propertyId))
      .leftJoin(occasions, eq(occasions.id, stays.occasionId))
      .where(and(eq(stays.contactId, contactId), isNull(stays.deletedAt)))
      .orderBy(sql`${stays.arrivalDate} desc nulls last`, desc(stays.id));

    const visits = rows.filter((s) => s.status === 'checked_out');
    const today = hotelToday();
    const upcoming = rows
      .filter((s) => LIVE.includes(s.status) && (!s.departureDate || s.departureDate >= today))
      .sort((a, b) => (a.arrivalDate ?? '').localeCompare(b.arrivalDate ?? ''));
    return {
      totals: {
        stays: visits.length,
        nights: visits.reduce((sum, s) => sum + (s.nights ?? 0), 0),
        hotels: [...new Set(visits.map((s) => s.hotel))],
        lastStay: visits.map((s) => s.arrivalDate).filter(Boolean).sort().at(-1) ?? null,
        nextStay: upcoming[0] ? { id: upcoming[0].id, arrivalDate: upcoming[0].arrivalDate, hotel: upcoming[0].hotel } : null,
      },
      stays: rows,
    };
  }

  // ---------- add, edit, status, delete ----------
  async create(input: CreateStay) {
    const id = await withActingStaff(this.db, async (tx) => {
      const contactId = input.newGuest ? await insertGuest(tx, input.newGuest) : input.contactId!;
      if (!input.newGuest) await this.assertGuest(tx, contactId);
      const [row] = await tx
        .insert(stays)
        .values({
          contactId,
          propertyId: input.propertyId,
          arrivalDate: input.arrivalDate,
          departureDate: input.departureDate,
          bookingReference: input.bookingReference,
          roomType: input.roomType,
          adults: input.adults,
          children: input.children,
          roomRevenue: input.roomRevenue?.toFixed(2),
          currency: input.currency,
          channel: input.channel,
          bookingCompanyId: input.bookingCompanyId,
          occasionId: input.occasionId,
          bookingRemarks: input.bookingRemarks,
          status: input.status,
        })
        .returning({ id: stays.id });
      // a matching open lead becomes booked with this stay (Module 7)
      await convertLeadsForStays(tx, [
        { id: row.id, contactId, propertyId: input.propertyId, arrivalDate: input.arrivalDate, status: input.status },
      ]);
      return row.id;
    });
    return this.get(id);
  }

  async update(id: number, input: UpdateStay) {
    const current = await this.get(id);
    const { roomRevenue, ...rest } = input;
    const changes: Partial<typeof stays.$inferInsert> = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    if (roomRevenue !== undefined) changes.roomRevenue = roomRevenue?.toFixed(2) ?? null;

    // checked against the saved stay, since only some fields may be sent
    const arrival = input.arrivalDate ?? current.arrivalDate;
    const departure = input.departureDate ?? current.departureDate;
    if (arrival && departure && departure < arrival) throw new BadRequestException('Departure cannot be before arrival');
    const amount = roomRevenue !== undefined ? roomRevenue : current.roomRevenue;
    const currency = input.currency !== undefined ? input.currency : current.currency;
    if (amount != null && !currency) throw new BadRequestException('Room revenue needs a currency');
    if (!Object.keys(changes).length) return current;

    await withActingStaff(this.db, async (tx) => {
      if (input.contactId && input.contactId !== current.guest.id) await this.assertGuest(tx, input.contactId);
      await tx.update(stays).set(changes).where(eq(stays.id, id));
    });
    return this.get(id);
  }

  // Check in, check out, no-show, cancel (with a reason) and their undo steps.
  async changeStatus(id: number, input: ChangeStatus) {
    const current = await this.get(id);
    if (current.status === input.status) return current;
    if (!canChangeStatus(current.status, input.status)) {
      throw new BadRequestException(
        `A stay that is ${STATUS_LABELS[current.status].toLowerCase()} can't be marked ${STATUS_LABELS[input.status].toLowerCase()}`,
      );
    }
    const reason = input.status === 'cancelled' || input.status === 'no_show' ? (input.reason ?? null) : null;
    await withActingStaff(this.db, (tx) =>
      tx.update(stays).set({ status: input.status, cancellationReason: reason }).where(eq(stays.id, id)),
    );
    return this.get(id);
  }

  // For mistakes and junk rows; a booking that won't happen is cancelled instead.
  async remove(id: number) {
    await withActingStaff(this.db, (tx) => softDelete(tx, stays, id));
  }

  async restore(id: number) {
    await withActingStaff(this.db, (tx) => restore(tx, stays, id));
    return this.get(id);
  }

  // ---------- helpers ----------
  private viewCondition(view: QuickView, today: string): SQL {
    switch (view) {
      case 'arriving_today':
        return and(eq(stays.arrivalDate, today), inArray(stays.status, LIVE))!;
      case 'in_house':
        return eq(stays.status, 'checked_in');
      case 'departing_today':
        return and(eq(stays.departureDate, today), inArray(stays.status, ['checked_in', 'checked_out']))!;
      case 'arriving_week':
        return and(gte(stays.arrivalDate, today), lte(stays.arrivalDate, addDays(today, 6)), inArray(stays.status, LIVE))!;
    }
  }

  // The "More filters" panel: dates, party, room, revenue, feedback and the guest.
  private moreConditions(filter: ListStays): (SQL | undefined)[] {
    const party = sql`coalesce(${stays.adults}, 0) + coalesce(${stays.children}, 0)`;
    const hasFeedback = (extra = sql`true`) =>
      sql`exists (select 1 from ${feedback} f where f.stay_id = ${stays.id} and f.deleted_at is null and ${extra})`;
    return [
      betweenDays(stays.departureDate, filter.departureFrom, filter.departureTo),
      between(stays.nights, filter.nightsMin, filter.nightsMax),
      filter.guestsMin !== undefined || filter.guestsMax !== undefined
        ? and(sql`(${stays.adults} is not null or ${stays.children} is not null)`, between(party, filter.guestsMin, filter.guestsMax))
        : undefined,
      whenYesNo(filter.children, sql`coalesce(${stays.children}, 0) > 0`),
      filter.roomType ? ilike(stays.roomType, likePattern(filter.roomType)) : undefined,
      inList(stays.currency, filter.currency),
      between(stays.roomRevenue, filter.revenueMin, filter.revenueMax),
      whenYesNo(filter.remarks, sql`nullif(trim(${stays.bookingRemarks}), '') is not null`),
      filter.feedback === 'given'
        ? hasFeedback()
        : filter.feedback === 'low'
          ? hasFeedback(sql`f.rating <= ${LOW_RATING}`)
          : filter.feedback === 'none'
            ? not(hasFeedback())
            : undefined,
      whenYesNo(filter.fromLead, sql`exists (select 1 from ${leads} l where l.stay_id = ${stays.id} and l.deleted_at is null)`),
      inList(contacts.lifecycleStage, filter.guestStage),
      inList(contacts.market, filter.market),
      inList(contacts.countryCode, filter.country),
    ];
  }

  // every word in the guest's name, or the booking reference
  private searchCondition(q: string): SQL {
    const text = q.trim().replace(/\s+/g, ' ');
    const words = text.split(' ').filter(Boolean);
    return or(and(...words.map((w) => ilike(guestName, likePattern(w)))), ilike(stays.bookingReference, likePattern(text)))!;
  }

  private async assertGuest(tx: Transaction, contactId: number) {
    const [guest] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)));
    if (!guest) throw new BadRequestException('That guest no longer exists');
  }
}

const lower = (column: typeof contacts.lastName) => sql`lower(${column})`;
