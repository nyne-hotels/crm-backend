import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, sql, TransactionRollbackError } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  CONSENT_CHANNELS,
  consents,
  contactMethods,
  contactOverview,
  contacts,
  contactTags,
  interactions,
  leads,
  notDuplicates,
  notes,
  possibleDuplicates,
  preferences,
  properties,
  specialDates,
  stays,
  tags,
  type CONSENT_STATUSES,
} from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { GuestsService } from '../guests/guests.service.js';
import type { ListDuplicates, Merge, Pair, Preview } from './duplicates.schemas.js';
import {
  filledFields,
  mergePreview,
  pairOf,
  suggestKeep,
  type DuplicateReason,
  type MergeOutcome,
} from './merge-rules.js';

type Db = Database | Transaction;
type ConsentStatus = (typeof CONSENT_STATUSES)[number];

const d = possibleDuplicates;
const guestA = alias(contactOverview, 'guest_a');
const guestB = alias(contactOverview, 'guest_b');

const REASON_COLUMNS = { email: d.sameEmail, phone: d.samePhone, name: d.sameName } as const;

const reasonsOf = (row: { sameEmail: boolean; samePhone: boolean; sameName: boolean }) =>
  [row.sameEmail && 'email', row.samePhone && 'phone', row.sameName && 'name'].filter(
    (r): r is DuplicateReason => !!r,
  );

const side = (g: typeof guestA | typeof guestB) => ({
  id: g.id,
  firstName: g.firstName,
  lastName: g.lastName,
  email: g.email,
  phone: g.phone,
  lifecycleStage: g.lifecycleStage,
  stayCount: g.stayRows,
  lastStay: g.lastStay,
});

// Duplicates and merging (Module 6): the queue of possible duplicates, the
// side-by-side comparison, the preview of a merge and the merge itself. The
// database's merge_contacts() does the merge in one step; nothing is ever
// merged without a person deciding.
@Injectable()
export class DuplicatesService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly guests: GuestsService,
  ) {}

  // ---------- Guests → Possible duplicates ----------
  // Pairs matching on email or phone first: they are the likeliest real duplicates.
  async list(filter: ListDuplicates) {
    const where = filter.reason ? eq(REASON_COLUMNS[filter.reason], true) : undefined;
    const [rows, [counts]] = await Promise.all([
      this.db
        .select({
          a: side(guestA),
          b: side(guestB),
          sameEmail: d.sameEmail,
          samePhone: d.samePhone,
          sameName: d.sameName,
        })
        .from(d)
        .innerJoin(guestA, eq(guestA.id, d.contactA))
        .innerJoin(guestB, eq(guestB.id, d.contactB))
        .where(where)
        .orderBy(
          desc(sql`${d.sameEmail} or ${d.samePhone}`),
          sql`lower(${d.nameA}) nulls last`,
          asc(d.contactA),
          asc(d.contactB),
        )
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize),
      this.db
        .select({
          all: count(),
          email: sql<number>`count(*) filter (where ${d.sameEmail})::int`,
          phone: sql<number>`count(*) filter (where ${d.samePhone})::int`,
          name: sql<number>`count(*) filter (where ${d.sameName})::int`,
        })
        .from(d),
    ]);
    const { all, ...byReason } = counts;
    return {
      rows: rows.map(({ a, b, ...reasons }) => ({ a, b, reasons: reasonsOf(reasons) })),
      total: filter.reason ? byReason[filter.reason] : all,
      counts: { all, ...byReason },
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }

  // ---------- the merge screen: both profiles side by side ----------
  async compare({ a, b }: Pair) {
    const [lo, hi] = pairOf(a, b);
    const [first, second, [flagged], [dismissed]] = await Promise.all([
      this.profile(a, b),
      this.profile(b, a),
      this.db
        .select({ sameEmail: d.sameEmail, samePhone: d.samePhone, sameName: d.sameName })
        .from(d)
        .where(and(eq(d.contactA, lo), eq(d.contactB, hi))),
      this.db
        .select({ at: notDuplicates.createdAt })
        .from(notDuplicates)
        .where(and(eq(notDuplicates.contactA, lo), eq(notDuplicates.contactB, hi))),
    ]);
    const size = (p: typeof first) => ({
      id: p.guest.id,
      stays: p.stays.filter((s) => s.status !== 'cancelled' && s.status !== 'no_show').length,
      knowledge: p.notes.count + p.preferences.length + p.specialDates.length + p.leads,
      details: p.guest.emails.length + p.guest.phones.length,
    });
    return {
      a: first,
      b: second,
      reasons: flagged ? reasonsOf(flagged) : [],
      notDuplicate: !!dismissed, // marked before; staff can still merge them
      suggestedKeepId: suggestKeep(size(first), size(second)),
    };
  }

  // One column of the merge screen. Stays the other guest also has (same
  // hotel and booking reference, or same hotel and arrival date) are flagged:
  // the merge keeps them once.
  private async profile(id: number, otherId: number) {
    const guest = await this.guests.get(id);
    const [consentRows, stayRows, [noteCount], latestNotes, prefs, dates, [leadCount]] = await Promise.all([
      this.db
        .select({ channel: consents.channel, status: consents.status, givenAt: consents.givenAt })
        .from(consents)
        .where(and(eq(consents.contactId, id), isNull(consents.deletedAt))),
      this.db
        .select({
          id: stays.id,
          hotel: properties.name,
          status: stays.status,
          arrivalDate: stays.arrivalDate,
          departureDate: stays.departureDate,
          bookingReference: stays.bookingReference,
          inBoth: sql<boolean>`exists (select 1 from ${stays} x where x.contact_id = ${otherId}
                   and x.deleted_at is null and same_stay(x, ${stays}))`,
        })
        .from(stays)
        .innerJoin(properties, eq(properties.id, stays.propertyId))
        .where(and(eq(stays.contactId, id), isNull(stays.deletedAt)))
        .orderBy(sql`${stays.arrivalDate} desc nulls last`, desc(stays.id)),
      this.db.select({ n: count() }).from(notes).where(and(eq(notes.contactId, id), isNull(notes.deletedAt))),
      this.db
        .select({ id: notes.id, body: notes.body, createdAt: notes.createdAt })
        .from(notes)
        .where(and(eq(notes.contactId, id), isNull(notes.deletedAt)))
        .orderBy(desc(notes.createdAt), desc(notes.id))
        .limit(3),
      this.db
        .select({ id: preferences.id, kind: preferences.kind, body: preferences.body })
        .from(preferences)
        .where(and(eq(preferences.contactId, id), isNull(preferences.deletedAt)))
        .orderBy(asc(preferences.kind), desc(preferences.createdAt)),
      this.db
        .select({
          id: specialDates.id,
          occasion: specialDates.occasion,
          label: specialDates.label,
          month: specialDates.month,
          day: specialDates.day,
          year: specialDates.year,
        })
        .from(specialDates)
        .where(and(eq(specialDates.contactId, id), isNull(specialDates.deletedAt)))
        .orderBy(asc(specialDates.month), asc(specialDates.day)),
      this.db.select({ n: count() }).from(leads).where(and(eq(leads.contactId, id), isNull(leads.deletedAt))),
    ]);
    return {
      guest,
      // a channel without a row (loaded before consent was tracked) is unknown
      consents: CONSENT_CHANNELS.map((channel) => ({
        channel,
        status: consentRows.find((c) => c.channel === channel)?.status ?? ('unknown' as ConsentStatus),
      })),
      stays: stayRows,
      notes: { count: noteCount.n, latest: latestNotes },
      preferences: prefs,
      specialDates: dates,
      leads: leadCount.n,
    };
  }

  // ---------- the preview: what the merge would do ----------
  // Runs the real merge in a transaction that is then rolled back, so the
  // preview can't drift from what merge_contacts() does.
  async preview({ keepId, removeId }: Preview) {
    let outcome: MergeOutcome | undefined;
    try {
      await withActingStaff(this.db, async (tx) => {
        await this.lockBoth(tx, keepId, removeId);
        const [kept, removed, sharedStays, moved, tagsBefore] = await Promise.all([
          this.named(tx, keepId),
          this.named(tx, removeId),
          tx
            .select({ hotel: properties.name })
            .from(stays)
            .innerJoin(properties, eq(properties.id, stays.propertyId))
            .where(
              and(
                eq(stays.contactId, removeId),
                isNull(stays.deletedAt),
                sql`exists (select 1 from ${stays} x where x.contact_id = ${keepId}
                      and x.deleted_at is null and same_stay(x, ${stays}))`,
              ),
            ),
          this.historyCounts(tx, removeId),
          this.tagNames(tx, keepId),
        ]);

        await tx.execute(sql`select merge_contacts(${keepId}::bigint, ${removeId}::bigint)`);

        const [after, methods, stayCounts, consentRows, tagsAfter] = await Promise.all([
          this.contactRow(tx, keepId),
          tx
            .select({ kind: contactMethods.kind, value: contactMethods.value, isPrimary: contactMethods.isPrimary })
            .from(contactMethods)
            .where(and(eq(contactMethods.contactId, keepId), isNull(contactMethods.deletedAt))),
          tx
            .select({
              visits: sql<number>`count(*) filter (where ${stays.status} = 'checked_out')::int`,
              upcoming: sql<number>`count(*) filter (where ${stays.status} in ('booked', 'checked_in'))::int`,
            })
            .from(stays)
            .where(and(eq(stays.contactId, keepId), isNull(stays.deletedAt))),
          tx
            .select({ channel: consents.channel, status: consents.status })
            .from(consents)
            .where(and(eq(consents.contactId, keepId), isNull(consents.deletedAt))),
          this.tagNames(tx, keepId),
        ]);
        const consentOf = (channel: (typeof CONSENT_CHANNELS)[number]) =>
          consentRows.find((c) => c.channel === channel)?.status ?? 'unknown';
        outcome = {
          keptName: nameOf(after!, methods),
          removedName: removed.name,
          emails: methods.filter((m) => m.kind === 'email').length,
          phones: methods.filter((m) => m.kind === 'phone').length,
          stays: stayCounts[0].visits,
          upcoming: stayCounts[0].upcoming,
          sharedStayHotels: sharedStays.map((s) => s.hotel),
          consent: { email: consentOf('email'), whatsapp: consentOf('whatsapp') },
          stageBefore: kept.row.lifecycleStage,
          stage: after!.lifecycleStage,
          moved,
          tagsAdded: tagsAfter.filter((t) => !tagsBefore.includes(t)),
          filled: filledFields(kept.row, after!),
          doNotContactCarried: removed.row.status === 'do_not_contact' && kept.row.status !== 'do_not_contact',
        };
        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
    return { keepId, removeId, sentences: mergePreview(outcome!), outcome: outcome! };
  }

  // ---------- merge ----------
  async merge({ keepId, removeId, note }: Merge) {
    await withActingStaff(this.db, async (tx) => {
      await this.lockBoth(tx, keepId, removeId);
      await tx.execute(sql`select merge_contacts(${keepId}::bigint, ${removeId}::bigint, ${note ?? null}::text)`);
    });
    return { keptId: keepId };
  }

  // ---------- "Not a duplicate" ----------
  // Remembered for the pair, so it never returns to the queue.
  async markNotDuplicate({ a, b }: Pair) {
    const [lo, hi] = pairOf(a, b);
    await withActingStaff(this.db, async (tx) => {
      await this.lockBoth(tx, lo, hi);
      await tx.insert(notDuplicates).values({ contactA: lo, contactB: hi }).onConflictDoNothing();
    });
  }

  // The Undo on the toast after "Not a duplicate".
  async unmarkNotDuplicate({ a, b }: Pair) {
    const [lo, hi] = pairOf(a, b);
    await withActingStaff(this.db, (tx) =>
      tx.delete(notDuplicates).where(and(eq(notDuplicates.contactA, lo), eq(notDuplicates.contactB, hi))),
    );
  }

  // Both guests, locked for the rest of the transaction; a guest merged or
  // deleted meanwhile (by someone else on the same pair) is a 404.
  private async lockBoth(tx: Transaction, a: number, b: number) {
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(inArray(contacts.id, [a, b]), isNull(contacts.deletedAt)))
      .orderBy(asc(contacts.id))
      .for('update');
    if (rows.length < 2) {
      throw new NotFoundException('One of these guests has already been merged or deleted. Refresh the page.');
    }
  }

  private async named(tx: Transaction, id: number) {
    const [row, methods] = await Promise.all([
      this.contactRow(tx, id),
      tx
        .select({ kind: contactMethods.kind, value: contactMethods.value, isPrimary: contactMethods.isPrimary })
        .from(contactMethods)
        .where(and(eq(contactMethods.contactId, id), isNull(contactMethods.deletedAt))),
    ]);
    return { row: row!, name: nameOf(row!, methods) };
  }

  private async contactRow(db: Db, id: number) {
    const [row] = await db
      .select({
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        lifecycleStage: contacts.lifecycleStage,
        status: contacts.status,
        countryCode: contacts.countryCode,
        companyId: contacts.companyId,
        designation: contacts.designation,
        vipReason: contacts.vipReason,
      })
      .from(contacts)
      .where(eq(contacts.id, id));
    return row;
  }

  private async tagNames(db: Db, id: number) {
    const rows = await db
      .select({ name: tags.name })
      .from(contactTags)
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(eq(contactTags.contactId, id));
    return rows.map((r) => r.name);
  }

  // What moves across besides stays, emails and phones.
  private async historyCounts(db: Db, id: number) {
    const n = (table: typeof notes | typeof preferences | typeof specialDates | typeof leads | typeof interactions) =>
      sql<number>`(select count(*)::int from ${table} where ${table.contactId} = ${id} and ${table.deletedAt} is null)`;
    const [row] = await db
      .select({
        notes: n(notes),
        preferences: n(preferences),
        specialDates: n(specialDates),
        leads: n(leads),
        interactions: n(interactions),
      })
      .from(contacts)
      .where(eq(contacts.id, id));
    return row;
  }
}

// A guest without a name goes by their primary email or phone, as on the profile.
function nameOf(
  row: { firstName: string | null; lastName: string | null },
  methods: { kind: string; value: string; isPrimary: boolean }[],
): string {
  const name = [row.firstName, row.lastName].filter(Boolean).join(' ');
  const primary = (kind: string) => methods.find((m) => m.kind === kind && m.isPrimary)?.value;
  return name || primary('email') || primary('phone') || 'Unnamed guest';
}
