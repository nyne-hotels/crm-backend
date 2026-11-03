import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, isNotNull, isNull, not, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { can } from '../auth/permissions.js';
import type { SignedInStaff } from '../auth/signed-in-staff.js';
import { createdInfo, creator, joinCreator, joinUpdater, lastUpdated, softDelete, updater } from '../common/audit.js';
import { betweenDays, betweenTimes, blank, inList, noMethod, whenFields, whenYesNo } from '../common/filters.js';
import { likePattern } from '../common/sql.js';
import { givenAtFor } from '../consent/consent-rules.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  contactOverview,
  contacts,
  employeeMentions,
  feedback,
  interactions,
  notes,
  properties,
  propertyRatings,
  staffUsers,
  stays,
} from '../db/schema/index.js';
import { withActingStaff } from '../db/with-staff.js';
import { interactionItems, newestFirst, noteItems } from '../leads/timeline.js';
import { hotelToday } from '../stays/stay-rules.js';
import { canHaveFeedback, LOW_RATING, STAY_NOT_OVER } from './feedback-rules.js';
import type { CreateFeedback, ListFeedback, UpdateFeedback } from './feedback.schemas.js';
import { mentionsOf } from './mentions.service.js';

const follower = alias(staffUsers, 'follower'); // who marked it followed up
const guestName = sql<string>`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})`;
const needsFollowUp = sql<boolean>`coalesce(${feedback.rating} <= ${LOW_RATING}, false) and ${feedback.followedUpAt} is null`;
const mentionCount = sql<number>`(select count(*)::int from ${employeeMentions} m
  where m.feedback_id = ${feedback.id} and m.deleted_at is null)`;
// live feedback on a live stay of a live guest
const live = and(isNull(feedback.deletedAt), isNull(stays.deletedAt), isNull(contacts.deletedAt))!;
const TAB_CONDITIONS = {
  all: undefined,
  needs_follow_up: needsFollowUp,
  followed_up: isNotNull(feedback.followedUpAt),
};

// Guest feedback (Module 8): one response per stay, from the post-stay form.
// The guest and hotel come from the stay. Ratings of 1 or 2 need follow-up
// until a manager marks them followed up with an outcome. What guests said
// about named employees (mentions) is only sent to roles that may see it.
@Injectable()
export class FeedbackService {
  constructor(@InjectDb() private readonly db: Database) {}

  // ---------- the inbox ----------
  // Newest first, with a count for each tab under the same filters.
  async list(filter: ListFeedback, staff: SignedInStaff) {
    const showMentions = can(staff.role, 'employees', 'view');
    const conditions: (SQL | undefined)[] = [live];
    conditions.push(inList(stays.propertyId, filter.propertyId), inList(feedback.rating, filter.rating));
    conditions.push(betweenTimes(feedback.submittedAt, filter.from, filter.to));
    // the "More filters" panel
    if (filter.q) conditions.push(this.searchCondition(filter.q));
    const mentioned = (sentiment?: 'positive' | 'negative') =>
      sql`exists (select 1 from ${employeeMentions} m where m.feedback_id = ${feedback.id} and m.deleted_at is null
            ${sentiment ? sql`and m.sentiment = ${sentiment}` : sql``})`;
    conditions.push(
      whenYesNo(
        filter.contacted,
        sql`exists (select 1 from ${interactions} i where i.feedback_id = ${feedback.id} and i.deleted_at is null)`,
      ),
      betweenDays(stays.departureDate, filter.stayFrom, filter.stayTo),
      inList(stays.channel, filter.channel),
      inList(contacts.market, filter.market),
      whenFields(filter, {
        rating: isNull(feedback.rating),
        review: blank(feedback.review),
        bookingReference: blank(stays.bookingReference),
        stayDates: or(isNull(stays.arrivalDate), isNull(stays.departureDate))!,
        guestName: and(blank(contacts.firstName), blank(contacts.lastName))!,
        guestEmail: noMethod(contacts.id, 'email'),
        guestPhone: noMethod(contacts.id, 'phone'),
      }),
    );
    // mentions are only filtered for roles that may see them
    if (showMentions && filter.mentions) {
      conditions.push(
        filter.mentions === 'any'
          ? mentioned()
          : filter.mentions === 'praise'
            ? mentioned('positive')
            : filter.mentions === 'criticism'
              ? mentioned('negative')
              : not(mentioned()),
      );
    }
    const tab = TAB_CONDITIONS[filter.tab];
    const where = and(...conditions, tab);

    const [rows, [counts]] = await Promise.all([
      this.db
        .select({
          id: feedback.id,
          submittedAt: feedback.submittedAt,
          stayId: stays.id,
          propertyId: stays.propertyId,
          hotel: properties.name,
          arrivalDate: stays.arrivalDate,
          departureDate: stays.departureDate,
          contactId: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          rating: feedback.rating,
          review: feedback.review,
          needsFollowUp,
          followedUpAt: feedback.followedUpAt,
          mentions: showMentions ? mentionCount : sql<null>`null`,
        })
        .from(feedback)
        .innerJoin(stays, eq(stays.id, feedback.stayId))
        .innerJoin(contacts, eq(contacts.id, stays.contactId))
        .innerJoin(properties, eq(properties.id, stays.propertyId))
        .where(where)
        .orderBy(desc(feedback.submittedAt), desc(feedback.id))
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize),
      this.db
        .select({
          all: count(),
          needs_follow_up: sql<number>`count(*) filter (where ${needsFollowUp})::int`,
          followed_up: sql<number>`count(*) filter (where ${feedback.followedUpAt} is not null)::int`,
        })
        .from(feedback)
        .innerJoin(stays, eq(stays.id, feedback.stayId))
        .innerJoin(contacts, eq(contacts.id, stays.contactId))
        .where(and(...conditions)),
    ]);
    return { rows, total: counts[filter.tab], counts, page: filter.page, pageSize: filter.pageSize };
  }

  // ---------- one response ----------
  async get(id: number, staff: SignedInStaff) {
    const [row] = await this.db
      .select({
        id: feedback.id,
        rating: feedback.rating,
        review: feedback.review,
        submittedAt: feedback.submittedAt,
        needsFollowUp,
        followUp: sql<{ at: string; by: string | null; outcome: string } | null>`case
          when ${feedback.followedUpAt} is null then null
          else json_build_object('at', ${feedback.followedUpAt}, 'outcome', ${feedback.followUpOutcome},
            'by', nullif(concat_ws(' ', ${follower.firstName}, ${follower.lastName}), '')) end`,
        stay: {
          id: stays.id,
          propertyId: stays.propertyId,
          hotel: properties.name,
          status: stays.status,
          arrivalDate: stays.arrivalDate,
          departureDate: stays.departureDate,
          nights: stays.nights,
          bookingReference: stays.bookingReference,
        },
        guest: {
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          lifecycleStage: contacts.lifecycleStage,
          email: contactOverview.email,
          phone: contactOverview.phone,
        },
        created: createdInfo(feedback),
        lastUpdated: lastUpdated(feedback),
      })
      .from(feedback)
      .innerJoin(stays, eq(stays.id, feedback.stayId))
      .innerJoin(contacts, eq(contacts.id, stays.contactId))
      .innerJoin(properties, eq(properties.id, stays.propertyId))
      .leftJoin(contactOverview, eq(contactOverview.id, contacts.id))
      .leftJoin(follower, eq(follower.id, feedback.followedUpBy))
      .leftJoin(creator, joinCreator(feedback))
      .leftJoin(updater, joinUpdater(feedback))
      .where(and(eq(feedback.id, id), live));
    if (!row) throw new NotFoundException('Feedback not found');
    // praise and criticism of named employees: management and admin only
    const mentions = can(staff.role, 'employees', 'view') ? await mentionsOf(this.db, id) : null;
    return { ...row, mentions };
  }

  // The follow-up: conversations logged on this response, and notes on the stay.
  async timeline(id: number) {
    const stayId = await this.stayOf(id);
    const [talks, stayNotes] = await Promise.all([
      interactionItems(this.db, eq(interactions.feedbackId, id)),
      noteItems(this.db, eq(notes.stayId, stayId)),
    ]);
    return newestFirst([...talks, ...stayNotes]);
  }

  // An internal remark is a note on the stay (it shows on the guest too).
  async addNote(id: number, body: string) {
    const stayId = await this.stayOf(id);
    await withActingStaff(this.db, (tx) => tx.insert(notes).values({ stayId, body }));
    return this.timeline(id);
  }

  // ---------- add, edit, delete ----------
  // One response per stay, and only on a stay that is over. A second
  // response is refused with the first one's id, so the app can link to it.
  async create(input: CreateFeedback, staff: SignedInStaff) {
    const submittedAt = this.receivedAt(input.receivedOn);
    const id = await withActingStaff(this.db, async (tx) => {
      const [stay] = await tx
        .select({ id: stays.id, status: stays.status })
        .from(stays)
        .innerJoin(contacts, eq(contacts.id, stays.contactId))
        .where(and(eq(stays.id, input.stayId), isNull(stays.deletedAt), isNull(contacts.deletedAt)))
        .for('update', { of: stays });
      if (!stay) throw new BadRequestException('That stay no longer exists');
      if (!canHaveFeedback(stay.status)) throw new BadRequestException(STAY_NOT_OVER);
      const [existing] = await tx
        .select({ id: feedback.id })
        .from(feedback)
        .where(and(eq(feedback.stayId, stay.id), isNull(feedback.deletedAt)));
      if (existing) {
        throw new ConflictException({
          statusCode: 409,
          message: 'This stay already has a response',
          code: 'FEEDBACK_EXISTS',
          feedbackId: existing.id,
        });
      }
      const [row] = await tx
        .insert(feedback)
        .values({ stayId: stay.id, rating: input.rating ?? null, review: input.review ?? null, submittedAt })
        .returning({ id: feedback.id });
      return row.id;
    });
    return this.get(id, staff);
  }

  async update(id: number, input: UpdateFeedback, staff: SignedInStaff) {
    const current = await this.get(id, staff);
    const changes: Partial<typeof feedback.$inferInsert> = {};
    if (input.rating !== undefined) changes.rating = input.rating;
    if (input.review !== undefined) changes.review = input.review;
    if (input.receivedOn !== undefined) changes.submittedAt = this.receivedAt(input.receivedOn);
    if (!Object.keys(changes).length) return current;
    const rating = changes.rating !== undefined ? changes.rating : current.rating;
    const review = changes.review !== undefined ? changes.review : current.review;
    if (rating == null && !review) throw new BadRequestException('Enter a rating, a review, or both');
    await withActingStaff(this.db, (tx) => tx.update(feedback).set(changes).where(eq(feedback.id, id)));
    return this.get(id, staff);
  }

  // For a response entered on the wrong stay; its mentions go with it.
  async remove(id: number) {
    await this.stayOf(id);
    await withActingStaff(this.db, (tx) => softDelete(tx, feedback, id));
  }

  // ---------- follow-up ----------
  // Records who and when. Any response can be marked, though only 1 and 2
  // star ones wait on the Needs follow-up tab. Marking again replaces the outcome.
  async markFollowedUp(id: number, outcome: string, staff: SignedInStaff) {
    await this.stayOf(id);
    await withActingStaff(this.db, (tx) =>
      tx
        .update(feedback)
        .set({ followedUpAt: new Date(), followedUpBy: staff.id, followUpOutcome: outcome })
        .where(eq(feedback.id, id)),
    );
    return this.get(id, staff);
  }

  // Undo: back on the Needs follow-up tab if the rating is low.
  async clearFollowUp(id: number, staff: SignedInStaff) {
    await this.stayOf(id);
    await withActingStaff(this.db, (tx) =>
      tx
        .update(feedback)
        .set({ followedUpAt: null, followedUpBy: null, followUpOutcome: null })
        .where(eq(feedback.id, id)),
    );
    return this.get(id, staff);
  }

  // ---------- finding the stay for Add response ----------
  // Every word of the guest's name, or the booking reference. Stays that
  // didn't happen are left out; ones not yet over are listed so staff see why
  // they can't be picked. Most recent first.
  searchStays(q: string) {
    const text = q.trim().replace(/\s+/g, ' ');
    const words = text.split(' ').filter(Boolean);
    const search = or(and(...words.map((w) => ilike(guestName, likePattern(w)))), ilike(stays.bookingReference, likePattern(text)))!;
    return this.db
      .select({
        id: stays.id,
        propertyId: stays.propertyId,
        hotel: properties.name,
        contactId: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        arrivalDate: stays.arrivalDate,
        departureDate: stays.departureDate,
        bookingReference: stays.bookingReference,
        status: stays.status,
        feedbackId: feedback.id,
      })
      .from(stays)
      .innerJoin(contacts, eq(contacts.id, stays.contactId))
      .innerJoin(properties, eq(properties.id, stays.propertyId))
      .leftJoin(feedback, and(eq(feedback.stayId, stays.id), isNull(feedback.deletedAt)))
      .where(and(isNull(stays.deletedAt), isNull(contacts.deletedAt), notInArray(stays.status, ['cancelled', 'no_show']), search))
      .orderBy(sql`${stays.arrivalDate} desc nulls last`, desc(stays.id))
      .limit(20);
  }

  // ---------- the panels on the guest profile and the stay ----------
  async forGuest(contactId: number) {
    const [guest] = await this.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)));
    if (!guest) throw new NotFoundException('Guest not found');
    return this.panelRows(eq(stays.contactId, contactId));
  }

  async forStay(stayId: number) {
    const [row] = await this.panelRows(eq(stays.id, stayId));
    return { feedback: row ?? null };
  }

  // ---------- Hotel ratings ----------
  // One row per hotel, A to Z, and the whole group.
  async ratings() {
    const r = propertyRatings;
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    const [rows, [group]] = await Promise.all([
      this.db
        .select({
          id: r.id,
          name: r.name,
          responses: r.responses,
          avgRating: sql<number | null>`${r.avgRating}::float8`,
          avgRating90Days: sql<number | null>`${r.avgRating90Days}::float8`,
          responses90Days: r.responses90Days,
          lowRatings: r.lowRatings,
          needsFollowUp: r.needsFollowUp,
          lastResponse: r.lastResponse,
        })
        .from(r)
        .orderBy(asc(sql`lower(${r.name})`)),
      this.db
        .select({
          responses: count(),
          avgRating: sql<number | null>`round(avg(${feedback.rating}), 2)::float8`,
          avgRating90Days: sql<number | null>`round(avg(${feedback.rating}) filter (where ${feedback.submittedAt} >= ${ninetyDaysAgo}), 2)::float8`,
          responses90Days: sql<number>`count(*) filter (where ${feedback.submittedAt} >= ${ninetyDaysAgo})::int`,
          lowRatings: sql<number>`count(*) filter (where ${feedback.rating} <= ${LOW_RATING})::int`,
          needsFollowUp: sql<number>`count(*) filter (where ${needsFollowUp})::int`,
          lastResponse: sql<string | null>`max(${feedback.submittedAt})`,
        })
        .from(feedback)
        .innerJoin(stays, eq(stays.id, feedback.stayId))
        .innerJoin(contacts, eq(contacts.id, stays.contactId))
        .innerJoin(properties, and(eq(properties.id, stays.propertyId), isNull(properties.deletedAt)))
        .where(live),
    ]);
    return { rows, group };
  }

  // =====================================================================
  private panelRows(condition: SQL) {
    return this.db
      .select({
        id: feedback.id,
        stayId: stays.id,
        hotel: properties.name,
        arrivalDate: stays.arrivalDate,
        departureDate: stays.departureDate,
        rating: feedback.rating,
        review: feedback.review,
        submittedAt: feedback.submittedAt,
        needsFollowUp,
        followedUpAt: feedback.followedUpAt,
      })
      .from(feedback)
      .innerJoin(stays, eq(stays.id, feedback.stayId))
      .innerJoin(contacts, eq(contacts.id, stays.contactId))
      .innerJoin(properties, eq(properties.id, stays.propertyId))
      .where(and(live, condition))
      .orderBy(desc(feedback.submittedAt), desc(feedback.id));
  }

  // The stay a live response is on (404 when the response is gone).
  private async stayOf(id: number) {
    const [row] = await this.db
      .select({ stayId: stays.id })
      .from(feedback)
      .innerJoin(stays, eq(stays.id, feedback.stayId))
      .innerJoin(contacts, eq(contacts.id, stays.contactId))
      .where(and(eq(feedback.id, id), live));
    if (!row) throw new NotFoundException('Feedback not found');
    return row.stayId;
  }

  // every word in the guest's name, the booking reference, or the words in the review
  private searchCondition(q: string): SQL {
    const text = q.trim().replace(/\s+/g, ' ');
    const words = text.split(' ').filter(Boolean);
    return or(
      and(...words.map((w) => ilike(guestName, likePattern(w)))),
      ilike(stays.bookingReference, likePattern(text)),
      ilike(feedback.review, likePattern(text)),
    )!;
  }

  // The date received: today is now; an earlier day is that day in Colombo.
  private receivedAt(day: string | undefined): Date {
    if (!day) return new Date();
    if (day > hotelToday()) throw new BadRequestException("The date received can't be in the future");
    return givenAtFor(day);
  }
}
