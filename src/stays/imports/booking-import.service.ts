import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { creator, joinCreator } from '../../common/audit.js';
import { chunks } from '../../common/sql.js';
import { recordConsentChoices } from '../../consent/consent-writer.js';
import { InjectDb, type Database } from '../../db/drizzle.module.js';
import {
  bookingImports,
  companies,
  CONSENT_CHANNELS,
  consents,
  contactMethods,
  contacts,
  countries,
  importMappings,
  occasions,
  properties,
  stays,
  type BookingImportDetails,
} from '../../db/schema/index.js';
import { withActingStaff, type Transaction } from '../../db/with-staff.js';
import { matchKey } from '../../guests/guest-rules.js';
import { convertLeadsForStays } from '../../leads/lead-writer.js';
import {
  IMPORT_FIELDS,
  parseBooking,
  planImport,
  providedColumns,
  stayKey,
  type ExistingData,
  type ExistingStay,
  type GuestRef,
  type ImportField,
  type ImportLookups,
  type ImportPlan,
  type KnownContact,
  type ParsedRow,
  type PlannedRow,
  type RawBooking,
} from './booking-import-rules.js';
import type { CommitImport, ImportRows } from './booking-import.schemas.js';

type Reader = Database | Transaction;

const MAPPING_KIND = 'bookings';

const phoneDigits = sql`regexp_replace(${contactMethods.value}, '[^0-9]', '', 'g')`;
const nameOf = (c: { firstName: string | null; lastName: string | null }, fallback: string) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ') || fallback;

// Booking file import (Stays → Import bookings). The app reads the file and
// sends its rows with the columns already matched to CRM fields. Preview
// saves nothing; import re-checks every row against the current data and
// saves them all in one transaction, so a failure leaves nothing half done.
@Injectable()
export class BookingImportService {
  constructor(@InjectDb() private readonly db: Database) {}

  // ---------- step 2: the fields, and the matching remembered from last time ----------
  async setup() {
    const [saved] = await this.db
      .select({ mapping: importMappings.mapping })
      .from(importMappings)
      .where(eq(importMappings.kind, MAPPING_KIND));
    return {
      fields: IMPORT_FIELDS.map(({ key, label, headings, ...rest }) => ({
        key,
        label,
        headings,
        required: 'required' in rest ? rest.required : false,
        hint: 'hint' in rest ? rest.hint : null,
      })),
      mapping: saved?.mapping ?? {},
    };
  }

  async saveMapping(mapping: Record<string, string>) {
    await withActingStaff(this.db, (tx) =>
      tx
        .insert(importMappings)
        .values({ kind: MAPPING_KIND, mapping })
        .onConflictDoUpdate({ target: importMappings.kind, set: { mapping } }),
    );
    return this.setup();
  }

  // ---------- step 3: what each row would do, saving nothing ----------
  async preview(input: ImportRows) {
    const { plan } = await this.plan(this.db, input, new Set());
    return { rows: plan.rows, counts: countOutcomes(plan.rows), newGuests: plan.newGuests.length };
  }

  // ---------- step 4: save it all ----------
  async commit(input: CommitImport) {
    return withActingStaff(this.db, async (tx) => {
      // one import at a time, so two people can't both create the same new guest
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('booking_import'))`);
      const { plan, fields } = await this.plan(tx, input, new Set(input.skip));

      const newIds = await this.insertNewGuests(tx, plan);
      const resolve = (g: GuestRef) => ('id' in g ? g.id : newIds[g.newKey]);
      await this.addContactMethods(tx, plan);
      const optedIn = await this.recordConsents(tx, plan, newIds);
      const { added, updated, inserted } = await this.writeStays(tx, plan, fields, resolve);
      for (const move of plan.moves) {
        await tx
          .update(stays)
          .set({ status: 'cancelled', cancellationReason: move.reason })
          .where(and(eq(stays.id, move.stayId), eq(stays.status, 'booked')));
      }
      // new bookings close the guest's matching open lead (Module 7)
      const leadsBooked = await convertLeadsForStays(tx, inserted);

      // only those whose opt-in was recorded: a tick older than the do-not-contact request changes nothing
      const dncOptedIn = plan.doNotContact.filter((id) => optedIn.includes(id));
      const doNotContact = dncOptedIn.length
        ? await tx
            .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName })
            .from(contacts)
            .where(inArray(contacts.id, dncOptedIn))
        : [];
      const details: BookingImportDetails = {
        newGuests: plan.newGuests.map((g) => ({ id: newIds[g.key], name: nameOf(g, g.methods[0]?.value ?? 'New guest') })),
        doNotContact: doNotContact.map((c) => ({ id: c.id, name: nameOf(c, `Guest #${c.id}`) })),
        leadsBooked: leadsBooked.map((l) => ({ id: l.leadId, name: l.name })),
      };
      const counts = countOutcomes(plan.rows);
      const [saved] = await tx
        .insert(bookingImports)
        .values({
          fileName: input.fileName,
          propertyId: input.propertyId || null,
          rowsTotal: input.rows.length,
          added,
          updated,
          skipped: counts.error + counts.skipped,
          newGuests: plan.newGuests.length,
          details,
        })
        .returning({ id: bookingImports.id });

      return { id: saved.id, added, updated, skipped: counts.error + counts.skipped, ...details, rows: plan.rows };
    });
  }

  // ---------- import history ----------
  history() {
    return this.db
      .select({
        id: bookingImports.id,
        fileName: bookingImports.fileName,
        hotel: properties.name,
        rowsTotal: bookingImports.rowsTotal,
        added: bookingImports.added,
        updated: bookingImports.updated,
        skipped: bookingImports.skipped,
        newGuests: bookingImports.newGuests,
        importedAt: bookingImports.createdAt,
        importedBy: sql<string | null>`nullif(concat_ws(' ', ${creator.firstName}, ${creator.lastName}), '')`,
      })
      .from(bookingImports)
      .leftJoin(properties, eq(properties.id, bookingImports.propertyId))
      .leftJoin(creator, joinCreator(bookingImports))
      .where(isNull(bookingImports.deletedAt))
      .orderBy(desc(bookingImports.createdAt), desc(bookingImports.id))
      .limit(100);
  }

  // =====================================================================
  // Loading and planning
  // =====================================================================
  private async plan(db: Reader, input: ImportRows, skip: ReadonlySet<number>) {
    const lookups = await this.lookups(db, input.propertyId ?? null);
    const parsed = input.rows.map((row, i) => parseBooking(row as RawBooking, i, lookups));
    const existing = await this.existing(db, parsed);
    const fields = [...new Set(input.rows.flatMap((r) => Object.keys(r)))] as ImportField[];
    return { plan: planImport(parsed, existing, { skip, fileName: input.fileName }), fields };
  }

  private async lookups(db: Reader, pickedPropertyId: string | null): Promise<ImportLookups> {
    // retired hotels and occasions still match, so old bookings import
    const [hotelRows, occasionRows, companyRows, countryRows] = await Promise.all([
      db.select({ id: properties.id, name: properties.name }).from(properties).where(isNull(properties.deletedAt)),
      db.select({ id: occasions.id, name: occasions.name }).from(occasions).where(isNull(occasions.deletedAt)),
      db.select({ id: companies.id, name: companies.name }).from(companies).where(isNull(companies.deletedAt)),
      db.select({ code: countries.code, name: countries.name }).from(countries).where(isNull(countries.deletedAt)),
    ]);
    return { pickedPropertyId, properties: hotelRows, occasions: occasionRows, companies: companyRows, countries: countryRows };
  }

  // Everything the plan needs to know about the CRM, loaded in a few queries.
  private async existing(db: Reader, parsed: ParsedRow[]): Promise<ExistingData> {
    const usable = parsed.filter((r) => !r.errors.length).map((r) => r.values);
    const references = [...new Set(usable.map((v) => v.bookingReference!).filter(Boolean))];
    const emails = [...new Set(usable.map((v) => v.email && matchKey('email', v.email)).filter((v): v is string => !!v))];
    const phones = [...new Set(usable.map((v) => v.phone && matchKey('phone', v.phone)).filter((v): v is string => !!v))];

    // stays with any of these references, at any hotel
    const stayRows: ExistingStay[] = [];
    for (const part of chunks(references)) {
      stayRows.push(
        ...(await db
          .select({
            id: stays.id,
            contactId: stays.contactId,
            propertyId: stays.propertyId,
            propertyName: properties.name,
            bookingReference: sql<string>`${stays.bookingReference}`,
            status: stays.status,
            cancellationReason: stays.cancellationReason,
          })
          .from(stays)
          .innerJoin(properties, eq(properties.id, stays.propertyId))
          .where(and(inArray(stays.bookingReference, part), isNull(stays.deletedAt)))),
      );
    }

    // guests with these emails or phones; shared addresses never match
    const matches: { contactId: number; kind: 'email' | 'phone'; key: string }[] = [];
    const matchConditions: SQL[] = [
      ...chunks(emails).map((part) => and(eq(contactMethods.kind, 'email'), inArray(sql`lower(${contactMethods.value})`, part))!),
      ...chunks(phones).map((part) => and(eq(contactMethods.kind, 'phone'), inArray(phoneDigits, part))!),
    ];
    for (const condition of matchConditions) {
      matches.push(
        ...(await db
          .select({
            contactId: contactMethods.contactId,
            kind: contactMethods.kind,
            key: sql<string>`case when ${contactMethods.kind} = 'email' then lower(${contactMethods.value}) else ${phoneDigits} end`,
          })
          .from(contactMethods)
          .innerJoin(contacts, eq(contacts.id, contactMethods.contactId))
          .where(
            and(condition, eq(contactMethods.isShared, false), isNull(contactMethods.deletedAt), isNull(contacts.deletedAt)),
          )
          .orderBy(asc(contactMethods.contactId))),
      );
    }

    const contactsByEmail = new Map<string, number[]>();
    const contactsByPhone = new Map<string, number[]>();
    for (const m of matches) {
      const index = m.kind === 'email' ? contactsByEmail : contactsByPhone;
      const ids = index.get(m.key) ?? [];
      if (!ids.includes(m.contactId)) ids.push(m.contactId);
      index.set(m.key, ids);
    }

    // the matched guests and the guests of existing stays, with all their emails and phones
    const contactIds = [...new Set([...matches.map((m) => m.contactId), ...stayRows.map((s) => s.contactId)])];
    const known = new Map<number, KnownContact>();
    for (const part of chunks(contactIds)) {
      const people = await db
        .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, status: contacts.status })
        .from(contacts)
        .where(inArray(contacts.id, part));
      for (const p of people) {
        known.set(p.id, {
          id: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          doNotContact: p.status === 'do_not_contact',
          emails: [],
          phones: [],
        });
      }
      const methods = await db
        .select({ contactId: contactMethods.contactId, kind: contactMethods.kind, value: contactMethods.value })
        .from(contactMethods)
        .where(and(inArray(contactMethods.contactId, part), isNull(contactMethods.deletedAt)));
      for (const m of methods) {
        known.get(m.contactId)?.[m.kind === 'email' ? 'emails' : 'phones'].push(matchKey(m.kind, m.value));
      }
    }

    const staysByKey = new Map<string, ExistingStay>();
    const staysByReference = new Map<string, ExistingStay[]>();
    for (const s of stayRows) {
      staysByKey.set(stayKey(s.propertyId, s.bookingReference), s);
      staysByReference.set(s.bookingReference, [...(staysByReference.get(s.bookingReference) ?? []), s]);
    }
    return { staysByKey, staysByReference, contactsByEmail, contactsByPhone, contacts: known };
  }

  // =====================================================================
  // Writing
  // =====================================================================

  // New guests, as the database doc describes: first word of the name as the
  // first name, country from the booking or the phone, market from the
  // country, the email and phone as primary (unverified), consent unknown.
  // Ids are reserved first so the stays can point at them in one insert.
  private async insertNewGuests(tx: Transaction, plan: ImportPlan): Promise<number[]> {
    if (!plan.newGuests.length) return [];
    const { rows } = await tx.execute<{ id: string }>(
      sql`select nextval(pg_get_serial_sequence('contacts', 'id')) as id from generate_series(1, ${plan.newGuests.length})`,
    );
    const ids = rows.map((r) => Number(r.id));
    for (const part of chunks(plan.newGuests)) {
      await tx.insert(contacts).values(
        part.map((g) => ({
          id: ids[g.key],
          firstName: g.firstName,
          lastName: g.lastName,
          contactType: 'guest' as const,
          lifecycleStage: 'lead' as const, // moves to stayed on check-out
          market: g.market,
          countryCode: g.countryCode,
        })),
      );
    }
    const methods = plan.newGuests.flatMap((g) => g.methods.map((m) => ({ contactId: ids[g.key], ...m })));
    for (const part of chunks(methods)) await tx.insert(contactMethods).values(part);
    return ids;
  }

  // New emails and phones for existing guests; their name and primaries stay as they are.
  private async addContactMethods(tx: Transaction, plan: ImportPlan) {
    for (const part of chunks(plan.methodsToAdd)) await tx.insert(contactMethods).values(part);
    const touched = [...new Set(plan.methodsToAdd.map((m) => m.contactId))];
    for (const part of chunks(touched)) {
      await tx
        .update(contacts)
        .set({ updatedAt: sql`now()` })
        .where(inArray(contacts.id, part));
    }
  }

  // Consent rows for new guests (email and WhatsApp unknown), then the booking
  // tick box through the shared consent rules (recordConsentChoices): ticked
  // opts the guest in to email with source booking form and the booking date,
  // even after an opt-out, unless the guest's choice on file is newer than the
  // booking. Unticked changes nothing. Do-not-contact guests are recorded but
  // keep their block (marketing_email_list still leaves them out) and are
  // listed for staff. Returns the guests whose opt-in was recorded.
  private async recordConsents(tx: Transaction, plan: ImportPlan, newIds: number[]) {
    const fresh = plan.newGuests.flatMap((g) => CONSENT_CHANNELS.map((channel) => ({ contactId: newIds[g.key], channel })));
    for (const part of chunks(fresh)) await tx.insert(consents).values(part);
    return recordConsentChoices(
      tx,
      plan.consents.map((c) => ({
        contactId: 'id' in c.guest ? c.guest.id : newIds[c.guest.newKey],
        channel: 'email',
        status: 'opted_in',
        source: 'booking_form',
        evidence: c.evidence,
        givenAt: c.givenAt,
      })),
    );
  }

  // New stays and updates in one upsert per chunk. The hotel and booking
  // reference find the stay (re-importing a file is safe); an update changes
  // the dates, status and only the columns the file has, never the guest.
  private async writeStays(
    tx: Transaction,
    plan: ImportPlan,
    fields: ImportField[],
    resolve: (g: GuestRef) => number,
  ) {
    const columns = providedColumns(fields);
    const updatable = ['arrivalDate', 'departureDate', 'status', 'cancellationReason', ...columns] as const;
    const set = Object.fromEntries(updatable.map((c) => [c, sql.raw(`excluded.${stays[c].name}`)]));
    let added = 0;
    let updated = 0;
    const inserted: { id: number; contactId: number; propertyId: string; arrivalDate: string | null; status: string }[] = [];
    for (const part of chunks(plan.stayWrites)) {
      const rows = part.map((w) => {
        const b = w.booking;
        const row: typeof stays.$inferInsert = {
          contactId: resolve(w.guest),
          propertyId: b.propertyId!,
          bookingReference: b.bookingReference!,
          arrivalDate: b.arrivalDate,
          departureDate: b.departureDate,
          status: w.status,
          cancellationReason: w.cancellationReason,
        };
        for (const c of columns) (row as Record<string, unknown>)[c] = b[c];
        return row;
      });
      const result = await tx
        .insert(stays)
        .values(rows)
        .onConflictDoUpdate({
          target: [stays.propertyId, stays.bookingReference],
          targetWhere: sql`booking_reference is not null and deleted_at is null`,
          set,
        })
        .returning({
          inserted: sql<boolean>`(xmax = 0)`,
          id: stays.id,
          contactId: stays.contactId,
          propertyId: stays.propertyId,
          arrivalDate: stays.arrivalDate,
          status: stays.status,
        });
      for (const { inserted: isNew, ...stay } of result) {
        if (isNew) inserted.push(stay);
      }
      added += result.filter((r) => r.inserted).length;
      updated += result.filter((r) => !r.inserted).length;
    }
    return { added, updated, inserted };
  }
}

function countOutcomes(rows: PlannedRow[]) {
  const counts = { new_guest: 0, existing_guest: 0, update: 0, error: 0, skipped: 0 };
  for (const r of rows) counts[r.outcome]++;
  return counts;
}

