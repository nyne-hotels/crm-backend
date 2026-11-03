import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm';
import {
  createdInfo,
  creator,
  joinCreator,
  joinUpdater,
  lastUpdated,
  restore,
  softDelete,
  updater,
} from '../common/audit.js';
import { between, betweenDays, betweenTimes, blank, inList, whenFields, whenYesNo } from '../common/filters.js';
import { likePattern } from '../common/sql.js';
import { InjectDb, type Database } from '../db/drizzle.module.js';
import {
  companies,
  CONSENT_CHANNELS,
  consents,
  contactImportChanges,
  contactImports,
  contactMerges,
  contactMethods,
  contactOverview,
  contacts,
  contactTags,
  countries,
  feedback,
  leads,
  marketingEmailList,
  preferences,
  specialDates,
  stays,
  tags,
} from '../db/schema/index.js';
import { withActingStaff, type Transaction } from '../db/with-staff.js';
import { LOW_RATING } from '../feedback/feedback-rules.js';
import { hotelToday } from '../stays/stay-rules.js';
import { formatPhone, initialStage, marketForCountry, matchKey, searchTerms, stageAfterTypeChange } from './guest-rules.js';
import type { CreateGuest, FindMatches, ListGuests, UpdateGuest } from './guests.schemas.js';

const o = contactOverview;
const fullName = sql<string>`concat_ws(' ', ${o.firstName}, ${o.lastName})`;
// digits only, so '+966 54 148 8817' is found by '+966 54' or '96654'
const phoneDigitsOf = sql`regexp_replace(${contactMethods.value}, '[^0-9]', '', 'g')`;

// The guest directory: one row per person (guests, leads, agent contacts,
// influencers). Lists read from the contact_overview view, which already
// hides deleted guests; their emails and phones are in contact_methods.
@Injectable()
export class GuestsService {
  constructor(@InjectDb() private readonly db: Database) {}

  async list(filter: ListGuests) {
    const conditions: (SQL | undefined)[] = [];
    if (filter.q) conditions.push(this.searchCondition(filter.q));
    conditions.push(
      inList(o.contactType, filter.type),
      inList(o.lifecycleStage, filter.stage),
      inList(o.market, filter.market),
      inList(o.countryCode, filter.country),
    );
    if (filter.propertyId) {
      // "Stayed at" any of them: checked-out stays, as counted in contact_overview
      conditions.push(
        sql`exists (select 1 from ${stays} where ${stays.contactId} = ${o.id}
              and ${inArray(stays.propertyId, filter.propertyId)} and ${stays.status} = 'checked_out'
              and ${stays.deletedAt} is null)`,
      );
    }
    if (filter.tagId) {
      // tagged with any of them
      conditions.push(
        sql`exists (select 1 from ${contactTags} where ${contactTags.contactId} = ${o.id}
              and ${inArray(contactTags.tagId, filter.tagId)})`,
      );
    }
    conditions.push(...this.moreConditions(filter));
    const where = and(...conditions);

    const order = filter.order ?? (filter.sort === 'name' ? 'asc' : 'desc');
    const dir = order === 'asc' ? asc : desc;
    // nameless and never-stayed guests go last either way
    const orderBy =
      filter.sort === 'lastStay'
        ? [sql`${o.lastStay} ${sql.raw(order)} nulls last`, dir(o.id)]
        : filter.sort === 'stays'
          ? [dir(o.stayRows), sql`${o.lastStay} ${sql.raw(order)} nulls last`, dir(o.id)]
          : [
              sql`lower(${o.firstName}) ${sql.raw(order)} nulls last`,
              sql`lower(${o.lastName}) ${sql.raw(order)} nulls last`,
              dir(o.id),
            ];

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: o.id,
          firstName: o.firstName,
          lastName: o.lastName,
          contactType: o.contactType,
          lifecycleStage: o.lifecycleStage,
          market: o.market,
          countryCode: o.countryCode,
          country: o.country,
          company: o.company,
          email: o.email,
          phone: o.phone,
          hotels: o.hotels,
          stayCount: o.stayRows,
          lastStay: o.lastStay,
        })
        .from(o)
        .where(where)
        .orderBy(...orderBy)
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize),
      this.db.select({ total: count() }).from(o).where(where),
    ]);
    return { rows, total, page: filter.page, pageSize: filter.pageSize };
  }

  // The "More filters" panel: consent, contact details, stays, leads, feedback and dates.
  private moreConditions(filter: ListGuests): (SQL | undefined)[] {
    const today = hotelToday();
    const consentIs = (channel: 'email' | 'whatsapp', status: string): SQL =>
      status === 'unknown'
        ? sql`not exists (select 1 from ${consents} k where k.contact_id = ${o.id} and k.channel = ${channel}
              and k.deleted_at is null and k.status <> 'unknown')`
        : sql`exists (select 1 from ${consents} k where k.contact_id = ${o.id} and k.channel = ${channel}
              and k.deleted_at is null and k.status = ${status})`;
    const hasMethod = (kind: 'email' | 'phone', extra = sql`true`) =>
      sql`exists (select 1 from ${contactMethods} m where m.contact_id = ${o.id} and m.kind = ${kind}
            and m.deleted_at is null and ${extra})`;
    const onContact = (condition: SQL) =>
      sql`exists (select 1 from ${contacts} c where c.id = ${o.id} and ${condition})`;
    const lowRating = sql`f.rating <= ${LOW_RATING}`;
    const gaveFeedback = (extra = sql`true`) =>
      sql`exists (select 1 from ${feedback} f join ${stays} s on s.id = f.stay_id
            where s.contact_id = ${o.id} and f.deleted_at is null and s.deleted_at is null and ${extra})`;
    const none = (table: SQL, extra = sql`true`) =>
      sql`not exists (select 1 from ${table} x where x.contact_id = ${o.id} and x.deleted_at is null and ${extra})`;

    return [
      filter.company && onContact(inArray(sql`c.company_id`, filter.company)),
      filter.emailConsent && or(...filter.emailConsent.map((status) => consentIs('email', status))),
      filter.whatsappConsent && or(...filter.whatsappConsent.map((status) => consentIs('whatsapp', status))),
      whenYesNo(filter.doNotContact, onContact(sql`c.status = 'do_not_contact'`)),
      whenYesNo(filter.canEmail, sql`exists (select 1 from ${marketingEmailList} ml where ml.id = ${o.id})`),
      filter.emailStatus ? hasMethod('email', sql`m.is_primary and ${inArray(sql`m.status`, filter.emailStatus)}`) : undefined,
      between(o.stayRows, filter.staysMin, filter.staysMax),
      betweenDays(o.lastStay, filter.lastStayFrom, filter.lastStayTo),
      betweenTimes(o.createdAt, filter.addedFrom, filter.addedTo),
      whenYesNo(
        filter.upcomingStay,
        sql`exists (select 1 from ${stays} s where s.contact_id = ${o.id} and s.deleted_at is null
              and (s.status = 'checked_in' or (s.status = 'booked' and s.arrival_date >= ${today})))`,
      ),
      whenYesNo(
        filter.openLead,
        sql`exists (select 1 from ${leads} l where l.contact_id = ${o.id} and l.deleted_at is null
              and l.status in ('new', 'contacted', 'quoted'))`,
      ),
      filter.feedback === 'given'
        ? gaveFeedback()
        : filter.feedback === 'low'
          ? gaveFeedback(lowRating)
          : filter.feedback === 'none'
            ? not(gaveFeedback())
            : undefined,
      filter.birthdayMonth
        ? sql`exists (select 1 from ${specialDates} d where d.contact_id = ${o.id} and d.deleted_at is null
              and d.occasion = 'birthday' and ${inArray(sql`d.month`, filter.birthdayMonth)})`
        : undefined,
      // each test says when the field is missing; filled in is the opposite
      whenFields(filter, {
        name: and(blank(o.firstName), blank(o.lastName))!,
        firstName: blank(o.firstName),
        lastName: blank(o.lastName),
        email: not(hasMethod('email')),
        phone: not(hasMethod('phone')),
        whatsapp: not(hasMethod('phone', sql`m.is_whatsapp`)),
        country: isNull(o.countryCode),
        company: onContact(sql`c.company_id is null`),
        jobTitle: onContact(blank(sql`c.designation`)),
        vipReason: onContact(blank(sql`c.vip_reason`)),
        birthday: none(sql`${specialDates}`, sql`x.occasion = 'birthday'`),
        specialDates: none(sql`${specialDates}`),
        preferences: none(sql`${preferences}`),
        tags: sql`not exists (select 1 from ${contactTags} t where t.contact_id = ${o.id})`,
      }),
    ];
  }

  async get(id: number) {
    const [guest] = await this.db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        contactType: contacts.contactType,
        lifecycleStage: contacts.lifecycleStage,
        market: contacts.market,
        countryCode: contacts.countryCode,
        countryName: countries.name,
        dialCode: countries.dialCode,
        companyId: contacts.companyId,
        companyName: companies.name,
        designation: contacts.designation,
        vipReason: contacts.vipReason,
        status: contacts.status,
        created: createdInfo(contacts),
        lastUpdated: lastUpdated(contacts),
      })
      .from(contacts)
      .leftJoin(countries, eq(countries.code, contacts.countryCode))
      .leftJoin(companies, and(eq(companies.id, contacts.companyId), isNull(companies.deletedAt)))
      .leftJoin(creator, joinCreator(contacts))
      .leftJoin(updater, joinUpdater(contacts))
      .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)));
    if (!guest) throw new NotFoundException('Guest not found');

    const [methods, [summary], guestTags, merges, [contactImport]] = await Promise.all([
      this.db
        .select({
          id: contactMethods.id,
          kind: contactMethods.kind,
          value: contactMethods.value,
          isPrimary: contactMethods.isPrimary,
          isShared: contactMethods.isShared,
          isWhatsapp: contactMethods.isWhatsapp,
          status: contactMethods.status,
          lastUpdated: lastUpdated(contactMethods),
        })
        .from(contactMethods)
        .leftJoin(updater, joinUpdater(contactMethods))
        .where(and(eq(contactMethods.contactId, id), isNull(contactMethods.deletedAt)))
        .orderBy(desc(contactMethods.isPrimary), desc(contactMethods.createdAt), desc(contactMethods.id)),
      this.db
        .select({ hotels: o.hotels, stayCount: o.stayRows, lastStay: o.lastStay })
        .from(o)
        .where(eq(o.id, id)),
      // retired tags stay on the guests who have them
      this.db
        .select({ id: tags.id, name: tags.name, isActive: tags.isActive })
        .from(contactTags)
        .innerJoin(tags, and(eq(tags.id, contactTags.tagId), isNull(tags.deletedAt)))
        .where(eq(contactTags.contactId, id))
        .orderBy(asc(sql`lower(${tags.name})`)),
      // "Merged with a duplicate on 21 Oct 2026 by Nisha Silva" (Module 6)
      this.db
        .select({ id: contactMerges.id, merged: createdInfo(contactMerges) })
        .from(contactMerges)
        .leftJoin(creator, joinCreator(contactMerges))
        .where(eq(contactMerges.keptContactId, id))
        .orderBy(desc(contactMerges.createdAt), desc(contactMerges.id)),
      // "Updated by contact import #12 (Tehan, 28 Oct 2026)": the last import that changed or created them (Module 9)
      this.db
        .select({ id: contactImports.id, imported: createdInfo(contactImports) })
        .from(contactImportChanges)
        .innerJoin(contactImports, eq(contactImports.id, contactImportChanges.importId))
        .leftJoin(creator, joinCreator(contactImports))
        .where(eq(contactImportChanges.contactId, id))
        .orderBy(desc(contactImportChanges.id))
        .limit(1),
    ]);

    return {
      ...guest,
      emails: methods.filter((m) => m.kind === 'email'),
      phones: methods.filter((m) => m.kind === 'phone'),
      summary: summary ?? { hotels: null, stayCount: 0, lastStay: null },
      tags: guestTags,
      merges, // newest first
      contactImport: contactImport ?? null,
    };
  }

  async create(input: CreateGuest) {
    const id = await withActingStaff(this.db, (tx) => insertGuest(tx, input));
    return this.get(id);
  }

  async update(id: number, input: UpdateGuest) {
    const current = await this.get(id);
    const changes: Partial<typeof contacts.$inferInsert> = Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    );
    // market follows the country unless it's given (staff can override it)
    if (input.countryCode !== undefined && input.market === undefined && input.countryCode !== current.countryCode) {
      changes.market = marketForCountry(input.countryCode);
    }
    if (!Object.keys(changes).length) return current;

    await withActingStaff(this.db, async (tx) => {
      if (input.contactType && input.contactType !== current.contactType) {
        const [{ stayCount }] = await tx
          .select({ stayCount: count() })
          .from(stays)
          .where(and(eq(stays.contactId, id), eq(stays.status, 'checked_out'), isNull(stays.deletedAt)));
        const stage = stageAfterTypeChange(current.lifecycleStage, input.contactType, stayCount);
        if (stage) changes.lifecycleStage = stage;
      }
      await tx.update(contacts).set(changes).where(eq(contacts.id, id));
    });
    return this.get(id);
  }

  // Hides the guest from every list and search. Their stays, notes and
  // other rows stay attached, so a restore brings everything back.
  async remove(id: number) {
    await withActingStaff(this.db, (tx) => softDelete(tx, contacts, id));
  }

  async restore(id: number) {
    await withActingStaff(this.db, (tx) => restore(tx, contacts, id));
    return this.get(id);
  }

  // Other guests who already have this email or phone, for the
  // "This email belongs to Ahmed Daoud" warning. Shared addresses (agent
  // office, family email) never match, and neither do deleted guests.
  async findMatches(input: FindMatches) {
    let condition: SQL;
    if (input.email) {
      condition = and(eq(contactMethods.kind, 'email'), eq(sql`lower(${contactMethods.value})`, matchKey('email', input.email)))!;
    } else {
      const digits = matchKey('phone', formatPhone(input.phone!, input.phoneCountry) ?? input.phone!);
      if (digits.length < 6) return [];
      condition = and(eq(contactMethods.kind, 'phone'), eq(phoneDigitsOf, digits))!;
    }
    return this.db
      .selectDistinct({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contactMethods)
      .innerJoin(contacts, eq(contacts.id, contactMethods.contactId))
      .where(
        and(
          condition,
          eq(contactMethods.isShared, false),
          isNull(contactMethods.deletedAt),
          isNull(contacts.deletedAt),
          input.excludeId ? ne(contacts.id, input.excludeId) : undefined,
        ),
      )
      .orderBy(asc(contacts.id))
      .limit(5);
  }

  private searchCondition(q: string): SQL {
    const { text, words, phoneDigits } = searchTerms(q);
    const methodMatches: SQL[] = [ilike(contactMethods.value, likePattern(text))];
    for (const digits of phoneDigits) {
      methodMatches.push(and(eq(contactMethods.kind, 'phone'), sql`${phoneDigitsOf} like ${likePattern(digits)}`)!);
    }
    const byMethod = this.db
      .select({ id: contactMethods.contactId })
      .from(contactMethods)
      .where(and(isNull(contactMethods.deletedAt), or(...methodMatches)));
    return or(and(...words.map((w) => ilike(fullName, likePattern(w)))), inArray(o.id, byMethod))!;
  }
}

// A new guest with their first email and/or phone (both primary), and
// consent rows for each channel at "unknown", as for guests from bookings.
// Run inside withActingStaff(); returns the new guest's id. Also used by the
// stay form's "New guest".
export async function insertGuest(tx: Transaction, input: CreateGuest): Promise<number> {
  const phone = input.phone && {
    ...input.phone,
    value: phoneOrThrow(input.phone.value, input.phone.country ?? input.countryCode),
  };
  const [row] = await tx
    .insert(contacts)
    .values({
      firstName: input.firstName,
      lastName: input.lastName,
      contactType: input.contactType,
      lifecycleStage: initialStage(input.contactType),
      market: input.market ?? marketForCountry(input.countryCode),
      countryCode: input.countryCode,
      designation: input.designation,
      vipReason: input.vipReason,
      companyId: input.companyId,
    })
    .returning({ id: contacts.id });

  const methods: (typeof contactMethods.$inferInsert)[] = [];
  if (input.email) {
    methods.push({ contactId: row.id, kind: 'email', value: input.email.value, isPrimary: true, isShared: input.email.isShared });
  }
  if (phone) {
    methods.push({
      contactId: row.id,
      kind: 'phone',
      value: phone.value,
      isPrimary: true,
      isShared: phone.isShared,
      isWhatsapp: phone.isWhatsapp ?? null,
    });
  }
  await tx.insert(contactMethods).values(methods);
  await tx.insert(consents).values(CONSENT_CHANNELS.map((channel) => ({ contactId: row.id, channel })));
  return row.id;
}

export function phoneOrThrow(value: string, country: string | null | undefined): string {
  const phone = formatPhone(value, country);
  if (!phone) throw new BadRequestException('Enter a valid phone number, with its country code');
  return phone;
}
