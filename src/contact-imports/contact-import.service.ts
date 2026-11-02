import { ConflictException, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { chunks } from '../common/sql.js';
import { recordConsentChoices } from '../consent/consent-writer.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import { actingStaffId } from '../db/request-context.js';
import {
  companies,
  CONSENT_CHANNELS,
  consents,
  contactImportChanges,
  contactImports,
  contactMethods,
  contacts,
  contactTags,
  countries,
  importMappings,
  notes,
  preferences,
  properties,
  staffUsers,
  stays,
  tags,
  type ContactImportDetails,
  type ContactImportResultRow,
} from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { matchKey } from '../guests/guest-rules.js';
import {
  CONTACT_IMPORT_FIELDS,
  parseContact,
  planContactImport,
  type CompanyRef,
  type ContactCreate,
  type ContactImportPlan,
  type ContactLookups,
  type ContactUpdate,
  type ExistingContact,
  type ExistingContacts,
  type ParsedContactRow,
  type RawContact,
  type RowChoice,
} from './contact-import-rules.js';
import type { CommitContactImport, ContactRows } from './contact-import.schemas.js';

type Reader = Database | Transaction;

const MAPPING_KIND = 'contacts';
const VIP_TAG = 'vip / industry';
const phoneDigits = sql`regexp_replace(${contactMethods.value}, '[^0-9]', '', 'g')`;
const nameOf = (c: { firstName: string | null; lastName: string | null }, fallback: string) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ') || fallback;

// Settings → Import contacts (Module 9, admin only). The app reads the file
// and sends its rows with the columns matched to CRM fields, plus the
// admin's Ignore / Add / Update choice for rows already in the CRM. Preview
// saves nothing; import re-plans every row against the current data and
// saves it all in one transaction, with the change log.
@Injectable()
export class ContactImportService {
  constructor(@InjectDb() private readonly db: Database) {}

  // ---------- the fields, the matching remembered from last time, and the template's allowed values ----------
  async setup() {
    const [[saved], countryRows, hotelRows, tagRows] = await Promise.all([
      this.db.select({ mapping: importMappings.mapping }).from(importMappings).where(eq(importMappings.kind, MAPPING_KIND)),
      this.db.select({ code: countries.code, name: countries.name }).from(countries).where(isNull(countries.deletedAt)).orderBy(asc(countries.name)),
      this.db
        .select({ id: properties.id, name: properties.name })
        .from(properties)
        .where(and(eq(properties.isActive, true), isNull(properties.deletedAt)))
        .orderBy(asc(properties.id)),
      this.db
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(and(eq(tags.isActive, true), isNull(tags.deletedAt)))
        .orderBy(asc(sql`lower(${tags.name})`)),
    ]);
    return {
      fields: CONTACT_IMPORT_FIELDS.map(({ key, label, headings, ...rest }) => ({
        key,
        label,
        headings,
        required: false,
        hint: 'hint' in rest ? rest.hint : null,
      })),
      mapping: saved?.mapping ?? {},
      allowed: { countries: countryRows, hotels: hotelRows, tags: tagRows.map((t) => t.name) },
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

  // ---------- steps 3 and 4: what each row would do, saving nothing ----------
  async preview(input: ContactRows) {
    const { plan } = await this.plan(this.db, input);
    return { rows: plan.rows, summary: plan.summary };
  }

  // ---------- step 5: save it all, or nothing ----------
  async commit(input: CommitContactImport) {
    return withActingStaff(this.db, async (tx) => {
      // one import at a time; the second admin is told to wait rather than queued
      const { rows: lock } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext('contact_import')) as locked`,
      );
      if (!lock[0]?.locked) {
        throw new ConflictException('Another admin is importing contacts right now. Wait for that import to finish, then try again.');
      }
      const { plan } = await this.plan(tx, input);
      const staffId = actingStaffId();
      const [staff] = staffId
        ? await tx.select({ firstName: staffUsers.firstName, lastName: staffUsers.lastName }).from(staffUsers).where(eq(staffUsers.id, staffId))
        : [];
      const staffName = staff ? nameOf(staff, 'an admin') : 'the system';

      // the import's own row first: its number goes into the consent evidence
      const [saved] = await tx
        .insert(contactImports)
        .values({
          fileName: input.fileName,
          rowsTotal: input.rows.length,
          created: 0,
          updated: 0,
          addedAgain: 0,
          ignored: 0,
          errors: 0,
          mapping: input.mapping,
          details: { newContacts: [], newCompanies: [], doNotContact: [] },
          results: [],
        })
        .returning({ id: contactImports.id });

      const companyIds = await this.insertCompanies(tx, plan);
      const companyOf = (ref: CompanyRef | null) => (ref ? ('id' in ref ? ref.id : companyIds[ref.newKey]) : null);
      const newIds = await this.insertContacts(tx, plan.creates, companyOf);
      await this.applyUpdates(tx, plan.updates, companyOf);

      // consent follows the file, with the import as source and evidence
      const evidence = (index: number) => `Contact import #${saved.id}, ${input.fileName}, row ${index + 1}, by ${staffName}`;
      const now = new Date();
      const optedIn = await recordConsentChoices(tx, [
        ...plan.creates.flatMap((c, i) =>
          c.consent.map((k) => ({ contactId: newIds[i], ...k, source: 'contact_import' as const, evidence: evidence(c.index), givenAt: now })),
        ),
        ...plan.updates.flatMap((u) =>
          u.consent.map((k) => ({ contactId: u.contactId, ...k, source: 'contact_import' as const, evidence: evidence(u.index), givenAt: now })),
        ),
      ]);

      // tags, likes and dislikes, notes and stays without dates
      await this.addKnowledge(tx, [
        ...plan.creates.map((c, i) => ({ contactId: newIds[i], ...c })),
        ...plan.updates.map((u) => ({ ...u })),
      ]);

      // the change log: every field an update changed, and every contact created
      const log = [
        ...plan.creates.map((c, i) => ({
          rowNumber: c.index + 1,
          contactId: newIds[i],
          field: 'contact',
          oldValue: null,
          newValue: c.addedAgain ? 'added_again' : 'new',
        })),
        ...plan.updates.flatMap((u) =>
          u.changes.map((ch) => ({ rowNumber: u.index + 1, contactId: u.contactId, field: ch.field, oldValue: ch.old, newValue: ch.new })),
        ),
      ];
      for (const part of chunks(log)) {
        await tx.insert(contactImportChanges).values(part.map((l) => ({ importId: saved.id, ...l })));
      }

      // only those whose opt-in was recorded
      const dncIds = plan.doNotContact.filter((id) => optedIn.includes(id));
      const dncPeople = dncIds.length
        ? await tx
            .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName })
            .from(contacts)
            .where(inArray(contacts.id, dncIds))
        : [];
      const details: ContactImportDetails = {
        newContacts: plan.creates.map((c, i) => ({ id: newIds[i], name: c.name, row: c.index + 1 })),
        newCompanies: plan.newCompanies.map((c) => ({ id: companyIds[c.key], name: c.name })),
        doNotContact: dncPeople.map((c) => ({ id: c.id, name: nameOf(c, `Contact #${c.id}`) })),
      };
      const createdId = new Map(plan.creates.map((c, i) => [c.index, newIds[i]]));
      const results: ContactImportResultRow[] = plan.rows.map((r) => ({
        row: r.index + 1,
        outcome: r.outcome,
        contactId: createdId.get(r.index) ?? r.contactId,
        reason: r.errors.length
          ? r.errors.join('; ')
          : r.outcome === 'ignored'
            ? [`Already in the CRM as ${r.matches.find((m) => m.contactId === r.contactId)?.name ?? `#${r.contactId}`}`, ...r.warnings].join('; ')
            : r.warnings.join('; ') || null,
        values: (input.rows[r.index] ?? {}) as Record<string, string>,
      }));
      const o = plan.summary.outcomes;
      await tx
        .update(contactImports)
        .set({ created: o.new, updated: o.updated, addedAgain: o.added_again, ignored: o.ignored, errors: o.error, details, results })
        .where(eq(contactImports.id, saved.id));

      return {
        id: saved.id,
        counts: o,
        ...details,
        rows: results.map(({ values: _values, ...r }) => r),
      };
    });
  }

  // =====================================================================
  // Loading and planning
  // =====================================================================
  private async plan(db: Reader, input: ContactRows) {
    const lookups = await this.lookups(db);
    const parsed = input.rows.map((row, i) => parseContact(row as RawContact, i, lookups));
    const existing = await this.existing(db, parsed);
    const choices = new Map<number, RowChoice>(input.choices.map(({ index, ...c }) => [index, c]));
    return { plan: planContactImport(parsed, existing, lookups, choices) };
  }

  private async lookups(db: Reader): Promise<ContactLookups> {
    // retired hotels still match, so old guest lists import; retired tags don't
    const [countryRows, hotelRows, tagRows, companyRows] = await Promise.all([
      db.select({ code: countries.code, name: countries.name }).from(countries).where(isNull(countries.deletedAt)),
      db.select({ id: properties.id, name: properties.name }).from(properties).where(isNull(properties.deletedAt)),
      db.select({ id: tags.id, name: tags.name, isActive: tags.isActive }).from(tags).where(isNull(tags.deletedAt)),
      db.select({ id: companies.id, name: companies.name }).from(companies).where(isNull(companies.deletedAt)),
    ]);
    return {
      countries: countryRows,
      properties: hotelRows,
      tags: tagRows.filter((t) => t.isActive),
      companies: companyRows,
      vipTagId: tagRows.find((t) => t.name.toLowerCase() === VIP_TAG)?.id ?? null,
    };
  }

  // The contacts with the file's emails and phones, and everything an update
  // compares against, loaded in a few queries.
  private async existing(db: Reader, parsed: ParsedContactRow[]): Promise<ExistingContacts> {
    const usable = parsed.filter((r) => !r.errors.length).map((r) => r.values);
    const emails = [...new Set(usable.flatMap((v) => v.emails.map((e) => matchKey('email', e))))];
    const phones = [...new Set(usable.flatMap((v) => v.phones.map((p) => matchKey('phone', p))))];

    // shared addresses never match, and neither do deleted contacts
    const matches: { contactId: number; kind: 'email' | 'phone'; key: string }[] = [];
    const conditions: SQL[] = [
      ...chunks(emails).map((part) => and(eq(contactMethods.kind, 'email'), inArray(sql`lower(${contactMethods.value})`, part))!),
      ...chunks(phones).map((part) => and(eq(contactMethods.kind, 'phone'), inArray(phoneDigits, part))!),
    ];
    for (const condition of conditions) {
      matches.push(
        ...(await db
          .select({
            contactId: contactMethods.contactId,
            kind: contactMethods.kind,
            key: sql<string>`case when ${contactMethods.kind} = 'email' then lower(${contactMethods.value}) else ${phoneDigits} end`,
          })
          .from(contactMethods)
          .innerJoin(contacts, eq(contacts.id, contactMethods.contactId))
          .where(and(condition, eq(contactMethods.isShared, false), isNull(contactMethods.deletedAt), isNull(contacts.deletedAt)))
          .orderBy(asc(contactMethods.contactId))),
      );
    }
    const byEmail = new Map<string, number[]>();
    const byPhone = new Map<string, number[]>();
    for (const m of matches) {
      const index = m.kind === 'email' ? byEmail : byPhone;
      const ids = index.get(m.key) ?? [];
      if (!ids.includes(m.contactId)) ids.push(m.contactId);
      index.set(m.key, ids);
    }

    const known = new Map<number, ExistingContact>();
    for (const part of chunks([...new Set(matches.map((m) => m.contactId))])) {
      const [people, methods, consentRows, tagRows, prefRows, noteRows, stayRows] = await Promise.all([
        db
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            contactType: contacts.contactType,
            lifecycleStage: contacts.lifecycleStage,
            market: contacts.market,
            countryCode: contacts.countryCode,
            companyId: contacts.companyId,
            companyName: companies.name,
            designation: contacts.designation,
            vipReason: contacts.vipReason,
            status: contacts.status,
          })
          .from(contacts)
          .leftJoin(companies, and(eq(companies.id, contacts.companyId), isNull(companies.deletedAt)))
          .where(inArray(contacts.id, part)),
        db
          .select({
            contactId: contactMethods.contactId,
            kind: contactMethods.kind,
            value: contactMethods.value,
            isPrimary: contactMethods.isPrimary,
            isShared: contactMethods.isShared,
          })
          .from(contactMethods)
          .where(and(inArray(contactMethods.contactId, part), isNull(contactMethods.deletedAt)))
          .orderBy(asc(contactMethods.id)),
        db
          .select({ contactId: consents.contactId, channel: consents.channel, status: consents.status })
          .from(consents)
          .where(and(inArray(consents.contactId, part), isNull(consents.deletedAt))),
        db.select({ contactId: contactTags.contactId, tagId: contactTags.tagId }).from(contactTags).where(inArray(contactTags.contactId, part)),
        db
          .select({ contactId: preferences.contactId, kind: preferences.kind, body: preferences.body })
          .from(preferences)
          .where(and(inArray(preferences.contactId, part), isNull(preferences.deletedAt))),
        db
          .select({ contactId: notes.contactId, body: notes.body })
          .from(notes)
          .where(and(inArray(notes.contactId, part), isNull(notes.deletedAt))),
        db
          .select({
            contactId: stays.contactId,
            propertyId: stays.propertyId,
            checkedOut: sql<number>`count(*) filter (where ${stays.status} = 'checked_out')::int`,
          })
          .from(stays)
          .where(and(inArray(stays.contactId, part), isNull(stays.deletedAt)))
          .groupBy(stays.contactId, stays.propertyId),
      ]);
      for (const p of people) {
        known.set(p.id, {
          ...p,
          doNotContact: p.status === 'do_not_contact',
          emails: [],
          phones: [],
          consent: { email: 'unknown', whatsapp: 'unknown' },
          tagIds: [],
          likes: [],
          dislikes: [],
          notes: [],
          hotelIds: [],
          checkedOutStays: 0,
        });
      }
      for (const m of methods) known.get(m.contactId)?.[m.kind === 'email' ? 'emails' : 'phones'].push(m);
      for (const k of consentRows) {
        const c = known.get(k.contactId);
        if (c) c.consent[k.channel] = k.status;
      }
      for (const t of tagRows) known.get(t.contactId)?.tagIds.push(t.tagId);
      for (const p of prefRows) known.get(p.contactId)?.[p.kind === 'like' ? 'likes' : 'dislikes'].push(p.body);
      for (const n of noteRows) if (n.contactId) known.get(n.contactId)?.notes.push(n.body);
      for (const s of stayRows) {
        const c = known.get(s.contactId);
        if (!c) continue;
        c.hotelIds.push(s.propertyId);
        c.checkedOutStays += s.checkedOut;
      }
    }
    return { byEmail, byPhone, contacts: known };
  }

  // =====================================================================
  // Writing
  // =====================================================================

  // Companies the CRM doesn't have yet: travel agents, as prospects.
  private async insertCompanies(tx: Transaction, plan: ContactImportPlan): Promise<number[]> {
    if (!plan.newCompanies.length) return [];
    const rows = await tx
      .insert(companies)
      .values(plan.newCompanies.map((c) => ({ name: c.name, companyType: 'travel_agent' as const, status: 'prospect' as const })))
      .returning({ id: companies.id });
    return rows.map((r) => r.id);
  }

  // New and added-again contacts, as one added in the app would be: emails and
  // phones unverified, consent rows unknown until the file's choices are
  // recorded. Ids are reserved first so the emails and phones can point at them.
  private async insertContacts(tx: Transaction, creates: ContactCreate[], companyOf: (ref: CompanyRef | null) => number | null) {
    if (!creates.length) return [];
    const { rows } = await tx.execute<{ id: string }>(
      sql`select nextval(pg_get_serial_sequence('contacts', 'id')) as id from generate_series(1, ${creates.length})`,
    );
    const ids = rows.map((r) => Number(r.id));
    for (const part of chunks(creates.map((c, i) => ({ c, id: ids[i] })))) {
      await tx.insert(contacts).values(part.map(({ c, id }) => ({ id, ...c.contact, companyId: companyOf(c.company) })));
    }
    const methods = creates.flatMap((c, i) => c.methods.map((m) => ({ contactId: ids[i], ...m })));
    for (const part of chunks(methods)) await tx.insert(contactMethods).values(part);
    const fresh = ids.flatMap((contactId) => CONSENT_CHANNELS.map((channel) => ({ contactId, channel })));
    for (const part of chunks(fresh)) await tx.insert(consents).values(part);
    return ids;
  }

  // Updates. Filled cells replace the contact's values; empty ones were left
  // out of the plan, so coalesce() keeps the CRM's value. Every updated
  // contact is written, which also bumps "Last updated" when only an email,
  // tag or note changed. Then the primaries move and new emails and phones
  // are added; the old primaries stay as extras.
  private async applyUpdates(tx: Transaction, updates: ContactUpdate[], companyOf: (ref: CompanyRef | null) => number | null) {
    const changed = updates.filter((u) => u.changes.length);
    for (const part of chunks(changed)) {
      const values = sql.join(
        part.map((u) => {
          const s = u.set;
          return sql`(${u.contactId}::bigint, ${s.firstName ?? null}::text, ${s.lastName ?? null}::text,
            ${s.contactType ?? null}::text, ${s.lifecycleStage ?? null}::text, ${s.market ?? null}::text,
            ${s.countryCode ?? null}::char(2), ${u.company === undefined ? null : companyOf(u.company)}::bigint,
            ${s.designation ?? null}::text, ${s.vipReason ?? null}::text)`;
        }),
        sql`, `,
      );
      await tx.execute(sql`
        update contacts c set
          first_name = coalesce(v.first_name, c.first_name), last_name = coalesce(v.last_name, c.last_name),
          contact_type = coalesce(v.contact_type, c.contact_type), lifecycle_stage = coalesce(v.lifecycle_stage, c.lifecycle_stage),
          market = coalesce(v.market, c.market), country_code = coalesce(v.country_code, c.country_code),
          company_id = coalesce(v.company_id, c.company_id), designation = coalesce(v.designation, c.designation),
          vip_reason = coalesce(v.vip_reason, c.vip_reason), updated_at = now()
        from (values ${values}) as v (id, first_name, last_name, contact_type, lifecycle_stage, market, country_code,
                                      company_id, designation, vip_reason)
        where c.id = v.id`);
    }

    // primaries: clear the old one, then mark the file's (or add it as primary)
    const moves = updates.flatMap((u) => u.primary.map((p) => ({ contactId: u.contactId, ...p })));
    for (const part of chunks(moves)) {
      const pairs = sql.join(
        part.map((m) => sql`(${m.contactId}::bigint, ${m.kind}::text)`),
        sql`, `,
      );
      await tx.execute(sql`
        update contact_methods m set is_primary = false
          from (values ${pairs}) as v (contact_id, kind)
         where m.contact_id = v.contact_id and m.kind = v.kind and m.is_primary and m.deleted_at is null`);
      const onFile = part.filter((m) => m.onFile);
      if (onFile.length) {
        const keys = sql.join(
          onFile.map((m) => sql`(${m.contactId}::bigint, ${m.kind}::text, ${matchKey(m.kind, m.value)}::text)`),
          sql`, `,
        );
        await tx.execute(sql`
          update contact_methods m set is_primary = true
            from (values ${keys}) as v (contact_id, kind, key)
           where m.id = (select x.id from contact_methods x
                          where x.contact_id = v.contact_id and x.kind = v.kind and x.deleted_at is null
                            and contact_method_key(x.kind, x.value) = v.key
                          order by x.is_shared, x.id limit 1)`);
      }
    }
    const added = [
      ...moves.filter((m) => !m.onFile).map((m) => ({ contactId: m.contactId, kind: m.kind, value: m.value, isPrimary: true, isShared: false })),
      ...updates.flatMap((u) => u.methods.map((m) => ({ contactId: u.contactId, ...m }))),
    ];
    for (const part of chunks(added)) await tx.insert(contactMethods).values(part);
  }

  // Tags, likes and dislikes, notes, and a checked-out stay without dates at
  // each hotel stayed at (the lifecycle trigger moves the stage).
  private async addKnowledge(
    tx: Transaction,
    targets: (Pick<ContactCreate, 'tagIds' | 'hotelIds' | 'preferences' | 'notes'> & { contactId: number })[],
  ) {
    const tagRows = targets.flatMap((t) => t.tagIds.map((tagId) => ({ contactId: t.contactId, tagId })));
    for (const part of chunks(tagRows)) await tx.insert(contactTags).values(part).onConflictDoNothing();
    const prefRows = targets.flatMap((t) => t.preferences.map((p) => ({ contactId: t.contactId, ...p })));
    for (const part of chunks(prefRows)) await tx.insert(preferences).values(part);
    const noteRows = targets.flatMap((t) => t.notes.map((body) => ({ contactId: t.contactId, body })));
    for (const part of chunks(noteRows)) await tx.insert(notes).values(part);
    const stayRows = targets.flatMap((t) =>
      t.hotelIds.map((propertyId) => ({ contactId: t.contactId, propertyId, status: 'checked_out' as const })),
    );
    for (const part of chunks(stayRows)) await tx.insert(stays).values(part);
  }
}
